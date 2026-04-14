const state = {
  settings: null,
  interfaces: [],
  scenarios: [],
  runs: [],
  bugs: [],
  caseFilterMode: "all",
  interfaceGroupFilter: "all",
  batchTargetGroupId: "",
  selectedInterfaceIds: new Set(),
  latestImportGroupId: "",
  latestImportGroupName: "",
  selectedInterfaceId: "",
  selectedCaseId: "",
  selectedScenarioId: "",
  selectedScenarioStepIndex: -1,
  selectedRunId: "",
  runAuthProfileId: "__case__",
  settingsDirty: false,
  oosLoginSessionId: "",
  oosLoginTimer: null,
  oosLoginPollingBusy: false,
  aiChatMessages: [],
  bugFilterStatus: "all",
  runChatMessages: {}, // { [runId]: [{role, content, time}] }
  dashboardRunId: "",
  retestUpdates: {}, // { "interfaceId:caseId": { pass, assertionSummary, label } }
  lastVerifiedCaseKeys: new Set(),
  lastAdoptedCaseKeys: new Set(),
};

const $ = (selector) => document.querySelector(selector);
const beijingFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function showToast(message, type = "success") {
  const toast = $("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast ${type}`;
  window.setTimeout(() => {
    toast.className = "toast hidden";
  }, 2800);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBeijingTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${beijingFormatter.format(date).replace(",", "")} UTC+8`;
}

function formatDisplayValue(value) {
  if (value == null || value === "") return "-";
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "-";
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

function safeJsonParse(text, fallback) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

async function apiFetch(url, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text);
      message = parsed.message || parsed.reason || parsed.error || message;
    } catch {
      // Keep raw message.
    }
    throw new Error(message);
  }

  return response.json();
}

function showTab(tabId) {
  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === tabId);
  });
}

function syncLatestImportGroupFromSettings() {
  if (!state.latestImportGroupId) return;
  const existed = getInterfaceGroups().find(
    (item) => item.id === state.latestImportGroupId,
  );
  if (!existed) {
    state.latestImportGroupId = "";
    state.latestImportGroupName = "";
    return;
  }
  state.latestImportGroupName = String(existed.name || state.latestImportGroupId);
}

function syncImportGroupQuickActionVisibility() {
  const button = $("#run-import-group-unverified-btn");
  if (!button) return;
  if (!state.latestImportGroupId) {
    button.style.display = "none";
    button.textContent = "运行该导入分组未校对用例";
    return;
  }
  button.style.display = "inline-flex";
  button.textContent = `运行导入分组未校对用例（${state.latestImportGroupName || state.latestImportGroupId}）`;
}

function markSettingsDirty() {
  state.settingsDirty = true;
}

function setOosBrowserStatus(message) {
  const node = $("#ai-oos-browser-status");
  if (!node) return;
  node.textContent = String(message || "");
}

function stopOosLoginPolling() {
  if (state.oosLoginTimer) {
    window.clearInterval(state.oosLoginTimer);
    state.oosLoginTimer = null;
  }
  state.oosLoginPollingBusy = false;
}

function getAuthProfiles() {
  return state.settings?.authProfiles || [];
}

function getAuthProfileName(authProfileId) {
  if (!authProfileId) return "无账号";
  return (
    getAuthProfiles().find((item) => item.id === authProfileId)?.name ||
    authProfileId
  );
}

function getExecutionProfileLabel(run) {
  return run?.executionProfile?.label || "按用例账号";
}

function parseMessageIncludes(expectedValue) {
  if (Array.isArray(expectedValue)) {
    return expectedValue
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }
  return String(expectedValue || "")
    .split("||")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildAiMetaLines(aiMeta) {
  if (!aiMeta) return [];
  const lines = [];
  if (aiMeta.authMode) lines.push(`认证方式: ${aiMeta.authMode}`);
  if (aiMeta.wireApi) lines.push(`AI 协议: ${aiMeta.wireApi}`);
  if (aiMeta.endpoint) lines.push(`AI 地址: ${aiMeta.endpoint}`);
  if (aiMeta.status != null) lines.push(`AI 状态: ${aiMeta.status}`);
  if (aiMeta.reason) lines.push(`AI 详情: ${aiMeta.reason}`);
  if (Array.isArray(aiMeta.attempts) && aiMeta.attempts.length) {
    lines.push(
      `AI 尝试链路: ${aiMeta.attempts
        .map(
          (item) =>
            `${item.wireApi}${item.variant ? `/${item.variant}` : ""} ${item.status} ${item.endpoint}`,
        )
        .join(" | ")}`,
    );
  }
  if (aiMeta.planMeta?.endpoint) {
    lines.push(`AI 计划地址: ${aiMeta.planMeta.endpoint}`);
  }
  if (aiMeta.judgeMeta?.endpoint) {
    lines.push(`AI 判定地址: ${aiMeta.judgeMeta.endpoint}`);
  }
  if (aiMeta.scenarioCount != null) {
    lines.push(`AI 计划场景数: ${aiMeta.scenarioCount}`);
  }
  return lines;
}

function getResultAuthLabel(result) {
  if (result.authSource === "override_public") return "无账号";
  if (result.authSource === "override" && result.authProfileName)
    return `${result.authProfileName} (覆盖)`;
  if (result.authProfileName) return result.authProfileName;
  if (result.authProfileId) return getAuthProfileName(result.authProfileId);
  return "无账号";
}

function buildResponseText(response = {}) {
  const lines = [];
  if (response.transportError)
    lines.push(`网络错误: ${response.transportError}`);
  if (response.bodyJson != null) {
    lines.push(JSON.stringify(response.bodyJson, null, 2));
  } else if (response.bodyText) {
    lines.push(response.bodyText);
  } else if (response.httpStatus != null) {
    lines.push(`HTTP ${response.httpStatus}`);
  }
  return lines.filter(Boolean).join("\n\n") || "-";
}

function buildRetryText(retry = {}) {
  if (
    !retry.attempted ||
    !Array.isArray(retry.attempts) ||
    retry.attempts.length < 2
  )
    return "-";
  return retry.attempts
    .map((item, index) => {
      const parts = [
        `第 ${index + 1} 次`,
        `原因: ${item.reason || "-"}`,
        `请求体:\n${formatDisplayValue(item.request?.body)}`,
        `响应:\n${buildResponseText(item.response)}`,
      ];
      return parts.join("\n\n");
    })
    .join("\n\n----------------\n\n");
}

function buildResultDetailsHtml(item) {
  const requestLine = [item.method, item.url || item.path]
    .filter(Boolean)
    .join(" ");
  return `
    <div class="result-summary-text">${escapeHtml(item.assertionSummary || "")}</div>
    <details class="result-details">
      <summary>查看请求与响应详情</summary>
      <div class="result-detail-meta">${escapeHtml(requestLine || "-")}</div>
      <div class="result-detail-block">
        <div class="detail-label">请求 Headers</div>
        <pre>${escapeHtml(formatDisplayValue(item.request?.headers))}</pre>
      </div>
      <div class="result-detail-block">
        <div class="detail-label">请求参数 / Body</div>
        <pre>${escapeHtml(formatDisplayValue(item.request?.body))}</pre>
      </div>
      <div class="result-detail-block">
        <div class="detail-label">响应结果</div>
        <pre>${escapeHtml(buildResponseText(item.response))}</pre>
      </div>
      <div class="result-detail-block">
        <div class="detail-label">自动重试记录</div>
        <pre>${escapeHtml(buildRetryText(item.retry))}</pre>
      </div>
    </details>
    ${item.interfaceId && item.caseId ? `<div class="result-retest-row"><button type="button" class="secondary subtle-btn" data-retest-interface="${escapeHtml(item.interfaceId)}" data-retest-case="${escapeHtml(item.caseId)}" data-retest-case-name="${escapeHtml(item.caseName || "")}" data-retest-interface-name="${escapeHtml(item.interfaceName || "")}">重测此用例 ▾</button></div>` : ""}
  `;
}

function renderScenarioRunTable(results) {
  const tbody = $("#scenario-run-results");
  if (!tbody) return;
  tbody.innerHTML = "";

  for (const item of results || []) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(item.stepName || item.caseName || "")}</td>
      <td>${escapeHtml(item.interfaceName || item.interfaceId || "")}</td>
      <td class="${item.pass ? "status-pass" : "status-fail"}">${item.skipped ? "跳过" : item.pass ? "通过" : "失败"}</td>
      <td class="result-detail-cell">${buildResultDetailsHtml(item)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderRunTable(tbodySelector, results) {
  const tbody = $(tbodySelector);
  if (!tbody) return;
  tbody.innerHTML = "";

  for (const item of results || []) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(item.interfaceName || "")}</td>
      <td>${escapeHtml(item.caseName || "")}</td>
      <td>${escapeHtml(getResultAuthLabel(item))}</td>
      <td class="${item.pass ? "status-pass" : "status-fail"}">${item.pass ? "通过" : "失败"}</td>
      <td class="result-detail-cell">${buildResultDetailsHtml(item)}</td>
    `;
    tbody.appendChild(tr);

    // 重测结果持久化：如果此用例有重测记录，重新应用到行上
    const retestKey = `${item.interfaceId}:${item.caseId}`;
    const retestUpdate = state.retestUpdates[retestKey];
    if (retestUpdate) {
      const tds = tr.querySelectorAll("td");
      const statusTd = tds[3];
      if (statusTd) {
        statusTd.className = retestUpdate.pass ? "status-pass" : "status-fail";
        statusTd.childNodes.forEach((n) => {
          if (n.nodeType === Node.TEXT_NODE)
            n.textContent = retestUpdate.pass ? "通过" : "失败";
        });
        const badge = document.createElement("div");
        badge.className = `retest-badge ${retestUpdate.pass ? "status-pass" : "status-fail"}`;
        badge.textContent = `${retestUpdate.label}: ${retestUpdate.pass ? "通过" : "失败"}`;
        statusTd.appendChild(badge);
      }
      const summaryEl = tds[4]?.querySelector(".result-summary-text");
      if (summaryEl)
        summaryEl.textContent = `[${retestUpdate.label}] ${retestUpdate.assertionSummary || ""}`;
    }
  }

  tbody.querySelectorAll("[data-retest-interface]").forEach((button) => {
    button.onclick = () => {
      const row = button.closest(".result-retest-row");
      const existing = row.querySelector(".retest-panel");
      if (existing) {
        existing.remove();
        button.textContent = "重测此用例 ▾";
        return;
      }
      button.textContent = "重测此用例 ▴";

      const panel = document.createElement("div");
      panel.className = "retest-panel";
      panel.innerHTML = `
        <div class="retest-hint">填写业务说明后可以让 AI 先更新用例数据再重测，或直接用原数据重测。</div>
        <textarea class="retest-reason" placeholder="业务说明（可选）：例如：业务规则改了，总返佣限制改为 70/80/90，请更新用例数据" rows="2"></textarea>
        <div class="row">
          <button type="button" class="primary subtle-btn retest-update-run">AI 更新用例后重测</button>
          <button type="button" class="secondary subtle-btn retest-confirm">直接重测（原数据）</button>
        </div>
        <div class="retest-status-line muted" style="display:none"></div>
        <div class="retest-result-block" style="display:none">
          <div class="retest-result-head"></div>
          <details class="retest-response-detail">
            <summary>请求体</summary>
            <pre class="retest-request-body"></pre>
          </details>
          <details class="retest-response-detail">
            <summary>响应详情</summary>
            <pre class="retest-response-body"></pre>
          </details>
          <div class="retest-ai-reply muted" style="display:none"></div>
        </div>
      `;
      row.appendChild(panel);

      // ── AI 更新用例后重测 ──────────────────────────────
      panel.querySelector(".retest-update-run").onclick = async () => {
        const updateBtn = panel.querySelector(".retest-update-run");
        const reason = panel.querySelector(".retest-reason").value.trim();
        const statusLine = panel.querySelector(".retest-status-line");
        const resultBlock = panel.querySelector(".retest-result-block");
        const resultHead = panel.querySelector(".retest-result-head");
        const responseBody = panel.querySelector(".retest-response-body");
        const aiReplyDiv = panel.querySelector(".retest-ai-reply");

        const caseName =
          button.dataset.retestCaseName || button.dataset.retestCase;
        const interfaceName = button.dataset.retestInterfaceName || "";

        updateBtn.disabled = true;
        panel.querySelector(".retest-confirm").disabled = true;
        statusLine.style.display = "";
        statusLine.textContent = "AI 更新用例中...";
        resultBlock.style.display = "none";

        try {
          // Step 1: 让 AI 修改用例数据
          const updateMsg = `根据以下业务变更说明，更新接口"${interfaceName}"中用例"${caseName}"的请求体和期望结果。业务说明：${reason || "（无说明）"}`;
          const updateResult = await apiFetch("/api/ai/chat", {
            method: "POST",
            body: JSON.stringify({
              message: updateMsg,
              autoApply: true,
              history: [],
            }),
          });

          if (!updateResult.updated) {
            statusLine.textContent = `AI 未能更新用例：${updateResult.reply || "无回复"}，请手动在"接口与用例"Tab 修改后再重测。`;
            updateBtn.disabled = false;
            panel.querySelector(".retest-confirm").disabled = false;
            return;
          }

          statusLine.textContent = `用例已更新（${updateResult.reply?.slice(0, 60) || ""}），正在重测...`;

          // Step 2: 重新加载接口数据后运行
          await loadInterfacesOnly();

          const retestResult = await apiFetch(
            `/api/interfaces/${button.dataset.retestInterface}/cases/${button.dataset.retestCase}/run`,
            { method: "POST", body: JSON.stringify({}) },
          );

          const pass = retestResult.pass;
          resultHead.className = `retest-result-head ${pass ? "status-pass" : "status-fail"}`;
          resultHead.textContent = `${pass ? "✓ 通过" : "✗ 失败"} — ${retestResult.assertionSummary || ""}`;

          // 请求体
          const reqBodyEl = panel.querySelector(".retest-request-body");
          reqBodyEl.textContent = formatDisplayValue(
            retestResult.request?.body,
          );

          // 响应体
          const respJson = retestResult.response?.bodyJson;
          const respText = retestResult.response?.bodyText;
          const respErr = retestResult.response?.transportError;
          responseBody.textContent = respErr
            ? `网络错误: ${respErr}`
            : respJson != null
              ? JSON.stringify(respJson, null, 2)
              : respText || "-";

          resultBlock.style.display = "";
          statusLine.textContent = pass
            ? "用例已更新并通过重测，可以 dismissed 对应 bug。"
            : "用例已更新但重测仍失败，请检查用例数据是否正确。";

          // 保存重测结果到 state，防止页面重渲后丢失
          const retestKey = `${button.dataset.retestInterface}:${button.dataset.retestCase}`;
          state.retestUpdates[retestKey] = {
            pass,
            assertionSummary: retestResult.assertionSummary || "",
            label: "AI更新重测",
          };

          // 在结果行更新状态
          const tr = button.closest("tr");
          if (tr) {
            const tds = tr.querySelectorAll("td");
            const statusTd = tds[3];
            if (statusTd) {
              statusTd.className = pass ? "status-pass" : "status-fail";
              statusTd.childNodes.forEach((n) => {
                if (n.nodeType === Node.TEXT_NODE)
                  n.textContent = pass ? "通过" : "失败";
              });
              const old = statusTd.querySelector(".retest-badge");
              if (old) old.remove();
              const badge = document.createElement("div");
              badge.className = `retest-badge ${pass ? "status-pass" : "status-fail"}`;
              badge.textContent = `AI更新重测: ${pass ? "通过" : "失败"}`;
              statusTd.appendChild(badge);
            }
            const detailTd = tds[4];
            if (detailTd) {
              const summaryEl = detailTd.querySelector(".result-summary-text");
              if (summaryEl)
                summaryEl.textContent = `[AI更新重测] ${retestResult.assertionSummary || "全部断言通过"}`;
            }
          }

          // 发给 AI run-chat 更新 bug 状态
          const activeRunId = state.dashboardRunId || state.selectedRunId;
          if (activeRunId) {
            if (!state.runChatMessages[activeRunId])
              state.runChatMessages[activeRunId] = [];
            const matchingBug = state.bugs.find(
              (b) =>
                b.caseName === caseName &&
                (b.status === "open" || b.status === "confirmed"),
            );
            const bugIdLine = matchingBug
              ? `对应 bugId：${matchingBug.id}（${matchingBug.title}）`
              : "";
            const chatContent = [
              `[AI更新用例后重测] 接口：${interfaceName}，用例：${caseName}`,
              bugIdLine,
              `业务说明：${reason || "无"}`,
              `重测结果：${pass ? "通过" : "失败"} — ${retestResult.assertionSummary || ""}`,
            ]
              .filter(Boolean)
              .join("\n");

            state.runChatMessages[activeRunId].push({
              role: "user",
              content: chatContent,
              time: new Date().toISOString(),
            });
            renderRunChatLog("dashboard-run-chat-log", activeRunId);
            renderRunChatLog("selected-run-chat-log", activeRunId);

            aiReplyDiv.style.display = "";
            aiReplyDiv.textContent = "AI 分析中...";
            try {
              const history = state.runChatMessages[activeRunId]
                .slice(-10)
                .map((m) => ({ role: m.role, content: m.content }));
              const chatResult = await apiFetch("/api/ai/run-chat", {
                method: "POST",
                body: JSON.stringify({
                  runId: activeRunId,
                  message: chatContent,
                  history,
                }),
              });
              const reply = chatResult.reply || "已处理";
              state.runChatMessages[activeRunId].push({
                role: "assistant",
                content: reply,
                time: new Date().toISOString(),
              });
              renderRunChatLog("dashboard-run-chat-log", activeRunId);
              renderRunChatLog("selected-run-chat-log", activeRunId);
              aiReplyDiv.textContent = `AI：${reply}`;
              aiReplyDiv.className = "retest-ai-reply";
              if (chatResult.appliedCount > 0) {
                await loadBugsOnly();
                renderBugList();
              }
            } catch {
              aiReplyDiv.textContent = "AI 分析失败";
              aiReplyDiv.className = "retest-ai-reply muted";
            }
          }
        } catch (error) {
          statusLine.textContent = `操作失败: ${error.message}`;
        } finally {
          updateBtn.disabled = false;
          panel.querySelector(".retest-confirm").disabled = false;
        }
      };

      // ── 直接重测（原数据）──────────────────────────────
      panel.querySelector(".retest-confirm").onclick = async () => {
        const confirmBtn = panel.querySelector(".retest-confirm");
        const reason = panel.querySelector(".retest-reason").value.trim();
        const resultBlock = panel.querySelector(".retest-result-block");
        const resultHead = panel.querySelector(".retest-result-head");
        const responseBody = panel.querySelector(".retest-response-body");
        const aiReplyDiv = panel.querySelector(".retest-ai-reply");

        confirmBtn.disabled = true;
        confirmBtn.textContent = "重测中...";
        resultBlock.style.display = "none";
        aiReplyDiv.style.display = "none";

        let retestResult = null;
        try {
          retestResult = await apiFetch(
            `/api/interfaces/${button.dataset.retestInterface}/cases/${button.dataset.retestCase}/run`,
            { method: "POST", body: JSON.stringify({}) },
          );
          const pass = retestResult.pass;
          resultHead.className = `retest-result-head ${pass ? "status-pass" : "status-fail"}`;
          resultHead.textContent = `${pass ? "✓ 通过" : "✗ 失败"} — ${retestResult.assertionSummary || ""}`;

          // 请求体
          panel.querySelector(".retest-request-body").textContent =
            formatDisplayValue(retestResult.request?.body);

          // 响应体
          const respJson = retestResult.response?.bodyJson;
          const respText = retestResult.response?.bodyText;
          const respErr = retestResult.response?.transportError;
          responseBody.textContent = respErr
            ? `网络错误: ${respErr}`
            : respJson != null
              ? JSON.stringify(respJson, null, 2)
              : respText || "-";

          resultBlock.style.display = "";
          confirmBtn.textContent = "再次重测";
          confirmBtn.disabled = false;
        } catch (error) {
          resultHead.className = "retest-result-head status-fail";
          resultHead.textContent = `重测请求失败: ${error.message}`;
          responseBody.textContent = "";
          resultBlock.style.display = "";
          confirmBtn.textContent = "确认重测";
          confirmBtn.disabled = false;
          return;
        }

        // 保存重测结果到 state，防止页面重渲后丢失
        const retestKey2 = `${button.dataset.retestInterface}:${button.dataset.retestCase}`;
        state.retestUpdates[retestKey2] = {
          pass: retestResult.pass,
          assertionSummary: retestResult.assertionSummary || "",
          label: "重测",
        };

        // 重测完成后在结果行的状态列追加标记
        const tr = button.closest("tr");
        if (tr) {
          const tds = tr.querySelectorAll("td");
          const statusTd = tds[3];
          if (statusTd) {
            const old = statusTd.querySelector(".retest-badge");
            if (old) old.remove();
            const badge = document.createElement("div");
            badge.className = `retest-badge ${retestResult.pass ? "status-pass" : "status-fail"}`;
            badge.textContent = `重测: ${retestResult.pass ? "通过" : "失败"}`;
            statusTd.appendChild(badge);
          }
        }

        // 无论有没有填原因，把重测结果发给 AI 分析
        const activeRunId = state.dashboardRunId || state.selectedRunId;
        if (!activeRunId) return;
        if (!state.runChatMessages[activeRunId])
          state.runChatMessages[activeRunId] = [];

        const caseName =
          button.dataset.retestCaseName || button.dataset.retestCase;
        const interfaceName = button.dataset.retestInterfaceName || "";
        const pass = retestResult.pass;
        const respSummary = retestResult.assertionSummary || "";
        const respBody =
          retestResult.response?.bodyJson != null
            ? JSON.stringify(retestResult.response.bodyJson, null, 2)
            : retestResult.response?.bodyText ||
              retestResult.response?.transportError ||
              "";

        // 找对应 bug，把 bugId 带给 AI，让 AI 精准更新而不只是"建议"
        const matchingBug = state.bugs.find(
          (b) =>
            b.caseName === caseName &&
            (b.status === "open" || b.status === "confirmed"),
        );
        const bugIdLine = matchingBug
          ? `对应 bugId：${matchingBug.id}（${matchingBug.title}）`
          : "";

        const chatContent = [
          `[重测] 接口：${interfaceName}，用例：${caseName}`,
          bugIdLine,
          reason ? `重测原因：${reason}` : "（无原因说明，用户手动触发重测）",
          `重测结果：${pass ? "通过" : "失败"} — ${respSummary}`,
          !pass && respBody ? `响应内容：\n${respBody.slice(0, 800)}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        state.runChatMessages[activeRunId].push({
          role: "user",
          content: chatContent,
          time: new Date().toISOString(),
        });
        renderRunChatLog("dashboard-run-chat-log", activeRunId);
        renderRunChatLog("selected-run-chat-log", activeRunId);

        aiReplyDiv.style.display = "";
        aiReplyDiv.textContent = "AI 分析中...";

        try {
          const history = state.runChatMessages[activeRunId]
            .slice(-10)
            .map((m) => ({ role: m.role, content: m.content }));
          const chatResult = await apiFetch("/api/ai/run-chat", {
            method: "POST",
            body: JSON.stringify({
              runId: activeRunId,
              message: chatContent,
              history,
            }),
          });
          const reply = chatResult.reply || "AI 暂无回复";
          state.runChatMessages[activeRunId].push({
            role: "assistant",
            content: reply,
            time: new Date().toISOString(),
          });
          renderRunChatLog("dashboard-run-chat-log", activeRunId);
          renderRunChatLog("selected-run-chat-log", activeRunId);
          aiReplyDiv.textContent = `AI：${reply}`;
          aiReplyDiv.className = "retest-ai-reply";

          if (chatResult.appliedCount > 0) {
            await loadBugsOnly();
            renderBugList();
          }
        } catch {
          aiReplyDiv.textContent = "AI 分析失败，请在对话面板手动提问";
          aiReplyDiv.className = "retest-ai-reply muted";
        }
      };
    };
  });
}

function renderSummary(run) {
  const container = $("#dashboard-summary");
  if (!container) return;
  if (!run) {
    container.innerHTML = "";
    return;
  }

  const failureBreakdown = run.summary?.failureBreakdown || {};
  const extra = Object.keys(failureBreakdown).length
    ? `<div class="summary-card"><div class="muted">失败细分</div><div class="value summary-small">运输 ${failureBreakdown.transport_error || 0} / 断言 ${failureBreakdown.assertion_fail || 0} / 前置 ${failureBreakdown.precondition_fail || 0}</div></div>`
    : `<div class="summary-card"><div class="muted">执行类型</div><div class="value summary-small">${escapeHtml(run.executionMode || "-")}</div></div>`;

  container.innerHTML = `
    <div class="summary-card"><div class="muted">总数</div><div class="value">${run.summary.total}</div></div>
    <div class="summary-card"><div class="muted">通过</div><div class="value">${run.summary.passed}</div></div>
    <div class="summary-card"><div class="muted">失败</div><div class="value">${run.summary.failed}</div></div>
    ${extra}
    <div class="summary-card"><div class="muted">执行账号</div><div class="value summary-small">${escapeHtml(getExecutionProfileLabel(run))}</div></div>
  `;
}

function renderLatestRun() {
  const run = state.runs[0];
  renderSummary(run);
  const meta = $("#latest-run-meta");
  if (!meta) return;

  if (!run) {
    meta.textContent = "暂无执行记录";
    renderRunTable("#latest-run-results", []);
    return;
  }

  const scopeLabel = run.scenario?.name
    ? `场景 ${run.scenario.name}`
    : run.caseSelection === "unverified"
      ? `未校对用例校对运行 ${run.id}`
      : run.caseSelection === "failed_only"
        ? `失败项重跑 ${run.id}`
        : `记录 ${run.id}`;
  meta.textContent = `${scopeLabel} | 开始 ${formatBeijingTime(run.startedAt)} | ${getExecutionProfileLabel(run)} | 通过 ${run.summary.passed} / 失败 ${run.summary.failed}`;
  renderRunTable("#latest-run-results", run.results || []);
}

function ensureAiChatInitMessage() {
  if (state.aiChatMessages.length) return;
  state.aiChatMessages.push({
    role: "assistant",
    content:
      "我是用例编辑 AI。你可以直接说“新增/修改/删除哪个接口或用例”，我会直接修改平台数据。",
    time: new Date().toISOString(),
  });
}

function renderAiChatLog() {
  const container = $("#ai-chat-log");
  if (!container) return;
  ensureAiChatInitMessage();

  container.innerHTML = "";
  for (const item of state.aiChatMessages) {
    const node = document.createElement("div");
    const role = item.role === "user" ? "user" : "assistant";
    node.className = `ai-chat-item ${role}`;
    const meta = `${role === "user" ? "你" : "AI"} | ${formatBeijingTime(item.time)}`;
    const extra = item.meta?.endpoint
      ? `\n\n[AI Endpoint] ${item.meta.endpoint}`
      : "";
    node.innerHTML = `
      <div class="ai-chat-meta">${escapeHtml(meta)}</div>
      <div class="ai-chat-text">${escapeHtml(`${item.content || ""}${extra}`).replace(/\n/g, "<br/>")}</div>
    `;
    container.appendChild(node);
  }
  container.scrollTop = container.scrollHeight;
}

async function sendAiChatMessage() {
  const input = $("#ai-chat-input");
  const button = $("#ai-chat-send-btn");
  if (!input || !button) return;
  const message = input.value.trim();
  if (!message) return;

  state.aiChatMessages.push({
    role: "user",
    content: message,
    time: new Date().toISOString(),
  });
  renderAiChatLog();
  input.value = "";

  button.disabled = true;
  const oldText = button.textContent;
  button.textContent = "处理中...";
  try {
    await persistSettingsIfDirty();
    const autoApply = $("#ai-chat-auto-apply")?.checked !== false;
    const result = await apiFetch("/api/ai/chat", {
      method: "POST",
      body: JSON.stringify({
        message,
        autoApply,
        history: state.aiChatMessages.slice(-12).map((item) => ({
          role: item.role,
          content: item.content,
        })),
      }),
    });

    const actionLine = result.actions?.length
      ? `\n\n生成操作: ${result.actions.length}，已应用: ${result.appliedCount || 0}`
      : "";
    state.aiChatMessages.push({
      role: "assistant",
      content: `${result.reply || "已处理。"}${actionLine}`,
      time: new Date().toISOString(),
      meta: result.aiMeta || null,
    });
    renderAiChatLog();

    if (result.updated) {
      await loadInterfacesOnly();
      renderInterfaceList();
      populateInterfaceForm();
      renderCaseList();
      populateCaseForm();
      showToast("AI 已应用修改到接口/用例");
    } else {
      showToast("AI 已回复");
    }
  } catch (error) {
    state.aiChatMessages.push({
      role: "assistant",
      content: `处理失败：${error.message}`,
      time: new Date().toISOString(),
    });
    renderAiChatLog();
    showToast(`AI 对话失败: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = oldText || "发送并执行";
  }
}

function clearAiChatMessages() {
  state.aiChatMessages = [];
  renderAiChatLog();
}

async function loadBugsOnly() {
  const payload = await apiFetch("/api/bugs");
  state.bugs = payload.bugs || [];
}

function renderBugList() {
  const container = $("#bug-list-container");
  if (!container) return;

  const filtered =
    state.bugFilterStatus === "all"
      ? state.bugs
      : state.bugs.filter((b) => b.status === state.bugFilterStatus);

  const totalBugs = state.bugs.length;
  const note =
    totalBugs === 0
      ? '<div class="bug-list-note muted">AI 执行后会自动分析失败用例，判断哪些是真实 Bug（注：失败用例数 ≠ Bug 数，数据前置失败、已知限制等不计入）</div>'
      : `<div class="bug-list-note muted">共 ${totalBugs} 条 Bug（AI 从失败用例中筛选的真实问题；数据前置失败等不计入）</div>`;

  if (!filtered.length) {
    container.innerHTML =
      note +
      '<div class="list-item muted" style="margin-top:10px">暂无符合条件的 Bug</div>';
    return;
  }

  container.innerHTML = note;
  for (const bug of filtered) {
    const card = document.createElement("div");
    card.className = "card bug-card";
    card.innerHTML = `
      <div class="bug-card-head">
        <span class="severity-badge severity-${escapeHtml(bug.severity || "medium")}">${escapeHtml(bug.severity || "medium")}</span>
        <strong class="bug-title">${escapeHtml(bug.title || "")}</strong>
        <select class="bug-status-select" data-bug-id="${escapeHtml(bug.id)}">
          ${["open", "confirmed", "fixed", "dismissed"]
            .map(
              (s) =>
                `<option value="${s}" ${bug.status === s ? "selected" : ""}>${s}</option>`,
            )
            .join("")}
        </select>
        <button type="button" class="danger subtle-btn" data-delete-bug="${escapeHtml(bug.id)}">删除</button>
      </div>
      <div class="bug-location">
        <span class="bug-interface-tag">${escapeHtml(bug.method || "")} ${escapeHtml(bug.path || bug.url || bug.interfaceName || "未知接口")}</span>
        ${bug.caseName ? `<span class="bug-case-tag">${escapeHtml(bug.caseName)}</span>` : ""}
      </div>
      <div class="bug-description">${escapeHtml(bug.description || "")}</div>
      <details class="bug-evidence">
        <summary>查看请求与响应</summary>
        <div class="result-detail-block">
          <div class="detail-label">请求</div>
          <pre>${escapeHtml(formatDisplayValue(bug.request))}</pre>
        </div>
        <div class="result-detail-block">
          <div class="detail-label">响应</div>
          <pre>${escapeHtml(formatDisplayValue(bug.response))}</pre>
        </div>
      </details>
      <div class="tiny-muted">${formatBeijingTime(bug.createdAt)}</div>
    `;
    container.appendChild(card);
  }

  container.querySelectorAll(".bug-status-select").forEach((select) => {
    select.onchange = async () => {
      try {
        await apiFetch(`/api/bugs/${select.dataset.bugId}`, {
          method: "PUT",
          body: JSON.stringify({ status: select.value }),
        });
        const bug = state.bugs.find((b) => b.id === select.dataset.bugId);
        if (bug) bug.status = select.value;
        showToast("Bug 状态已更新");
        renderBugList();
      } catch (error) {
        showToast(`更新失败: ${error.message}`, "error");
      }
    };
  });

  container.querySelectorAll("[data-delete-bug]").forEach((button) => {
    button.onclick = async () => {
      if (!window.confirm("确认删除此 Bug 吗？")) return;
      try {
        await apiFetch(`/api/bugs/${button.dataset.deleteBug}`, {
          method: "DELETE",
        });
        state.bugs = state.bugs.filter(
          (b) => b.id !== button.dataset.deleteBug,
        );
        renderBugList();
        showToast("Bug 已删除");
      } catch (error) {
        showToast(`删除失败: ${error.message}`, "error");
      }
    };
  });
}

async function clearFixedBugs() {
  const toDelete = state.bugs.filter(
    (b) => b.status === "fixed" || b.status === "dismissed",
  );
  if (!toDelete.length) {
    showToast("没有可清除的 Bug", "error");
    return;
  }
  if (
    !window.confirm(`确认清除 ${toDelete.length} 条 fixed/dismissed Bug 吗？`)
  )
    return;
  try {
    await Promise.all(
      toDelete.map((b) => apiFetch(`/api/bugs/${b.id}`, { method: "DELETE" })),
    );
    state.bugs = state.bugs.filter(
      (b) => b.status !== "fixed" && b.status !== "dismissed",
    );
    renderBugList();
    showToast(`已清除 ${toDelete.length} 条 Bug`);
  } catch (error) {
    showToast(`清除失败: ${error.message}`, "error");
  }
}

function renderRunChatLog(logId, runId) {
  const container = document.getElementById(logId);
  if (!container) return;
  const messages = state.runChatMessages[runId] || [];
  container.innerHTML = "";
  for (const item of messages) {
    const node = document.createElement("div");
    const role = item.role === "user" ? "user" : "assistant";
    node.className = `ai-chat-item ${role}`;
    const meta = `${role === "user" ? "你" : "AI"} | ${formatBeijingTime(item.time)}`;
    node.innerHTML = `
      <div class="ai-chat-meta">${escapeHtml(meta)}</div>
      <div class="ai-chat-text">${escapeHtml(item.content || "").replace(/\n/g, "<br/>")}</div>
    `;
    container.appendChild(node);
  }
  container.scrollTop = container.scrollHeight;
}

async function sendRunChatMessage(inputId, logId, sendBtnId, runId) {
  const input = document.getElementById(inputId);
  const button = document.getElementById(sendBtnId);
  if (!input || !button) return;
  const message = input.value.trim();
  if (!message) return;
  if (!runId) {
    showToast("请先选择执行记录", "error");
    return;
  }
  if (!state.runChatMessages[runId]) state.runChatMessages[runId] = [];
  state.runChatMessages[runId].push({
    role: "user",
    content: message,
    time: new Date().toISOString(),
  });
  renderRunChatLog(logId, runId);
  input.value = "";
  button.disabled = true;
  const oldText = button.textContent;
  button.textContent = "处理中...";
  try {
    const history = state.runChatMessages[runId]
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }));
    const result = await apiFetch("/api/ai/run-chat", {
      method: "POST",
      body: JSON.stringify({ runId, message, history }),
    });
    const actionLine =
      result.appliedCount > 0
        ? `\n\n已更新 ${result.appliedCount} 条 Bug 状态。`
        : "";
    state.runChatMessages[runId].push({
      role: "assistant",
      content: `${result.reply || "已处理。"}${actionLine}`,
      time: new Date().toISOString(),
    });
    renderRunChatLog(logId, runId);
    if (result.appliedCount > 0) {
      await loadBugsOnly();
      renderBugList();
      showToast(`AI 已更新 ${result.appliedCount} 条 Bug 状态`);
    } else {
      showToast("AI 已回复");
    }
  } catch (error) {
    state.runChatMessages[runId].push({
      role: "assistant",
      content: `处理失败：${error.message}`,
      time: new Date().toISOString(),
    });
    renderRunChatLog(logId, runId);
    showToast(`AI 对话失败: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = oldText || "发送";
  }
}

function getSelectedInterface() {
  return (
    state.interfaces.find((item) => item.id === state.selectedInterfaceId) ||
    null
  );
}

function getSelectedCase() {
  const apiInterface = getSelectedInterface();
  const visibleCases = getVisibleCases(apiInterface);
  return visibleCases.find((item) => item.id === state.selectedCaseId) || null;
}

function getInterfaceGroups() {
  return state.settings?.interfaceGroups || [];
}

function getInterfaceGroupName(groupId) {
  if (!groupId) return "未分组";
  return getInterfaceGroups().find((item) => item.id === groupId)?.name || groupId;
}

function getVisibleInterfaces() {
  return state.interfaceGroupFilter === "all"
    ? state.interfaces
    : state.interfaces.filter((item) => String(item.groupId || "") === state.interfaceGroupFilter);
}

function renderInterfaceGroups() {
  const selectIds = ["#interface-group-filter", "#interface-group", "#import-doc-group", "#run-group-filter"];
  const groups = getInterfaceGroups();
  for (const selector of selectIds) {
    const node = $(selector);
    if (!node) continue;
    let baseOption = '<option value="">未分组</option>';
    if (selector === "#interface-group-filter") {
      baseOption = '<option value="all">全部分组</option>';
    }
    if (selector === "#run-group-filter") {
      baseOption = '<option value="">全部分组</option>';
    }
    node.innerHTML = [baseOption]
      .concat(groups.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`))
      .join("");
  }
  if ($("#interface-group-filter")) {
    $("#interface-group-filter").value = state.interfaceGroupFilter;
  }
}

function renderInterfaceGroupList() {
  const container = $("#interface-group-list");
  if (!container) return;
  const groups = getInterfaceGroups();
  container.innerHTML = groups.length
    ? groups
      .map(
        (item) => `
          <div class="list-item">
            <strong>${escapeHtml(item.name)}</strong>
            <div class="tiny-muted">id: ${escapeHtml(item.id)}</div>
            <div class="row">
              <button type="button" class="secondary subtle-btn" data-group-rename="${escapeHtml(item.id)}">重命名</button>
              <button type="button" class="danger subtle-btn" data-group-delete="${escapeHtml(item.id)}">删除</button>
            </div>
          </div>
        `,
      )
      .join("")
    : '<div class="list-item muted">暂无分组</div>';

  container.querySelectorAll("[data-group-rename]").forEach((button) => {
    button.onclick = async (event) => {
      event.stopPropagation();
      const groupId = String(button.dataset.groupRename || "").trim();
      const oldName = getInterfaceGroupName(groupId);
      const nextName = window.prompt("请输入新分组名", oldName);
      if (!nextName || !nextName.trim()) return;
      try {
        await apiFetch(`/api/interface-groups/${groupId}`, {
          method: "PUT",
          body: JSON.stringify({ name: nextName.trim() }),
        });
        await loadAll();
        showToast("分组已重命名");
      } catch (error) {
        showToast(`重命名失败: ${error.message}`, "error");
      }
    };
  });

  container.querySelectorAll("[data-group-delete]").forEach((button) => {
    button.onclick = async (event) => {
      event.stopPropagation();
      const groupId = String(button.dataset.groupDelete || "").trim();
      const groupName = getInterfaceGroupName(groupId);
      const targetGroupId = window.prompt(
        `删除分组【${groupName}】。如需迁移请输入目标分组ID；留空则迁移到未分组。`,
        "",
      );
      if (targetGroupId === null) return;
      try {
        await apiFetch(`/api/interface-groups/${groupId}`, {
          method: "DELETE",
          body: JSON.stringify({
            targetGroupId: String(targetGroupId || "").trim(),
          }),
        });
        if (state.interfaceGroupFilter === groupId) {
          state.interfaceGroupFilter = "all";
        }
        if (state.latestImportGroupId === groupId) {
          state.latestImportGroupId = "";
          state.latestImportGroupName = "";
        }
        await loadAll();
        showToast("分组已删除");
      } catch (error) {
        showToast(`删除失败: ${error.message}`, "error");
      }
    };
  });
}

function renderInterfaceList() {
  const container = $("#interface-list");
  if (!container) return;
  container.innerHTML = "";

  const visibleInterfaces = getVisibleInterfaces();
  const visibleIdSet = new Set(visibleInterfaces.map((item) => item.id));
  state.selectedInterfaceIds = new Set(
    [...state.selectedInterfaceIds].filter((id) => visibleIdSet.has(id)),
  );

  if (!visibleInterfaces.length) {
    state.selectedInterfaceId = "";
    container.innerHTML = '<div class="list-item muted">暂无接口</div>';
    renderBatchGroupControls();
    return;
  }

  if (!visibleInterfaces.some((item) => item.id === state.selectedInterfaceId)) {
    state.selectedInterfaceId = visibleInterfaces[0]?.id || "";
    state.selectedCaseId = "";
  }

  for (const item of visibleInterfaces) {
    const selected = state.selectedInterfaceIds.has(item.id);
    const row = document.createElement("div");
    row.className = `list-item ${item.id === state.selectedInterfaceId ? "active" : ""}`;
    row.innerHTML = `
      <label class="tiny-muted" style="display:flex;align-items:center;gap:6px;">
        <input type="checkbox" data-interface-select="${escapeHtml(item.id)}" ${selected ? "checked" : ""} />
        <span>批量</span>
      </label>
      <strong>${escapeHtml(item.name || "")}</strong>
      <div class="muted">${escapeHtml(item.method || "GET")} ${escapeHtml(item.path || "")}</div>
      <div class="tiny-muted">分组: ${escapeHtml(getInterfaceGroupName(item.groupId))}</div>
      <div class="tiny-muted">${(item.cases || []).length} 条用例</div>
    `;
    row.onclick = (event) => {
      if (event.target && event.target.matches('input[type="checkbox"]')) {
        return;
      }
      state.selectedInterfaceId = item.id;
      state.selectedCaseId = "";
      renderInterfaceList();
      populateInterfaceForm();
      renderCaseList();
      populateCaseForm();
    };
    container.appendChild(row);
  }

  container.querySelectorAll("[data-interface-select]").forEach((checkbox) => {
    checkbox.onchange = (event) => {
      const interfaceId = String(checkbox.dataset.interfaceSelect || "").trim();
      if (!interfaceId) return;
      if (event.target.checked) {
        state.selectedInterfaceIds.add(interfaceId);
      } else {
        state.selectedInterfaceIds.delete(interfaceId);
      }
      renderBatchGroupControls();
    };
  });

  renderBatchGroupControls();
}

function renderBatchGroupControls() {
  const select = $("#batch-target-group");
  const moveButton = $("#batch-move-group-btn");
  const clearButton = $("#batch-clear-selection-btn");
  if (!select || !moveButton || !clearButton) return;

  const groups = getInterfaceGroups();
  select.innerHTML = ['<option value="">迁移到未分组</option>']
    .concat(groups.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`))
    .join("");
  select.value = state.batchTargetGroupId || "";

  const selectedCount = state.selectedInterfaceIds.size;
  moveButton.disabled = selectedCount === 0;
  moveButton.textContent = selectedCount
    ? `批量迁移 (${selectedCount})`
    : "批量迁移";
  clearButton.disabled = selectedCount === 0;
}

function populateInterfaceForm() {
  const item = getSelectedInterface();
  $("#interface-id").value = item?.id || "";
  $("#interface-name").value = item?.name || "";
  $("#interface-method").value = item?.method || "GET";
  $("#interface-path").value = item?.path || "";
  $("#interface-group").value = item?.groupId || "";
  $("#interface-description").value = item?.description || "";
  $("#interface-headers").value = JSON.stringify(item?.headers || {}, null, 2);
  $("#interface-body").value = item?.bodyTemplate || "";
}

function renderCaseAuthOptions() {
  const select = $("#case-auth-profile");
  if (!select) return;
  select.innerHTML = '<option value="">无账号</option>';
  for (const profile of getAuthProfiles()) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    select.appendChild(option);
  }
}

function renderRunAuthOptions() {
  const select = $("#run-auth-profile");
  if (!select) return;
  select.innerHTML = [
    '<option value="__case__">按用例账号执行</option>',
    '<option value="__public__">无账号执行</option>',
  ].join("");

  for (const profile of getAuthProfiles()) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `覆盖执行: ${profile.name}`;
    select.appendChild(option);
  }

  const validValues = new Set([
    "__case__",
    "__public__",
    ...getAuthProfiles().map((item) => item.id),
  ]);
  if (!validValues.has(state.runAuthProfileId)) {
    state.runAuthProfileId = "__case__";
  }
  select.value = state.runAuthProfileId;
}

function getSelectedScenario() {
  return (
    state.scenarios.find((item) => item.id === state.selectedScenarioId) || null
  );
}

function getScenarioStepsFromEditor() {
  const steps = safeJsonParse($("#scenario-steps").value, []);
  return Array.isArray(steps) ? steps : [];
}

function syncScenarioStepsJson(steps, options = {}) {
  $("#scenario-steps").value = JSON.stringify(steps || [], null, 2);
  if (options.render !== false) {
    renderScenarioStepList();
  }
}

function resetScenarioStepBuilder() {
  [
    "#scenario-step-name",
    "#scenario-step-extract-name",
    "#scenario-step-extract-path",
    "#scenario-step-assert-path",
    "#scenario-step-assert-expected",
    "#scenario-step-body",
    "#scenario-step-path-params",
    "#scenario-step-headers",
  ].forEach((selector) => {
    const el = $(selector);
    if (el) el.value = "";
  });
  if ($("#scenario-step-interface")) $("#scenario-step-interface").value = "";
  populateScenarioStepCaseOptions();
  if ($("#scenario-step-case")) $("#scenario-step-case").value = "";
  if ($("#scenario-step-assert-type")) $("#scenario-step-assert-type").value = "exists";
}

function fillScenarioStepBuilder(step = {}) {
  $("#scenario-step-name").value = step.name || "";
  $("#scenario-step-interface").value = step.interfaceId || "";
  populateScenarioStepCaseOptions();
  $("#scenario-step-case").value = step.caseId || "";
  $("#scenario-step-path-params").value = JSON.stringify(step.request?.pathParams || {}, null, 2);
  $("#scenario-step-headers").value = JSON.stringify(step.request?.headers || {}, null, 2);
  const bodyValue = step.request && Object.prototype.hasOwnProperty.call(step.request, "body")
    ? step.request.body
    : "";
  $("#scenario-step-body").value = typeof bodyValue === "string"
    ? bodyValue
    : bodyValue == null
      ? ""
      : JSON.stringify(bodyValue, null, 2);

  const firstExtract = Array.isArray(step.extracts) ? step.extracts[0] : null;
  $("#scenario-step-extract-name").value = firstExtract?.name || "";
  $("#scenario-step-extract-path").value = firstExtract?.path || "";

  const firstAssertion = Array.isArray(step.assertions) ? step.assertions[0] : null;
  $("#scenario-step-assert-type").value = firstAssertion?.type || "exists";
  $("#scenario-step-assert-path").value = firstAssertion?.path || "";
  const expectedValue = firstAssertion && Object.prototype.hasOwnProperty.call(firstAssertion, "expected")
    ? firstAssertion.expected
    : "";
  $("#scenario-step-assert-expected").value = typeof expectedValue === "string"
    ? expectedValue
    : expectedValue == null || expectedValue === ""
      ? ""
      : JSON.stringify(expectedValue);
}

function buildScenarioStepFromBuilder() {
  const name = $("#scenario-step-name")?.value.trim();
  const interfaceId = $("#scenario-step-interface")?.value || "";
  const caseId = $("#scenario-step-case")?.value || "";
  const extractName = $("#scenario-step-extract-name")?.value.trim();
  const extractPath = $("#scenario-step-extract-path")?.value.trim();
  const assertionType = $("#scenario-step-assert-type")?.value || "exists";
  const assertionPath = $("#scenario-step-assert-path")?.value.trim();
  const assertionExpectedRaw = $("#scenario-step-assert-expected")?.value.trim();
  const requestBodyRaw = $("#scenario-step-body")?.value.trim();
  const requestPathParamsRaw = $("#scenario-step-path-params")?.value.trim();
  const requestHeadersRaw = $("#scenario-step-headers")?.value.trim();

  if (!name || !interfaceId || !caseId) {
    showToast("步骤名、接口、用例不能为空", "error");
    return null;
  }

  const step = {
    name,
    interfaceId,
    caseId,
  };

  const request = {};
  if (requestPathParamsRaw) request.pathParams = safeJsonParse(requestPathParamsRaw, {});
  if (requestHeadersRaw) request.headers = safeJsonParse(requestHeadersRaw, {});
  if (requestBodyRaw) request.body = safeJsonParse(requestBodyRaw, requestBodyRaw);
  if (Object.keys(request).length) step.request = request;

  if (extractName && extractPath) {
    step.extracts = [{ name: extractName, source: "response.bodyJson", path: extractPath }];
  }

  if (assertionPath) {
    step.assertions = [{
      type: assertionType,
      source: "response.bodyJson",
      path: assertionPath,
      expected: assertionExpectedRaw ? safeJsonParse(assertionExpectedRaw, assertionExpectedRaw) : undefined,
    }];
  }

  return step;
}

function populateScenarioForm() {
  const scenario = getSelectedScenario();
  $("#scenario-id").value = scenario?.id || "";
  $("#scenario-name").value = scenario?.name || "";
  $("#scenario-description").value = scenario?.description || "";
  $("#scenario-steps").value = JSON.stringify(scenario?.steps || [], null, 2);
  const stepInterfaceSelect = $("#scenario-step-interface");
  if (stepInterfaceSelect) {
    const options = ['<option value="">请选择接口</option>']
      .concat(state.interfaces.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} (${escapeHtml(item.method)} ${escapeHtml(item.path)})</option>`));
    stepInterfaceSelect.innerHTML = options.join("");
  }
  state.selectedScenarioStepIndex = -1;
  resetScenarioStepBuilder();
  renderScenarioStepList();
}

function populateScenarioStepCaseOptions() {
  const interfaceId = $("#scenario-step-interface")?.value || "";
  const caseSelect = $("#scenario-step-case");
  if (!caseSelect) return;
  const apiInterface = state.interfaces.find((item) => item.id === interfaceId);
  const cases = apiInterface?.cases || [];
  caseSelect.innerHTML = ['<option value="">请选择用例</option>']
    .concat(cases.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`))
    .join("");
}

function renderScenarioStepList() {
  const container = $("#scenario-step-list");
  if (!container) return;
  const steps = getScenarioStepsFromEditor();
  container.innerHTML = "";

  if (!steps.length) {
    container.innerHTML = '<div class="list-item muted">暂无步骤</div>';
    return;
  }

  steps.forEach((step, index) => {
    const apiInterface = state.interfaces.find((item) => item.id === step.interfaceId);
    const testCase = apiInterface?.cases?.find((item) => item.id === step.caseId);
    const row = document.createElement("div");
    row.className = `list-item scenario-step-item ${index === state.selectedScenarioStepIndex ? "active" : ""}`;
    row.innerHTML = `
      <div class="row-between">
        <strong>#${index + 1} ${escapeHtml(step.name || "未命名步骤")}</strong>
        <div class="row scenario-step-actions">
          <button type="button" class="secondary subtle-btn" data-step-move="up" data-step-index="${index}">上移</button>
          <button type="button" class="secondary subtle-btn" data-step-move="down" data-step-index="${index}">下移</button>
          <button type="button" class="danger subtle-btn" data-step-delete="${index}">删除</button>
        </div>
      </div>
      <div class="muted">${escapeHtml(apiInterface?.name || step.interfaceId || "未知接口")} / ${escapeHtml(testCase?.name || step.caseId || "未知用例")}</div>
      <div class="tiny-muted">提取 ${(step.extracts || []).length} 个变量 · 断言 ${(step.assertions || []).length} 条</div>
    `;
    row.onclick = (event) => {
      if (event.target.closest("button")) return;
      state.selectedScenarioStepIndex = index;
      fillScenarioStepBuilder(step);
      renderScenarioStepList();
    };
    container.appendChild(row);
  });

  container.querySelectorAll("[data-step-delete]").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      const index = Number(button.dataset.stepDelete);
      const steps = getScenarioStepsFromEditor();
      steps.splice(index, 1);
      if (state.selectedScenarioStepIndex === index) {
        state.selectedScenarioStepIndex = -1;
        resetScenarioStepBuilder();
      } else if (state.selectedScenarioStepIndex > index) {
        state.selectedScenarioStepIndex -= 1;
      }
      syncScenarioStepsJson(steps);
    };
  });

  container.querySelectorAll("[data-step-move]").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      const index = Number(button.dataset.stepIndex);
      const direction = button.dataset.stepMove;
      const nextIndex = direction === "up" ? index - 1 : index + 1;
      const steps = getScenarioStepsFromEditor();
      if (nextIndex < 0 || nextIndex >= steps.length) return;
      [steps[index], steps[nextIndex]] = [steps[nextIndex], steps[index]];
      if (state.selectedScenarioStepIndex === index) {
        state.selectedScenarioStepIndex = nextIndex;
      } else if (state.selectedScenarioStepIndex === nextIndex) {
        state.selectedScenarioStepIndex = index;
      }
      syncScenarioStepsJson(steps);
    };
  });
}

function appendScenarioStepFromBuilder() {
  const step = buildScenarioStepFromBuilder();
  if (!step) return;

  const steps = getScenarioStepsFromEditor();
  steps.push(step);
  state.selectedScenarioStepIndex = steps.length - 1;
  syncScenarioStepsJson(steps);
  fillScenarioStepBuilder(step);
  showToast("步骤已追加到场景");
}

function saveScenarioStepEdit() {
  const step = buildScenarioStepFromBuilder();
  if (!step) return;
  const steps = getScenarioStepsFromEditor();
  if (state.selectedScenarioStepIndex < 0 || state.selectedScenarioStepIndex >= steps.length) {
    showToast("请先在步骤列表选择一个步骤", "error");
    return;
  }
  steps[state.selectedScenarioStepIndex] = {
    ...steps[state.selectedScenarioStepIndex],
    ...step,
  };
  syncScenarioStepsJson(steps);
  showToast("步骤已更新");
}

function cancelScenarioStepEdit() {
  state.selectedScenarioStepIndex = -1;
  resetScenarioStepBuilder();
  renderScenarioStepList();
}

function renderScenarioList() {
  const container = $("#scenario-list");
  if (!container) return;
  container.innerHTML = "";

  if (!state.scenarios.length) {
    container.innerHTML = '<div class="list-item muted">暂无场景</div>';
    $("#scenario-run-meta").textContent = "暂无执行结果";
    renderScenarioRunTable([]);
    return;
  }

  for (const scenario of state.scenarios) {
    const row = document.createElement("div");
    row.className = `list-item ${scenario.id === state.selectedScenarioId ? "active" : ""}`;
    row.innerHTML = `
      <strong>${escapeHtml(scenario.name || "未命名场景")}</strong>
      <div class="muted">${escapeHtml(scenario.description || "-")}</div>
      <div class="tiny-muted">步骤数 ${(scenario.steps || []).length}</div>
    `;
    row.onclick = () => {
      state.selectedScenarioId = scenario.id;
      state.selectedScenarioStepIndex = -1;
      renderScenarioList();
      populateScenarioForm();
    };
    container.appendChild(row);
  }
}

async function saveScenario(event) {
  event.preventDefault();
  const payload = {
    id: $("#scenario-id").value || undefined,
    name: $("#scenario-name").value.trim(),
    description: $("#scenario-description").value.trim(),
    steps: safeJsonParse($("#scenario-steps").value, null),
  };

  if (!payload.name) {
    showToast("场景名称不能为空", "error");
    return;
  }
  if (!Array.isArray(payload.steps)) {
    showToast("步骤必须是合法 JSON 数组", "error");
    return;
  }

  if (payload.id) {
    await apiFetch(`/api/scenarios/${payload.id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    showToast("场景已更新");
  } else {
    await apiFetch("/api/scenarios", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    showToast("场景已创建");
  }

  await loadScenariosOnly();
  if (!payload.id) {
    state.selectedScenarioId = state.scenarios[0]?.id || "";
  }
  renderScenarioList();
  populateScenarioForm();
}

async function deleteSelectedScenario() {
  const scenario = getSelectedScenario();
  if (!scenario) {
    showToast("请先选择场景", "error");
    return;
  }
  await apiFetch(`/api/scenarios/${scenario.id}`, { method: "DELETE" });
  state.selectedScenarioId = "";
  await loadScenariosOnly();
  renderScenarioList();
  populateScenarioForm();
  showToast("场景已删除");
}

async function runSelectedScenario() {
  const scenario = getSelectedScenario();
  if (!scenario) {
    showToast("请先选择场景", "error");
    return;
  }
  const result = await apiFetch(`/api/scenarios/${scenario.id}/run`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  $("#scenario-run-meta").textContent = `场景 ${result.scenario?.name || result.scenarioName} | 开始 ${formatBeijingTime(result.startedAt)} | 通过 ${result.summary.passed} / 失败 ${result.summary.failed}`;
  renderScenarioRunTable(result.results || []);
  await loadRunsOnly();
  renderLatestRun();
  renderRunList();
  showToast(`场景执行完成: 通过 ${result.summary.passed} / 失败 ${result.summary.failed}`);
}

function getVisibleCases(apiInterface) {
  const sourceCases = apiInterface?.cases || [];
  return state.caseFilterMode === "unverified"
    ? sourceCases.filter((item) => isCaseUnverified(item))
    : sourceCases;
}

function renderCaseList() {
  const container = $("#case-list");
  if (!container) return;
  container.innerHTML = "";
  const apiInterface = getSelectedInterface();
  if (!apiInterface) {
    container.innerHTML = '<div class="list-item muted">请先选择接口</div>';
    return;
  }

  const cases = getVisibleCases(apiInterface);
  if (!cases.length) {
    container.innerHTML = state.caseFilterMode === "unverified"
      ? '<div class="list-item muted">暂无未校对用例</div>'
      : '<div class="list-item muted">暂无用例</div>';
    return;
  }

  if (state.selectedCaseId && !cases.some((item) => item.id === state.selectedCaseId)) {
    state.selectedCaseId = cases[0]?.id || "";
  }

  for (const item of cases) {
    const row = document.createElement("div");
    const caseKey = `${apiInterface.id}:${item.id}`;
    const verifiedHighlight = state.lastVerifiedCaseKeys.has(caseKey);
    const adoptedHighlight = state.lastAdoptedCaseKeys.has(caseKey);
    row.className = `list-item ${item.id === state.selectedCaseId ? "active" : ""} ${verifiedHighlight ? "verified-highlight" : ""} ${adoptedHighlight ? "adopted-highlight" : ""}`;
    row.innerHTML = `
      <strong>${escapeHtml(item.name || "")}</strong>
      <div class="muted">${escapeHtml(item.description || "")}</div>
      <div class="tiny-muted">账号: ${escapeHtml(getAuthProfileName(item.authProfileId))}</div>
      <div class="tiny-muted">${escapeHtml(getBusinessCodeStatusText(item))}</div>
      ${verifiedHighlight ? '<div class="tiny-muted status-pass">✓ 刚完成校对</div>' : ""}
      ${adoptedHighlight ? '<div class="tiny-muted status-pass">✓ 刚采纳失败结果</div>' : ""}
    `;
    row.onclick = () => {
      state.selectedCaseId = item.id;
      renderCaseList();
      populateCaseForm();
    };
    container.appendChild(row);
  }
}

function isCaseUnverified(item) {
  return item?.expectedMeta?.businessCodeVerified !== true;
}

function getBusinessCodeStatusText(item) {
  const source = String(item?.expectedMeta?.businessCodeSource || "manual");
  const verified = Boolean(item?.expectedMeta?.businessCodeVerified);
  const hasCode = item?.expected?.businessCode != null && String(item?.expected?.businessCode).trim() !== "";
  if (!hasCode) {
    return "业务码：未设置（建议先执行一次再回填）";
  }
  if (verified && source === "actual_run") {
    return "业务码来源：已由真实运行结果校对";
  }
  if (source === "ai_guess") {
    return "业务码来源：AI 猜测值，建议先执行再回填";
  }
  if (source === "unset") {
    return "业务码：未校对";
  }
  return "业务码来源：手工设置";
}

function populateCaseForm() {
  const item = getSelectedCase();
  $("#case-id").value = item?.id || "";
  $("#case-name").value = item?.name || "";
  $("#case-description").value = item?.description || "";
  $("#case-auth-profile").value = item?.authProfileId || "";
  $("#case-path-params").value = JSON.stringify(
    item?.pathParams || {},
    null,
    2,
  );
  $("#case-headers").value = JSON.stringify(item?.headers || {}, null, 2);
  $("#case-body").value = item?.body || "";
  $("#expected-business-code").value = item?.expected?.businessCode ?? "";
  $("#expected-business-code-status").textContent = getBusinessCodeStatusText(item);
  $("#expected-message").value = parseMessageIncludes(
    item?.expected?.messageIncludes,
  ).join("||");
}

function normalizeAiSettings(ai = {}) {
  const authMode =
    String(ai.authMode || "api_key")
      .trim()
      .toLowerCase() === "oos"
      ? "oos"
      : "api_key";
  return {
    enabled: Boolean(ai.enabled),
    autoAnalyzeOnRun: Boolean(ai.autoAnalyzeOnRun),
    url: String(ai.url || ""),
    apiKey: String(ai.apiKey || ""),
    oosToken: String(ai.oosToken || ""),
    oosCookie: String(ai.oosCookie || ""),
    oosUserAgent: String(ai.oosUserAgent || ""),
    oosBrowserSessionId: String(ai.oosBrowserSessionId || ""),
    model: String(ai.model || ""),
    wireApi: String(ai.wireApi || ""),
    globalInstruction: String(ai.globalInstruction || ""),
    unverifiedRunFillMode: ["confirm", "always", "manual"].includes(
      String(ai.unverifiedRunFillMode || "").trim(),
    )
      ? String(ai.unverifiedRunFillMode || "").trim()
      : "confirm",
    authMode,
  };
}

function syncAiAuthModeUI() {
  const mode = $("#ai-auth-mode").value;
  const apiKeyWrap = $("#ai-api-key-wrap");
  const oosTokenWrap = $("#ai-oos-token-wrap");
  const oosCookieWrap = $("#ai-oos-cookie-wrap");
  const oosUserAgentWrap = $("#ai-oos-user-agent-wrap");
  const oosVerifyRow = $("#ai-oos-verify-row");
  const oosStatus = $("#ai-oos-browser-status");
  const aiUrl = $("#ai-url");

  if (mode === "oos") {
    apiKeyWrap.style.display = "none";
    oosTokenWrap.style.display = "";
    oosCookieWrap.style.display = "";
    oosUserAgentWrap.style.display = "";
    oosVerifyRow.style.display = "";
    oosStatus.style.display = "";
    const current = aiUrl.value.trim();
    if (
      !current ||
      (!/^https?:\/\/([^/]+\.)?chatgpt\.com(\/|$)/i.test(current) &&
        !/\/backend-api(\/|$)/i.test(current))
    ) {
      aiUrl.value = "https://chatgpt.com";
    }
    aiUrl.placeholder = "https://chatgpt.com";
  } else {
    stopOosLoginPolling();
    apiKeyWrap.style.display = "";
    oosTokenWrap.style.display = "none";
    oosCookieWrap.style.display = "none";
    oosUserAgentWrap.style.display = "none";
    oosVerifyRow.style.display = "none";
    oosStatus.style.display = "none";
    if (!aiUrl.value.trim()) {
      aiUrl.placeholder = "https://api.openai.com/v1";
    }
  }
}

function renderSettings() {
  if (!state.settings) return;

  state.settings.executionMode =
    state.settings.executionMode === "case_runner" ? "case_runner" : "ai_agent";
  $("#settings-base-url").value = state.settings.baseUrl || "";
  $("#settings-execution-mode").value =
    state.settings.executionMode || "ai_agent";
  const ai = normalizeAiSettings(state.settings.ai || {});
  state.settings.ai = { ...(state.settings.ai || {}), ...ai };

  $("#ai-enabled").checked = ai.enabled;
  $("#ai-auto-run").checked = ai.autoAnalyzeOnRun;
  $("#ai-url").value = ai.url;
  $("#ai-auth-mode").value = ai.authMode;
  $("#ai-api-key").value = ai.apiKey;
  $("#ai-oos-token").value = ai.oosToken;
  $("#ai-oos-cookie").value = ai.oosCookie;
  $("#ai-oos-user-agent").value = ai.oosUserAgent;
  $("#ai-model").value = ai.model;
  $("#ai-global-instruction").value = ai.globalInstruction;
  $("#unverified-run-fill-mode").value = ai.unverifiedRunFillMode;
  syncAiAuthModeUI();

  const container = $("#auth-profile-list");
  container.innerHTML = "";
  const profiles = state.settings.authProfiles || [];

  profiles.forEach((profile, index) => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <label>账号名称<input data-auth-index="${index}" data-field="name" value="${escapeHtml(profile.name || "")}" /></label>
      <label>账号 ID<input data-auth-index="${index}" data-field="id" value="${escapeHtml(profile.id || "")}" /></label>
      <label>类型
        <select data-auth-index="${index}" data-field="type">
          <option value="bearer" ${profile.type === "bearer" ? "selected" : ""}>Bearer</option>
        </select>
      </label>
      <label>Token<input data-auth-index="${index}" data-field="token" value="${escapeHtml(profile.token || "")}" /></label>
      <button type="button" class="danger" data-delete-auth="${index}">删除账号</button>
    `;
    container.appendChild(card);
  });

  container.querySelectorAll("[data-delete-auth]").forEach((button) => {
    button.onclick = () => {
      const index = Number(button.dataset.deleteAuth);
      state.settings.authProfiles.splice(index, 1);
      markSettingsDirty();
      renderSettings();
      renderCaseAuthOptions();
      renderRunAuthOptions();
    };
  });

  container.querySelectorAll("[data-auth-index]").forEach((input) => {
    input.oninput = () => {
      const index = Number(input.dataset.authIndex);
      const field = input.dataset.field;
      state.settings.authProfiles[index][field] = input.value;
      markSettingsDirty();
      renderCaseAuthOptions();
      renderRunAuthOptions();
    };
    input.onchange = input.oninput;
  });
}

function clearSelectedRunDetail() {
  $("#selected-run-meta").textContent = "暂无选中记录";
  renderRunTable("#selected-run-results", []);
  $("#selected-run-ai-report").textContent = "暂无 AI 分析";
}

async function loadRunDetail(runId) {
  const run = await apiFetch(`/api/runs/${runId}`);
  const scopeLabel = run.scenario?.name
    ? `场景 ${run.scenario.name}`
    : run.caseSelection === "unverified"
      ? `未校对用例校对运行 ${run.id}`
      : run.caseSelection === "failed_only"
        ? `失败项重跑 ${run.id}`
        : `记录 ${run.id}`;
  $("#selected-run-meta").textContent =
    `${scopeLabel} | 开始 ${formatBeijingTime(run.startedAt)} | ${getExecutionProfileLabel(run)} | 通过 ${run.summary.passed} / 失败 ${run.summary.failed}`;
  renderRunTable("#selected-run-results", run.results || []);
  $("#selected-run-ai-report").textContent = run.aiReport || "暂无 AI 分析";

  const selectedRunChat = $("#selected-run-chat");
  if (selectedRunChat) {
    selectedRunChat.style.display = "";
    renderRunChatLog("selected-run-chat-log", runId);
  }
}

async function deleteRun(runId) {
  const index = state.runs.findIndex((item) => item.id === runId);
  if (index === -1) {
    showToast("记录不存在", "error");
    return;
  }
  if (!window.confirm("确认删除这条执行记录吗？")) return;

  await apiFetch(`/api/runs/${runId}`, { method: "DELETE" });
  state.runs = state.runs.filter((item) => item.id !== runId);

  if (state.selectedRunId === runId) {
    const fallback =
      state.runs[index] || state.runs[index - 1] || state.runs[0] || null;
    state.selectedRunId = fallback?.id || "";
  }

  renderRunList();
  renderLatestRun();
  if (state.selectedRunId) {
    await loadRunDetail(state.selectedRunId);
  } else {
    clearSelectedRunDetail();
  }
  showToast("执行记录已删除");
}

function renderRunList() {
  const container = $("#run-list");
  if (!container) return;
  container.innerHTML = "";

  if (!state.runs.length) {
    container.innerHTML = '<div class="list-item muted">暂无执行记录</div>';
    return;
  }

  for (const run of state.runs) {
    const row = document.createElement("div");
    row.className = `list-item ${run.id === state.selectedRunId ? "active" : ""}`;
    row.innerHTML = `
      <div class="run-list-head">
        <strong>${escapeHtml(run.id.slice(0, 8))}</strong>
        <button type="button" class="danger subtle-btn" data-delete-run="${run.id}">删除</button>
      </div>
      <div class="muted">${formatBeijingTime(run.startedAt)}</div>
      <div class="tiny-muted">${escapeHtml(getExecutionProfileLabel(run))}</div>
      <div class="tiny-muted">${escapeHtml(run.scenario?.name ? `场景 / ${run.scenario.name}` : run.groupName ? `分组 / ${run.groupName}` : run.caseSelection === "failed_only" ? "失败项重跑" : run.executionMode || "")}</div>
      <div>通过 ${run.summary.passed} / 失败 ${run.summary.failed}</div>
    `;
    row.onclick = async () => {
      state.selectedRunId = run.id;
      renderRunList();
      await loadRunDetail(run.id);
    };
    container.appendChild(row);
  }

  container.querySelectorAll("[data-delete-run]").forEach((button) => {
    button.onclick = async (event) => {
      event.stopPropagation();
      try {
        await deleteRun(button.dataset.deleteRun);
      } catch (error) {
        showToast(`删除失败: ${error.message}`, "error");
      }
    };
  });
}

async function loadSettingsOnly() {
  state.settings = await apiFetch("/api/settings");
}

async function loadInterfacesOnly() {
  const payload = await apiFetch("/api/interfaces");
  state.interfaces = payload.interfaces || [];
  if (
    !state.selectedInterfaceId ||
    !state.interfaces.some((item) => item.id === state.selectedInterfaceId)
  ) {
    state.selectedInterfaceId = state.interfaces[0]?.id || "";
    state.selectedCaseId = "";
  }
}

async function loadScenariosOnly() {
  const payload = await apiFetch("/api/scenarios");
  state.scenarios = payload.scenarios || [];
  if (
    !state.selectedScenarioId ||
    !state.scenarios.some((item) => item.id === state.selectedScenarioId)
  ) {
    state.selectedScenarioId = state.scenarios[0]?.id || "";
  }
}

async function loadRunsOnly() {
  const payload = await apiFetch("/api/runs");
  state.runs = payload.runs || [];
  if (
    !state.selectedRunId ||
    !state.runs.some((item) => item.id === state.selectedRunId)
  ) {
    state.selectedRunId = state.runs[0]?.id || "";
  }
}

async function loadAll() {
  await Promise.all([
    loadSettingsOnly(),
    loadInterfacesOnly(),
    loadScenariosOnly(),
    loadRunsOnly(),
    loadBugsOnly(),
  ]);

  syncLatestImportGroupFromSettings();
  renderLatestRun();
  renderInterfaceGroups();
  renderInterfaceGroupList();
  renderInterfaceList();
  renderBatchGroupControls();
  populateInterfaceForm();
  renderCaseAuthOptions();
  renderRunAuthOptions();
  const runGroupFilter = $("#run-group-filter");
  if (runGroupFilter) {
    const hasLatestImportGroup =
      state.latestImportGroupId &&
      Array.from(runGroupFilter.options || []).some(
        (option) => option.value === state.latestImportGroupId,
      );
    runGroupFilter.value = hasLatestImportGroup
      ? state.latestImportGroupId
      : runGroupFilter.value || "";
  }
  syncImportGroupQuickActionVisibility();
  const caseFilterMode = $("#case-filter-mode");
  if (caseFilterMode) {
    caseFilterMode.value = state.caseFilterMode;
  }
  renderCaseList();
  populateCaseForm();
  renderScenarioList();
  populateScenarioForm();
  renderSettings();
  renderRunList();
  renderAiChatLog();
  renderBugList();

  if (state.selectedRunId) {
    await loadRunDetail(state.selectedRunId);
  } else {
    clearSelectedRunDetail();
  }
}

async function persistSettingsIfDirty() {
  if (!state.settingsDirty) return;
  await saveSettings();
}

async function refreshTabData(tabId) {
  if (tabId !== "settings") {
    await persistSettingsIfDirty();
  }

  if (tabId === "dashboard") {
    await Promise.all([loadRunsOnly(), loadSettingsOnly()]);
    renderRunAuthOptions();
    renderLatestRun();
    return;
  }

  if (tabId === "interfaces") {
    await Promise.all([loadInterfacesOnly(), loadSettingsOnly()]);
    renderInterfaceGroups();
    renderInterfaceGroupList();
    renderInterfaceList();
    renderBatchGroupControls();
    populateInterfaceForm();
    renderCaseAuthOptions();
    renderRunAuthOptions();
    const caseFilterMode = $("#case-filter-mode");
    if (caseFilterMode) {
      caseFilterMode.value = state.caseFilterMode;
    }
    renderCaseList();
    populateCaseForm();
    return;
  }

  if (tabId === "scenarios") {
    await Promise.all([loadScenariosOnly(), loadInterfacesOnly()]);
    renderScenarioList();
    populateScenarioForm();
    return;
  }

  if (tabId === "settings") {
    await loadSettingsOnly();
    renderSettings();
    renderCaseAuthOptions();
    renderRunAuthOptions();
    return;
  }

  if (tabId === "runs") {
    await loadRunsOnly();
    renderRunList();
    if (state.selectedRunId) {
      await loadRunDetail(state.selectedRunId);
    } else {
      clearSelectedRunDetail();
    }
    return;
  }

  if (tabId === "ai-chat") {
    await Promise.all([loadSettingsOnly(), loadInterfacesOnly()]);
    renderAiChatLog();
    return;
  }

  if (tabId === "bugs") {
    await loadBugsOnly();
    renderBugList();
  }
}

async function saveInterface(event) {
  event.preventDefault();
  const payload = {
    id: $("#interface-id").value || undefined,
    name: $("#interface-name").value.trim(),
    method: $("#interface-method").value,
    path: $("#interface-path").value.trim(),
    groupId: $("#interface-group").value || "",
    description: $("#interface-description").value,
    headers: safeJsonParse($("#interface-headers").value, {}),
    bodyTemplate: $("#interface-body").value,
  };

  if (!payload.name || !payload.path) {
    showToast("接口名称和路径不能为空", "error");
    return;
  }

  if (payload.id) {
    await apiFetch(`/api/interfaces/${payload.id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    showToast("接口已更新");
  } else {
    await apiFetch("/api/interfaces", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    showToast("接口已创建");
  }

  await loadAll();
}

async function deleteSelectedInterface() {
  const apiInterface = getSelectedInterface();
  if (!apiInterface) {
    showToast("请先选择接口", "error");
    return;
  }
  await apiFetch(`/api/interfaces/${apiInterface.id}`, { method: "DELETE" });
  state.selectedInterfaceId = "";
  state.selectedCaseId = "";
  await loadAll();
  showToast("接口已删除");
}

async function saveCase(event) {
  event.preventDefault();
  const apiInterface = getSelectedInterface();
  if (!apiInterface) {
    showToast("请先选择接口", "error");
    return;
  }

  const currentCase = getSelectedCase();
  const businessCodeValue = $("#expected-business-code").value.trim() || null;
  const payload = {
    id: $("#case-id").value || undefined,
    name: $("#case-name").value.trim(),
    description: $("#case-description").value,
    authProfileId: $("#case-auth-profile").value,
    pathParams: safeJsonParse($("#case-path-params").value, {}),
    headers: safeJsonParse($("#case-headers").value, {}),
    body: $("#case-body").value,
    expected: {
      businessCode: businessCodeValue,
      messageIncludes: $("#expected-message").value.trim(),
    },
    expectedMeta: {
      businessCodeSource: businessCodeValue ? "manual" : "unset",
      businessCodeVerified: false,
      businessCodeUpdatedAt:
        businessCodeValue && currentCase?.expected?.businessCode !== businessCodeValue
          ? new Date().toISOString()
          : String(currentCase?.expectedMeta?.businessCodeUpdatedAt || ""),
    },
  };

  if (!payload.name) {
    showToast("用例名称不能为空", "error");
    return;
  }

  if (payload.id) {
    await apiFetch(`/api/interfaces/${apiInterface.id}/cases/${payload.id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    showToast("用例已更新");
  } else {
    await apiFetch(`/api/interfaces/${apiInterface.id}/cases`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    showToast("用例已创建");
  }

  await loadAll();
}

async function deleteSelectedCase() {
  const apiInterface = getSelectedInterface();
  const testCase = getSelectedCase();
  if (!apiInterface || !testCase) {
    showToast("请先选择用例", "error");
    return;
  }
  await apiFetch(`/api/interfaces/${apiInterface.id}/cases/${testCase.id}`, {
    method: "DELETE",
  });
  state.selectedCaseId = "";
  await loadAll();
  showToast("用例已删除");
}

async function runCurrentCase() {
  const apiInterface = getSelectedInterface();
  const testCase = getSelectedCase();
  if (!apiInterface || !testCase) {
    showToast("请先选择用例", "error");
    return;
  }

  const result = await apiFetch(`/api/interfaces/${apiInterface.id}/cases/${testCase.id}/run`, {
    method: "POST",
    body: JSON.stringify(buildRunRequestPayload()),
  });

  const pseudoRun = {
    id: result.id,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    summary: {
      total: 1,
      passed: result.pass ? 1 : 0,
      failed: result.pass ? 0 : 1,
    },
    executionMode: "case_runner",
    caseSelection: "single_case",
    groupId: apiInterface.groupId || "",
    groupName: getInterfaceGroupName(apiInterface.groupId),
    executionProfile: {
      mode: result.authProfileId ? "override" : "case",
      authProfileId: result.authProfileId || "",
      authProfileName: getAuthProfileName(result.authProfileId || ""),
      label: result.authProfileId ? `统一使用 ${getAuthProfileName(result.authProfileId)}` : "按用例账号执行",
    },
    results: [result],
    ai: {
      enabled: false,
      analyzed: false,
      provider: "",
      meta: null,
    },
  };

  state.runs.unshift(pseudoRun);
  state.selectedRunId = pseudoRun.id;
  renderLatestRun();
  renderRunList();
  showTab("runs");
  await loadRunDetail(pseudoRun.id).catch(() => {
    $("#selected-run-meta").textContent = `当前用例执行 | 开始 ${formatBeijingTime(pseudoRun.startedAt)} | 通过 ${pseudoRun.summary.passed} / 失败 ${pseudoRun.summary.failed}`;
    renderRunTable("#selected-run-results", pseudoRun.results || []);
  });
  showToast(`当前用例执行完成: ${result.pass ? "通过" : "失败"}`);
}

function buildAiPayloadFromForm() {
  const authMode = $("#ai-auth-mode").value === "oos" ? "oos" : "api_key";
  const rawUrl = $("#ai-url").value.trim();
  const normalizedUrl =
    authMode === "oos"
      ? /^https?:\/\/([^/]+\.)?chatgpt\.com(\/|$)/i.test(rawUrl) ||
        /\/backend-api(\/|$)/i.test(rawUrl)
        ? rawUrl
        : "https://chatgpt.com"
      : rawUrl;
  return {
    ...(state.settings?.ai || {}),
    enabled: $("#ai-enabled").checked,
    autoAnalyzeOnRun: $("#ai-auto-run").checked,
    url: normalizedUrl,
    authMode,
    apiKey: $("#ai-api-key").value.trim(),
    oosToken: $("#ai-oos-token").value.trim(),
    oosCookie: $("#ai-oos-cookie").value.trim(),
    oosUserAgent: $("#ai-oos-user-agent").value.trim(),
    model: $("#ai-model").value.trim(),
    globalInstruction: $("#ai-global-instruction").value.trim(),
    unverifiedRunFillMode: $("#unverified-run-fill-mode").value,
  };
}

async function verifyOosLogin() {
  try {
    const ai = buildAiPayloadFromForm();
    ai.authMode = "oos";
    const result = await apiFetch("/api/ai/oos/verify", {
      method: "POST",
      body: JSON.stringify({ ai }),
    });
    showToast(`OOS 登录可用，HTTP ${result.status}`);
  } catch (error) {
    showToast(`OOS 校验失败: ${error.message}`, "error");
  }
}

function formatOosBrowserStatus(result) {
  return [
    `sessionId: ${result.sessionId || "-"}`,
    `model status: ${result.modelStatus ?? "-"}`,
    `session status: ${result.sessionStatus ?? "-"}`,
    `has session cookie: ${result.hasSessionCookie ? "yes" : "no"}`,
    `has cf_clearance: ${result.hasCfClearance ? "yes" : "no"}`,
    `token captured: ${result.oosToken ? "yes" : "no"}`,
    `cookie captured: ${result.oosCookie ? "yes" : "no"}`,
    "",
    String(result.modelSnippet || ""),
  ].join("\n");
}

async function pollOosBrowserLoginStatus() {
  if (state.oosLoginPollingBusy) return;
  const sessionId = String(state.oosLoginSessionId || "").trim();
  if (!sessionId) {
    stopOosLoginPolling();
    return;
  }

  state.oosLoginPollingBusy = true;
  try {
    const status = await apiFetch(
      `/api/ai/oos/browser-login/${sessionId}/status`,
      {
        method: "GET",
      },
    );
    setOosBrowserStatus(formatOosBrowserStatus(status));

    const shouldApply = Boolean(
      status.ok ||
      status.hasSessionCookie ||
      status.oosCookie ||
      status.oosToken,
    );
    if (!shouldApply) return;

    const applied = await apiFetch(
      `/api/ai/oos/browser-login/${sessionId}/apply`,
      {
        method: "POST",
        body: JSON.stringify({ close: false }),
      },
    );

    stopOosLoginPolling();
    state.oosLoginSessionId = "";
    await loadSettingsOnly();
    renderSettings();
    state.settingsDirty = false;
    setOosBrowserStatus(
      `Login applied at ${new Date().toISOString()}\n\n${formatOosBrowserStatus(applied.status || {})}`,
    );
    showToast("OOS 登录成功，已自动写入 AI 配置");
  } catch (error) {
    if (/not found/i.test(String(error.message || ""))) {
      stopOosLoginPolling();
      state.oosLoginSessionId = "";
    }
    setOosBrowserStatus(`Polling failed: ${error.message}`);
  } finally {
    state.oosLoginPollingBusy = false;
  }
}

async function startOosBrowserLogin() {
  const button = $("#ai-oos-browser-login-btn");
  button.disabled = true;
  button.textContent = "Opening...";

  try {
    const result = await apiFetch("/api/ai/oos/browser-login/start", {
      method: "POST",
      body: JSON.stringify({ headless: false }),
    });
    if (!result.sessionId) {
      throw new Error("Browser login sessionId is empty");
    }

    state.oosLoginSessionId = result.sessionId;
    setOosBrowserStatus(
      [
        result.message || "Browser login started.",
        `sessionId: ${result.sessionId}`,
        `startedAt: ${result.startedAt || "-"}`,
        "",
        "Please complete login in the opened ChatGPT window.",
        "Status will auto-refresh every 3 seconds.",
      ].join("\n"),
    );

    stopOosLoginPolling();
    state.oosLoginTimer = window.setInterval(() => {
      pollOosBrowserLoginStatus().catch(() => {});
    }, 3000);
    await pollOosBrowserLoginStatus();
    showToast("已打开 ChatGPT 登录窗口，请在浏览器完成登录");
  } catch (error) {
    setOosBrowserStatus(`Failed to start browser login: ${error.message}`);
    showToast(`浏览器登录启动失败: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = "打开 ChatGPT 登录并自动接入";
  }
}

async function saveSettings(event) {
  if (event) event.preventDefault();
  if (!state.settings) return;

  state.settings.baseUrl = $("#settings-base-url").value.trim();
  state.settings.executionMode =
    $("#settings-execution-mode").value === "ai_agent"
      ? "ai_agent"
      : "case_runner";
  state.settings.ai = buildAiPayloadFromForm();
  await apiFetch("/api/settings", {
    method: "PUT",
    body: JSON.stringify(state.settings),
  });

  state.settingsDirty = false;
  await loadAll();
  if (event) {
    showToast("设置已保存");
  }
}

function buildRunRequestPayload() {
  const payload = {};
  if (state.runAuthProfileId !== "__case__") {
    payload.authProfileId = state.runAuthProfileId;
  }
  const groupId = $("#run-group-filter")?.value || "";
  if (groupId) {
    payload.groupId = groupId;
  }
  const aiInstruction = ($("#run-ai-instruction")?.value || "").trim();
  if (aiInstruction) {
    payload.aiInstruction = aiInstruction;
  }
  const aiContext = ($("#run-ai-context")?.value || "").trim();
  if (aiContext) {
    payload.aiContext = aiContext;
  }
  return payload;
}

async function runAllCases(options = {}) {
  const onlyUnverified = options.onlyUnverified === true;
  const primaryButton = $("#run-all-btn");
  const verificationButton = $("#run-unverified-btn");
  const activeButton = onlyUnverified ? verificationButton : primaryButton;
  const idleText = onlyUnverified ? "只跑未校对用例" : "运行全部用例";

  primaryButton.disabled = true;
  verificationButton.disabled = true;
  activeButton.textContent = "执行中...";

  try {
    await persistSettingsIfDirty();
    const requestPayload = buildRunRequestPayload();
    if (onlyUnverified) {
      requestPayload.onlyUnverified = true;
    }
    const run = await apiFetch("/api/run-all", {
      method: "POST",
      body: JSON.stringify(requestPayload),
    });

    state.runs.unshift(run);
    state.selectedRunId = run.id;
    state.retestUpdates = {};
    renderLatestRun();
    renderRunList();

    if (run.ai?.analyzed) {
      const detail = await apiFetch(`/api/runs/${run.id}`);
      $("#ai-report").textContent = detail.aiReport || "暂无 AI 分析";
    } else {
      $("#ai-report").textContent = onlyUnverified
        ? "未校对用例执行完成，可直接回填业务码。"
        : "已完成执行，可点击 AI 分析。";
    }

    const scopeLabel = requestPayload.groupId
      ? `${onlyUnverified ? "未校对用例" : "分组"}执行[${getInterfaceGroupName(requestPayload.groupId)}]`
      : onlyUnverified
        ? "未校对用例"
        : "执行";
    showToast(
      `${scopeLabel}完成: 通过 ${run.summary.passed} / 失败 ${run.summary.failed}`,
    );

    if (onlyUnverified) {
      const mode = String(state.settings?.ai?.unverifiedRunFillMode || "confirm");
      let filledNow = false;
      if (mode === "always") {
        await fillBusinessCodes(run.id);
        filledNow = true;
      } else if (mode === "confirm") {
        const shouldFill = window.confirm(
          `未校对用例已执行完成（通过 ${run.summary.passed} / 失败 ${run.summary.failed}）。\n是否立即按本次结果回填业务码？`,
        );
        if (shouldFill) {
          await fillBusinessCodes(run.id);
          filledNow = true;
        }
      }

      if (filledNow) {
        state.caseFilterMode = "unverified";
        showTab("interfaces");
        await refreshTabData("interfaces");
      }
    }

    state.dashboardRunId = run.id;
    const dashRunChat = $("#dashboard-run-chat");
    if (dashRunChat) {
      dashRunChat.style.display = "";
      renderRunChatLog("dashboard-run-chat-log", run.id);
    }
    await loadBugsOnly();
    renderBugList();
  } catch (error) {
    showToast(`执行失败: ${error.message}`, "error");
  } finally {
    primaryButton.disabled = false;
    verificationButton.disabled = false;
    activeButton.textContent = idleText;
  }
}

async function analyzeLatest() {
  try {
    const latest = state.runs[0];
    if (!latest) {
      showToast("暂无可分析记录", "error");
      return;
    }
    const result = await apiFetch(`/api/runs/${latest.id}/analyze`, {
      method: "POST",
    });
    $("#ai-report").textContent = [
      result.markdown,
      ...buildAiMetaLines(result.aiMeta),
    ]
      .filter(Boolean)
      .join("\n\n");
    // 只刷新 run 列表，不重渲结果表格（避免丢失重测标记）
    await loadRunsOnly();
    renderRunList();
    showToast("AI 分析完成");
  } catch (error) {
    showToast(`AI 分析失败: ${error.message}`, "error");
  }
}

async function retestFailedCases() {
  try {
    if (!state.selectedRunId) {
      showToast("请先选择历史记录", "error");
      return;
    }
    const run = await apiFetch(`/api/runs/${state.selectedRunId}/retest-failures`, {
      method: "POST",
    });
    state.runs.unshift(run);
    state.selectedRunId = run.id;
    state.retestUpdates = {};
    renderLatestRun();
    renderRunList();
    await loadRunDetail(run.id);
    showToast(`失败项重跑完成: 通过 ${run.summary.passed} / 失败 ${run.summary.failed}`);
  } catch (error) {
    showToast(`失败项重跑失败: ${error.message}`, "error");
  }
}

async function adoptFailureResults() {
  try {
    if (!state.selectedRunId) {
      showToast("请先选择历史记录", "error");
      return;
    }
    const result = await apiFetch(`/api/runs/${state.selectedRunId}/adopt-failure-results`, {
      method: "POST",
    });
    await loadInterfacesOnly();
    setAdoptedHighlights(result.adoptedCases || []);
    showTab("interfaces");
    await refreshTabData("interfaces");
    showToast(`采纳完成：更新 ${result.updatedCount} 个，跳过 ${result.skippedCount} 个`);
  } catch (error) {
    showToast(`批量采纳失败: ${error.message}`, "error");
  }
}

async function analyzeSelectedRun() {
  try {
    if (!state.selectedRunId) {
      showToast("请先选择历史记录", "error");
      return;
    }
    const result = await apiFetch(`/api/runs/${state.selectedRunId}/analyze`, {
      method: "POST",
    });
    $("#selected-run-ai-report").textContent = [
      result.markdown,
      ...buildAiMetaLines(result.aiMeta),
    ]
      .filter(Boolean)
      .join("\n\n");
    // 只刷新 run 列表，不重渲结果表格（避免丢失重测标记）
    await loadRunsOnly();
    renderRunList();
    showToast("AI 分析完成");
  } catch (error) {
    showToast(`AI 分析失败: ${error.message}`, "error");
  }
}

function setVerifiedHighlights(items = []) {
  state.lastVerifiedCaseKeys = new Set(
    (items || []).map((item) => `${item.interfaceId}:${item.caseId}`),
  );
  window.setTimeout(() => {
    state.lastVerifiedCaseKeys = new Set();
    renderCaseList();
  }, 10000);
}

function setAdoptedHighlights(items = []) {
  state.lastAdoptedCaseKeys = new Set(
    (items || []).map((item) => `${item.interfaceId}:${item.caseId}`),
  );
  window.setTimeout(() => {
    state.lastAdoptedCaseKeys = new Set();
    renderCaseList();
  }, 10000);
}

async function fillBusinessCodes(runId = state.selectedRunId) {
  try {
    if (!runId) {
      showToast("请先选择历史记录", "error");
      return;
    }
    const result = await apiFetch(
      `/api/runs/${runId}/fill-business-codes`,
      { method: "POST" },
    );
    showToast(
      `回填完成：更新 ${result.filledCount} 个，跳过 ${result.skippedCount} 个`,
    );
    // 回填后刷新接口/用例数据，让表单显示最新业务码
    await loadInterfacesOnly();
    setVerifiedHighlights(result.verifiedCases || []);
    renderInterfaceList();
    renderCaseList();
    populateCaseForm();
  } catch (error) {
    showToast(`回填失败: ${error.message}`, "error");
  }
}

async function handleDocFileChange(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  $("#api-doc-name").value = file.name;
  const content = await file.text();
  $("#api-doc-content").value = content;
  showToast(`文档已读取: ${file.name}`);
}

async function importApiDoc(event) {
  event.preventDefault();
  const filename =
    $("#api-doc-name").value.trim() ||
    $("#api-doc-file").files?.[0]?.name ||
    "api-doc.txt";
  const content = $("#api-doc-content").value;
  if (!content.trim()) {
    showToast("请先提供文档内容", "error");
    return;
  }

  const button = $("#import-doc-btn");
  button.disabled = true;
  button.textContent = "导入中...";

  try {
    await persistSettingsIfDirty();
    const result = await apiFetch("/api/interfaces/import-doc", {
      method: "POST",
      body: JSON.stringify({
        filename,
        content,
        groupId: $("#import-doc-group")?.value || "",
      }),
    });

    const analysisBlock = result.analysis
      ? ["业务分析:", JSON.stringify(result.analysis, null, 2), ""]
      : [];

    const importGroupBlock = result.importGroup
      ? [
          "",
          "导入分组:",
          `- 分组: ${result.importGroup.groupName || result.importGroup.groupId}`,
          `- 分组ID: ${result.importGroup.groupId || "-"}`,
          `- 自动创建: ${result.importGroup.autoCreated ? "是" : "否"}`,
          "",
        ]
      : [];

    const verificationHint = [
      "",
      "【导入校对提示】",
      "- AI 导入的业务码可能是猜测值，不一定准确。",
      "- 建议先运行一次，再使用“回填业务码”按真实结果校对。",
      "- 未校对的用例会在“接口与用例”里显示提示。",
    ];

    $("#api-doc-result").textContent = [
      `提供方: ${result.provider}`,
      ...buildAiMetaLines(result.aiMeta),
      `识别接口数: ${result.recognizedInterfaces}`,
      `新增接口数: ${result.addedInterfaces}`,
      `合并接口数: ${result.mergedInterfaces}`,
      `新增用例数: ${result.addedCases}`,
      "",
      ...analysisBlock,
      ...importGroupBlock,
      ...(result.notes || []),
      ...verificationHint,
    ].join("\n");

    state.latestImportGroupId = String(result.importGroup?.groupId || "").trim();
    state.latestImportGroupName = String(
      result.importGroup?.groupName || state.latestImportGroupId || "",
    ).trim();

    await loadAll();

    if (state.latestImportGroupId) {
      state.interfaceGroupFilter = state.latestImportGroupId;
      const interfaceGroupFilter = $("#interface-group-filter");
      if (interfaceGroupFilter) {
        interfaceGroupFilter.value = state.latestImportGroupId;
      }
      const runGroupFilter = $("#run-group-filter");
      if (runGroupFilter) {
        runGroupFilter.value = state.latestImportGroupId;
      }
      showTab("interfaces");
      renderInterfaceList();
      renderBatchGroupControls();
      populateInterfaceForm();
      renderCaseList();
      populateCaseForm();
      syncImportGroupQuickActionVisibility();
    }

    showToast(
      `导入完成: 新增接口 ${result.addedInterfaces}，新增用例 ${result.addedCases}`,
    );
  } catch (error) {
    showToast(`导入失败: ${error.message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = "AI 识别接口并补全用例";
  }
}

function bindSettingsDirtyInputs() {
  const ids = [
    "#settings-base-url",
    "#settings-execution-mode",
    "#ai-enabled",
    "#ai-auto-run",
    "#ai-url",
    "#ai-auth-mode",
    "#ai-api-key",
    "#ai-oos-token",
    "#ai-oos-cookie",
    "#ai-oos-user-agent",
    "#ai-model",
    "#ai-global-instruction",
    "#unverified-run-fill-mode",
  ];

  for (const id of ids) {
    const node = $(id);
    if (!node) continue;
    node.oninput = () => {
      markSettingsDirty();
      if (id === "#ai-auth-mode") syncAiAuthModeUI();
    };
    node.onchange = node.oninput;
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.onclick = async () => {
      const tabId = button.dataset.tab;
      showTab(tabId);
      try {
        await refreshTabData(tabId);
      } catch (error) {
        showToast(`刷新 ${tabId} 失败: ${error.message}`, "error");
      }
    };
  });

  $("#interface-form").onsubmit = async (event) => {
    try {
      await saveInterface(event);
    } catch (error) {
      showToast(`保存接口失败: ${error.message}`, "error");
    }
  };

  $("#case-form").onsubmit = async (event) => {
    try {
      await saveCase(event);
    } catch (error) {
      showToast(`保存用例失败: ${error.message}`, "error");
    }
  };

  $("#settings-form").onsubmit = async (event) => {
    try {
      await saveSettings(event);
    } catch (error) {
      showToast(`保存设置失败: ${error.message}`, "error");
    }
  };

  $("#scenario-form").onsubmit = async (event) => {
    try {
      await saveScenario(event);
    } catch (error) {
      showToast(`保存场景失败: ${error.message}`, "error");
    }
  };

  $("#import-doc-form").onsubmit = importApiDoc;
  $("#api-doc-file").onchange = async (event) => {
    try {
      await handleDocFileChange(event);
    } catch (error) {
      showToast(`读取文档失败: ${error.message}`, "error");
    }
  };
  $("#run-all-btn").onclick = () => runAllCases();
  $("#run-unverified-btn").onclick = () =>
    runAllCases({ onlyUnverified: true });
  $("#analyze-latest-btn").onclick = analyzeLatest;
  $("#analyze-selected-run-btn").onclick = analyzeSelectedRun;
  $("#retest-failed-btn").onclick = retestFailedCases;
  $("#adopt-failure-results-btn").onclick = adoptFailureResults;

  $("#fill-business-codes-btn").onclick = () => fillBusinessCodes();
  $("#fill-latest-business-codes-btn").onclick = () => {
    const latest = state.runs[0];
    if (!latest) {
      showToast("暂无最新记录", "error");
      return;
    }
    fillBusinessCodes(latest.id);
  };
  $("#run-auth-profile").onchange = (event) => {
    state.runAuthProfileId = event.target.value;
  };

  $("#run-import-group-unverified-btn").onclick = async () => {
    if (!state.latestImportGroupId) {
      showToast("暂无最近导入分组", "error");
      return;
    }
    const runGroupFilter = $("#run-group-filter");
    if (runGroupFilter) {
      runGroupFilter.value = state.latestImportGroupId;
    }
    showTab("dashboard");
    try {
      await runAllCases({ onlyUnverified: true });
    } catch (error) {
      showToast(`执行失败: ${error.message}`, "error");
    }
  };

  $("#interface-group-filter").onchange = (event) => {
    state.interfaceGroupFilter = event.target.value || "all";
    renderInterfaceList();
    renderBatchGroupControls();
    populateInterfaceForm();
    renderCaseList();
    populateCaseForm();
  };

  $("#batch-target-group").onchange = (event) => {
    state.batchTargetGroupId = event.target.value || "";
  };

  $("#batch-clear-selection-btn").onclick = () => {
    state.selectedInterfaceIds = new Set();
    renderInterfaceList();
    renderBatchGroupControls();
  };

  $("#batch-move-group-btn").onclick = async () => {
    const interfaceIds = [...state.selectedInterfaceIds];
    if (!interfaceIds.length) {
      showToast("请先勾选要迁移的接口", "error");
      return;
    }
    try {
      const result = await apiFetch("/api/interfaces/batch-group", {
        method: "POST",
        body: JSON.stringify({
          interfaceIds,
          groupId: state.batchTargetGroupId || "",
        }),
      });
      state.selectedInterfaceIds = new Set();
      await loadInterfacesOnly();
      renderInterfaceList();
      renderBatchGroupControls();
      populateInterfaceForm();
      renderCaseList();
      populateCaseForm();
      showToast(`批量迁移完成: ${result.updatedCount} 个接口`);
    } catch (error) {
      showToast(`批量迁移失败: ${error.message}`, "error");
    }
  };

  $("#new-interface-group-btn").onclick = async () => {
    const name = window.prompt("请输入分组名称");
    if (!name || !name.trim()) return;
    const id = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "") || `group-${Date.now()}`;
    state.settings.interfaceGroups = [
      ...(state.settings.interfaceGroups || []),
      { id, name: name.trim() },
    ];
    await saveSettings();
    renderInterfaceGroups();
    renderInterfaceGroupList();
    showToast("分组已创建");
  };

  $("#case-filter-mode").onchange = (event) => {
    state.caseFilterMode = event.target.value || "all";
    renderCaseList();
    populateCaseForm();
  };

  $("#new-interface-btn").onclick = () => {
    state.selectedInterfaceId = "";
    state.selectedCaseId = "";
    populateInterfaceForm();
    renderCaseList();
    populateCaseForm();
  };

  $("#new-scenario-btn").onclick = () => {
    state.selectedScenarioId = "";
    state.selectedScenarioStepIndex = -1;
    populateScenarioForm();
  };

  $("#scenario-step-interface").onchange = () => {
    populateScenarioStepCaseOptions();
  };

  $("#append-scenario-step-btn").onclick = () => {
    appendScenarioStepFromBuilder();
  };

  $("#save-scenario-step-btn").onclick = () => {
    saveScenarioStepEdit();
  };

  $("#cancel-scenario-step-btn").onclick = () => {
    cancelScenarioStepEdit();
  };

  $("#scenario-steps").oninput = () => {
    renderScenarioStepList();
  };

  $("#run-scenario-btn").onclick = async () => {
    try {
      await runSelectedScenario();
    } catch (error) {
      showToast(`场景执行失败: ${error.message}`, "error");
    }
  };

  $("#delete-scenario-btn").onclick = async () => {
    try {
      await deleteSelectedScenario();
    } catch (error) {
      showToast(`删除场景失败: ${error.message}`, "error");
    }
  };

  $("#delete-interface-btn").onclick = async () => {
    try {
      await deleteSelectedInterface();
    } catch (error) {
      showToast(`删除接口失败: ${error.message}`, "error");
    }
  };

  $("#new-case-btn").onclick = () => {
    state.selectedCaseId = "";
    populateCaseForm();
  };

  $("#delete-case-btn").onclick = async () => {
    try {
      await deleteSelectedCase();
    } catch (error) {
      showToast(`删除用例失败: ${error.message}`, "error");
    }
  };

  $("#run-current-case-btn").onclick = async () => {
    try {
      await runCurrentCase();
    } catch (error) {
      showToast(`运行当前用例失败: ${error.message}`, "error");
    }
  };

  $("#new-auth-profile-btn").onclick = () => {
    state.settings.authProfiles.push({
      id: `profile-${Date.now()}`,
      name: "New Profile",
      type: "bearer",
      token: "",
    });
    markSettingsDirty();
    renderSettings();
    renderCaseAuthOptions();
    renderRunAuthOptions();
  };

  $("#ai-oos-verify-btn").onclick = verifyOosLogin;
  $("#ai-oos-browser-login-btn").onclick = startOosBrowserLogin;
  $("#ai-chat-send-btn").onclick = sendAiChatMessage;
  $("#ai-chat-clear-btn").onclick = clearAiChatMessages;

  $("#bug-filter-status").onchange = (event) => {
    state.bugFilterStatus = event.target.value;
    renderBugList();
  };

  $("#clear-fixed-bugs-btn").onclick = async () => {
    try {
      await clearFixedBugs();
    } catch (error) {
      showToast(`清除失败: ${error.message}`, "error");
    }
  };

  $("#dashboard-run-chat-send").onclick = async () => {
    try {
      await sendRunChatMessage(
        "dashboard-run-chat-input",
        "dashboard-run-chat-log",
        "dashboard-run-chat-send",
        state.dashboardRunId,
      );
    } catch (error) {
      showToast(`AI 对话失败: ${error.message}`, "error");
    }
  };

  $("#selected-run-chat-send").onclick = async () => {
    try {
      await sendRunChatMessage(
        "selected-run-chat-input",
        "selected-run-chat-log",
        "selected-run-chat-send",
        state.selectedRunId,
      );
    } catch (error) {
      showToast(`AI 对话失败: ${error.message}`, "error");
    }
  };

  bindSettingsDirtyInputs();

  window.addEventListener("beforeunload", () => {
    stopOosLoginPolling();
  });

  await loadAll();
});
