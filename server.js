const crypto = require('crypto');
const express = require('express');
const path = require('path');
const {
  deleteAiReport,
  getDocContexts,
  getInterfaces,
  getRuns,
  getSettings,
  readAiReport,
  saveDocContexts,
  saveAiReport,
  saveInterfaces,
  saveRuns,
  saveSettings,
} = require('./lib/store');
const { analyzeRunWithAi } = require('./lib/ai');
const { importApiDocument } = require('./lib/doc-import');
const { runAllWithAiAgent } = require('./lib/ai-agent-runner');
const { verifyOosLogin, callAiText, hasAiCredential, normalizeAuthMode, parseJsonSafe } = require('./lib/ai-client');
const {
  startOosBrowserLogin,
  getOosBrowserLoginStatus,
  applyOosBrowserLogin,
  closeOosBrowserLogin,
} = require('./lib/oos-browser-login');
const { normalizeCaseBody, normalizeInterfaceBodyTemplate, parseTemplateBodyObject } = require('./lib/body-utils');

const app = express();
const port = process.env.PORT || 3006;

app.use(express.json({ limit: '2mb' }));
app.use('/api', (_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    'Surrogate-Control': 'no-store',
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function normalizeInterface(input, existingCases = []) {
  return {
    id: input.id || crypto.randomUUID(),
    name: input.name || '',
    method: (input.method || 'GET').toUpperCase(),
    path: input.path || '',
    description: input.description || '',
    headers: input.headers || {},
    bodyTemplate: normalizeInterfaceBodyTemplate(input.bodyTemplate, [...existingCases, ...(input.cases || [])]),
    cases: input.cases || existingCases || [],
  };
}

function normalizeCase(input, apiInterface = null) {
  const exampleBody = parseTemplateBodyObject(apiInterface?.bodyTemplate || '');
  return {
    id: input.id || crypto.randomUUID(),
    name: input.name || '',
    description: input.description || '',
    authProfileId: input.authProfileId || '',
    headers: input.headers || {},
    pathParams: input.pathParams || {},
    body: normalizeCaseBody(input.body, exampleBody),
    expected: {
      businessCode: input.expected?.businessCode ?? null,
      messageIncludes: input.expected?.messageIncludes ?? '',
    },
  };
}

function normalizeExecutionMode(value) {
  return String(value || '').trim().toLowerCase() === 'case_runner' ? 'case_runner' : 'ai_agent';
}

function hasAiTransportConfig(ai = {}) {
  const authMode = normalizeAuthMode(ai);
  if (authMode === 'oos') return true;
  return Boolean(String(ai.url || '').trim());
}

function collectJsonCandidates(text) {
  const source = String(text || '').trim();
  if (!source) return [];
  const candidates = [];
  const push = (value) => {
    if (value && typeof value === 'object') candidates.push(value);
  };

  push(parseJsonSafe(source));

  const fenced = [...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const match of fenced) {
    push(parseJsonSafe(match[1].trim()));
  }

  const firstBrace = source.indexOf('{');
  const lastBrace = source.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    push(parseJsonSafe(source.slice(firstBrace, lastBrace + 1)));
  }

  return candidates.filter(Boolean);
}

function normalizeAiChatAction(action) {
  if (!action || typeof action !== 'object') return null;
  const rawType = String(action.type || '').trim().toLowerCase();
  const typeAliases = {
    add_interface: 'create_interface',
    create_interface: 'create_interface',
    update_interface: 'update_interface',
    modify_interface: 'update_interface',
    delete_interface: 'delete_interface',
    remove_interface: 'delete_interface',
    add_case: 'create_case',
    create_case: 'create_case',
    update_case: 'update_case',
    modify_case: 'update_case',
    delete_case: 'delete_case',
    remove_case: 'delete_case',
  };
  const type = typeAliases[rawType] || '';
  if (!type) return null;

  return {
    type,
    interfaceId: String(action.interfaceId || action.id || '').trim(),
    caseId: String(action.caseId || '').trim(),
    interface: action.interface && typeof action.interface === 'object' ? action.interface : null,
    case: action.case && typeof action.case === 'object' ? action.case : null,
  };
}

function parseAiChatPayload(text) {
  const candidates = collectJsonCandidates(text);
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const reply = String(candidate.reply || candidate.message || '').trim();
    const notes = Array.isArray(candidate.notes)
      ? candidate.notes.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const actions = (Array.isArray(candidate.actions) ? candidate.actions : [])
      .map((item) => normalizeAiChatAction(item))
      .filter(Boolean);
    if (!reply && !actions.length) continue;
    return {
      reply: reply || '已分析你的修改请求。',
      notes,
      actions,
    };
  }
  return null;
}

function findInterfaceIndex(payload, interfaceId) {
  if (!interfaceId) return -1;
  return (payload.interfaces || []).findIndex((item) => item.id === interfaceId);
}

function applyAiChatActions(payload, actions) {
  const next = {
    interfaces: [...(payload.interfaces || [])],
  };
  const applied = [];

  for (const action of actions || []) {
    if (!action || !action.type) continue;

    if (action.type === 'create_interface' && action.interface) {
      const created = normalizeInterface(action.interface, action.interface.cases || []);
      next.interfaces.push(created);
      applied.push({ type: action.type, interfaceId: created.id });
      continue;
    }

    if (action.type === 'update_interface' && action.interface) {
      const idx = findInterfaceIndex(next, action.interfaceId || action.interface.id);
      if (idx === -1) continue;
      const current = next.interfaces[idx];
      const merged = normalizeInterface(
        {
          ...current,
          ...action.interface,
          id: current.id,
          cases: current.cases || [],
        },
        current.cases || [],
      );
      next.interfaces[idx] = {
        ...current,
        ...merged,
        id: current.id,
        cases: current.cases || [],
      };
      applied.push({ type: action.type, interfaceId: current.id });
      continue;
    }

    if (action.type === 'delete_interface') {
      const idx = findInterfaceIndex(next, action.interfaceId);
      if (idx === -1) continue;
      const [removed] = next.interfaces.splice(idx, 1);
      applied.push({ type: action.type, interfaceId: removed.id });
      continue;
    }

    if (action.type === 'create_case' && action.case) {
      const idx = findInterfaceIndex(next, action.interfaceId);
      if (idx === -1) continue;
      const apiInterface = next.interfaces[idx];
      const createdCase = normalizeCase(action.case, apiInterface);
      next.interfaces[idx] = {
        ...apiInterface,
        cases: [...(apiInterface.cases || []), createdCase],
      };
      applied.push({ type: action.type, interfaceId: apiInterface.id, caseId: createdCase.id });
      continue;
    }

    if (action.type === 'update_case' && action.case) {
      const idx = findInterfaceIndex(next, action.interfaceId);
      if (idx === -1) continue;
      const apiInterface = next.interfaces[idx];
      const caseIdx = (apiInterface.cases || []).findIndex((item) => item.id === action.caseId);
      if (caseIdx === -1) continue;
      const currentCase = apiInterface.cases[caseIdx];
      const nextCase = {
        ...normalizeCase({ ...currentCase, ...action.case }, apiInterface),
        id: currentCase.id,
      };
      const cases = [...(apiInterface.cases || [])];
      cases[caseIdx] = nextCase;
      next.interfaces[idx] = { ...apiInterface, cases };
      applied.push({ type: action.type, interfaceId: apiInterface.id, caseId: currentCase.id });
      continue;
    }

    if (action.type === 'delete_case') {
      const idx = findInterfaceIndex(next, action.interfaceId);
      if (idx === -1) continue;
      const apiInterface = next.interfaces[idx];
      const existingCases = apiInterface.cases || [];
      const caseIdx = existingCases.findIndex((item) => item.id === action.caseId);
      if (caseIdx === -1) continue;
      const removedCase = existingCases[caseIdx];
      const cases = existingCases.filter((item) => item.id !== action.caseId);
      next.interfaces[idx] = { ...apiInterface, cases };
      applied.push({ type: action.type, interfaceId: apiInterface.id, caseId: removedCase.id });
    }
  }

  return {
    payload: next,
    applied,
    updated: applied.length > 0,
  };
}

app.get('/api/settings', asyncHandler(async (_req, res) => {
  const settings = await getSettings();
  settings.executionMode = normalizeExecutionMode(settings.executionMode);
  settings.ai = {
    ...(settings.ai || {}),
    globalInstruction: String(settings.ai?.globalInstruction || ''),
  };
  res.json(settings);
}));

app.put('/api/settings', asyncHandler(async (req, res) => {
  const next = {
    ...req.body,
    executionMode: normalizeExecutionMode(req.body?.executionMode),
    ai: {
      ...(req.body?.ai || {}),
      globalInstruction: String(req.body?.ai?.globalInstruction || ''),
    },
  };
  const saved = await saveSettings(next);
  res.json(saved);
}));

app.post('/api/ai/oos/verify', asyncHandler(async (req, res) => {
  const ai = req.body?.ai || req.body || {};
  const result = await verifyOosLogin(ai);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
}));

app.post('/api/ai/oos/browser-login/start', asyncHandler(async (req, res) => {
  const result = await startOosBrowserLogin({
    headless: Boolean(req.body?.headless),
  });
  res.json(result);
}));

app.get('/api/ai/oos/browser-login/:sessionId/status', asyncHandler(async (req, res) => {
  try {
    const result = await getOosBrowserLoginStatus(req.params.sessionId);
    res.json(result);
  } catch (error) {
    if (error.code === 'OOS_SESSION_NOT_FOUND') {
      res.status(404).json({ message: error.message });
      return;
    }
    throw error;
  }
}));

app.post('/api/ai/oos/browser-login/:sessionId/apply', asyncHandler(async (req, res) => {
  try {
    const applied = await applyOosBrowserLogin(req.params.sessionId, {
      getSettings,
      saveSettings,
    });
    if (!applied.ok) {
      res.status(409).json(applied);
      return;
    }
    if (req.body?.close !== false) {
      await closeOosBrowserLogin(req.params.sessionId).catch(() => {});
    }
    res.json(applied);
  } catch (error) {
    if (error.code === 'OOS_SESSION_NOT_FOUND') {
      res.status(404).json({ message: error.message });
      return;
    }
    throw error;
  }
}));

app.delete('/api/ai/oos/browser-login/:sessionId', asyncHandler(async (req, res) => {
  try {
    const closed = await closeOosBrowserLogin(req.params.sessionId);
    res.json(closed);
  } catch (error) {
    if (error.code === 'OOS_SESSION_NOT_FOUND') {
      res.status(404).json({ message: error.message });
      return;
    }
    throw error;
  }
}));

app.get('/api/interfaces', asyncHandler(async (_req, res) => {
  res.json(await getInterfaces());
}));

app.get('/api/doc-contexts', asyncHandler(async (_req, res) => {
  res.json(await getDocContexts());
}));

app.post('/api/doc-contexts', asyncHandler(async (req, res) => {
  const filename = String(req.body?.filename || '').trim() || `doc-${Date.now()}.txt`;
  const content = String(req.body?.content || '');
  const analysis = req.body?.analysis && typeof req.body.analysis === 'object' ? req.body.analysis : null;
  if (!content.trim()) {
    res.status(400).json({ message: 'Document content is required' });
    return;
  }

  const payload = await getDocContexts();
  payload.docs = [
    {
      id: crypto.randomUUID(),
      filename,
      content: content.slice(0, 120000),
      analysis,
      uploadedAt: new Date().toISOString(),
    },
    ...(payload.docs || []),
  ].slice(0, 20);
  await saveDocContexts(payload);
  res.json(payload);
}));

app.delete('/api/doc-contexts/:id', asyncHandler(async (req, res) => {
  const payload = await getDocContexts();
  payload.docs = (payload.docs || []).filter((item) => item.id !== req.params.id);
  await saveDocContexts(payload);
  res.json(payload);
}));

app.post('/api/ai/chat', asyncHandler(async (req, res) => {
  const message = String(req.body?.message || '').trim();
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  const autoApply = req.body?.autoApply !== false;
  if (!message) {
    res.status(400).json({ message: 'Message is required' });
    return;
  }

  const settings = await getSettings();
  const ai = settings.ai || {};
  if (!ai.enabled || !hasAiTransportConfig(ai) || !hasAiCredential(ai)) {
    res.status(400).json({ message: 'AI is not configured or enabled' });
    return;
  }

  const interfacesPayload = await getInterfaces();
  const docContexts = await getDocContexts();
  const interfaceSummary = (interfacesPayload.interfaces || []).map((item) => ({
    id: item.id,
    name: item.name,
    method: item.method,
    path: item.path,
    caseCount: Array.isArray(item.cases) ? item.cases.length : 0,
    cases: (item.cases || []).slice(0, 12).map((testCase) => ({
      id: testCase.id,
      name: testCase.name,
      description: testCase.description,
    })),
  }));
  const docsSummary = (docContexts.docs || []).slice(0, 4).map((doc) => ({
    id: doc.id,
    filename: doc.filename,
    analysis: doc.analysis || null,
    contentPreview: String(doc.content || '').slice(0, 2000),
  }));
  const historySummary = history
    .slice(-8)
    .map((item) => ({
      role: String(item?.role || ''),
      content: String(item?.content || '').slice(0, 1500),
    }))
    .filter((item) => ['user', 'assistant'].includes(item.role) && item.content);

  const prompt = [
    'You are an API QA assistant for a test platform.',
    'You must answer in Chinese.',
    'You can directly modify interface/case definitions by returning actions.',
    'Return STRICT JSON only with shape:',
    '{',
    '  "reply": "string",',
    '  "notes": ["string"],',
    '  "actions": [',
    '    { "type": "create_interface", "interface": { ... } },',
    '    { "type": "update_interface", "interfaceId": "id", "interface": { ... } },',
    '    { "type": "delete_interface", "interfaceId": "id" },',
    '    { "type": "create_case", "interfaceId": "id", "case": { ... } },',
    '    { "type": "update_case", "interfaceId": "id", "caseId": "id", "case": { ... } },',
    '    { "type": "delete_case", "interfaceId": "id", "caseId": "id" }',
    '  ]',
    '}',
    'Rules:',
    '- Do not output markdown.',
    '- If user asks to modify cases, prefer returning actions.',
    '- Keep ids stable unless creating new objects.',
    '- Focus on business logic driven testing, not rigid status/message assertions.',
    '',
    `User message: ${message}`,
    `Recent chat history: ${JSON.stringify(historySummary)}`,
    `Current interfaces: ${JSON.stringify(interfaceSummary)}`,
    `Doc contexts: ${JSON.stringify(docsSummary)}`,
  ].join('\n');

  const aiResult = await callAiText(ai, {
    systemPrompt: 'You are a precise API QA copilot that returns strict JSON.',
    userPrompt: prompt,
  });

  if (!aiResult.ok) {
    res.status(400).json({
      message: 'AI chat failed',
      aiMeta: aiResult.meta,
    });
    return;
  }

  const parsed = parseAiChatPayload(aiResult.text);
  if (!parsed) {
    res.json({
      reply: String(aiResult.text || '').trim() || 'AI未返回可解析结构，请重试。',
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
  let updated = false;
  if (autoApply && parsed.actions.length) {
    const appliedResult = applyAiChatActions(interfacesPayload, parsed.actions);
    applied = appliedResult.applied;
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
    appliedCount: applied.length,
    updated,
    aiMeta: aiResult.meta,
  });
}));

app.post('/api/interfaces', asyncHandler(async (req, res) => {
  const payload = await getInterfaces();
  payload.interfaces.push(normalizeInterface(req.body, req.body.cases || []));
  await saveInterfaces(payload);
  res.json(payload);
}));

app.put('/api/interfaces/:id', asyncHandler(async (req, res) => {
  const payload = await getInterfaces();
  payload.interfaces = payload.interfaces.map((item) =>
    item.id === req.params.id ? { ...normalizeInterface(req.body, item.cases || []), id: req.params.id, cases: item.cases || [] } : item,
  );
  await saveInterfaces(payload);
  res.json(payload);
}));

app.delete('/api/interfaces/:id', asyncHandler(async (req, res) => {
  const payload = await getInterfaces();
  payload.interfaces = payload.interfaces.filter((item) => item.id !== req.params.id);
  await saveInterfaces(payload);
  res.json(payload);
}));

app.post('/api/interfaces/:id/cases', asyncHandler(async (req, res) => {
  const payload = await getInterfaces();
  payload.interfaces = payload.interfaces.map((item) => {
    if (item.id !== req.params.id) return item;
    return { ...item, cases: [...(item.cases || []), normalizeCase(req.body, item)] };
  });
  await saveInterfaces(payload);
  res.json(payload);
}));

app.put('/api/interfaces/:id/cases/:caseId', asyncHandler(async (req, res) => {
  const payload = await getInterfaces();
  payload.interfaces = payload.interfaces.map((item) => {
    if (item.id !== req.params.id) return item;
    return {
      ...item,
      cases: (item.cases || []).map((testCase) =>
        testCase.id === req.params.caseId ? { ...normalizeCase(req.body, item), id: req.params.caseId } : testCase,
      ),
    };
  });
  await saveInterfaces(payload);
  res.json(payload);
}));

app.delete('/api/interfaces/:id/cases/:caseId', asyncHandler(async (req, res) => {
  const payload = await getInterfaces();
  payload.interfaces = payload.interfaces.map((item) => {
    if (item.id !== req.params.id) return item;
    return {
      ...item,
      cases: (item.cases || []).filter((testCase) => testCase.id !== req.params.caseId),
    };
  });
  await saveInterfaces(payload);
  res.json(payload);
}));

app.get('/api/runs', asyncHandler(async (_req, res) => {
  res.json(await getRuns());
}));

app.get('/api/runs/:id', asyncHandler(async (req, res) => {
  const payload = await getRuns();
  const run = payload.runs.find((item) => item.id === req.params.id);
  if (!run) {
    res.status(404).json({ message: 'Run not found' });
    return;
  }
  const aiReport = await readAiReport(run.id);
  res.json({ ...run, aiReport });
}));

app.delete('/api/runs/:id', asyncHandler(async (req, res) => {
  const payload = await getRuns();
  const exists = payload.runs.some((item) => item.id === req.params.id);
  if (!exists) {
    res.status(404).json({ message: 'Run not found' });
    return;
  }

  payload.runs = payload.runs.filter((item) => item.id !== req.params.id);
  await saveRuns(payload);
  await deleteAiReport(req.params.id);
  res.json(payload);
}));

app.post('/api/run-all', asyncHandler(async (req, res) => {
  const requestedAuthProfileId = String(req.body?.authProfileId || '').trim();
  const forceNoAuth = requestedAuthProfileId === '__public__';
  const runInstruction = String(req.body?.aiInstruction || '').trim();
  const runContext = String(req.body?.aiContext || '').trim();
  const settings = await getSettings();
  const interfacesPayload = await getInterfaces();
  const docContexts = await getDocContexts();
  const executionMode = 'ai_agent';
  const overrideProfile = requestedAuthProfileId && !forceNoAuth
    ? settings.authProfiles.find((item) => item.id === requestedAuthProfileId)
    : null;

  if (requestedAuthProfileId && !forceNoAuth && !overrideProfile) {
    res.status(400).json({ message: 'Selected auth profile not found' });
    return;
  }

  const startedAt = new Date().toISOString();
  let results = [];
  let summary = { total: 0, passed: 0, failed: 0 };
  const aiAgentRun = await runAllWithAiAgent(
    settings,
    interfacesPayload,
    docContexts,
    {
      overrideAuthProfileId: overrideProfile?.id || '',
      forceNoAuth,
    },
    runInstruction,
    runContext,
  );
  results = aiAgentRun.results;
  summary = aiAgentRun.summary;
  const finishedAt = new Date().toISOString();

  const run = {
    id: crypto.randomUUID(),
    startedAt,
    finishedAt,
    summary,
    executionMode,
    runInstruction,
    runContext,
    executionProfile: forceNoAuth
      ? {
          mode: 'public',
          authProfileId: '',
          authProfileName: '',
          label: '统一无账号执行',
        }
      : overrideProfile
        ? {
            mode: 'override',
            authProfileId: overrideProfile.id,
            authProfileName: overrideProfile.name,
            label: `统一使用 ${overrideProfile.name}`,
          }
        : {
            mode: 'case',
            authProfileId: '',
            authProfileName: '',
            label: '按用例配置执行',
          },
    results,
    ai: {
      enabled: Boolean(settings.ai?.enabled),
      analyzed: false,
      provider: '',
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
  res.json(run);
}));

app.post('/api/interfaces/import-doc', asyncHandler(async (req, res) => {
  const filename = String(req.body?.filename || '').trim();
  const content = String(req.body?.content || '');
  if (!content.trim()) {
    res.status(400).json({ message: 'Document content is required' });
    return;
  }

  const settings = await getSettings();
  const interfacesPayload = await getInterfaces();
  const result = await importApiDocument(settings, interfacesPayload, { filename, content });
  await saveInterfaces(result.payload);

  const docPayload = await getDocContexts();
  docPayload.docs = [
    {
      id: crypto.randomUUID(),
      filename: filename || `doc-${Date.now()}.txt`,
      content: content.slice(0, 120000),
      analysis: result.analysis || null,
      uploadedAt: new Date().toISOString(),
    },
    ...(docPayload.docs || []),
  ].slice(0, 20);
  await saveDocContexts(docPayload);

  res.json({
    message: 'API document imported',
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
}));

app.post('/api/runs/:id/analyze', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const runsPayload = await getRuns();
  const run = runsPayload.runs.find((item) => item.id === req.params.id);
  if (!run) {
    res.status(404).json({ message: 'Run not found' });
    return;
  }

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
}));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({
    message: error.message || 'Internal server error',
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
  });
});

app.listen(port, () => {
  console.log(`Affiliate API platform running at http://localhost:${port}`);
});
