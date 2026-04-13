const crypto = require("crypto");
const {
  deleteAiReport,
  getBugs,
  getDocContexts,
  getInterfaces,
  getRuns,
  getScenarios,
  getSettings,
  readAiReport,
  saveBugs,
  saveDocContexts,
  saveAiReport,
  saveInterfaces,
  saveRuns,
  saveScenarios,
  saveSettings,
} = require("../lib/store");
const { analyzeRunWithAi } = require("../lib/ai");
const { importApiDocument } = require("../lib/doc-import");
const { runAllWithAiAgent } = require("../lib/ai-agent-runner");
const { runAll, runCase } = require("../lib/runner");
const { runScenario } = require("../lib/scenario-runner");
const {
  verifyOosLogin,
  callAiText,
  hasAiCredential,
} = require("../lib/ai-client");
const {
  startOosBrowserLogin,
  getOosBrowserLoginStatus,
  applyOosBrowserLogin,
  closeOosBrowserLogin,
} = require("../lib/oos-browser-login");
const {
  asyncHandler,
  normalizeInterface,
  normalizeCase,
  normalizeExecutionMode,
  hasAiTransportConfig,
  collectJsonCandidates,
  parseAiChatPayload,
  applyAiChatActions,
} = require("../lib/server-helpers");
const { normalizeScenario } = require("../lib/scenario-utils");
const {
  createHttpError,
  validationError,
  notFoundError,
  conflictError,
} = require("../lib/http-errors");
const {
  validateSettingsInput,
  validateInterfaceInput,
  validateCaseInput,
  validateDocContextInput,
  validateAiChatInput,
  validateRunAllInput,
  validateImportDocInput,
  validateBugUpdateInput,
  validateAiRunChatInput,
  validateRunCaseInput,
  validateScenarioInput,
} = require("../lib/validators");

const { extractBusinessCode, businessCodeEquals } = require("../lib/business-code");

const validBugStatuses = ["open", "confirmed", "fixed", "dismissed"];

function normalizeSettingsResponse(settings) {
  return {
    ...settings,
    executionMode: normalizeExecutionMode(settings.executionMode),
    ai: {
      ...(settings.ai || {}),
      globalInstruction: String(settings.ai?.globalInstruction || ""),
    },
  };
}

function ensureAiAvailable(ai, message, code) {
  if (!ai?.enabled || !hasAiTransportConfig(ai) || !hasAiCredential(ai)) {
    throw createHttpError(400, message, {
      code: code || "AI_NOT_CONFIGURED",
    });
  }
}

function toOosNotFoundError(error, sessionId) {
  return createHttpError(404, error.message || "Session not found", {
    code: error.code || "OOS_SESSION_NOT_FOUND",
    details: { sessionId },
  });
}

function getRunOrThrow(payload, runId) {
  const run = payload.runs.find((item) => item.id === runId);
  if (!run) {
    throw notFoundError("Run not found", { runId });
  }
  return run;
}

function getBugIndexOrThrow(payload, bugId) {
  const idx = payload.bugs.findIndex((item) => item.id === bugId);
  if (idx === -1) {
    throw notFoundError("Bug not found", { bugId });
  }
  return idx;
}

function getInterfaceOrThrow(interfacesPayload, interfaceId) {
  const apiInterface = interfacesPayload.interfaces.find(
    (item) => item.id === interfaceId,
  );
  if (!apiInterface) {
    throw notFoundError("接口不存在", { interfaceId });
  }
  return apiInterface;
}

function getCaseOrThrow(apiInterface, caseId) {
  const testCase = (apiInterface.cases || []).find((item) => item.id === caseId);
  if (!testCase) {
    throw notFoundError("用例不存在", {
      interfaceId: apiInterface.id,
      caseId,
    });
  }
  return testCase;
}

function getScenarioOrThrow(payload, scenarioId) {
  const scenario = (payload.scenarios || []).find((item) => item.id === scenarioId);
  if (!scenario) {
    throw notFoundError("场景不存在", { scenarioId });
  }
  return scenario;
}

function ensureBugStatus(status) {
  if (!validBugStatuses.includes(status)) {
    throw validationError(`status must be one of ${validBugStatuses.join(", ")}`);
  }
}

function getRunExecutionOptions(run = {}) {
  const mode = String(run?.executionProfile?.mode || "case");
  if (mode === "public") {
    return { forceNoAuth: true, overrideAuthProfileId: "" };
  }
  if (mode === "override") {
    return {
      overrideAuthProfileId: String(run?.executionProfile?.authProfileId || "").trim(),
    };
  }
  return {};
}

function getActualMessageFromResponse(responseBody) {
  if (!responseBody || typeof responseBody !== "object") return "";
  const candidates = [
    responseBody.message,
    responseBody.msg,
    responseBody.errorMessage,
    responseBody.reason,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function buildSimpleRunSummary(results = []) {
  const total = results.length;
  const passed = results.filter((item) => item?.pass).length;
  return {
    total,
    passed,
    failed: total - passed,
  };
}

function isUnverifiedCase(testCase = {}) {
  return testCase?.expectedMeta?.businessCodeVerified !== true;
}

function filterInterfacesForUnverifiedCases(interfacesPayload) {
  const nextPayload = {
    ...interfacesPayload,
    interfaces: (interfacesPayload.interfaces || [])
      .map((apiInterface) => ({
        ...apiInterface,
        cases: (apiInterface.cases || []).filter((testCase) =>
          isUnverifiedCase(testCase),
        ),
      }))
      .filter((apiInterface) => (apiInterface.cases || []).length > 0),
  };

  return nextPayload;
}

function registerApiRoutes(app) {
  app.get(
    "/api/settings",
    asyncHandler(async (_req, res) => {
      const settings = await getSettings();
      res.json(normalizeSettingsResponse(settings));
    }),
  );

  app.put(
    "/api/settings",
    asyncHandler(async (req, res) => {
      const input = validateSettingsInput(req.body);
      const next = {
        ...input,
        executionMode: normalizeExecutionMode(input.executionMode),
        ai: {
          ...(input.ai || {}),
          globalInstruction: String(input.ai?.globalInstruction || ""),
        },
      };
      const saved = await saveSettings(next);
      res.json(saved);
    }),
  );

  app.post(
    "/api/ai/oos/verify",
    asyncHandler(async (req, res) => {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const ai = body.ai || body || {};
      const result = await verifyOosLogin(ai);
      if (!result.ok) {
        throw createHttpError(400, result.message || "OOS verify failed", {
          code: result.code || "OOS_VERIFY_FAILED",
          details: result,
        });
      }
      res.json(result);
    }),
  );

  app.post(
    "/api/ai/oos/browser-login/start",
    asyncHandler(async (req, res) => {
      const result = await startOosBrowserLogin({
        headless: Boolean(req.body?.headless),
      });
      res.json(result);
    }),
  );

  app.get(
    "/api/ai/oos/browser-login/:sessionId/status",
    asyncHandler(async (req, res) => {
      try {
        const result = await getOosBrowserLoginStatus(req.params.sessionId);
        res.json(result);
      } catch (error) {
        if (error.code === "OOS_SESSION_NOT_FOUND") {
          throw toOosNotFoundError(error, req.params.sessionId);
        }
        throw error;
      }
    }),
  );

  app.post(
    "/api/ai/oos/browser-login/:sessionId/apply",
    asyncHandler(async (req, res) => {
      try {
        const applied = await applyOosBrowserLogin(req.params.sessionId, {
          getSettings,
          saveSettings,
        });
        if (!applied.ok) {
          throw conflictError(applied.message || "OOS login apply conflict", applied);
        }
        if (req.body?.close !== false) {
          await closeOosBrowserLogin(req.params.sessionId).catch(() => {});
        }
        res.json(applied);
      } catch (error) {
        if (error.code === "OOS_SESSION_NOT_FOUND") {
          throw toOosNotFoundError(error, req.params.sessionId);
        }
        throw error;
      }
    }),
  );

  app.delete(
    "/api/ai/oos/browser-login/:sessionId",
    asyncHandler(async (req, res) => {
      try {
        const closed = await closeOosBrowserLogin(req.params.sessionId);
        res.json(closed);
      } catch (error) {
        if (error.code === "OOS_SESSION_NOT_FOUND") {
          throw toOosNotFoundError(error, req.params.sessionId);
        }
        throw error;
      }
    }),
  );

  app.get(
    "/api/interfaces",
    asyncHandler(async (_req, res) => {
      res.json(await getInterfaces());
    }),
  );

  app.get(
    "/api/scenarios",
    asyncHandler(async (_req, res) => {
      res.json(await getScenarios());
    }),
  );

  app.post(
    "/api/scenarios",
    asyncHandler(async (req, res) => {
      const input = validateScenarioInput(req.body);
      const payload = await getScenarios();
      const scenario = normalizeScenario(input);
      payload.scenarios.unshift(scenario);
      await saveScenarios(payload);
      res.json(payload);
    }),
  );

  app.put(
    "/api/scenarios/:id",
    asyncHandler(async (req, res) => {
      const input = validateScenarioInput(req.body);
      const payload = await getScenarios();
      getScenarioOrThrow(payload, req.params.id);
      payload.scenarios = (payload.scenarios || []).map((item) =>
        item.id === req.params.id
          ? {
              ...normalizeScenario({ ...item, ...input, id: req.params.id }),
              id: req.params.id,
            }
          : item,
      );
      await saveScenarios(payload);
      res.json(payload);
    }),
  );

  app.delete(
    "/api/scenarios/:id",
    asyncHandler(async (req, res) => {
      const payload = await getScenarios();
      getScenarioOrThrow(payload, req.params.id);
      payload.scenarios = (payload.scenarios || []).filter(
        (item) => item.id !== req.params.id,
      );
      await saveScenarios(payload);
      res.json(payload);
    }),
  );

  app.post(
    "/api/scenarios/:id/run",
    asyncHandler(async (req, res) => {
      const input = validateRunAllInput(req.body);
      const requestedAuthProfileId = String(input.authProfileId || "").trim();
      const forceNoAuth = requestedAuthProfileId === "__public__";
      const settings = await getSettings();
      const interfacesPayload = await getInterfaces();
      const scenariosPayload = await getScenarios();
      const scenario = getScenarioOrThrow(scenariosPayload, req.params.id);
      const scenarioRun = await runScenario(settings, interfacesPayload, scenario, {
        overrideAuthProfileId: forceNoAuth ? "" : requestedAuthProfileId,
        forceNoAuth,
      });

      const run = {
        id: scenarioRun.id,
        startedAt: scenarioRun.startedAt,
        finishedAt: scenarioRun.finishedAt,
        summary: scenarioRun.summary,
        executionMode: "scenario_runner",
        runInstruction: "",
        runContext: "",
        executionProfile: forceNoAuth
          ? {
              mode: "public",
              authProfileId: "",
              authProfileName: "",
              label: "统一无账号执行",
            }
          : requestedAuthProfileId
            ? {
                mode: "override",
                authProfileId: requestedAuthProfileId,
                authProfileName: requestedAuthProfileId,
                label: `统一使用 ${requestedAuthProfileId}`,
              }
            : {
                mode: "scenario",
                authProfileId: "",
                authProfileName: "",
                label: "按场景步骤执行",
              },
        scenario: {
          id: scenario.id,
          name: scenario.name,
        },
        results: scenarioRun.results,
        variables: scenarioRun.variables,
        ai: {
          enabled: false,
          analyzed: false,
          provider: "",
          meta: null,
        },
      };

      const runsPayload = await getRuns();
      runsPayload.runs.unshift(run);
      await saveRuns(runsPayload);

      res.json(run);
    }),
  );

  app.get(
    "/api/doc-contexts",
    asyncHandler(async (_req, res) => {
      res.json(await getDocContexts());
    }),
  );

  app.post(
    "/api/doc-contexts",
    asyncHandler(async (req, res) => {
      const input = validateDocContextInput(req.body);
      const filename = input.filename || `doc-${Date.now()}.txt`;
      const payload = await getDocContexts();
      payload.docs = [
        {
          id: crypto.randomUUID(),
          filename,
          content: input.content.slice(0, 120000),
          analysis: input.analysis || null,
          uploadedAt: new Date().toISOString(),
        },
        ...(payload.docs || []),
      ].slice(0, 20);
      await saveDocContexts(payload);
      res.json(payload);
    }),
  );

  app.delete(
    "/api/doc-contexts/:id",
    asyncHandler(async (req, res) => {
      const payload = await getDocContexts();
      payload.docs = (payload.docs || []).filter(
        (item) => item.id !== req.params.id,
      );
      await saveDocContexts(payload);
      res.json(payload);
    }),
  );

  app.post(
    "/api/ai/chat",
    asyncHandler(async (req, res) => {
      const input = validateAiChatInput(req.body);
      const autoApply = input.autoApply !== false;

      const settings = await getSettings();
      const ai = settings.ai || {};
      ensureAiAvailable(ai, "AI is not configured or enabled", "AI_NOT_CONFIGURED");

      const interfacesPayload = await getInterfaces();
      const docContexts = await getDocContexts();
      const interfaceSummary = (interfacesPayload.interfaces || []).map((item) => ({
        id: item.id,
        name: item.name,
        method: item.method,
        path: item.path,
        description: item.description || "",
        bodyTemplate: item.bodyTemplate || "",
        headers: item.headers || {},
        caseCount: Array.isArray(item.cases) ? item.cases.length : 0,
        cases: (item.cases || []).map((testCase) => ({
          id: testCase.id,
          name: testCase.name,
          description: testCase.description,
          authProfileId: testCase.authProfileId || "",
          pathParams: testCase.pathParams || {},
          headers: testCase.headers || {},
          body: testCase.body || "",
          expected: testCase.expected || {},
        })),
      }));
      const docsSummary = (docContexts.docs || []).slice(0, 4).map((doc) => ({
        id: doc.id,
        filename: doc.filename,
        analysis: doc.analysis || null,
        contentPreview: String(doc.content || "").slice(0, 2000),
      }));
      const historySummary = input.history
        .slice(-8)
        .map((item) => ({
          role: String(item?.role || ""),
          content: String(item?.content || "").slice(0, 1500),
        }))
        .filter(
          (item) => ["user", "assistant"].includes(item.role) && item.content,
        );

      const prompt = [
        "You are an API QA assistant for a test platform.",
        "You must answer in Chinese.",
        "You can directly modify interface/case definitions by returning actions.",
        "Return STRICT JSON only with shape:",
        "{",
        '  "reply": "string",',
        '  "notes": ["string"],',
        '  "actions": [',
        '    { "type": "create_interface", "interface": { ... } },',
        '    { "type": "update_interface", "interfaceId": "id", "interfaceName": "optional", "interface": { ... } },',
        '    { "type": "delete_interface", "interfaceId": "id", "interfaceName": "optional" },',
        '    { "type": "create_case", "interfaceId": "id", "case": { ... } },',
        '    { "type": "update_case", "interfaceId": "id", "interfaceName": "optional", "caseId": "id", "caseName": "optional", "case": { ... } },',
        '    { "type": "delete_case", "interfaceId": "id", "interfaceName": "optional", "caseId": "id", "caseName": "optional" }',
        "  ]",
        "}",
        "Rules:",
        "- Do not output markdown.",
        "- If user asks to modify cases, prefer returning actions.",
        "- Keep ids stable unless creating new objects.",
        "- If caseId is unknown, you may use caseName + interfaceId/interfaceName to target the case.",
        "- For request data change, update case.body directly and keep other fields unchanged unless user asks.",
        "- Focus on business logic driven testing, not rigid status/message assertions.",
        "",
        `User message: ${input.message}`,
        `Recent chat history: ${JSON.stringify(historySummary)}`,
        `Current interfaces: ${JSON.stringify(interfaceSummary)}`,
        `Doc contexts: ${JSON.stringify(docsSummary)}`,
      ].join("\n");

      const aiResult = await callAiText(ai, {
        systemPrompt:
          "You are a precise API QA copilot that returns strict JSON.",
        userPrompt: prompt,
      });

      if (!aiResult.ok) {
        throw createHttpError(400, "AI chat failed", {
          code: "AI_CHAT_FAILED",
          details: { aiMeta: aiResult.meta },
        });
      }

      const parsed = parseAiChatPayload(aiResult.text);
      if (!parsed) {
        res.json({
          reply:
            String(aiResult.text || "").trim() || "AI未返回可解析结构，请重试。",
          notes: [],
          actions: [],
          applied: [],
          appliedCount: 0,
          updated: false,
          aiMeta: aiResult.meta,
        });
        return;
      }

      let applied = [];
      let skipped = [];
      let updated = false;
      if (autoApply && parsed.actions.length) {
        const appliedResult = applyAiChatActions(
          interfacesPayload,
          parsed.actions,
        );
        applied = appliedResult.applied;
        skipped = appliedResult.skipped || [];
        updated = appliedResult.updated;
        if (updated) {
          await saveInterfaces(appliedResult.payload);
        }
      }

      res.json({
        reply: parsed.reply,
        notes: parsed.notes,
        actions: parsed.actions,
        applied,
        skipped,
        appliedCount: applied.length,
        updated,
        aiMeta: aiResult.meta,
      });
    }),
  );

  app.post(
    "/api/interfaces",
    asyncHandler(async (req, res) => {
      const input = validateInterfaceInput(req.body);
      const payload = await getInterfaces();
      payload.interfaces.push(normalizeInterface(input, input.cases || []));
      await saveInterfaces(payload);
      res.json(payload);
    }),
  );

  app.put(
    "/api/interfaces/:id",
    asyncHandler(async (req, res) => {
      const input = validateInterfaceInput(req.body);
      const payload = await getInterfaces();
      payload.interfaces = payload.interfaces.map((item) =>
        item.id === req.params.id
          ? {
              ...normalizeInterface(input, item.cases || []),
              id: req.params.id,
              cases: item.cases || [],
            }
          : item,
      );
      await saveInterfaces(payload);
      res.json(payload);
    }),
  );

  app.delete(
    "/api/interfaces/:id",
    asyncHandler(async (req, res) => {
      const payload = await getInterfaces();
      payload.interfaces = payload.interfaces.filter(
        (item) => item.id !== req.params.id,
      );
      await saveInterfaces(payload);
      res.json(payload);
    }),
  );

  app.post(
    "/api/interfaces/:id/cases",
    asyncHandler(async (req, res) => {
      const input = validateCaseInput(req.body);
      const payload = await getInterfaces();
      payload.interfaces = payload.interfaces.map((item) => {
        if (item.id !== req.params.id) return item;
        return {
          ...item,
          cases: [...(item.cases || []), normalizeCase(input, item)],
        };
      });
      await saveInterfaces(payload);
      res.json(payload);
    }),
  );

  app.put(
    "/api/interfaces/:id/cases/:caseId",
    asyncHandler(async (req, res) => {
      const input = validateCaseInput(req.body);
      const payload = await getInterfaces();
      payload.interfaces = payload.interfaces.map((item) => {
        if (item.id !== req.params.id) return item;
        return {
          ...item,
          cases: (item.cases || []).map((testCase) =>
            testCase.id === req.params.caseId
              ? { ...normalizeCase(input, item), id: req.params.caseId }
              : testCase,
          ),
        };
      });
      await saveInterfaces(payload);
      res.json(payload);
    }),
  );

  app.delete(
    "/api/interfaces/:id/cases/:caseId",
    asyncHandler(async (req, res) => {
      const payload = await getInterfaces();
      payload.interfaces = payload.interfaces.map((item) => {
        if (item.id !== req.params.id) return item;
        return {
          ...item,
          cases: (item.cases || []).filter(
            (testCase) => testCase.id !== req.params.caseId,
          ),
        };
      });
      await saveInterfaces(payload);
      res.json(payload);
    }),
  );

  app.get(
    "/api/runs",
    asyncHandler(async (_req, res) => {
      res.json(await getRuns());
    }),
  );

  app.get(
    "/api/runs/:id",
    asyncHandler(async (req, res) => {
      const payload = await getRuns();
      const run = getRunOrThrow(payload, req.params.id);
      const aiReport = await readAiReport(run.id);
      res.json({ ...run, aiReport });
    }),
  );

  app.delete(
    "/api/runs/:id",
    asyncHandler(async (req, res) => {
      const payload = await getRuns();
      getRunOrThrow(payload, req.params.id);
      payload.runs = payload.runs.filter((item) => item.id !== req.params.id);
      await saveRuns(payload);
      await deleteAiReport(req.params.id);
      res.json(payload);
    }),
  );

  app.post(
    "/api/run-all",
    asyncHandler(async (req, res) => {
      const input = validateRunAllInput(req.body);
      const requestedAuthProfileId = String(input.authProfileId || "").trim();
      const forceNoAuth = requestedAuthProfileId === "__public__";
      const runInstruction = String(input.aiInstruction || "").trim();
      const runContext = String(input.aiContext || "").trim();
      const onlyUnverified = input.onlyUnverified === true;
      const settings = await getSettings();
      const allInterfacesPayload = await getInterfaces();
      const interfacesPayload = onlyUnverified
        ? filterInterfacesForUnverifiedCases(allInterfacesPayload)
        : allInterfacesPayload;
      const docContexts = await getDocContexts();
      const executionMode = normalizeExecutionMode(settings.executionMode);
      const overrideProfile =
        requestedAuthProfileId && !forceNoAuth
          ? settings.authProfiles.find(
              (item) => item.id === requestedAuthProfileId,
            )
          : null;

      if (requestedAuthProfileId && !forceNoAuth && !overrideProfile) {
        throw validationError("Selected auth profile not found", {
          authProfileId: requestedAuthProfileId,
        });
      }

      if (onlyUnverified && (!interfacesPayload.interfaces || !interfacesPayload.interfaces.length)) {
        throw validationError("暂无未校对用例可执行");
      }

      const startedAt = new Date().toISOString();
      let results = [];
      let summary = { total: 0, passed: 0, failed: 0 };
      let aiAgentRun = null;

      if (executionMode === "ai_agent") {
        aiAgentRun = await runAllWithAiAgent(
          settings,
          interfacesPayload,
          docContexts,
          {
            overrideAuthProfileId: overrideProfile?.id || "",
            forceNoAuth,
          },
          runInstruction,
          runContext,
        );
        results = aiAgentRun.results;
        summary = aiAgentRun.summary;
      } else {
        results = await runAll(settings, interfacesPayload, {
          overrideAuthProfileId: overrideProfile?.id || "",
          forceNoAuth,
        });
        summary = {
          total: results.length,
          passed: results.filter((item) => item.pass).length,
          failed: results.filter((item) => !item.pass).length,
        };
      }

      const finishedAt = new Date().toISOString();

      const run = {
        id: crypto.randomUUID(),
        startedAt,
        finishedAt,
        summary,
        executionMode,
        runInstruction,
        runContext,
        caseSelection: onlyUnverified ? "unverified" : "all",
        executionProfile: forceNoAuth
          ? {
              mode: "public",
              authProfileId: "",
              authProfileName: "",
              label: "统一无账号执行",
            }
          : overrideProfile
            ? {
                mode: "override",
                authProfileId: overrideProfile.id,
                authProfileName: overrideProfile.name,
                label: `统一使用 ${overrideProfile.name}`,
              }
            : {
                mode: "case",
                authProfileId: "",
                authProfileName: "",
                label: "按用例配置执行",
              },
        results,
        ai: {
          enabled: Boolean(settings.ai?.enabled),
          analyzed: false,
          provider: "",
          meta: null,
        },
      };

      if (aiAgentRun) {
        await saveAiReport(run.id, aiAgentRun.markdown);
        run.ai = {
          enabled: true,
          analyzed: true,
          provider: aiAgentRun.provider,
          meta: aiAgentRun.meta,
        };
      } else if (settings.ai?.autoAnalyzeOnRun) {
        const analysis = await analyzeRunWithAi(settings, run);
        await saveAiReport(run.id, analysis.markdown);
        run.ai = {
          enabled: true,
          analyzed: true,
          provider: analysis.provider,
          meta: analysis.meta,
        };
      }

      const runsPayload = await getRuns();
      runsPayload.runs.unshift(run);
      await saveRuns(runsPayload);

      if (aiAgentRun?.bugs && aiAgentRun.bugs.length) {
        const bugsPayload = await getBugs();
        const now = new Date().toISOString();
        for (const bug of aiAgentRun.bugs) {
          const evidenceResults = results.filter((r) =>
            (bug.evidenceResultIds || []).includes(r.id),
          );
          const toProcess = evidenceResults.length > 0 ? evidenceResults : [null];
          for (const evidence of toProcess) {
            bugsPayload.bugs.push({
              id: crypto.randomUUID(),
              runId: run.id,
              title: bug.title || "",
              severity: bug.severity || "medium",
              description: bug.description || "",
              status: "open",
              interfaceName: evidence?.interfaceName || "",
              caseName: evidence?.caseName || "",
              method: evidence?.method || "",
              path: evidence?.path || "",
              url: evidence?.url || "",
              request: evidence?.request || {},
              response: evidence?.response || {},
              evidenceResultIds: evidence
                ? [evidence.id]
                : bug.evidenceResultIds || [],
              createdAt: now,
              updatedAt: now,
            });
          }
        }
        await saveBugs(bugsPayload);
      }

      res.json(run);
    }),
  );

  app.post(
    "/api/interfaces/import-doc",
    asyncHandler(async (req, res) => {
      const input = validateImportDocInput(req.body);
      const settings = await getSettings();
      const interfacesPayload = await getInterfaces();
      const result = await importApiDocument(settings, interfacesPayload, {
        filename: input.filename,
        content: input.content,
      });
      await saveInterfaces(result.payload);

      const docPayload = await getDocContexts();
      docPayload.docs = [
        {
          id: crypto.randomUUID(),
          filename: input.filename || `doc-${Date.now()}.txt`,
          content: input.content.slice(0, 120000),
          analysis: result.analysis || null,
          uploadedAt: new Date().toISOString(),
        },
        ...(docPayload.docs || []),
      ].slice(0, 20);
      await saveDocContexts(docPayload);

      res.json({
        message: "API 文档导入完成",
        provider: result.provider,
        aiMeta: result.meta,
        recognizedInterfaces: result.recognizedInterfaces,
        addedInterfaces: result.addedInterfaces,
        mergedInterfaces: result.mergedInterfaces,
        addedCases: result.addedCases,
        notes: result.notes,
        analysis: result.analysis || null,
        interfaces: result.payload.interfaces,
        storedDocs: docPayload.docs.length,
      });
    }),
  );

  app.post(
    "/api/runs/:id/fill-business-codes",
    asyncHandler(async (req, res) => {
      const runsPayload = await getRuns();
      const run = getRunOrThrow(runsPayload, req.params.id);
      const interfacesPayload = await getInterfaces();

      let filledCount = 0;
      let skippedCount = 0;
      const verifiedCases = [];

      for (const result of run.results || []) {
        const transportError = result.response?.transportError;
        const responseBody = result.response?.bodyJson;
        if (transportError || !responseBody || typeof responseBody !== "object") {
          skippedCount += 1;
          continue;
        }

        const actualCode = extractBusinessCode(responseBody);
        if (actualCode === null) {
          skippedCount += 1;
          continue;
        }

        const interfaceId = result.interfaceId;
        const caseId = result.caseId;
        const apiInterface = interfacesPayload.interfaces.find(
          (item) => item.id === interfaceId,
        );
        if (!apiInterface) {
          skippedCount += 1;
          continue;
        }

        const testCase = (apiInterface.cases || []).find(
          (item) => item.id === caseId,
        );
        if (!testCase) {
          skippedCount += 1;
          continue;
        }

        const expectedCode = testCase.expected?.businessCode;
        if (!businessCodeEquals(actualCode, expectedCode)) {
          if (!testCase.expected) {
            testCase.expected = {};
          }
          if (!testCase.expectedMeta || typeof testCase.expectedMeta !== "object") {
            testCase.expectedMeta = {};
          }
          testCase.expected.businessCode = actualCode;
          testCase.expectedMeta.businessCodeSource = "actual_run";
          testCase.expectedMeta.businessCodeVerified = true;
          testCase.expectedMeta.businessCodeUpdatedAt = new Date().toISOString();
          verifiedCases.push({ interfaceId, caseId });
          filledCount += 1;
        } else {
          if (!testCase.expectedMeta || typeof testCase.expectedMeta !== "object") {
            testCase.expectedMeta = {};
          }
          if (testCase.expected.businessCode != null) {
            testCase.expectedMeta.businessCodeVerified = true;
            testCase.expectedMeta.businessCodeUpdatedAt = new Date().toISOString();
            testCase.expectedMeta.businessCodeSource =
              String(testCase.expectedMeta.businessCodeSource || "manual") === "ai_guess"
                ? "actual_run"
                : String(testCase.expectedMeta.businessCodeSource || "manual");
            verifiedCases.push({ interfaceId, caseId });
          }
          skippedCount += 1;
        }
      }

      await saveInterfaces(interfacesPayload);

      res.json({
        ok: true,
        filledCount,
        skippedCount,
        verifiedCases,
      });
    }),
  );

  app.post(
    "/api/runs/:id/analyze",
    asyncHandler(async (req, res) => {
      const settings = await getSettings();
      const runsPayload = await getRuns();
      const run = getRunOrThrow(runsPayload, req.params.id);

      const analysis = await analyzeRunWithAi(settings, run);
      await saveAiReport(run.id, analysis.markdown);
      run.ai = {
        enabled: true,
        analyzed: true,
        provider: analysis.provider,
        meta: analysis.meta,
      };
      await saveRuns(runsPayload);
      res.json({
        runId: run.id,
        provider: analysis.provider,
        markdown: analysis.markdown,
        aiMeta: analysis.meta,
      });
    }),
  );

  app.get(
    "/api/bugs",
    asyncHandler(async (_req, res) => {
      res.json(await getBugs());
    }),
  );

  app.put(
    "/api/bugs/:id",
    asyncHandler(async (req, res) => {
      const input = validateBugUpdateInput(req.body);
      const payload = await getBugs();
      const idx = getBugIndexOrThrow(payload, req.params.id);
      const current = payload.bugs[idx];
      const next = { ...current };
      if (input.status !== undefined) {
        ensureBugStatus(input.status);
        next.status = input.status;
      }
      if (input.note !== undefined) {
        next.note = String(input.note || "");
      }
      next.updatedAt = new Date().toISOString();
      payload.bugs[idx] = next;
      await saveBugs(payload);
      res.json(next);
    }),
  );

  app.delete(
    "/api/bugs/:id",
    asyncHandler(async (req, res) => {
      const payload = await getBugs();
      getBugIndexOrThrow(payload, req.params.id);
      payload.bugs = payload.bugs.filter((item) => item.id !== req.params.id);
      await saveBugs(payload);
      res.json(payload);
    }),
  );

  app.post(
    "/api/ai/run-chat",
    asyncHandler(async (req, res) => {
      const input = validateAiRunChatInput(req.body);
      const runId = String(input.runId || "").trim();
      const autoApplyBugActions = input.autoApplyBugActions !== false;

      const settings = await getSettings();
      const ai = settings.ai || {};
      ensureAiAvailable(ai, "AI 未配置或未启用", "AI_NOT_CONFIGURED");

      let run = null;
      if (runId) {
        const runsPayload = await getRuns();
        run = runsPayload.runs.find((item) => item.id === runId) || null;
      }

      const bugsPayload = await getBugs();
      const runBugs = runId
        ? bugsPayload.bugs.filter((item) => item.runId === runId)
        : bugsPayload.bugs.slice(0, 20);

      const runSummary = run
        ? {
            runId: run.id,
            startedAt: run.startedAt,
            summary: run.summary,
            executionProfile: run.executionProfile?.label || "",
            results: (run.results || []).map((r) => ({
              interfaceName: r.interfaceName,
              caseName: r.caseName,
              pass: r.pass,
              assertionSummary: r.assertionSummary,
              method: r.method,
              url: r.url,
            })),
          }
        : null;

      const bugsSummary = runBugs.map((b) => ({
        id: b.id,
        title: b.title,
        severity: b.severity,
        status: b.status,
        description: b.description,
        interfaceName: b.interfaceName,
        caseName: b.caseName,
      }));

      const historySummary = input.history
        .slice(-8)
        .map((item) => ({
          role: String(item?.role || ""),
          content: String(item?.content || "").slice(0, 1500),
        }))
        .filter(
          (item) => ["user", "assistant"].includes(item.role) && item.content,
        );

      const prompt = [
        "你是 API 测试分析助手，负责帮用户分析已执行的测试结果并直接操作 bug 状态。",
        "仅输出严格 JSON，格式如下（不得输出其他内容）：",
        '{ "reply": "string", "actions": [{ "type": "update_bug_status", "bugId": "id", "status": "open|confirmed|fixed|dismissed", "reason": "说明" }] }',
        "",
        "【必须遵守的规则】",
        "- reply 必须用中文，简洁说明你做了什么。",
        "- 如果消息中明确包含 bugId，你必须在 actions 中针对该 bugId 执行相应操作，不能只在 reply 里'建议'，必须真正生成 action。",
        "- 【重要】只有当消息中[重测结果：通过]时，才可以将对应 bug dismissed。",
        "  如果消息中[重测结果：失败]，即使用户解释了业务规则变更，也绝对不能 dismissed；",
        "  此时应在 reply 中告诉用户：重测仍失败，需要先在[接口与用例]Tab 更新用例的请求体和期望值，再重测。",
        "- 如果用户直接说某个 bug 是文档/设计问题（无重测场景），可以 dismissed。",
        "- 如果用户确认某个 bug 是真实缺陷，必须生成 action，status 设为 confirmed。",
        "- 如果用户说已修复，status 设为 fixed。",
        "- 没有明确状态变更意图时，actions 返回空数组。",
        "- 禁止只在 reply 里说'建议更新'而不输出 action——说了就必须做。",
        "",
        `当前 Run 执行摘要: ${JSON.stringify(runSummary)}`,
        `Bug 列表（共 ${bugsSummary.length} 个，含 bugId）: ${JSON.stringify(bugsSummary)}`,
        `历史对话: ${JSON.stringify(historySummary)}`,
        `用户消息: ${input.message}`,
      ].join("\n");

      const aiResult = await callAiText(ai, {
        systemPrompt: "你是 API 测试分析助手，只输出严格 JSON。",
        userPrompt: prompt,
      });

      if (!aiResult.ok) {
        throw createHttpError(400, "AI 对话失败", {
          code: "AI_RUN_CHAT_FAILED",
          details: { aiMeta: aiResult.meta },
        });
      }

      let reply = "";
      let actions = [];
      const candidates = collectJsonCandidates(aiResult.text);
      for (const candidate of candidates) {
        if (
          !candidate ||
          typeof candidate !== "object" ||
          Array.isArray(candidate)
        ) {
          continue;
        }
        const candidateReply = String(candidate.reply || "").trim();
        const candidateActions = Array.isArray(candidate.actions)
          ? candidate.actions
          : [];
        if (candidateReply || candidateActions.length) {
          reply = candidateReply || "已处理你的请求。";
          actions = candidateActions;
          break;
        }
      }
      if (!reply) {
        reply =
          String(aiResult.text || "").trim() || "AI 未返回可解析结构，请重试。";
      }

      const applied = [];
      if (autoApplyBugActions && actions.length) {
        const latestBugsPayload = await getBugs();
        const now = new Date().toISOString();
        let changed = false;
        for (const action of actions) {
          if (action?.type !== "update_bug_status") continue;
          const bugIdx = latestBugsPayload.bugs.findIndex(
            (b) => b.id === action.bugId,
          );
          if (bugIdx === -1) continue;
          if (!validBugStatuses.includes(action.status)) continue;
          latestBugsPayload.bugs[bugIdx] = {
            ...latestBugsPayload.bugs[bugIdx],
            status: action.status,
            note: String(action.reason || ""),
            updatedAt: now,
          };
          applied.push({ bugId: action.bugId, status: action.status });
          changed = true;
        }
        if (changed) {
          await saveBugs(latestBugsPayload);
        }
      }

      res.json({
        reply,
        actions,
        applied,
        appliedCount: applied.length,
        aiMeta: aiResult.meta,
      });
    }),
  );

  app.post(
    "/api/runs/:id/retest-failures",
    asyncHandler(async (req, res) => {
      const sourceRunsPayload = await getRuns();
      const sourceRun = getRunOrThrow(sourceRunsPayload, req.params.id);
      const settings = await getSettings();
      const interfacesPayload = await getInterfaces();
      const failedResults = (sourceRun.results || []).filter(
        (item) => item && item.pass === false && item.interfaceId && item.caseId,
      );

      if (!failedResults.length) {
        throw validationError("当前记录没有可重跑的失败用例");
      }

      const executionOptions = getRunExecutionOptions(sourceRun);
      const retestResults = [];

      for (const item of failedResults) {
        const apiInterface = getInterfaceOrThrow(interfacesPayload, item.interfaceId);
        const testCase = getCaseOrThrow(apiInterface, item.caseId);
        const retestResult = await runCase(
          settings,
          apiInterface,
          testCase,
          executionOptions,
          interfacesPayload,
        );
        retestResults.push(retestResult);
      }

      const retestRun = {
        id: crypto.randomUUID(),
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        summary: buildSimpleRunSummary(retestResults),
        executionMode: "case_runner",
        runInstruction: sourceRun.runInstruction || "",
        runContext: sourceRun.runContext || "",
        caseSelection: "failed_only",
        sourceRunId: sourceRun.id,
        executionProfile: sourceRun.executionProfile || {
          mode: "case",
          authProfileId: "",
          authProfileName: "",
          label: "按用例账号执行",
        },
        results: retestResults,
        ai: {
          enabled: false,
          analyzed: false,
          provider: "",
          meta: null,
        },
      };

      const latestRunsPayload = await getRuns();
      latestRunsPayload.runs.unshift(retestRun);
      await saveRuns(latestRunsPayload);
      res.json(retestRun);
    }),
  );

  app.post(
    "/api/runs/:id/adopt-failure-results",
    asyncHandler(async (req, res) => {
      const sourceRunsPayload = await getRuns();
      const sourceRun = getRunOrThrow(sourceRunsPayload, req.params.id);
      const interfacesPayload = await getInterfaces();
      let updatedCount = 0;
      let skippedCount = 0;
      const adoptedCases = [];

      for (const item of sourceRun.results || []) {
        if (!item || item.pass !== false || !item.interfaceId || !item.caseId) {
          skippedCount += 1;
          continue;
        }

        const apiInterface = getInterfaceOrThrow(interfacesPayload, item.interfaceId);
        const testCase = getCaseOrThrow(apiInterface, item.caseId);
        const responseBody = item.response?.bodyJson;
        const actualCode = extractBusinessCode(responseBody);
        const actualMessage = getActualMessageFromResponse(responseBody);
        const nextMessage = actualMessage ? actualMessage : (testCase.expected?.messageIncludes || "");

        if (actualCode === null && !actualMessage) {
          skippedCount += 1;
          continue;
        }

        if (!testCase.expected) {
          testCase.expected = {};
        }
        if (!testCase.expectedMeta || typeof testCase.expectedMeta !== "object") {
          testCase.expectedMeta = {};
        }

        testCase.expected.businessCode = actualCode === null ? testCase.expected.businessCode || null : actualCode;
        testCase.expected.messageIncludes = nextMessage;
        testCase.expectedMeta.businessCodeSource = "actual_run";
        testCase.expectedMeta.businessCodeVerified = true;
        testCase.expectedMeta.businessCodeUpdatedAt = new Date().toISOString();
        updatedCount += 1;
        adoptedCases.push({
          interfaceId: apiInterface.id,
          caseId: testCase.id,
        });
      }

      await saveInterfaces(interfacesPayload);
      res.json({
        ok: true,
        updatedCount,
        skippedCount,
        adoptedCases,
      });
    }),
  );

  app.post(
    "/api/interfaces/:id/cases/:caseId/run",
    asyncHandler(async (req, res) => {
      const input = validateRunCaseInput(req.body);
      const settings = await getSettings();
      const interfacesPayload = await getInterfaces();
      const apiInterface = getInterfaceOrThrow(interfacesPayload, req.params.id);
      const testCase = getCaseOrThrow(apiInterface, req.params.caseId);

      const caseToRun =
        input.bodyOverride !== undefined
          ? { ...testCase, body: input.bodyOverride }
          : testCase;

      const authProfileId = String(input.authProfileId || "").trim();
      const executionOptions = authProfileId
        ? { overrideAuthProfileId: authProfileId }
        : {};

      const result = await runCase(
        settings,
        apiInterface,
        caseToRun,
        executionOptions,
        interfacesPayload,
      );
      res.json(result);
    }),
  );
}

module.exports = { registerApiRoutes };
