const crypto = require('crypto');

function parseJsonSafe(text) {
  if (!text) return null;
  try {
    return JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function replacePathParams(template, params = {}) {
  return Object.entries(params).reduce((result, [key, value]) => {
    const stringValue = String(value);
    return result
      .replaceAll(`{{{${key}}}}`, stringValue)
      .replaceAll(`{{${key}}}`, stringValue);
  }, template);
}

function mergeHeaders(baseHeaders = {}, caseHeaders = {}) {
  return { ...baseHeaders, ...caseHeaders };
}

function hasHeader(headers, headerName) {
  const expected = String(headerName || '').toLowerCase();
  return Object.keys(headers || {}).some((key) => String(key).toLowerCase() === expected);
}

function shouldTreatAsJsonBody(rawBody) {
  if (typeof rawBody !== 'string') return false;
  const trimmed = rawBody.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return true;
  return parseJsonSafe(trimmed) != null;
}

function getAuthProfile(settings, authProfileId) {
  if (!authProfileId) return null;
  return settings.authProfiles.find((item) => item.id === authProfileId) || null;
}

function buildAuthHeaders(profile) {
  if (!profile || !profile.token) return {};
  if (profile.type === 'bearer') {
    return { Authorization: `Bearer ${profile.token}` };
  }
  return {};
}

function resolveExecutionProfile(settings, testCase, executionOptions = {}) {
  const overrideAuthProfileId = executionOptions.overrideAuthProfileId || '';
  if (executionOptions.forceNoAuth) {
    return {
      authProfileId: '',
      authProfileName: '',
      authSource: 'override_public',
      authHeaders: {},
    };
  }

  if (overrideAuthProfileId) {
    const overrideProfile = getAuthProfile(settings, overrideAuthProfileId);
    if (overrideProfile) {
      return {
        authProfileId: overrideProfile.id,
        authProfileName: overrideProfile.name,
        authSource: 'override',
        authHeaders: buildAuthHeaders(overrideProfile),
      };
    }
  }

  const caseProfile = getAuthProfile(settings, testCase.authProfileId);
  if (caseProfile) {
    return {
      authProfileId: caseProfile.id,
      authProfileName: caseProfile.name,
      authSource: 'case',
      authHeaders: buildAuthHeaders(caseProfile),
    };
  }

  return {
    authProfileId: '',
    authProfileName: '',
    authSource: 'none',
    authHeaders: {},
  };
}

function shouldExpectSuccess(expected = {}) {
  return expected.businessCode === 200;
}

function isDuplicateReferralCodeError(responseJson) {
  const message = String(responseJson?.message || '').toLowerCase();
  return message.includes('already taken') || message.includes('already exists') || message.includes('duplicate');
}

function buildUniqueReferralCode() {
  const timestampPart = Date.now().toString(36).toUpperCase().slice(-6);
  const randomPart = crypto.randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase();
  return `KU${timestampPart}${randomPart}`.slice(0, 12);
}

function maybeBuildRetryBody(rawBody, expected, responseJson) {
  if (!shouldExpectSuccess(expected)) return null;
  if (!isDuplicateReferralCodeError(responseJson)) return null;

  const parsedBody = parseJsonSafe(rawBody);
  if (!parsedBody || Array.isArray(parsedBody) || typeof parsedBody !== 'object') return null;
  if (typeof parsedBody.referralCode !== 'string' || !parsedBody.referralCode.trim()) return null;

  return {
    reason: 'referralCode already taken',
    body: JSON.stringify(
      {
        ...parsedBody,
        referralCode: buildUniqueReferralCode(),
      },
      null,
      2,
    ),
  };
}

function normalizeFieldKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isMetaFieldKey(normalizedKey) {
  return [
    'code',
    'status',
    'message',
    'msg',
    'success',
    'error',
    'errors',
    'timestamp',
    'path',
    'traceid',
    'requestid',
  ].includes(String(normalizedKey || ''));
}

function isLikelyEnvelopeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  const keys = Object.keys(value).map((key) => normalizeFieldKey(key)).filter(Boolean);
  if (!keys.length) return true;
  const businessKeys = keys.filter((key) => !isMetaFieldKey(key) && key !== 'data');
  return businessKeys.length === 0;
}

function isLikelyDataPreconditionError(responseJson) {
  const message = String(responseJson?.message || '').toLowerCase();
  if (!message) return false;
  return (
    message.includes('not found')
    || message.includes('required')
    || message.includes('does not exist')
    || message.includes('invalid')
    || message.includes('missing')
  );
}

function extractHintKeysFromMessage(message) {
  const text = String(message || '');
  if (!text) return [];

  const hints = new Set();
  const addToken = (token) => {
    const key = String(token || '').trim();
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      hints.add(key);
    }
  };

  const multiRequired = text.match(/([a-zA-Z_][a-zA-Z0-9_,\s]+)\s+are required/i);
  if (multiRequired?.[1]) {
    multiRequired[1]
      .split(',')
      .map((item) => item.replace(/\band\b/ig, '').trim())
      .filter(Boolean)
      .forEach(addToken);
  }

  const singlePatterns = [
    /([a-zA-Z_][a-zA-Z0-9_]*)\s+is required/i,
    /([a-zA-Z_][a-zA-Z0-9_]*)\s+not found/i,
    /([a-zA-Z_][a-zA-Z0-9_]*)\s+does not exist/i,
    /invalid\s+([a-zA-Z_][a-zA-Z0-9_]*)/i,
    /missing\s+([a-zA-Z_][a-zA-Z0-9_]*)/i,
  ];
  for (const pattern of singlePatterns) {
    const match = text.match(pattern);
    if (match?.[1]) addToken(match[1]);
  }

  return [...hints];
}

function collectCandidateObjects(responseJson) {
  const objects = [];
  const pushObject = (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && !isLikelyEnvelopeObject(value)) {
      objects.push(value);
    }
  };

  const pushArray = (value) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      pushObject(item);
    }
  };

  pushArray(responseJson?.data);
  pushArray(responseJson?.data?.list);
  pushArray(responseJson?.data?.items);
  pushArray(responseJson?.data?.records);
  pushObject(responseJson?.data);
  pushObject(responseJson?.data?.item);
  pushObject(responseJson?.data?.record);
  pushObject(responseJson?.data?.detail);
  pushArray(responseJson?.list);
  pushArray(responseJson?.items);
  pushArray(responseJson?.records);
  pushObject(responseJson?.item);
  pushObject(responseJson?.record);
  pushObject(responseJson?.detail);

  return objects;
}

function pickValueForTargetKey(targetKey, sourceObject) {
  const entries = Object.entries(sourceObject || {});
  const targetNorm = normalizeFieldKey(targetKey);
  if (!targetNorm) return undefined;

  for (const [key, value] of entries) {
    if (value == null || typeof value === 'object') continue;
    if (normalizeFieldKey(key) === targetNorm) {
      return value;
    }
  }

  const keyCandidates = entries
    .filter(([key, value]) => value != null && typeof value !== 'object' && !isMetaFieldKey(normalizeFieldKey(key)))
    .map(([key, value]) => ({ key, value, norm: normalizeFieldKey(key) }));

  if (targetNorm.endsWith('id')) {
    const prefix = targetNorm.slice(0, -2);
    const prefixed = keyCandidates.find((item) => item.norm.endsWith('id') && prefix && item.norm.includes(prefix));
    if (prefixed) return prefixed.value;
    const genericId = keyCandidates.find((item) => item.norm === 'id' || item.norm.endsWith('id'));
    if (genericId) return genericId.value;
    return undefined;
  }

  if (targetNorm.includes('code')) {
    const prefix = targetNorm.replace('code', '');
    const prefixed = keyCandidates.find((item) => item.norm.includes('code') && prefix && item.norm.includes(prefix));
    if (prefixed) return prefixed.value;
    const genericCode = keyCandidates.find((item) => item.norm === 'code' || item.norm.endsWith('code'));
    if (genericCode && typeof genericCode.value === 'string') return genericCode.value;
  }

  return undefined;
}

function resolveAdaptiveTargetKeys(parsedBody, messageHints) {
  const bodyKeys = Object.keys(parsedBody || {});
  const idOrCodeKeys = bodyKeys.filter((key) => /(id|code)/i.test(key));
  const resolved = new Set(idOrCodeKeys);

  for (const hint of messageHints || []) {
    const hintNorm = normalizeFieldKey(hint);
    if (!hintNorm) continue;
    const matched = bodyKeys.find((bodyKey) => {
      const bodyNorm = normalizeFieldKey(bodyKey);
      return bodyNorm === hintNorm || bodyNorm.includes(hintNorm) || hintNorm.includes(bodyNorm);
    });
    if (matched) resolved.add(matched);
  }

  return [...resolved];
}

function expectedMessageText(expected = {}) {
  return parseMessageIncludes(expected?.messageIncludes).join(' ').toLowerCase();
}

function shouldAllowNegativeWriteAdaptive(expected = {}) {
  const text = expectedMessageText(expected);
  if (!text) return false;
  if (/(not[\s-_]*found|不存在|未找到)/.test(text)) return false;
  return /(cannot|forbid|not allow|invalid|registration|register|inactive|disabled|frozen|pending|审核|注册|禁用|不可|不能)/.test(text);
}

function scoreNegativeCandidate(expected = {}, sourceObject = {}) {
  const text = expectedMessageText(expected);
  if (!text) return 0;

  let score = 0;
  const entries = Object.entries(sourceObject || {}).map(([key, value]) => [normalizeFieldKey(key), value]);
  const findValue = (regex) => entries.find(([key]) => regex.test(key))?.[1];

  if (/(registration|register|注册)/.test(text)) {
    const typeValue = findValue(/type|category|kind|source|role|mode/);
    if (typeValue != null) {
      const normalized = String(typeValue).toLowerCase();
      if (normalized === '1' || /register|registration|signup/.test(normalized)) score += 12;
      if (normalized === '2' || /affiliate|normal/.test(normalized)) score -= 8;
    }
  }

  if (/(inactive|disabled|frozen|关闭|禁用)/.test(text)) {
    const statusValue = findValue(/status|state|active|enabled|checkstatus|verify/);
    if (statusValue != null) {
      const normalized = String(statusValue).toLowerCase();
      if (['0', '1', 'true', 'active', 'enabled', 'normal', 'approved'].includes(normalized)) score -= 4;
      else score += 8;
    }
  }

  if (/(already default|已是默认)/.test(text)) {
    const isDefault = findValue(/isdefault|default/);
    if (String(isDefault) === '1' || String(isDefault).toLowerCase() === 'true') score += 8;
  }

  return score;
}

function buildCandidateSourceInterfaces(interfacesPayload, currentInterface) {
  const currentPath = String(currentInterface?.path || '');
  const currentPathParts = currentPath.split('/').filter(Boolean);
  const interfaces = Array.isArray(interfacesPayload?.interfaces) ? interfacesPayload.interfaces : [];

  const scored = interfaces
    .filter((item) => String(item?.method || '').toUpperCase() === 'GET')
    .map((item) => {
      const method = String(item?.method || '').toUpperCase();
      const path = String(item?.path || '');
      const text = `${item?.name || ''} ${path}`.toLowerCase();
      const pathParts = path.split('/').filter(Boolean);
      const sharedSegments = pathParts.filter((segment) => currentPathParts.includes(segment)).length;
      let score = sharedSegments;
      if (/(list|query|get|detail|info|search)/i.test(text)) score += 3;
      if (path === currentPath && method === String(currentInterface?.method || '').toUpperCase()) score -= 5;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 6).map((entry) => entry.item);
}

async function maybeBuildAdaptiveRetryBodies({
  settings,
  interfacesPayload,
  apiInterface,
  testCase,
  executionProfile,
  expected,
  rawBody,
  responseJson,
}) {
  if (!isLikelyDataPreconditionError(responseJson)) return [];

  const expectingSuccess = shouldExpectSuccess(expected);
  const method = String(apiInterface?.method || '').toUpperCase();
  const isWriteMethod = !['GET', 'HEAD'].includes(method);
  if (!expectingSuccess) {
    const hasExpectedMessage = parseMessageIncludes(expected?.messageIncludes).length > 0;
    if (!hasExpectedMessage) return [];
    if (isExpectedNotFoundCase(expected)) return [];
    if (isWriteMethod && !shouldAllowNegativeWriteAdaptive(expected)) return [];
  }

  const parsedBody = parseJsonSafe(rawBody);
  if (!parsedBody || Array.isArray(parsedBody) || typeof parsedBody !== 'object') return [];

  const messageHints = extractHintKeysFromMessage(responseJson?.message || '');
  const targetKeys = resolveAdaptiveTargetKeys(parsedBody, messageHints);
  if (!targetKeys.length) return [];

  const sourceInterfaces = buildCandidateSourceInterfaces(interfacesPayload, apiInterface);
  if (!sourceInterfaces.length) return [];

  const candidates = [];
  const seenBodies = new Set();
  const maxCandidates = expectingSuccess ? 8 : (isWriteMethod ? 1 : 2);
  const maxCollected = expectingSuccess ? maxCandidates : 24;

  for (const sourceInterface of sourceInterfaces) {
    const sourcePath = replacePathParams(sourceInterface.path || '', testCase.pathParams || {});
    if (sourcePath.includes('{{')) continue;

    const sourceUrl = `${settings.baseUrl.replace(/\/$/, '')}${sourcePath}`;
    const sourceHeaders = mergeHeaders(sourceInterface.headers || {}, executionProfile.authHeaders || {});
    // eslint-disable-next-line no-await-in-loop
    const sourceResult = await executeHttpRequest({
      method: 'GET',
      url: sourceUrl,
      headers: sourceHeaders,
      rawBody: '',
    });

    if (sourceResult.transportError) continue;
    const sourceObjects = collectCandidateObjects(sourceResult.responseJson);
    if (!sourceObjects.length) continue;

    for (const sourceObject of sourceObjects.slice(0, 10)) {
      const nextBody = { ...parsedBody };
      let changed = false;

      for (const targetKey of targetKeys) {
        const candidateValue = pickValueForTargetKey(targetKey, sourceObject);
        if (candidateValue == null) continue;
        if (!(targetKey in nextBody)) continue;
        if (nextBody[targetKey] !== candidateValue) {
          nextBody[targetKey] = candidateValue;
          changed = true;
        }
      }

      if (!changed) continue;

      const nextRawBody = JSON.stringify(nextBody, null, 2);
      if (nextRawBody.trim() === String(rawBody || '').trim()) continue;
      if (seenBodies.has(nextRawBody)) continue;
      seenBodies.add(nextRawBody);

      const candidate = {
        reason: `adaptive precondition repair via GET ${sourceInterface.path}`,
        body: nextRawBody,
        preflight: {
          sourceInterfaceId: sourceInterface.id,
          sourceInterfacePath: sourceInterface.path,
          hintKeys: targetKeys,
          sourceBusinessCode: sourceResult.responseJson?.code ?? null,
        },
      };

      if (!expectingSuccess) {
        const score = scoreNegativeCandidate(expected, sourceObject);
        if (score <= 0) continue;
        candidate.preflight.negativeScore = score;
      }

      candidates.push(candidate);

      if (candidates.length >= maxCandidates) {
        if (expectingSuccess) return candidates;
      }
      if (candidates.length >= maxCollected) {
        break;
      }
    }
    if (!expectingSuccess && candidates.length >= maxCollected) {
      break;
    }
  }

  if (!expectingSuccess) {
    return candidates
      .sort((a, b) => Number(b?.preflight?.negativeScore || 0) - Number(a?.preflight?.negativeScore || 0))
      .slice(0, maxCandidates);
  }

  return candidates;
}

async function executeHttpRequest({ method, url, headers, rawBody }) {
  let response;
  let responseText = '';
  let responseJson = null;
  let transportError = '';

  try {
    const requestHeaders = { ...headers };
    const requestInit = { method, headers: requestHeaders };

    if (!['GET', 'HEAD'].includes(method) && rawBody) {
      if (shouldTreatAsJsonBody(rawBody) && !hasHeader(requestHeaders, 'Content-Type')) {
        requestHeaders['Content-Type'] = 'application/json';
      }
      requestInit.body = rawBody;
    }

    response = await fetch(url, requestInit);
    responseText = await response.text();
    responseJson = parseJsonSafe(responseText);

    return {
      requestHeaders,
      rawBody,
      response,
      responseText,
      responseJson,
      transportError,
    };
  } catch (error) {
    transportError = error.message || String(error);
    return {
      requestHeaders: { ...headers },
      rawBody,
      response,
      responseText,
      responseJson,
      transportError,
    };
  }
}

function makeAssertionSummary(result) {
  if (result.pass) {
    if (result.retry?.attempted) {
      return `全部断言通过，已自动更换 referralCode 重试 ${result.retry.count} 次`;
    }
    return '全部断言通过';
  }
  return result.failures.join('；');
}

function parseMessageIncludes(expectedValue) {
  if (Array.isArray(expectedValue)) {
    return expectedValue
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  return String(expectedValue || '')
    .split('||')
    .map((item) => item.trim())
    .filter(Boolean);
}

function matchesExpectedMessage(expectedValue, actualMessage) {
  const patterns = parseMessageIncludes(expectedValue);
  if (!patterns.length) return true;
  const message = String(actualMessage || '');
  return patterns.some((pattern) => message.includes(pattern));
}

function isExpectedNotFoundCase(expected = {}) {
  const patterns = parseMessageIncludes(expected?.messageIncludes);
  if (!patterns.length) return false;
  const joined = patterns.join(' ').toLowerCase();
  return /(not[\s-_]*found|不存在|未找到)/.test(joined);
}

function collectFailures({ transportError, expected, response, responseJson, apiInterface, testCase }) {
  const failures = [];

  if (transportError) {
    failures.push(`请求发送失败：${transportError}`);
    return failures;
  }

  if (
    shouldExpectSuccess(expected)
    && Number(responseJson?.code) >= 400
    && isLikelyDataPreconditionError(responseJson)
  ) {
    failures.push(`precondition data issue: ${responseJson?.message || 'unknown data precondition error'}`);
    return failures;
  }
  if (expected.businessCode != null && responseJson?.code !== Number(expected.businessCode)) {
    failures.push(`业务码不匹配，期望 ${expected.businessCode}，实际 ${responseJson?.code}`);
  }

  if (!matchesExpectedMessage(expected.messageIncludes, responseJson?.message ?? '')) {
    const expectedPatterns = parseMessageIncludes(expected.messageIncludes).join(' | ');
    failures.push(`response message does not include expected patterns: ${expectedPatterns}`);
  }

  if (apiInterface.id === 'referral-list' && testCase.id === 'list-user374-default-first' && responseJson?.data?.length) {
    if (responseJson.data[0].is_default !== 1) {
      failures.push('用户 374 列表第一条不是默认邀请码');
    }
  }

  if (apiInterface.id === 'referral-list' && testCase.id === 'list-user375-created-desc' && responseJson?.data?.length) {
    const items = responseJson.data;
    const hasDefault = items.some((item) => item.is_default === 1);
    if (hasDefault) {
      failures.push('用户 375 在未设置默认邀请码时列表中出现了默认邀请码');
    } else {
      for (let index = 0; index < items.length - 1; index += 1) {
        if (Number(items[index].createdAt) < Number(items[index + 1].createdAt)) {
          failures.push('邀请码列表未按 createdAt 倒序排列');
          break;
        }
      }
    }
  }

  if (apiInterface.id === 'referral-code-info' && testCase.id === 'code-info-uppercase') {
    const walletAddress = responseJson?.data?.inviter?.wallet_address || '';
    if (!walletAddress.includes('...')) {
      failures.push('邀请码详情页邀请人地址未按要求脱敏展示');
    }
  }

  return failures;
}

async function runCase(settings, apiInterface, testCase, executionOptions = {}, interfacesPayload = { interfaces: [] }) {
  const path = replacePathParams(apiInterface.path, testCase.pathParams || {});
  const url = `${settings.baseUrl.replace(/\/$/, '')}${path}`;
  const executionProfile = resolveExecutionProfile(settings, testCase, executionOptions);
  const headers = mergeHeaders(
    mergeHeaders(apiInterface.headers, testCase.headers),
    executionProfile.authHeaders,
  );

  const method = apiInterface.method.toUpperCase();
  const initialRawBody = testCase.body || apiInterface.bodyTemplate || '';
  const expected = testCase.expected || {};
  const startedAt = new Date().toISOString();
  const attempts = [];

  let requestResult = await executeHttpRequest({
    method,
    url,
    headers,
    rawBody: initialRawBody,
  });

  attempts.push({
    reason: 'initial',
    request: {
      headers: requestResult.requestHeaders,
      body: requestResult.rawBody,
    },
    response: {
      httpStatus: requestResult.response?.status ?? 0,
      bodyText: requestResult.responseText,
      bodyJson: requestResult.responseJson,
      transportError: requestResult.transportError,
    },
  });

  const retryPayload = requestResult.transportError
    ? null
    : maybeBuildRetryBody(initialRawBody, expected, requestResult.responseJson);

  if (retryPayload) {
    requestResult = await executeHttpRequest({
      method,
      url,
      headers,
      rawBody: retryPayload.body,
    });

    attempts.push({
      reason: retryPayload.reason,
      request: {
        headers: requestResult.requestHeaders,
        body: requestResult.rawBody,
      },
      response: {
        httpStatus: requestResult.response?.status ?? 0,
        bodyText: requestResult.responseText,
        bodyJson: requestResult.responseJson,
        transportError: requestResult.transportError,
      },
    });
  }

  const adaptiveRetryPayloads = requestResult.transportError
    ? []
    : await maybeBuildAdaptiveRetryBodies({
      settings,
      interfacesPayload,
      apiInterface,
      testCase,
      executionProfile,
      expected,
      rawBody: requestResult.rawBody,
      responseJson: requestResult.responseJson,
    });

  if (adaptiveRetryPayloads.length) {
    for (const adaptiveRetryPayload of adaptiveRetryPayloads) {
      // eslint-disable-next-line no-await-in-loop
      requestResult = await executeHttpRequest({
        method,
        url,
        headers,
        rawBody: adaptiveRetryPayload.body,
      });

      attempts.push({
        reason: adaptiveRetryPayload.reason,
        preflight: adaptiveRetryPayload.preflight,
        request: {
          headers: requestResult.requestHeaders,
          body: requestResult.rawBody,
        },
        response: {
          httpStatus: requestResult.response?.status ?? 0,
          bodyText: requestResult.responseText,
          bodyJson: requestResult.responseJson,
          transportError: requestResult.transportError,
        },
      });

      const interimFailures = collectFailures({
        transportError: requestResult.transportError,
        expected,
        response: requestResult.response,
        responseJson: requestResult.responseJson,
        apiInterface,
        testCase,
      });

      if (interimFailures.length === 0) {
        break;
      }

      if (!shouldExpectSuccess(expected)) {
        const stillPreconditionError = isLikelyDataPreconditionError(requestResult.responseJson);
        const expectedCode = expected?.businessCode == null ? null : Number(expected.businessCode);
        const actualCode = Number(requestResult.responseJson?.code);
        if (!stillPreconditionError || (Number.isFinite(expectedCode) && actualCode !== expectedCode)) {
          break;
        }
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const { response, responseText, responseJson, transportError } = requestResult;
  const failures = collectFailures({
    transportError,
    expected,
    response,
    responseJson,
    apiInterface,
    testCase,
  });

  const retry = {
    attempted: attempts.length > 1,
    count: Math.max(0, attempts.length - 1),
    attempts,
  };

  return {
    id: crypto.randomUUID(),
    interfaceId: apiInterface.id,
    interfaceName: apiInterface.name,
    caseId: testCase.id,
    caseName: testCase.name,
    authProfileId: executionProfile.authProfileId,
    authProfileName: executionProfile.authProfileName,
    authSource: executionProfile.authSource,
    method,
    path,
    url,
    startedAt,
    finishedAt,
    request: {
      headers: requestResult.requestHeaders,
      body: requestResult.rawBody,
    },
    response: {
      httpStatus: response?.status ?? 0,
      bodyText: responseText,
      bodyJson: responseJson,
      transportError,
    },
    expected,
    retry,
    pass: failures.length === 0,
    failures,
    assertionSummary: makeAssertionSummary({
      pass: failures.length === 0,
      failures,
      retry,
    }),
  };
}

async function runAll(settings, interfacesPayload, executionOptions = {}) {
  const results = [];
  for (const apiInterface of interfacesPayload.interfaces) {
    for (const testCase of apiInterface.cases || []) {
      // eslint-disable-next-line no-await-in-loop
      const result = await runCase(settings, apiInterface, testCase, executionOptions, interfacesPayload);
      results.push(result);
    }
  }
  return results;
}

module.exports = {
  runAll,
};
