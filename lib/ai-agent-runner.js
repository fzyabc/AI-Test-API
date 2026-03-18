const crypto = require('crypto');
const { callAiText, hasAiCredential, normalizeAuthMode, parseJsonSafe } = require('./ai-client');

function hasAiTransportConfig(ai = {}) {
  const authMode = normalizeAuthMode(ai);
  if (authMode === 'oos') return true;
  return Boolean(String(ai.url || '').trim());
}

function normalizeMethod(value) {
  const method = String(value || '').toUpperCase();
  if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return method;
  return 'GET';
}

function extractPathFromUrl(input) {
  const text = String(input || '').trim();
  if (!text) return '';
  if (text.startsWith('/')) return text;
  if (/^https?:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      return parsed.pathname || '/';
    } catch {
      return '';
    }
  }
  return '';
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

function normalizeStep(step, scenarioIndex, stepIndex) {
  if (!step || typeof step !== 'object') return null;
  const method = normalizeMethod(step.method);
  const rawPath = String(step.path || step.url || step.endpoint || '').trim();
  const path = extractPathFromUrl(rawPath) || rawPath;
  if (!path) return null;
  return {
    id: step.id || `scenario-${scenarioIndex + 1}-step-${stepIndex + 1}`,
    name: step.name || `${method} ${path}`,
    method,
    path,
    headers: step.headers && typeof step.headers === 'object' ? step.headers : {},
    body: step.body == null ? '' : step.body,
    authProfileId: String(step.authProfileId || '').trim(),
    reason: String(step.reason || step.goal || ''),
  };
}

function normalizeScenario(scenario, scenarioIndex) {
  if (!scenario || typeof scenario !== 'object') return null;
  const rawSteps = Array.isArray(scenario.steps)
    ? scenario.steps
    : Array.isArray(scenario.requests)
      ? scenario.requests
      : [];
  const steps = rawSteps
    .map((step, stepIndex) => normalizeStep(step, scenarioIndex, stepIndex))
    .filter(Boolean);
  if (!steps.length) return null;
  return {
    id: scenario.id || `scenario-${scenarioIndex + 1}`,
    name: scenario.name || scenario.title || `Scenario ${scenarioIndex + 1}`,
    goal: String(scenario.goal || scenario.purpose || scenario.description || ''),
    authProfileId: String(scenario.authProfileId || '').trim(),
    steps,
  };
}

function extractPlanPayload(text) {
  const candidates = collectJsonCandidates(text);
  for (const candidate of candidates) {
    const rawScenarios = Array.isArray(candidate?.scenarios)
      ? candidate.scenarios
      : Array.isArray(candidate?.plan?.scenarios)
        ? candidate.plan.scenarios
        : Array.isArray(candidate?.tests)
          ? candidate.tests
          : Array.isArray(candidate)
            ? candidate
            : null;
    if (!rawScenarios) continue;
    const scenarios = rawScenarios
      .map((item, index) => normalizeScenario(item, index))
      .filter(Boolean);
    if (!scenarios.length) continue;
    return {
      scenarios,
      notes: Array.isArray(candidate?.notes) ? candidate.notes : [],
    };
  }
  return null;
}

function interpolateString(value, vars = {}) {
  return String(value || '').replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_match, key) => {
    const hit = vars[key];
    if (hit == null) return '';
    return String(hit);
  });
}

function interpolateValue(value, vars = {}) {
  if (typeof value === 'string') return interpolateString(value, vars);
  if (Array.isArray(value)) return value.map((item) => interpolateValue(item, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateValue(item, vars)]),
    );
  }
  return value;
}

function getAuthProfile(settings, authProfileId) {
  if (!authProfileId) return null;
  return (settings.authProfiles || []).find((item) => item.id === authProfileId) || null;
}

function buildAuthHeaders(profile) {
  if (!profile || !profile.token) return {};
  if (profile.type === 'bearer') return { Authorization: `Bearer ${profile.token}` };
  return {};
}

function resolveStepAuthProfile(settings, executionOptions, scenario, step) {
  if (executionOptions.forceNoAuth) return null;
  const overrideProfileId = String(executionOptions.overrideAuthProfileId || '').trim();
  if (overrideProfileId) return getAuthProfile(settings, overrideProfileId);
  const stepProfileId = String(step.authProfileId || '').trim();
  if (stepProfileId) return getAuthProfile(settings, stepProfileId);
  const scenarioProfileId = String(scenario.authProfileId || '').trim();
  if (scenarioProfileId) return getAuthProfile(settings, scenarioProfileId);
  return null;
}

function shouldTreatAsJsonBody(rawBody) {
  if (typeof rawBody !== 'string') return false;
  const trimmed = rawBody.trim();
  if (!trimmed) return false;
  return trimmed.startsWith('{') || trimmed.startsWith('[') || Boolean(parseJsonSafe(trimmed));
}

async function executeHttpStep({ settings, scenario, step, vars, executionOptions }) {
  const startedAt = new Date().toISOString();
  const interpolatedPath = interpolateString(step.path, vars);
  const path = extractPathFromUrl(interpolatedPath) || interpolatedPath;
  const url = /^https?:\/\//i.test(interpolatedPath)
    ? interpolatedPath
    : `${String(settings.baseUrl || '').replace(/\/$/, '')}${path}`;
  const profile = resolveStepAuthProfile(settings, executionOptions, scenario, step);

  const stepHeaders = interpolateValue(step.headers || {}, vars);
  const headers = {
    ...(stepHeaders && typeof stepHeaders === 'object' ? stepHeaders : {}),
    ...buildAuthHeaders(profile),
  };

  let rawBody = '';
  if (!['GET', 'HEAD'].includes(step.method)) {
    const bodyValue = interpolateValue(step.body, vars);
    if (typeof bodyValue === 'string') {
      rawBody = bodyValue;
    } else if (bodyValue != null && bodyValue !== '') {
      rawBody = JSON.stringify(bodyValue, null, 2);
    }
    if (rawBody && shouldTreatAsJsonBody(rawBody) && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }

  let response = null;
  let responseText = '';
  let responseJson = null;
  let transportError = '';
  try {
    response = await fetch(url, {
      method: step.method,
      headers,
      body: ['GET', 'HEAD'].includes(step.method) ? undefined : rawBody || undefined,
    });
    responseText = await response.text();
    responseJson = parseJsonSafe(responseText);
  } catch (error) {
    transportError = error.message || String(error);
  }
  const finishedAt = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    interfaceId: scenario.id,
    interfaceName: scenario.name,
    caseId: step.id,
    caseName: step.name,
    authProfileId: profile?.id || '',
    authProfileName: profile?.name || '',
    authSource: profile ? 'ai_selected' : 'none',
    method: step.method,
    path,
    url,
    startedAt,
    finishedAt,
    request: {
      headers,
      body: rawBody,
    },
    response: {
      httpStatus: response?.status ?? 0,
      bodyText: responseText,
      bodyJson: responseJson,
      transportError,
    },
    expected: {},
    retry: {
      attempted: false,
      count: 0,
      attempts: [],
    },
    pass: true,
    failures: [],
    assertionSummary: 'AI pending business judgement',
    aiStepReason: step.reason || scenario.goal || '',
  };
}

function flattenObjectToVars(obj, prefix, output) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const [key, value] of Object.entries(obj)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (value == null) continue;
    if (typeof value === 'object') {
      if (Array.isArray(value)) {
        if (value.length && value[0] && typeof value[0] === 'object') {
          flattenObjectToVars(value[0], `${nextKey}[0]`, output);
        } else if (value.length && (typeof value[0] === 'string' || typeof value[0] === 'number')) {
          output[nextKey] = value[0];
        }
      } else {
        flattenObjectToVars(value, nextKey, output);
      }
      continue;
    }
    output[nextKey] = value;
    if (/id$/i.test(key)) output.latestId = value;
    if (/code$/i.test(key)) output.latestCode = value;
    if (/referralcode/i.test(key)) output.referralCode = value;
  }
}

function updateVarsFromResult(vars, result, scenarioIndex, stepIndex) {
  const next = { ...vars };
  const prefix = `s${scenarioIndex + 1}.step${stepIndex + 1}`;
  const body = result.response?.bodyJson;
  const status = result.response?.httpStatus ?? 0;
  next[`${prefix}.httpStatus`] = status;
  if (body && typeof body === 'object') {
    flattenObjectToVars(body, `${prefix}.response`, next);
    if (body.data && typeof body.data === 'object') {
      flattenObjectToVars(body.data, 'data', next);
      flattenObjectToVars(body.data, `${prefix}.data`, next);
    }
    if (body.message != null) next.latestMessage = body.message;
    if (body.code != null) next.latestBusinessCode = body.code;
  }
  return next;
}

function buildDocContextText(docContexts) {
  const docs = Array.isArray(docContexts?.docs) ? docContexts.docs : [];
  if (!docs.length) return 'No uploaded documents.';
  const maxDocs = 4;
  return docs
    .slice(0, maxDocs)
    .map((doc, index) => {
      const filename = String(doc.filename || `doc-${index + 1}`);
      const content = String(doc.content || '').slice(0, 12000);
      const analysis = doc.analysis && typeof doc.analysis === 'object'
        ? `\n\n[analysis]\n${JSON.stringify(doc.analysis, null, 2)}`
        : '';
      return `### ${filename}\n${content}${analysis}`;
    })
    .join('\n\n');
}

function buildPlanningPrompt({
  settings,
  interfacesPayload,
  docContexts,
  runInstruction,
  runContext,
}) {
  const authProfiles = (settings.authProfiles || []).map((item) => ({
    id: item.id,
    name: item.name,
    type: item.type,
  }));
  const interfaces = (interfacesPayload.interfaces || []).map((item) => ({
    id: item.id,
    name: item.name,
    method: item.method,
    path: item.path,
    description: item.description,
    bodyTemplate: item.bodyTemplate,
  }));

  const globalInstruction = String(settings.ai?.globalInstruction || '').trim();
  return [
    'You are an API QA test agent. Build a BUSINESS-DRIVEN test plan.',
    'Do not rely on fixed HTTP/code/message assertions. Focus on business logic consistency and defect discovery.',
    'Output STRICT JSON only with this shape:',
    '{ "scenarios": [{ "id": "", "name": "", "goal": "", "authProfileId": "", "steps": [{ "id": "", "name": "", "method": "GET|POST|PUT|PATCH|DELETE", "path": "/api/.. or full url", "headers": {}, "body": {}, "reason": "" }] }], "notes": [] }',
    'Constraints:',
    '- Use baseUrl + relative path when possible.',
    '- Design precondition/data-preparation requests when needed.',
    '- Include positive, negative, boundary and state-transition checks.',
    '- Prefer realistic, non-hardcoded, reusable values.',
    '- Keep scenario count between 5 and 15.',
    '',
    `Base URL: ${settings.baseUrl || ''}`,
    `Auth profiles: ${JSON.stringify(authProfiles)}`,
    `Imported interfaces: ${JSON.stringify(interfaces)}`,
    '',
    `Global test instruction: ${globalInstruction || '(none)'}`,
    `Run-level instruction: ${String(runInstruction || '').trim() || '(none)'}`,
    `Run-level context: ${String(runContext || '').trim() || '(none)'}`,
    '',
    'Reference documents:',
    buildDocContextText(docContexts),
  ].join('\n');
}

function buildJudgePrompt({
  settings,
  docContexts,
  runInstruction,
  runContext,
  results,
}) {
  const globalInstruction = String(settings.ai?.globalInstruction || '').trim();
  const compactResults = results.map((item) => ({
    resultId: item.id,
    scenario: item.interfaceName,
    step: item.caseName,
    request: {
      method: item.method,
      path: item.path,
      headers: item.request?.headers,
      body: item.request?.body,
    },
    response: item.response?.bodyJson || item.response?.bodyText || {
      httpStatus: item.response?.httpStatus,
      transportError: item.response?.transportError,
    },
  }));

  return [
    'You are an API QA lead. Judge whether each executed step indicates a business bug.',
    'Do not use rigid HTTP status or static message matching as primary criterion.',
    'Use business context and cross-step consistency.',
    'Output STRICT JSON only with this shape:',
    '{ "summary": "", "judgements": [{ "resultId": "", "status": "pass|fail", "reason": "" }], "bugs": [{ "title": "", "severity": "high|medium|low", "description": "", "evidenceResultIds": [] }] }',
    '',
    `Global test instruction: ${globalInstruction || '(none)'}`,
    `Run-level instruction: ${String(runInstruction || '').trim() || '(none)'}`,
    `Run-level context: ${String(runContext || '').trim() || '(none)'}`,
    '',
    'Reference documents:',
    buildDocContextText(docContexts),
    '',
    'Executed results JSON:',
    JSON.stringify(compactResults, null, 2),
  ].join('\n');
}

function extractJudgePayload(text) {
  const candidates = collectJsonCandidates(text);
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    if (!Array.isArray(candidate.judgements)) continue;
    return {
      summary: String(candidate.summary || ''),
      judgements: candidate.judgements
        .filter((item) => item && typeof item === 'object' && item.resultId)
        .map((item) => ({
          resultId: String(item.resultId),
          status: String(item.status || '').toLowerCase() === 'fail' ? 'fail' : 'pass',
          reason: String(item.reason || ''),
        })),
      bugs: Array.isArray(candidate.bugs)
        ? candidate.bugs.map((item) => ({
          title: String(item?.title || ''),
          severity: ['high', 'medium', 'low'].includes(String(item?.severity || '').toLowerCase())
            ? String(item.severity).toLowerCase()
            : 'medium',
          description: String(item?.description || ''),
          evidenceResultIds: Array.isArray(item?.evidenceResultIds)
            ? item.evidenceResultIds.map((id) => String(id))
            : [],
        }))
        : [],
    };
  }
  return null;
}

function buildMarkdownFromJudge(judgePayload, results) {
  const lines = ['# AI Agent 测试报告', ''];
  lines.push('## 总结');
  lines.push(judgePayload.summary || '无');
  lines.push('');

  const bugs = judgePayload.bugs || [];
  lines.push('## 缺陷列表');
  if (!bugs.length) {
    lines.push('未识别到明确缺陷。');
  } else {
    for (const [index, bug] of bugs.entries()) {
      lines.push(`${index + 1}. [${bug.severity}] ${bug.title || '未命名缺陷'}`);
      lines.push(`   - 描述: ${bug.description || '-'}`);
      const evidence = (bug.evidenceResultIds || [])
        .map((id) => results.find((item) => item.id === id))
        .filter(Boolean)
        .map((item) => `${item.interfaceName} / ${item.caseName}`);
      lines.push(`   - 证据: ${evidence.length ? evidence.join(' ; ') : '-'}`);
    }
  }
  lines.push('');

  lines.push('## 逐步判定');
  for (const item of results) {
    lines.push(`- ${item.interfaceName} / ${item.caseName}: ${item.pass ? 'PASS' : 'FAIL'} | ${item.assertionSummary}`);
  }
  return lines.join('\n');
}

async function runAllWithAiAgent(
  settings,
  interfacesPayload,
  docContexts,
  executionOptions = {},
  runInstruction = '',
  runContext = '',
) {
  const ai = settings.ai || {};
  if (!ai.enabled || !hasAiTransportConfig(ai) || !hasAiCredential(ai)) {
    throw new Error('AI Agent mode requires valid AI settings.');
  }

  const planResponse = await callAiText(ai, {
    systemPrompt: 'You are a senior API QA autonomous agent.',
    userPrompt: buildPlanningPrompt({
      settings,
      interfacesPayload,
      docContexts,
      runInstruction,
      runContext,
    }),
  });
  if (!planResponse.ok) {
    throw new Error(`AI planning failed: ${planResponse.meta?.reason || 'unknown'}`);
  }

  const planPayload = extractPlanPayload(planResponse.text);
  if (!planPayload || !Array.isArray(planPayload.scenarios) || !planPayload.scenarios.length) {
    throw new Error('AI planning returned invalid JSON plan.');
  }

  let vars = {};
  const results = [];
  for (const [scenarioIndex, scenario] of planPayload.scenarios.entries()) {
    for (const [stepIndex, step] of scenario.steps.entries()) {
      // eslint-disable-next-line no-await-in-loop
      const result = await executeHttpStep({
        settings,
        scenario,
        step,
        vars,
        executionOptions,
      });
      results.push(result);
      vars = updateVarsFromResult(vars, result, scenarioIndex, stepIndex);
    }
  }

  const judgeResponse = await callAiText(ai, {
    systemPrompt: 'You are a principal API QA reviewer.',
    userPrompt: buildJudgePrompt({
      settings,
      docContexts,
      runInstruction,
      runContext,
      results,
    }),
  });

  let judgePayload = null;
  if (judgeResponse.ok) {
    judgePayload = extractJudgePayload(judgeResponse.text);
  }

  if (judgePayload) {
    const judgementMap = new Map(judgePayload.judgements.map((item) => [item.resultId, item]));
    for (const result of results) {
      const judged = judgementMap.get(result.id);
      if (!judged) {
        result.pass = true;
        result.failures = [];
        result.assertionSummary = 'AI judgement missing, default pass';
        continue;
      }
      result.pass = judged.status !== 'fail';
      result.failures = judged.status === 'fail' ? [judged.reason || 'AI judged as business defect'] : [];
      result.assertionSummary = judged.reason || (result.pass ? 'AI judged pass' : 'AI judged fail');
    }
  }

  const summary = {
    total: results.length,
    passed: results.filter((item) => item.pass).length,
    failed: results.filter((item) => !item.pass).length,
  };

  const markdown = judgePayload
    ? buildMarkdownFromJudge(judgePayload, results)
    : [
      '# AI Agent 测试报告',
      '',
      'AI 判定阶段失败，以下是执行摘要：',
      `- 总数: ${summary.total}`,
      `- 失败: ${summary.failed}`,
      `- 说明: ${judgeResponse?.meta?.reason || 'AI judgement unavailable'}`,
    ].join('\n');

  return {
    results,
    summary,
    markdown,
    provider: judgePayload ? 'remote-ai' : 'fallback',
    meta: {
      planMeta: planResponse.meta,
      judgeMeta: judgeResponse.meta,
      scenarioCount: planPayload.scenarios.length,
      noteCount: (planPayload.notes || []).length,
      runContextLength: String(runContext || '').length,
    },
  };
}

module.exports = {
  runAllWithAiAgent,
};
