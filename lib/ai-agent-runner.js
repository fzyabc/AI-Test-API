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

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function applyPathParams(pathTemplate, pathParams = {}) {
  let output = String(pathTemplate || '');
  if (!output) return '';
  for (const [key, rawValue] of Object.entries(pathParams || {})) {
    if (rawValue == null) continue;
    const value = encodeURIComponent(String(rawValue));
    const token = escapeRegExp(key);
    output = output.replace(new RegExp(`{{{\\s*${token}\\s*}}}`, 'g'), value);
    output = output.replace(new RegExp(`{{\\s*${token}\\s*}}`, 'g'), value);
    output = output.replace(new RegExp(`:${token}\\b`, 'g'), value);
  }
  return output;
}

function normalizeStepBody(rawBody) {
  if (rawBody == null) return '';
  if (typeof rawBody !== 'string') return rawBody;
  const trimmed = rawBody.trim();
  if (!trimmed) return '';
  const parsed = parseJsonSafe(trimmed);
  if (parsed && typeof parsed === 'object') return parsed;
  return rawBody;
}

function buildPlanFromImportedCases(interfacesPayload) {
  const interfaces = Array.isArray(interfacesPayload?.interfaces) ? interfacesPayload.interfaces : [];
  const scenarios = interfaces
    .map((apiInterface, interfaceIndex) => {
      const cases = Array.isArray(apiInterface?.cases) ? apiInterface.cases : [];
      const interfaceHeaders = apiInterface?.headers && typeof apiInterface.headers === 'object' ? apiInterface.headers : {};
      const steps = cases
        .map((testCase, caseIndex) => {
          const caseHeaders = testCase?.headers && typeof testCase.headers === 'object' ? testCase.headers : {};
          const pathParams = testCase?.pathParams && typeof testCase.pathParams === 'object' ? testCase.pathParams : {};
          const path = applyPathParams(apiInterface.path || '', pathParams);
          if (!path) return null;
          return {
            id: testCase?.id || `scenario-${interfaceIndex + 1}-step-${caseIndex + 1}`,
            name: testCase?.name || `${apiInterface.method || 'GET'} ${path}`,
            method: normalizeMethod(apiInterface.method),
            path,
            headers: {
              ...interfaceHeaders,
              ...caseHeaders,
            },
            body: normalizeStepBody(testCase?.body),
            authProfileId: String(testCase?.authProfileId || '').trim(),
            reason: String(testCase?.description || apiInterface?.description || '').trim(),
          };
        })
        .filter(Boolean);

      if (!steps.length) return null;
      return {
        id: apiInterface?.id || `scenario-${interfaceIndex + 1}`,
        name: apiInterface?.name || `接口-${interfaceIndex + 1}`,
        goal: String(apiInterface?.description || '').trim(),
        authProfileId: '',
        steps,
      };
    })
    .filter(Boolean);

  return {
    scenarios,
    notes: ['执行计划来源：已导入接口与用例（逐条执行，不额外扩展步骤）。'],
  };
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
    assertionSummary: '等待 AI 业务判定',
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
  if (!docs.length) return '无已上传文档。';
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

function buildPlanningPrompt({ settings, interfacesPayload, docContexts, runInstruction, runContext }) {
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
    '你是 API 测试代理，请生成业务驱动的测试计划。',
    '不要依赖固定 HTTP/code/message 断言，要聚焦业务一致性和缺陷发现。',
    '仅输出严格 JSON，格式如下：',
    '{ "scenarios": [{ "id": "", "name": "", "goal": "", "authProfileId": "", "steps": [{ "id": "", "name": "", "method": "GET|POST|PUT|PATCH|DELETE", "path": "/api/.. or full url", "headers": {}, "body": {}, "reason": "" }] }], "notes": [] }',
    '约束：',
    '- 尽量使用 baseUrl + 相对路径。',
    '- 必要时包含前置数据准备请求。',
    '- 覆盖正向、反向、边界、状态流转。',
    '- 用真实且可复用的数据，不要写死。',
    '- 场景数控制在 5 到 15。',
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

function buildJudgePrompt({ settings, docContexts, runInstruction, runContext, results }) {
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
    '你是 API 测试负责人。请判断每个执行步骤是否暴露业务缺陷。',
    '不要把 HTTP 状态码或固定文案匹配当作主要判断标准。',
    '必须结合业务上下文与跨步骤一致性。',
    '仅输出严格 JSON，格式如下：',
    '{ "summary": "", "judgements": [{ "resultId": "", "status": "pass|fail", "reason": "" }], "bugs": [{ "title": "", "severity": "high|medium|low", "description": "", "evidenceResultIds": [] }] }',
    '要求：summary、reason、title、description 全部使用中文。',
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
    lines.push('未发现明确缺陷。');
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

  lines.push('## 执行明细');
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

  let planPayload = buildPlanFromImportedCases(interfacesPayload);
  let planMeta = {
    endpoint: 'local-plan',
    wireApi: 'local',
    status: 200,
    reason: '执行计划来自已导入用例。',
  };

  if (!planPayload || !Array.isArray(planPayload.scenarios) || !planPayload.scenarios.length) {
    const planResponse = await callAiText(ai, {
      systemPrompt: '你是资深 API 测试代理，仅输出中文 JSON。',
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
    const extracted = extractPlanPayload(planResponse.text);
    if (!extracted || !Array.isArray(extracted.scenarios) || !extracted.scenarios.length) {
      throw new Error('AI planning returned invalid JSON plan.');
    }
    planPayload = extracted;
    planMeta = planResponse.meta || planMeta;
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
    systemPrompt: '你是首席 API 测试评审，只能输出中文 JSON。',
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
        result.assertionSummary = 'AI 未返回该步骤判定，默认通过';
        continue;
      }
      result.pass = judged.status !== 'fail';
      result.failures = judged.status === 'fail' ? [judged.reason || 'AI 判定为业务缺陷'] : [];
      result.assertionSummary = judged.reason || (result.pass ? 'AI 判定通过' : 'AI 判定失败');
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
      'AI 判定阶段失败，以下为执行统计：',
      `- 总数: ${summary.total}`,
      `- 失败: ${summary.failed}`,
      `- 原因: ${judgeResponse?.meta?.reason || 'AI 判定不可用'}`,
    ].join('\n');

  return {
    results,
    summary,
    markdown,
    provider: judgePayload ? 'remote-ai' : 'fallback',
    meta: {
      planMeta,
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
