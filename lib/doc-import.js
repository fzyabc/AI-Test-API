const crypto = require('crypto');
const { parseJsonSafe, callAiText, hasAiCredential, normalizeAuthMode } = require('./ai-client');
const {
  findExampleBody,
  normalizeCaseBody,
  normalizeInterfaceBodyTemplate,
  parseTemplateBodyObject,
  stringifyBody,
} = require('./body-utils');

function slugify(value, fallback = 'item') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

function extractJsonCandidate(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  const direct = parseJsonSafe(trimmed);
  if (direct) return direct;

  const fencedBlocks = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const match of fencedBlocks) {
    const parsed = parseJsonSafe(match[1].trim());
    if (parsed) return parsed;
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const parsed = parseJsonSafe(trimmed.slice(firstBrace, lastBrace + 1));
    if (parsed) return parsed;
  }

  return null;
}

function collectJsonCandidates(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];

  const candidates = [];
  const seen = new Set();

  const pushCandidate = (value) => {
    if (!value || typeof value !== 'object') return;
    const signature = JSON.stringify(value);
    if (seen.has(signature)) return;
    seen.add(signature);
    candidates.push(value);
  };

  const direct = parseJsonSafe(trimmed);
  if (direct) pushCandidate(direct);

  const fencedBlocks = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const match of fencedBlocks) {
    const parsed = parseJsonSafe(match[1].trim());
    if (parsed) pushCandidate(parsed);
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const parsed = parseJsonSafe(trimmed.slice(firstBrace, lastBrace + 1));
    if (parsed) pushCandidate(parsed);
  }

  return candidates;
}

function looksLikeInterfaceShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const method = String(value.method || value.httpMethod || value.verb || '').toUpperCase();
  const path = String(value.path || value.url || value.endpoint || value.uri || '').trim();
  if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && path.startsWith('/')) return true;
  if (path.startsWith('/') && Array.isArray(value.cases || value.testCases || value.tests)) return true;
  return false;
}

function coerceInterfaceShape(value, index = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const method = String(value.method || value.httpMethod || value.verb || '').toUpperCase() || 'GET';
  const path = String(value.path || value.url || value.endpoint || value.uri || '').trim();
  if (!path.startsWith('/')) return null;

  return {
    ...value,
    id: value.id || `ai-interface-${index + 1}`,
    name: value.name || value.title || `${method} ${path}`,
    method,
    path,
    description: String(value.description || value.desc || ''),
    headers: value.headers || value.requestHeaders || {},
    bodyTemplate: value.bodyTemplate || value.requestBody || value.payload || value.body || '',
    cases: Array.isArray(value.cases)
      ? value.cases
      : Array.isArray(value.testCases)
        ? value.testCases
        : Array.isArray(value.tests)
          ? value.tests
          : [],
  };
}

function normalizeGeneratedPayloadShape(value) {
  if (typeof value === 'string') {
    const parsed = parseJsonSafe(value);
    return parsed ? normalizeGeneratedPayloadShape(parsed) : null;
  }
  if (!value || typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    const interfaces = value
      .map((item, index) => coerceInterfaceShape(item, index))
      .filter(Boolean);
    return interfaces.length ? { interfaces, notes: [] } : null;
  }

  if (Array.isArray(value.interfaces)) {
    const interfaces = value.interfaces
      .map((item, index) => coerceInterfaceShape(item, index))
      .filter(Boolean);
    if (!interfaces.length) return null;
    return {
      interfaces,
      notes: Array.isArray(value.notes) ? value.notes : [],
    };
  }

  if (typeof value.interfaces === 'string') {
    const parsedInterfaces = parseJsonSafe(value.interfaces);
    if (Array.isArray(parsedInterfaces)) {
      const interfaces = parsedInterfaces
        .map((item, index) => coerceInterfaceShape(item, index))
        .filter(Boolean);
      if (interfaces.length) return { interfaces, notes: [] };
    }
  }

  const arrayKeys = ['apis', 'apiList', 'endpoints', 'routes', 'items', 'list'];
  for (const key of arrayKeys) {
    if (!Array.isArray(value[key])) continue;
    const interfaces = value[key]
      .map((item, index) => coerceInterfaceShape(item, index))
      .filter(Boolean);
    if (interfaces.length) return { interfaces, notes: [] };
  }

  if (value.data && typeof value.data === 'object') {
    const nested = normalizeGeneratedPayloadShape(value.data);
    if (nested?.interfaces?.length) return nested;
  }

  if (value.interface && typeof value.interface === 'object') {
    const single = coerceInterfaceShape(value.interface, 0);
    if (single) return { interfaces: [single], notes: [] };
  }

  if (looksLikeInterfaceShape(value)) {
    const single = coerceInterfaceShape(value, 0);
    if (single) return { interfaces: [single], notes: [] };
  }

  return null;
}

function extractGeneratedPayloadFromText(text, settings) {
  const candidates = collectJsonCandidates(text);
  let best = null;
  for (const candidate of candidates) {
    const normalized = normalizeGeneratedPayloadShape(candidate);
    if (!normalized?.interfaces?.length) continue;
    if (!best || normalized.interfaces.length > best.interfaces.length) {
      best = normalized;
    }
  }

  if (best) return best;

  const fromText = buildFallbackInterfaces(settings, text);
  if (fromText.length) {
    return {
      interfaces: fromText,
      notes: ['Recovered interfaces from AI text using local parser.'],
    };
  }

  return null;
}

function normalizePath(pathValue) {
  return String(pathValue || '')
    .trim()
    .replace(/\{([a-zA-Z0-9_]+)\}/g, '{{$1}}')
    .replace(/:([a-zA-Z0-9_]+)/g, '{{$1}}');
}

function getPathParams(pathValue, provided = {}) {
  const params = { ...(provided || {}) };
  const matches = [...String(pathValue || '').matchAll(/{{([a-zA-Z0-9_]+)}}/g)];
  for (const match of matches) {
    if (params[match[1]] == null || params[match[1]] === '') {
      params[match[1]] = `sample-${match[1]}`;
    }
  }
  return params;
}

function normalizeExpected(expected = {}) {
  const businessCode =
    expected.businessCode == null || expected.businessCode === '' ? null : Number(expected.businessCode);

  return {
    businessCode: Number.isFinite(businessCode) ? businessCode : null,
    messageIncludes: String(expected.messageIncludes || ''),
  };
}

function stripAuthorizationHeader(headers) {
  if (!headers || typeof headers !== 'object') return {};
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => String(key).toLowerCase() !== 'authorization'),
  );
}

function buildSmokeCase(apiInterface, authProfileId, exampleBody = null) {
  return {
    id: `${apiInterface.id}-smoke`,
    name: '冒烟校验',
    description: '根据 API 文档自动生成，校验主成功路径。',
    authProfileId: authProfileId || '',
    pathParams: getPathParams(apiInterface.path),
    headers: {},
    body: exampleBody != null ? JSON.stringify(exampleBody, null, 2) : apiInterface.bodyTemplate || '',
    expected: {
      businessCode: 200,
      messageIncludes: '',
    },
  };
}

function buildValidationCase(apiInterface, authProfileId) {
  const parsed = parseTemplateBodyObject(apiInterface.bodyTemplate);
  if (!parsed || Array.isArray(parsed)) return null;

  const entries = Object.entries(parsed);
  if (!entries.length) return null;

  const [fieldToRemove] = entries[0];
  const mutated = { ...parsed };
  delete mutated[fieldToRemove];

  return {
    id: `${apiInterface.id}-validation`,
    name: '参数校验候选',
    description: `根据 API 文档自动生成，移除 "${fieldToRemove}" 探测参数校验行为。`,
    authProfileId: authProfileId || '',
    pathParams: getPathParams(apiInterface.path),
    headers: {},
    body: JSON.stringify(mutated, null, 2),
    expected: {
      businessCode: null,
      messageIncludes: '',
    },
  };
}

function isMutatingMethod(method) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase());
}

function isLikelyExistingResourceMutation(apiInterface) {
  const method = String(apiInterface?.method || '').toUpperCase();
  if (['PUT', 'PATCH', 'DELETE'].includes(method)) return true;
  if (method !== 'POST') return false;
  const text = `${apiInterface?.path || ''} ${apiInterface?.name || ''}`.toLowerCase();
  return /(update|delete|set|edit|modify|status|default|remark)/.test(text);
}

function collectIdLikeKeys(apiInterface) {
  const keys = new Set();

  const pathMatches = [...String(apiInterface?.path || '').matchAll(/{{([a-zA-Z0-9_]+)}}/g)];
  for (const match of pathMatches) {
    if (/(id|code)$/i.test(match[1])) keys.add(match[1]);
  }

  const bodyObject = parseTemplateBodyObject(apiInterface?.bodyTemplate || '');
  if (bodyObject && typeof bodyObject === 'object' && !Array.isArray(bodyObject)) {
    for (const key of Object.keys(bodyObject)) {
      if (/(id|code)$/i.test(key)) keys.add(key);
    }
  }

  return [...keys];
}

function isLikelyNotFoundCase(testCase) {
  const text = getCaseText(testCase);
  const expectedText = String(testCase?.expected?.messageIncludes || '').toLowerCase();
  return /(not[\s-_]*found|不存在|未找到|不存在的)/.test(`${text} ${expectedText}`);
}

function mutateToNonexistentValue(value, key, seed = 'NF404') {
  if (typeof value === 'number') return 999999999;
  if (typeof value === 'string') {
    if (/id$/i.test(key)) return `NONEXIST_ID_${seed}`;
    if (/code$/i.test(key)) return `NONEXIST_CODE_${seed}`;
    return `NONEXIST_${seed}`;
  }
  return value;
}

function buildNotFoundCase(apiInterface, authProfileId, sourceCases = []) {
  if (!isLikelyExistingResourceMutation(apiInterface)) return null;

  const bodySeed = findExampleBody(sourceCases, apiInterface?.bodyTemplate || '');
  if (!bodySeed || typeof bodySeed !== 'object' || Array.isArray(bodySeed)) return null;

  const candidateKeys = collectIdLikeKeys(apiInterface);
  if (!candidateKeys.length) return null;

  const body = { ...bodySeed };
  let changed = false;
  for (const key of candidateKeys) {
    if (!(key in body)) continue;
    const nextValue = mutateToNonexistentValue(body[key], key);
    if (nextValue !== body[key]) {
      body[key] = nextValue;
      changed = true;
    }
  }

  if (!changed) return null;

  return {
    id: `${apiInterface.id}-not-found`,
    name: 'resource not found',
    description: 'Auto-generated negative case for missing precondition data or non-existent resource id/code.',
    authProfileId: authProfileId || '',
    pathParams: getPathParams(apiInterface.path),
    headers: {},
    body: JSON.stringify(body, null, 2),
    expected: {
      businessCode: null,
      messageIncludes: 'not found||不存在||未找到',
    },
  };
}

function ensureCoverageCases(apiInterface, cases, defaultAuthProfileId, interfaceExampleBody = null) {
  const nextCases = [...(cases || [])];
  const hasSuccess = nextCases.some((item) => item?.expected?.businessCode === 200 || /success|happy|smoke|正常|成功/.test(getCaseText(item)));
  const hasValidation = nextCases.some((item) => /(required|missing|invalid|validation|参数|校验|格式)/.test(getCaseText(item)));
  const hasNotFound = nextCases.some((item) => isLikelyNotFoundCase(item));

  if (!hasSuccess && isMutatingMethod(apiInterface.method)) {
    nextCases.push(buildSmokeCase(apiInterface, defaultAuthProfileId, interfaceExampleBody));
  }

  if (!hasValidation) {
    const validationCase = buildValidationCase(apiInterface, defaultAuthProfileId);
    if (validationCase) nextCases.push(validationCase);
  }

  if (!hasNotFound) {
    const notFoundCase = buildNotFoundCase(apiInterface, defaultAuthProfileId, nextCases);
    if (notFoundCase) nextCases.push(notFoundCase);
  }

  return nextCases;
}

function getCaseText(testCase) {
  return `${testCase?.id || ''} ${testCase?.name || ''} ${testCase?.description || ''}`.toLowerCase();
}

function isLikelyPositiveCase(testCase) {
  const text = getCaseText(testCase);
  return (
    testCase?.expected?.businessCode === 200
    || testCase?.expected?.httpStatus === 200
    || /success|valid|smoke|happy|正常|成功|有效|冒烟/.test(text)
  );
}

function buildCaseSeed(testCase, index) {
  const base = `${testCase?.id || testCase?.name || 'case'}-${index + 1}`;
  return crypto.createHash('md5').update(base).digest('hex').toUpperCase().slice(0, 6);
}

function buildUniqueCode(seed) {
  return `KU${seed}`.slice(0, 12);
}

function mutateStringField(key, value, seed) {
  if (typeof value !== 'string' || !value.trim()) return value;

  if (/(referral|invite).?code|^code$/i.test(key)) {
    return buildUniqueCode(seed);
  }
  if (/remark|comment|note|channel|title|label|name|desc|description/i.test(key)) {
    return `${value}-${seed.slice(0, 4)}`;
  }
  if (/email/i.test(key)) {
    return `qa+${seed.toLowerCase()}@example.com`;
  }
  if (/mobile|phone/i.test(key)) {
    return `138${seed.replace(/[^0-9]/g, '').padEnd(8, '0').slice(0, 8)}`;
  }

  return value;
}

function diversifyPositiveCaseBody(testCase, index) {
  if (!isLikelyPositiveCase(testCase)) return testCase;

  const parsed = parseJsonSafe(testCase.body);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return testCase;

  const seed = buildCaseSeed(testCase, index);
  let changed = false;
  const nextBody = { ...parsed };

  for (const [key, value] of Object.entries(nextBody)) {
    const mutated = mutateStringField(key, value, seed);
    if (mutated !== value) {
      nextBody[key] = mutated;
      changed = true;
    }
  }

  if (!changed) return testCase;
  return {
    ...testCase,
    body: JSON.stringify(nextBody, null, 2),
  };
}

function diversifyCases(cases) {
  const usedBodies = new Set();

  return (cases || []).map((testCase, index) => {
    let nextCase = diversifyPositiveCaseBody(testCase, index);
    const normalizedBody = String(nextCase.body || '').trim();

    if (normalizedBody && usedBodies.has(normalizedBody) && isLikelyPositiveCase(nextCase)) {
      nextCase = diversifyPositiveCaseBody(
        {
          ...nextCase,
          id: `${nextCase.id || 'case'}-dup-${index + 1}`,
        },
        index + 7,
      );
    }

    if (nextCase.body) {
      usedBodies.add(String(nextCase.body).trim());
    }
    return nextCase;
  });
}

function sanitizeCase(input, apiInterface, authProfileIds, defaultAuthProfileId, interfaceExampleBody = null) {
  const caseId = slugify(input.id || input.name || `${apiInterface.id}-case`, `${apiInterface.id}-case`);
  const requestedAuthProfileId = String(input.authProfileId || '');
  const authProfileId = authProfileIds.has(requestedAuthProfileId)
    ? requestedAuthProfileId
    : input.requiresAuth === true
      ? defaultAuthProfileId
      : '';
  const fallbackExampleBody = interfaceExampleBody || parseTemplateBodyObject(apiInterface.bodyTemplate);

  return {
    id: caseId,
    name: String(input.name || '自动生成用例'),
    description: String(input.description || ''),
    authProfileId: String(input.requiresAuth === false ? '' : authProfileId || ''),
    pathParams: getPathParams(apiInterface.path, input.pathParams || {}),
    headers: stripAuthorizationHeader(typeof input.headers === 'object' && input.headers ? input.headers : {}),
    body: normalizeCaseBody(input.body, fallbackExampleBody),
    expected: normalizeExpected(input.expected || {}),
  };
}

function sanitizeInterface(input, settings) {
  const method = String(input.method || 'GET').toUpperCase();
  const path = normalizePath(input.path);
  const authProfileIds = new Set((settings.authProfiles || []).map((item) => item.id));
  const defaultAuthProfileId = input.requiresAuth === true ? settings.authProfiles?.[0]?.id || '' : '';
  const interfaceExampleBody = findExampleBody(input.cases || [], input.bodyTemplate);

  const apiInterface = {
    id: slugify(input.id || `${method}-${path}`, crypto.randomUUID()),
    name: String(input.name || `${method} ${path}`),
    method,
    path,
    description: String(input.description || ''),
    headers: stripAuthorizationHeader(typeof input.headers === 'object' && input.headers ? input.headers : {}),
    bodyTemplate: normalizeInterfaceBodyTemplate(input.bodyTemplate, input.cases || []),
    cases: [],
  };

  const generatedCases = Array.isArray(input.cases)
    ? input.cases.map((item) => sanitizeCase(item, apiInterface, authProfileIds, defaultAuthProfileId, interfaceExampleBody))
    : [];

  const baseCases = generatedCases.length ? generatedCases : [buildSmokeCase(apiInterface, defaultAuthProfileId, interfaceExampleBody)];
  const cases = ensureCoverageCases(apiInterface, baseCases, defaultAuthProfileId, interfaceExampleBody);

  const usedCaseIds = new Set();
  apiInterface.cases = diversifyCases(cases)
    .filter((item) => item && item.name)
    .map((item) => {
      let caseId = item.id;
      let counter = 1;
      while (usedCaseIds.has(caseId)) {
        counter += 1;
        caseId = `${item.id}-${counter}`;
      }
      usedCaseIds.add(caseId);
      return { ...item, id: caseId };
    });

  return apiInterface;
}

function extractPathFromEndpointToken(token) {
  let value = String(token || '').trim();
  if (!value) return '';
  value = value.replace(/^['"`]+|['"`]+$/g, '');
  value = value.replace(/[),.;]+$/g, '');

  if (value.startsWith('/')) {
    return normalizePath(value);
  }

  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return normalizePath(parsed.pathname || '/');
    } catch {
      return '';
    }
  }

  return '';
}

function buildFallbackInterfaces(settings, content) {
  const text = String(content || '');
  const authDefault = settings.authProfiles?.[0]?.id || '';
  const matches = [
    ...text.matchAll(/(?:^|\n)\s*(?:[#>*-]|\d+[.)])?\s*(GET|POST|PUT|DELETE|PATCH)\s*[:：]?\s*`?((?:https?:\/\/|\/)[^\s`"'<>()]+)`?/gim),
    ...text.matchAll(/(?:^|\n)\s*(?:[#>*-]|\d+[.)])?\s*(GET|POST|PUT|DELETE|PATCH)\s*[:：]?\s*`?((?:https?:\/\/|\/)[^\s`"'<>()]+)`?/gim),
    ...Array.from(
      text.matchAll(/curl[\s\S]{0,400}?['"]((?:https?:\/\/)[^'"`\s]+)['"][\s\S]{0,400}?-X\s+['"]?(GET|POST|PUT|DELETE|PATCH)['"]?/gim),
      (item) => [item[0], item[2], item[1], item.index],
    ),
    ...text.matchAll(/curl[\s\S]{0,400}?-X\s+['"]?(GET|POST|PUT|DELETE|PATCH)['"]?[\s\S]{0,400}?['"]((?:https?:\/\/)[^'"`\s]+)['"]/gim),
  ];

  const parsedDoc = parseJsonSafe(text.trim()) || extractJsonCandidate(text);
  if (parsedDoc && typeof parsedDoc === 'object' && parsedDoc.paths && typeof parsedDoc.paths === 'object') {
    for (const [rawPath, methodMap] of Object.entries(parsedDoc.paths)) {
      if (!rawPath || typeof methodMap !== 'object') continue;
      for (const methodKey of Object.keys(methodMap || {})) {
        const method = String(methodKey || '').toUpperCase();
        if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) continue;
        matches.push(['openapi', method, rawPath, 0]);
      }
    }
  }

  const interfaces = [];
  const seenInterfaceKeys = new Set();

  for (const match of matches) {
    const method = String(match[1] || '').toUpperCase();
    const path = extractPathFromEndpointToken(match[2]);
    if (!path) continue;
    const interfaceKey = `${method} ${path}`;
    if (seenInterfaceKeys.has(interfaceKey)) continue;
    seenInterfaceKeys.add(interfaceKey);
    const matchIndex = Number.isFinite(match?.index) ? match.index : Number(match?.[3] || 0);
    const context = text.slice(matchIndex, matchIndex + 1600);
    const needsAuth = /authorization|bearer|token/i.test(context);
    const jsonBlocks = [...context.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
    const bodyTemplate =
      method === 'GET' || method === 'DELETE'
        ? ''
        : jsonBlocks.find((item) => parseJsonSafe(item[1].trim()))
          ? jsonBlocks.find((item) => parseJsonSafe(item[1].trim()))[1].trim()
          : '';

    const normalizedBodyTemplate = normalizeInterfaceBodyTemplate(bodyTemplate);
    const interfaceExampleBody = findExampleBody([], bodyTemplate);

    const apiInterface = {
      id: slugify(`${method}-${path}`),
      name: `${method} ${path}`,
      method,
      path,
      description: 'Generated by local fallback parser from uploaded API document.',
      headers: bodyTemplate ? { 'Content-Type': 'application/json' } : {},
      bodyTemplate: normalizedBodyTemplate,
      cases: [
        {
          id: `${slugify(`${method}-${path}`)}-smoke`,
          name: '冒烟校验',
          description: '本地兜底解析生成的冒烟用例。',
          authProfileId: needsAuth ? authDefault : '',
          pathParams: getPathParams(path),
          headers: {},
          body:
            interfaceExampleBody != null
              ? JSON.stringify(interfaceExampleBody, null, 2)
              : normalizeCaseBody(stringifyBody(bodyTemplate), parseTemplateBodyObject(normalizedBodyTemplate)),
          expected: {
            businessCode: 200,
            messageIncludes: '',
          },
        },
      ],
    };

    const validationCase = needsAuth ? null : buildValidationCase(apiInterface, '');
    if (validationCase) {
      apiInterface.cases.push(validationCase);
    }

    interfaces.push(apiInterface);
  }

  return interfaces;
}

function buildImportFallback(settings, doc) {
  const interfaces = buildFallbackInterfaces(settings, doc.content);
  return {
    interfaces,
    notes: interfaces.length
      ? ['AI 不可用或返回内容无效，已使用本地解析兜底。']
      : ['没有识别到接口，请检查文档中是否包含类似 "POST /api/example" 的接口定义。'],
  };
}

async function tryRepairPayloadWithAi(settings, text) {
  const ai = settings.ai || {};
  const repairPrompt = [
    'Convert the following model output into strict JSON only.',
    'Output must be a single JSON object with shape:',
    '{ "interfaces": [{ "id": "", "name": "", "method": "GET|POST|PUT|DELETE|PATCH", "path": "/...", "description": "", "headers": {}, "bodyTemplate": "", "cases": [] }], "notes": [] }',
    'Rules:',
    '- Do not include markdown code fences.',
    '- method must be uppercase.',
    '- path must start with "/".',
    '- Keep original semantics and endpoint names when possible.',
    '',
    'Input to repair:',
    String(text || ''),
  ].join('\n');

  const repair = await callAiText(ai, {
    systemPrompt: 'You are a JSON normalizer for API import.',
    userPrompt: repairPrompt,
  });

  if (!repair.ok) {
    return {
      ok: false,
      payload: null,
      text: String(repair.text || ''),
      raw: repair.raw,
      meta: repair.meta,
      reason: repair.meta?.reason || 'Repair call failed.',
    };
  }

  const repairedPayload = extractGeneratedPayloadFromText(repair.text, settings);
  if (repairedPayload?.interfaces?.length) {
    return {
      ok: true,
      payload: repairedPayload,
      text: String(repair.text || ''),
      raw: repair.raw,
      meta: repair.meta,
      reason: '',
    };
  }

  return {
    ok: false,
    payload: null,
    text: String(repair.text || ''),
    raw: repair.raw,
    meta: {
      ...(repair.meta || {}),
      usedFallback: true,
    },
    reason: 'Repair output is still not a valid interface payload.',
  };
}

async function requestAiGeneration(settings, doc) {
  const ai = settings.ai || {};
  const authMode = normalizeAuthMode(ai);
  const hasTransportConfig = authMode === 'oos' ? true : Boolean(String(ai.url || '').trim());
  if (!ai.enabled || !hasTransportConfig || !hasAiCredential(ai)) {
    return {
      provider: 'fallback',
      payload: buildImportFallback(settings, doc),
      raw: null,
      meta: {
        endpoint: '',
        wireApi: String(ai.wireApi || 'auto'),
        usedFallback: true,
        reason: 'AI 配置不完整，已使用本地解析兜底。',
      },
    };
  }

  const prompt = [
    '你是 API 测试设计助手。',
    '请阅读上传的 API 文档，并且只返回合法 JSON，不要输出 markdown。',
    '请为 API 测试平台生成接口定义和测试用例。',
    '严格使用以下 JSON 结构：',
    '{ "interfaces": [{ "id": "", "name": "", "method": "GET|POST|PUT|DELETE|PATCH", "path": "", "description": "", "headers": {}, "bodyTemplate": "", "requiresAuth": true, "cases": [{ "id": "", "name": "", "description": "", "authProfileId": "", "requiresAuth": true, "pathParams": {}, "headers": {}, "body": "", "expected": { "businessCode": 200, "messageIncludes": "" } }] }], "notes": [] }',
    '规则：',
    '- bodyTemplate 表示接口请求模板；cases.body 表示实际执行请求体。',
    '- 字符串占位符必须保留双引号，例如 "referralCode": "{{referralCode}}"。',
    '- 数字或布尔占位符不要加双引号，例如 "personalRebate": {{personalRebate}}。',
    '- 每个接口尽量生成 2 到 5 条用例。',
    '- 不要把 API 文档里的示例值原封不动复制到所有用例里；成功用例之间要使用不同的测试数据。',
    '- 如果字段看起来像唯一值，例如 referralCode、inviteCode、code、email，成功用例要使用不同值。',
    '- 如果文档里给的是请求示例，请把 bodyTemplate 转成占位符模板，同时把 case.body 保留成具体请求值。',
    '- 如果路径中存在参数，请把 {id} 或 :id 转成 {{id}}。',
    '- 如果预期结果不明确，请把 businessCode 留空，不要猜。',
    '- authProfileId 必须为空，或者只能取下面可用账号中的某一个。',
    '- 不要在 interface.headers 或 case.headers 中生成 Authorization，认证统一通过 authProfileId 表达。',
    '- 不要生成 Bearer valid-token、Bearer {{token}} 这类占位 Authorization 头。' ,
    '- For update/delete/set-default style APIs, include success + validation + not-found coverage.',
    '- Use id/code fields to build a non-existent-resource case so precondition gaps are explicitly tested.',

    `可用账号: ${JSON.stringify((settings.authProfiles || []).map((item) => ({ id: item.id, name: item.name })))}`,
    '',
    `文件名: ${doc.filename || 'uploaded-document.txt'}`,
    '文档内容:',
    doc.content,
  ].join('\n');

  const response = await callAiText(ai, {
    systemPrompt: '只返回合法 JSON，不要输出解释。',
    userPrompt: prompt,
  });

  if (!response.ok) {
    return {
      provider: 'fallback',
      payload: buildImportFallback(settings, doc),
      raw: response.raw,
      meta: response.meta,
    };
  }

  const extracted = extractGeneratedPayloadFromText(response.text, settings);
  if (!extracted?.interfaces?.length) {
    const repaired = await tryRepairPayloadWithAi(settings, response.text);
    if (repaired.ok && repaired.payload?.interfaces?.length) {
      return {
        provider: 'remote-ai',
        payload: {
          ...repaired.payload,
          notes: [
            ...(repaired.payload.notes || []),
            'Primary AI output required JSON repair and was normalized successfully.',
          ],
        },
        raw: {
          primary: response.raw,
          repair: repaired.raw,
        },
        meta: {
          ...response.meta,
          repaired: true,
          repairMeta: repaired.meta,
        },
      };
    }

    return {
      provider: 'fallback',
      payload: buildImportFallback(settings, doc),
      raw: {
        primary: response.raw,
        repair: repaired.raw,
      },
      meta: {
        ...response.meta,
        usedFallback: true,
        repaired: false,
        repairMeta: repaired.meta,
        reason: `AI returned content but not a valid interface payload at ${response.meta.endpoint} [${response.meta.wireApi}]. Repair failed: ${repaired.reason || 'unknown'}`,
        primaryPreview: String(response.text || '').slice(0, 1200),
        repairPreview: String(repaired.text || '').slice(0, 1200),
      },
    };
    return {
      provider: 'fallback',
      payload: buildImportFallback(settings, doc),
      raw: response.raw,
      meta: {
        ...response.meta,
        usedFallback: true,
        reason: `AI 已返回内容，但不是合法的接口 JSON。地址: ${response.meta.endpoint} [${response.meta.wireApi}]`,
      },
    };
  }

  return {
    provider: 'remote-ai',
    payload: extracted,
    raw: response.raw,
    meta: response.meta,
  };
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function extractDocAnalysisPayload(text) {
  const candidates = collectJsonCandidates(text);
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const summary = String(candidate.summary || candidate.overview || candidate.brief || '').trim();
    const businessRules = normalizeStringList(candidate.businessRules || candidate.rules);
    const preconditions = normalizeStringList(candidate.preconditions || candidate.dependencies);
    const riskAreas = normalizeStringList(candidate.riskAreas || candidate.risks);
    const testStrategy = normalizeStringList(candidate.testStrategy || candidate.testingStrategy || candidate.strategies);
    const dataHints = normalizeStringList(candidate.dataHints || candidate.testData || candidate.dataConstraints);
    if (!summary && !businessRules.length && !preconditions.length && !riskAreas.length && !testStrategy.length && !dataHints.length) {
      continue;
    }
    return {
      summary,
      businessRules,
      preconditions,
      riskAreas,
      testStrategy,
      dataHints,
    };
  }
  return null;
}

function buildDocAnalysisFallback(doc) {
  const content = String(doc?.content || '').trim();
  return {
    summary: content ? content.slice(0, 300) : '',
    businessRules: [],
    preconditions: [],
    riskAreas: [],
    testStrategy: [],
    dataHints: [],
  };
}

async function requestAiDocAnalysis(settings, doc) {
  const ai = settings.ai || {};
  const authMode = normalizeAuthMode(ai);
  const hasTransportConfig = authMode === 'oos' ? true : Boolean(String(ai.url || '').trim());
  if (!ai.enabled || !hasTransportConfig || !hasAiCredential(ai)) {
    return {
      provider: 'fallback',
      analysis: buildDocAnalysisFallback(doc),
      raw: null,
      meta: {
        endpoint: '',
        wireApi: String(ai.wireApi || 'auto'),
        usedFallback: true,
        reason: 'AI is disabled or not configured for document analysis.',
      },
    };
  }

  const prompt = [
    'You are a senior API QA analyst.',
    'Analyze the uploaded document deeply for BUSINESS testing.',
    'Output STRICT JSON only with this shape:',
    '{ "summary": "", "businessRules": [], "preconditions": [], "riskAreas": [], "testStrategy": [], "dataHints": [] }',
    'Rules:',
    '- Do not output markdown.',
    '- Focus on business constraints, state transitions, and hidden dependencies.',
    '- Include concrete test strategy guidance, not endpoint extraction.',
    '',
    `Filename: ${doc.filename || 'uploaded-document.txt'}`,
    'Document content:',
    String(doc.content || ''),
  ].join('\n');

  const response = await callAiText(ai, {
    systemPrompt: 'You produce strict JSON for API QA document analysis.',
    userPrompt: prompt,
  });

  if (!response.ok) {
    return {
      provider: 'fallback',
      analysis: buildDocAnalysisFallback(doc),
      raw: response.raw,
      meta: {
        ...(response.meta || {}),
        usedFallback: true,
      },
    };
  }

  const analysis = extractDocAnalysisPayload(response.text);
  if (!analysis) {
    return {
      provider: 'fallback',
      analysis: buildDocAnalysisFallback(doc),
      raw: response.raw,
      meta: {
        ...(response.meta || {}),
        usedFallback: true,
        reason: `AI returned content but not a valid analysis JSON at ${response.meta?.endpoint || '-'} [${response.meta?.wireApi || '-'}]`,
      },
    };
  }

  return {
    provider: 'remote-ai',
    analysis,
    raw: response.raw,
    meta: response.meta,
  };
}

function mergeInterfaces(existingPayload, generatedInterfaces) {
  const payload = {
    interfaces: [...(existingPayload.interfaces || [])],
  };
  const counters = {
    addedInterfaces: 0,
    mergedInterfaces: 0,
    addedCases: 0,
  };

  for (const candidate of generatedInterfaces) {
    const existing = payload.interfaces.find(
      (item) => item.id === candidate.id || (item.method === candidate.method && item.path === candidate.path),
    );

    if (!existing) {
      payload.interfaces.push(candidate);
      counters.addedInterfaces += 1;
      counters.addedCases += candidate.cases.length;
      continue;
    }

    counters.mergedInterfaces += 1;
    existing.name = candidate.name || existing.name;
    existing.description = candidate.description || existing.description;
    existing.headers = candidate.headers || existing.headers || {};
    existing.bodyTemplate = candidate.bodyTemplate || existing.bodyTemplate || '';

    for (const testCase of candidate.cases) {
      const existingCaseIndex = (existing.cases || []).findIndex(
        (item) => item.id === testCase.id || item.name === testCase.name,
      );
      if (existingCaseIndex === -1) {
        existing.cases = [...(existing.cases || []), testCase];
        counters.addedCases += 1;
        continue;
      }

      existing.cases[existingCaseIndex] = {
        ...existing.cases[existingCaseIndex],
        ...testCase,
        id: existing.cases[existingCaseIndex].id || testCase.id,
      };
    }
  }

  return { payload, counters };
}

async function importApiDocument(settings, existingPayload, doc) {
  const [generation, analysis] = await Promise.all([
    requestAiGeneration(settings, doc),
    requestAiDocAnalysis(settings, doc),
  ]);
  const sanitizedInterfaces = (generation.payload.interfaces || [])
    .map((item) => sanitizeInterface(item, settings))
    .filter((item) => item.path);
  const { payload, counters } = mergeInterfaces(existingPayload, sanitizedInterfaces);

  return {
    payload,
    provider: generation.provider,
    notes: generation.payload.notes || [],
    analysis: analysis.analysis,
    raw: generation.raw,
    meta: {
      ...(generation.meta || {}),
      analysisMeta: analysis.meta || null,
      analysisProvider: analysis.provider,
    },
    ...counters,
    recognizedInterfaces: sanitizedInterfaces.length,
  };
}

module.exports = {
  importApiDocument,
};
