const fs = require("fs/promises");
const path = require("path");

const dataDir = path.resolve(__dirname, "..", "data");
const qbjPath = path.join(dataDir, "qbj.json");

const writeQueues = new Map();

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

function queueFileWrite(filePath, writer) {
  const prev = writeQueues.get(filePath) || Promise.resolve();
  const current = prev.then(writer, writer);
  writeQueues.set(
    filePath,
    current.finally(() => {
      if (writeQueues.get(filePath) === current) {
        writeQueues.delete(filePath);
      }
    }),
  );
  return current;
}

async function waitForPendingWrite(filePath) {
  const pending = writeQueues.get(filePath);
  if (pending) {
    await pending;
  }
}

async function atomicWriteText(filePath, text) {
  await ensureDataDir();
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  const tmpPath = path.join(
    dir,
    `.${name}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await fs.writeFile(tmpPath, text, "utf8");
  await fs.rename(tmpPath, filePath);
}

async function writeJson(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  return queueFileWrite(filePath, async () => {
    await atomicWriteText(filePath, text);
  });
}

function buildSeedMatches() {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const sample = [
    {
      sportType: "football",
      league: "英超",
      homeTeam: "Arsenal",
      awayTeam: "Chelsea",
      offsetHours: 8,
    },
    {
      sportType: "football",
      league: "西甲",
      homeTeam: "Real Madrid",
      awayTeam: "Barcelona",
      offsetHours: 12,
    },
    {
      sportType: "football",
      league: "欧冠",
      homeTeam: "Bayern",
      awayTeam: "PSG",
      offsetHours: 30,
    },
    {
      sportType: "basketball",
      league: "NBA",
      homeTeam: "Lakers",
      awayTeam: "Warriors",
      offsetHours: 6,
    },
    {
      sportType: "basketball",
      league: "CBA",
      homeTeam: "广东",
      awayTeam: "辽宁",
      offsetHours: 18,
    },
    {
      sportType: "basketball",
      league: "EuroLeague",
      homeTeam: "Olympiacos",
      awayTeam: "Fenerbahce",
      offsetHours: 36,
    },
  ];

  return sample.map((item, index) => {
    const start = new Date(now + item.offsetHours * hour);
    const lock = new Date(start.getTime() - 5 * 60 * 1000);
    return {
      id: 9001 + index,
      sportType: item.sportType,
      league: item.league,
      homeTeam: item.homeTeam,
      awayTeam: item.awayTeam,
      startTime: start.toISOString(),
      lockTime: lock.toISOString(),
      status: "not_started",
      resultSummary: "",
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
  });
}

function buildDefaultData() {
  return {
    seq: {
      user: 100,
      match: 9100,
      follow: 1,
      record: 1,
      review: 1,
      poster: 1,
    },
    users: [],
    sessions: [],
    budgets: [],
    matches: buildSeedMatches(),
    follows: [],
    records: [],
    weeklyReviews: [],
    posters: [],
  };
}

async function readJson(filePath, fallbackFactory) {
  await ensureDataDir();
  await waitForPendingWrite(filePath);

  let text = "";
  try {
    text = await fs.readFile(filePath, "utf8");
    const normalized = String(text || "").replace(/^\uFEFF/, "");
    return JSON.parse(normalized);
  } catch (error) {
    if (error.code === "ENOENT") {
      const fallback = fallbackFactory();
      await writeJson(filePath, fallback);
      return fallback;
    }

    if (error instanceof SyntaxError) {
      const fallback = fallbackFactory();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${filePath}.corrupt-${stamp}.bak`;
      try {
        if (text) {
          await fs.writeFile(backupPath, text, "utf8");
        }
      } catch {
        // ignore backup failure
      }
      await writeJson(filePath, fallback);
      return fallback;
    }

    throw error;
  }
}

function normalizeData(payload) {
  const data = payload && typeof payload === "object" ? payload : {};
  return {
    seq: {
      user: Number(data.seq?.user || 100),
      match: Number(data.seq?.match || 9100),
      follow: Number(data.seq?.follow || 1),
      record: Number(data.seq?.record || 1),
      review: Number(data.seq?.review || 1),
      poster: Number(data.seq?.poster || 1),
    },
    users: Array.isArray(data.users) ? data.users : [],
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    budgets: Array.isArray(data.budgets) ? data.budgets : [],
    matches: Array.isArray(data.matches) ? data.matches : buildSeedMatches(),
    follows: Array.isArray(data.follows) ? data.follows : [],
    records: Array.isArray(data.records) ? data.records : [],
    weeklyReviews: Array.isArray(data.weeklyReviews) ? data.weeklyReviews : [],
    posters: Array.isArray(data.posters) ? data.posters : [],
  };
}

async function getQbjData() {
  const payload = await readJson(qbjPath, buildDefaultData);
  return normalizeData(payload);
}

async function saveQbjData(payload) {
  const normalized = normalizeData(payload);
  await writeJson(qbjPath, normalized);
  return normalized;
}

function nextId(data, key) {
  const current = Number(data.seq?.[key] || 1);
  data.seq[key] = current + 1;
  return current;
}

module.exports = {
  getQbjData,
  saveQbjData,
  nextId,
};
