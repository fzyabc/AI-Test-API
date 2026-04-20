const crypto = require("crypto");
const { getQbjData, saveQbjData, nextId } = require("../lib/qbj-store");

const SENSITIVE_WORDS = ["稳赚", "包赢", "内幕", "代投", "代购", "必中", "保本"];
const VALID_SPORTS = new Set(["football", "basketball"]);
const VALID_RECORD_STATUS = new Set(["draft", "submitted", "settled"]);
const VALID_SETTLE_RESULT = new Set(["win", "lose", "void"]);
const VALID_CYCLE_TYPE = new Set(["week", "month"]);
const VALID_OVER_LIMIT_MODE = new Set(["warn", "block"]);

function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

function ok(res, data = {}) {
  res.json({ code: 0, message: "ok", data });
}

function fail(res, httpStatus, code, message, data = null) {
  res.status(httpStatus).json({ code, message, data });
}

function toNumber(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toSafeText(value, maxLength = 255) {
  return String(value || "").trim().slice(0, maxLength);
}

function sanitizePickText(text) {
  const normalized = toSafeText(text, 255);
  for (const word of SENSITIVE_WORDS) {
    if (normalized.includes(word)) {
      return { ok: false, word };
    }
  }
  return { ok: true, value: normalized };
}

function getIsoWeekKey(dateInput) {
  const date = new Date(dateInput);
  const utc = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((utc - yearStart) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function getMonthKey(dateInput) {
  const date = new Date(dateInput);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getCycleKey(cycleType, dateInput = new Date()) {
  return cycleType === "month"
    ? getMonthKey(dateInput)
    : getIsoWeekKey(dateInput);
}

function isBeforeLock(match) {
  return Date.now() <= new Date(match.lockTime).getTime();
}

function parseAuthorizationToken(req) {
  const auth = String(req.headers.authorization || "").trim();
  if (!auth.toLowerCase().startsWith("bearer ")) return "";
  return auth.slice(7).trim();
}

function resolveUserByToken(data, token) {
  if (!token) return null;
  const now = Date.now();
  const session = (data.sessions || []).find(
    (item) => item.token === token && new Date(item.expiredAt).getTime() > now,
  );
  if (!session) return null;
  const user = (data.users || []).find((item) => item.id === session.userId);
  if (!user) return null;
  return { user, session };
}

function requireUser(req, res, data) {
  const token = parseAuthorizationToken(req);
  const resolved = resolveUserByToken(data, token);
  if (!resolved) {
    fail(res, 401, 40101, "未登录或 token 已失效");
    return null;
  }
  return resolved;
}

function findMatchOrNull(data, matchId) {
  const id = Number(matchId);
  return (data.matches || []).find((item) => item.id === id) || null;
}

function computeBudgetUsage(data, userId, cycleType, cycleKey, options = {}) {
  const excludeRecordId = Number(options.excludeRecordId || 0);
  const includeDraft = Boolean(options.includeDraft);
  let sum = 0;
  for (const record of data.records || []) {
    if (record.userId !== userId) continue;
    if (excludeRecordId && record.id === excludeRecordId) continue;
    const inStatus = includeDraft
      ? ["draft", "submitted", "settled"].includes(record.status)
      : ["submitted", "settled"].includes(record.status);
    if (!inStatus) continue;
    const pivotTime = record.submittedAt || record.createdAt;
    if (!pivotTime) continue;
    const key = getCycleKey(cycleType, pivotTime);
    if (key !== cycleKey) continue;
    sum += Number(record.amount || 0);
  }
  return Number(sum.toFixed(2));
}

function getBudgetEntries(data, userId, now = new Date()) {
  const weekKey = getCycleKey("week", now);
  const monthKey = getCycleKey("month", now);
  return (data.budgets || []).filter((item) => {
    if (item.userId !== userId) return false;
    if (item.cycleType === "week" && item.cycleKey === weekKey) return true;
    if (item.cycleType === "month" && item.cycleKey === monthKey) return true;
    return false;
  });
}

function checkBudgetOnSubmit(data, userId, amount, options = {}) {
  const now = options.now || new Date();
  const excludeRecordId = Number(options.excludeRecordId || 0);
  const entries = getBudgetEntries(data, userId, now);
  const warnings = [];

  for (const item of entries) {
    const currentUsed = computeBudgetUsage(data, userId, item.cycleType, item.cycleKey, {
      excludeRecordId,
    });
    const nextUsed = Number((currentUsed + Number(amount || 0)).toFixed(2));
    const total = Number(item.amountTotal || 0);
    if (total <= 0) continue;

    if (nextUsed > total) {
      if (item.overLimitMode === "block") {
        return {
          ok: false,
          code: 40901,
          message: `${item.cycleType} 预算超限，当前模式为 block，不允许提交`,
          details: {
            cycleType: item.cycleType,
            cycleKey: item.cycleKey,
            amountTotal: total,
            amountUsed: currentUsed,
            nextUsed,
          },
        };
      }
      warnings.push({
        cycleType: item.cycleType,
        cycleKey: item.cycleKey,
        amountTotal: total,
        amountUsed: currentUsed,
        nextUsed,
      });
    }
  }

  return { ok: true, warnings };
}

function buildBudgetView(data, userId, cycleType, now = new Date()) {
  const cycleKey = getCycleKey(cycleType, now);
  const existed = (data.budgets || []).find(
    (item) =>
      item.userId === userId
      && item.cycleType === cycleType
      && item.cycleKey === cycleKey,
  );

  const amountTotal = Number(existed?.amountTotal || 0);
  const amountUsed = computeBudgetUsage(data, userId, cycleType, cycleKey);
  const amountLeft = Number((amountTotal - amountUsed).toFixed(2));

  return {
    cycleType,
    cycleKey,
    amountTotal,
    amountUsed,
    amountLeft,
    overLimitMode: existed?.overLimitMode || "warn",
  };
}

function buildRecordView(record) {
  return {
    id: record.id,
    userId: record.userId,
    matchId: record.matchId,
    weekKey: record.weekKey,
    pickContent: record.pickContent,
    amount: Number(record.amount),
    status: record.status,
    result: record.result,
    returnAmount: Number(record.returnAmount || 0),
    profitLoss: Number(record.profitLoss || 0),
    note: record.note || "",
    submittedAt: record.submittedAt || null,
    settledAt: record.settledAt || null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function collectMistakeTags(records) {
  const tags = [];
  const loseCount = records.filter((item) => item.result === "lose").length;
  const maxAmount = records.reduce(
    (max, item) => Math.max(max, Number(item.amount || 0)),
    0,
  );
  const hasImpulseNote = records.some((item) =>
    /临场|冲动|上头|梭哈/u.test(String(item.note || "")),
  );

  if (loseCount >= 3) tags.push("连败后追注风险");
  if (maxAmount >= 500) tags.push("单场投入偏高");
  if (hasImpulseNote) tags.push("临场冲动加注");

  return tags.slice(0, 3);
}

function buildSuggestions(summary) {
  const suggestions = [];
  if (summary.totalRecords === 0) {
    suggestions.push("先从小额记录开始，连续一周形成复盘习惯");
    return suggestions;
  }
  if (summary.hitRate < 0.5) {
    suggestions.push("下周减少场次，优先做熟悉联赛与固定时段");
  }
  if (summary.netValue < 0) {
    suggestions.push("设置单场上限，不超过周预算的 15%");
  }
  if (summary.voidCount > 0) {
    suggestions.push("赛前确认规则，减少无效记录");
  }
  if (!suggestions.length) {
    suggestions.push("保持节奏，继续用固定预算和固定场次策略");
  }
  return suggestions.slice(0, 3);
}

function computeWeeklySummary(data, userId, weekKey) {
  const records = (data.records || []).filter(
    (item) =>
      item.userId === userId
      && item.weekKey === weekKey
      && item.status === "settled",
  );

  const totalRecords = records.length;
  const winCount = records.filter((item) => item.result === "win").length;
  const loseCount = records.filter((item) => item.result === "lose").length;
  const voidCount = records.filter((item) => item.result === "void").length;
  const denominator = winCount + loseCount;
  const hitRate = denominator > 0 ? Number((winCount / denominator).toFixed(4)) : 0;
  const netValue = Number(
    records.reduce((sum, item) => sum + Number(item.profitLoss || 0), 0).toFixed(2),
  );

  const base = {
    weekKey,
    totalRecords,
    winCount,
    loseCount,
    voidCount,
    hitRate,
    netValue,
  };

  return {
    ...base,
    mistakeTags: collectMistakeTags(records),
    suggestions: buildSuggestions(base),
  };
}

function parsePagination(req) {
  const page = Math.max(1, Math.floor(toNumber(req.query.page, 1)));
  const pageSize = Math.min(100, Math.max(1, Math.floor(toNumber(req.query.pageSize, 20))));
  return { page, pageSize };
}

function paginate(list, page, pageSize) {
  const total = list.length;
  const start = (page - 1) * pageSize;
  return {
    list: list.slice(start, start + pageSize),
    page,
    pageSize,
    total,
  };
}

function getRecordByIdOrNull(data, recordId) {
  const id = Number(recordId);
  return (data.records || []).find((item) => item.id === id) || null;
}

function enrichMatchBrief(data, record) {
  const match = (data.matches || []).find((item) => item.id === record.matchId);
  if (!match) return null;
  return {
    id: match.id,
    sportType: match.sportType,
    league: match.league,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    startTime: match.startTime,
  };
}

function registerQbjRoutes(app) {
  app.post(
    "/api/v1/auth/wx-login",
    asyncHandler(async (req, res) => {
      const code = toSafeText(req.body?.code, 200);
      if (!code) {
        return fail(res, 400, 40001, "code 不能为空");
      }

      const nickname = toSafeText(req.body?.nickname, 64) || "球友";
      const avatar = toSafeText(req.body?.avatar, 512);
      const openid = `wx_${crypto
        .createHash("sha1")
        .update(code)
        .digest("hex")
        .slice(0, 20)}`;

      const data = await getQbjData();
      let user = (data.users || []).find((item) => item.openid === openid);
      const nowIso = new Date().toISOString();

      if (!user) {
        user = {
          id: nextId(data, "user"),
          openid,
          nickname,
          avatar,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        data.users.push(user);
      } else {
        user.nickname = nickname || user.nickname;
        user.avatar = avatar || user.avatar;
        user.updatedAt = nowIso;
      }

      const token = crypto.randomUUID();
      const expiredAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      data.sessions = (data.sessions || []).filter(
        (item) => item.userId !== user.id && new Date(item.expiredAt).getTime() > Date.now(),
      );
      data.sessions.push({
        token,
        userId: user.id,
        createdAt: nowIso,
        expiredAt,
      });

      await saveQbjData(data);
      ok(res, {
        token,
        user: {
          id: user.id,
          nickname: user.nickname,
          avatar: user.avatar,
        },
      });
    }),
  );

  app.get(
    "/api/v1/matches",
    asyncHandler(async (req, res) => {
      const sportType = toSafeText(req.query.sportType, 20);
      const date = toSafeText(req.query.date, 20);
      const { page, pageSize } = parsePagination(req);

      const data = await getQbjData();
      let list = [...(data.matches || [])];

      if (sportType) {
        if (!VALID_SPORTS.has(sportType)) {
          return fail(res, 400, 40001, "sportType 非法");
        }
        list = list.filter((item) => item.sportType === sportType);
      }

      if (date) {
        list = list.filter(
          (item) => String(item.startTime || "").slice(0, 10) === date,
        );
      }

      list.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
      const paged = paginate(list, page, pageSize);

      ok(res, {
        list: paged.list.map((item) => ({
          id: item.id,
          sportType: item.sportType,
          league: item.league,
          homeTeam: item.homeTeam,
          awayTeam: item.awayTeam,
          startTime: item.startTime,
          status: item.status,
        })),
        page,
        pageSize,
        total: paged.total,
      });
    }),
  );

  app.get(
    "/api/v1/matches/:matchId",
    asyncHandler(async (req, res) => {
      const data = await getQbjData();
      const match = findMatchOrNull(data, req.params.matchId);
      if (!match) {
        return fail(res, 404, 40401, "赛事不存在");
      }
      ok(res, match);
    }),
  );

  app.post(
    "/api/v1/matches/:matchId/follow",
    asyncHandler(async (req, res) => {
      const data = await getQbjData();
      const resolved = requireUser(req, res, data);
      if (!resolved) return;

      const match = findMatchOrNull(data, req.params.matchId);
      if (!match) {
        return fail(res, 404, 40401, "赛事不存在");
      }

      const existed = (data.follows || []).find(
        (item) => item.userId === resolved.user.id && item.matchId === match.id,
      );
      if (!existed) {
        data.follows.push({
          id: nextId(data, "follow"),
          userId: resolved.user.id,
          matchId: match.id,
          createdAt: new Date().toISOString(),
        });
        await saveQbjData(data);
      }

      ok(res, { followed: true });
    }),
  );

  app.delete(
    "/api/v1/matches/:matchId/follow",
    asyncHandler(async (req, res) => {
      const data = await getQbjData();
      const resolved = requireUser(req, res, data);
      if (!resolved) return;

      const match = findMatchOrNull(data, req.params.matchId);
      if (!match) {
        return fail(res, 404, 40401, "赛事不存在");
      }

      data.follows = (data.follows || []).filter(
        (item) => !(item.userId === resolved.user.id && item.matchId === match.id),
      );
      await saveQbjData(data);

      ok(res, { followed: false });
    }),
  );

  app.get(
    "/api/v1/me/follows",
    asyncHandler(async (req, res) => {
      const data = await getQbjData();
      const resolved = requireUser(req, res, data);
      if (!resolved) return;

      const date = toSafeText(req.query.date, 20);
      const follows = (data.follows || []).filter(
        (item) => item.userId === resolved.user.id,
      );
      let matches = follows
        .map((item) => (data.matches || []).find((match) => match.id === item.matchId))
        .filter(Boolean);

      if (date) {
        matches = matches.filter(
          (item) => String(item.startTime || "").slice(0, 10) === date,
        );
      }

      matches.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
      ok(res, {
        list: matches.map((item) => ({
          id: item.id,
          sportType: item.sportType,
          league: item.league,
          homeTeam: item.homeTeam,
          awayTeam: item.awayTeam,
          startTime: item.startTime,
          status: item.status,
        })),
      });
    }),
  );

  app.get(
    "/api/v1/me/budget",
    asyncHandler(async (req, res) => {
      const cycleType = toSafeText(req.query.cycleType || "week", 20);
      if (!VALID_CYCLE_TYPE.has(cycleType)) {
        return fail(res, 400, 40001, "cycleType 非法");
      }

      const data = await getQbjData();
      const resolved = requireUser(req, res, data);
      if (!resolved) return;

      ok(res, buildBudgetView(data, resolved.user.id, cycleType));
    }),
  );

  app.put(
    "/api/v1/me/budget",
    asyncHandler(async (req, res) => {
      const cycleType = toSafeText(req.body?.cycleType, 20);
      const amountTotal = toNumber(req.body?.amountTotal, NaN);
      const overLimitMode = toSafeText(req.body?.overLimitMode || "warn", 20);

      if (!VALID_CYCLE_TYPE.has(cycleType)) {
        return fail(res, 400, 40001, "cycleType 非法");
      }
      if (!(amountTotal >= 0)) {
        return fail(res, 400, 40001, "amountTotal 必须 >= 0");
      }
      if (!VALID_OVER_LIMIT_MODE.has(overLimitMode)) {
        return fail(res, 400, 40001, "overLimitMode 非法");
      }

      const data = await getQbjData();
      const resolved = requireUser(req, res, data);
      if (!resolved) return;

      const cycleKey = getCycleKey(cycleType, new Date());
      const existed = (data.budgets || []).find(
        (item) =>
          item.userId === resolved.user.id
          && item.cycleType === cycleType
          && item.cycleKey === cycleKey,
      );
      const nowIso = new Date().toISOString();

      if (existed) {
        existed.amountTotal = Number(amountTotal.toFixed(2));
        existed.overLimitMode = overLimitMode;
        existed.updatedAt = nowIso;
      } else {
        data.budgets.push({
          id: Date.now() + Math.floor(Math.random() * 1000),
          userId: resolved.user.id,
          cycleType,
          cycleKey,
          amountTotal: Number(amountTotal.toFixed(2)),
          overLimitMode,
          createdAt: nowIso,
          updatedAt: nowIso,
        });
      }

      await saveQbjData(data);
      ok(res, buildBudgetView(data, resolved.user.id, cycleType));
    }),
  );

  app.post(
    "/api/v1/records",
    asyncHandler(async (req, res) => {
      const matchId = Number(req.body?.matchId);
      const amount = toNumber(req.body?.amount, NaN);
      const status = toSafeText(req.body?.status || "draft", 20);
      const pickCheck = sanitizePickText(req.body?.pickContent);
      const note = toSafeText(req.body?.note, 500);

      if (!Number.isInteger(matchId) || matchId <= 0) {
        return fail(res, 400, 40001, "matchId 非法");
      }
      if (!Number.isInteger(amount) || amount <= 0) {
        return fail(res, 400, 40001, "amount 必须为正整数");
      }
      if (!VALID_RECORD_STATUS.has(status) || status === "settled") {
        return fail(res, 400, 40001, "status 仅支持 draft 或 submitted");
      }
      if (!pickCheck.ok || !pickCheck.value) {
        return fail(res, 400, 40001, `pickContent 包含敏感词: ${pickCheck.word || ""}`);
      }

      const data = await getQbjData();
      const resolved = requireUser(req, res, data);
      if (!resolved) return;

      const match = findMatchOrNull(data, matchId);
      if (!match) {
        return fail(res, 404, 40401, "赛事不存在");
      }

      if (status === "submitted" && !isBeforeLock(match)) {
        return fail(res, 409, 40901, "已过锁单时间，不能提交");
      }

      let budgetWarnings = [];
      if (status === "submitted") {
        const budgetCheck = checkBudgetOnSubmit(data, resolved.user.id, amount);
        if (!budgetCheck.ok) {
          return fail(res, 409, budgetCheck.code, budgetCheck.message, budgetCheck.details);
        }
        budgetWarnings = budgetCheck.warnings || [];
      }

      const nowIso = new Date().toISOString();
      const record = {
        id: nextId(data, "record"),
        userId: resolved.user.id,
        matchId: match.id,
        weekKey: getIsoWeekKey(match.startTime),
        pickContent: pickCheck.value,
        amount,
        status,
        result: "pending",
        returnAmount: 0,
        profitLoss: 0,
        note,
        submittedAt: status === "submitted" ? nowIso : null,
        settledAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      data.records.unshift(record);
      await saveQbjData(data);

      ok(res, {
        record: buildRecordView(record),
        budgetWarnings,
      });
    }),
  );

  app.post(
    "/api/v1/records/:recordId/submit",
    asyncHandler(async (req, res) => {
      const data = await getQbjData();
      const resolved = requireUser(req, res, data);
      if (!resolved) return;

      const record = getRecordByIdOrNull(data, req.params.recordId);
      if (!record || record.userId !== resolved.user.id) {
        return fail(res, 404, 40401, "记录不存在");
      }
      if (record.status !== "draft") {
        return fail(res, 409, 40901, "仅 draft 记录可提交");
      }

      const match = findMatchOrNull(data, record.matchId);
      if (!match) {
        return fail(res, 404, 40401, "赛事不存在");
      }
      if (!isBeforeLock(match)) {
        return fail(res, 409, 40901, "已过锁单时间，不能提交");
      }

      const budgetCheck = checkBudgetOnSubmit(data, resolved.user.id, record.amount, {
        excludeRecordId: record.id,
      });
      if (!budgetCheck.ok) {
        return fail(res, 409, budgetCheck.code, budgetCheck.message, budgetCheck.details);
      }

      record.status = "submitted";
      record.submittedAt = new Date().toISOString();
      record.updatedAt = new Date().toISOString();
      await saveQbjData(data);

      ok(res, {
        record: buildRecordView(record),
        budgetWarnings: budgetCheck.warnings || [],
      });
    }),
  );

  app.patch(
    "/api/v1/records/:recordId",
    asyncHandler(async (req, res) => {
      const data = await getQbjData();
      const resolved = requireUser(req, res, data);
      if (!resolved) return;

      const record = getRecordByIdOrNull(data, req.params.recordId);
      if (!record || record.userId !== resolved.user.id) {
        return fail(res, 404, 40401, "记录不存在");
      }
      if (record.status === "settled") {
        return fail(res, 409, 40901, "已结算记录不可修改");
      }

      const match = findMatchOrNull(data, record.matchId);
      if (!match) {
        return fail(res, 404, 40401, "赛事不存在");
      }
      if (record.status === "submitted" && !isBeforeLock(match)) {
        return fail(res, 409, 40901, "已过锁单时间，不能修改");
      }

      const nextAmountRaw = req.body?.amount;
      const nextPickRaw = req.body?.pickContent;
      const nextNoteRaw = req.body?.note;

      if (nextPickRaw !== undefined) {
        const pickCheck = sanitizePickText(nextPickRaw);
        if (!pickCheck.ok || !pickCheck.value) {
          return fail(res, 400, 40001, `pickContent 包含敏感词: ${pickCheck.word || ""}`);
        }
        record.pickContent = pickCheck.value;
      }

      if (nextNoteRaw !== undefined) {
        record.note = toSafeText(nextNoteRaw, 500);
      }

      let budgetWarnings = [];
      if (nextAmountRaw !== undefined) {
        const nextAmount = toNumber(nextAmountRaw, NaN);
        if (!Number.isInteger(nextAmount) || nextAmount <= 0) {
          return fail(res, 400, 40001, "amount 必须为正整数");
        }

        if (record.status === "submitted") {
          const budgetCheck = checkBudgetOnSubmit(data, resolved.user.id, nextAmount, {
            excludeRecordId: record.id,
          });
          if (!budgetCheck.ok) {
            return fail(
              res,
              409,
              budgetCheck.code,
              budgetCheck.message,
              budgetCheck.details,
            );
          }
          budgetWarnings = budgetCheck.warnings || [];
        }

        record.amount = nextAmount;
      }

      record.updatedAt = new Date().toISOString();
      await saveQbjData(data);

      ok(res, {
        record: buildRecordView(record),
        budgetWarnings,
      });
    }),
  );

  app.delete(
    "/api/v1/records/:recordId",
    asyncHandler(async (req, res) => {
      const data = await getQbjData();
      const resolved = requireUser(req, res, data);
      if (!resolved) return;

      const record = getRecordByIdOrNull(data, req.params.recordId);
      if (!record || record.userId !== resolved.user.id) {
        return fail(res, 404, 40401, "记录不存在");
      }
      if (record.status !== "draft") {
        return fail(res, 409, 40901, "仅 draft 记录可删除");
      }

      data.records = (data.records || []).filter((item) => item.id !== record.id);
      await saveQbjData(data);

      ok(res, { deleted: true, recordId: record.id });
    }),
  );

  app.get(
    "/api/v1/records",
    asyncHandler(async (req, res) => {
      const data = await getQbjData();
      const resolved = requireUser(req, res, data);
      if (!resolved) return;

      const weekKey = toSafeText(req.query.weekKey, 16);
      const status = toSafeText(req.query.status, 20);
      const { page, pageSize } = parsePagination(req);

      let list = (data.records || []).filter((item) => item.userId === resolved.user.id);
      if (weekKey) {
        list = list.filter((item) => item.weekKey === weekKey);
      }
      if (status) {
        if (!VALID_RECORD_STATUS.has(status)) {
          return fail(res, 400, 40001, "status 非法");
        }
        list = list.filter((item) => item.status === status);
      }

      list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const paged = paginate(list, page, pageSize);
      ok(res, {
        list: paged.list.map((item) => ({
          ...buildRecordView(item),
          match: enrichMatchBrief(data, item),
        })),
        page,
        pageSize,
        total: paged.total,
      });
    }),
  );

  app.post(
    "/api/v1/records/:recordId/settle",
    asyncHandler(async (req, res) => {
      const result = toSafeText(req.body?.result, 20);
      const returnAmount = toNumber(req.body?.returnAmount, NaN);

      if (!VALID_SETTLE_RESULT.has(result)) {
        return fail(res, 400, 40001, "result 非法");
      }
      if (!(returnAmount >= 0)) {
        return fail(res, 400, 40001, "returnAmount 必须 >= 0");
      }

      const data = await getQbjData();
      const resolved = requireUser(req, res, data);
      if (!resolved) return;

      const record = getRecordByIdOrNull(data, req.params.recordId);
      if (!record || record.userId !== resolved.user.id) {
        return fail(res, 404, 40401, "记录不存在");
      }
      if (record.status !== "submitted") {
        return fail(res, 409, 40901, "仅 submitted 记录可结算");
      }

      record.result = result;
      record.returnAmount = Number(returnAmount.toFixed(2));
      record.profitLoss = Number((record.returnAmount - Number(record.amount)).toFixed(2));
      record.status = "settled";
      record.settledAt = new Date().toISOString();
      record.updatedAt = new Date().toISOString();

      await saveQbjData(data);
      ok(res, { record: buildRecordView(record) });
    }),
  );

  app.post(
    "/api/v1/reviews/weekly/generate",
    asyncHandler(async (req, res) => {
      const weekKey = toSafeText(req.body?.weekKey, 16);
      if (!weekKey || !/^\d{4}-W\d{2}$/.test(weekKey)) {
        return fail(res, 400, 40001, "weekKey 非法，格式应为 YYYY-Wxx");
      }

      const data = await getQbjData();
      const resolved = requireUser(req, res, data);
      if (!resolved) return;

      const summary = computeWeeklySummary(data, resolved.user.id, weekKey);
      const nowIso = new Date().toISOString();
      const existed = (data.weeklyReviews || []).find(
        (item) => item.userId === resolved.user.id && item.weekKey === weekKey,
      );

      if (existed) {
        Object.assign(existed, summary, { updatedAt: nowIso });
      } else {
        data.weeklyReviews.push({
          id: nextId(data, "review"),
          userId: resolved.user.id,
          ...summary,
          createdAt: nowIso,
          updatedAt: nowIso,
        });
      }

      await saveQbjData(data);
      ok(res, summary);
    }),
  );

  app.get(
    "/api/v1/reviews/weekly",
    asyncHandler(async (req, res) => {
      const weekKey = toSafeText(req.query.weekKey, 16);
      if (!weekKey || !/^\d{4}-W\d{2}$/.test(weekKey)) {
        return fail(res, 400, 40001, "weekKey 非法，格式应为 YYYY-Wxx");
      }

      const data = await getQbjData();
      const resolved = requireUser(req, res, data);
      if (!resolved) return;

      const existed = (data.weeklyReviews || []).find(
        (item) => item.userId === resolved.user.id && item.weekKey === weekKey,
      );
      if (existed) {
        return ok(res, {
          weekKey: existed.weekKey,
          totalRecords: existed.totalRecords,
          winCount: existed.winCount,
          loseCount: existed.loseCount,
          voidCount: existed.voidCount,
          hitRate: existed.hitRate,
          netValue: existed.netValue,
          mistakeTags: existed.mistakeTags || [],
          suggestions: existed.suggestions || [],
        });
      }

      ok(res, computeWeeklySummary(data, resolved.user.id, weekKey));
    }),
  );

  app.post(
    "/api/v1/posters/weekly",
    asyncHandler(async (req, res) => {
      const weekKey = toSafeText(req.body?.weekKey, 16);
      const theme = toSafeText(req.body?.theme || "dark", 20);

      if (!weekKey || !/^\d{4}-W\d{2}$/.test(weekKey)) {
        return fail(res, 400, 40001, "weekKey 非法，格式应为 YYYY-Wxx");
      }

      const data = await getQbjData();
      const resolved = requireUser(req, res, data);
      if (!resolved) return;

      const id = nextId(data, "poster");
      const posterUrl = `/static/posters/weekly-${resolved.user.id}-${weekKey}-${id}.png`;
      data.posters.push({
        id,
        userId: resolved.user.id,
        weekKey,
        theme,
        posterUrl,
        createdAt: new Date().toISOString(),
      });
      await saveQbjData(data);

      ok(res, {
        posterUrl,
        shareTitle: "我的本周复盘（理性娱乐）",
        sharePath: `/pages/review/week?weekKey=${weekKey}`,
      });
    }),
  );
}

module.exports = {
  registerQbjRoutes,
};
