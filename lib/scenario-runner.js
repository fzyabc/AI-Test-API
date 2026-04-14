const crypto = require("crypto");
const { runCase } = require("./runner");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonSafe(text) {
  if (text == null || text === "") return null;
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(String(text).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function getByPath(root, path) {
  if (path == null || path === "" || path === "$") return root;
  const raw = String(path || "").trim();
  if (!raw) return root;

  const normalized = raw.replace(/^\$\.?/, "");
  if (!normalized) return root;

  const tokens = normalized
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((item) => item.trim())
    .filter(Boolean);

  let current = root;
  for (const token of tokens) {
    if (current == null) return undefined;
    current = current[token];
  }
  return current;
}

function interpolateString(template, variables) {
  return String(template || "").replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_m, key) => {
    const value = getByPath(variables, key);
    return value == null ? "" : String(value);
  });
}

function interpolateValue(value, variables) {
  if (typeof value === "string") {
    const directMatch = value.match(/^{{\s*([a-zA-Z0-9_.-]+)\s*}}$/);
    if (directMatch) {
      const directValue = getByPath(variables, directMatch[1]);
      return directValue == null ? "" : directValue;
    }
    return interpolateString(value, variables);
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolateValue(item, variables));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, interpolateValue(child, variables)]),
    );
  }

  return value;
}

function stringifyBody(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function getScenarioStepInterface(interfacesPayload, interfaceId) {
  return (interfacesPayload.interfaces || []).find((item) => item.id === interfaceId) || null;
}

function getScenarioStepCase(apiInterface, caseId) {
  return (apiInterface?.cases || []).find((item) => item.id === caseId) || null;
}

function getTimestampMs(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function computeDurationMs(startedAt, finishedAt) {
  const start = getTimestampMs(startedAt);
  const end = getTimestampMs(finishedAt);
  if (start == null || end == null) return null;
  return Math.max(0, end - start);
}

function normalizeStepOnFailure(step = {}) {
  const raw = String(step.onFailure || "")
    .trim()
    .toLowerCase();
  if (["stop", "continue", "jump"].includes(raw)) return raw;
  return step.stopOnFailure === false ? "continue" : "stop";
}

function buildScenarioRunSummary(stepResults = []) {
  const total = stepResults.length;
  const skipped = stepResults.filter((item) => item.skipped).length;
  const passed = stepResults.filter((item) => item.pass && !item.skipped).length;
  const failed = stepResults.filter((item) => !item.pass && !item.skipped).length;
  const executed = total - skipped;
  return {
    total,
    executed,
    passed,
    failed,
    skipped,
  };
}

function buildAssertionFailure(message, fallback) {
  return message || fallback;
}

function normalizeAssertionType(type) {
  return String(type || "exists")
    .trim()
    .toLowerCase();
}

function toComparableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function evaluateAssertion(assertion, context) {
  const actual = getByPath(context, assertion.path || "$");
  const expected = assertion.expected;
  const type = normalizeAssertionType(assertion.type);

  switch (type) {
    case "equals":
      return actual === expected
        ? null
        : buildAssertionFailure(
            assertion.message,
            `断言失败: ${assertion.path} expected ${JSON.stringify(expected)} actual ${JSON.stringify(actual)}`,
          );
    case "contains": {
      const text = actual == null ? "" : String(actual);
      return text.includes(String(expected ?? ""))
        ? null
        : buildAssertionFailure(
            assertion.message,
            `断言失败: ${assertion.path} 不包含 ${JSON.stringify(expected)}`,
          );
    }
    case "regex": {
      try {
        const pattern = expected instanceof RegExp ? expected : new RegExp(String(expected ?? ""));
        return pattern.test(String(actual ?? ""))
          ? null
          : buildAssertionFailure(
              assertion.message,
              `断言失败: ${assertion.path} 不匹配正则 ${String(pattern)}`,
            );
      } catch {
        return buildAssertionFailure(assertion.message, `断言失败: 非法正则 ${JSON.stringify(expected)}`);
      }
    }
    case "length": {
      const actualLength = Array.isArray(actual) || typeof actual === "string"
        ? actual.length
        : actual && typeof actual === "object"
          ? Object.keys(actual).length
          : null;
      return actualLength === Number(expected)
        ? null
        : buildAssertionFailure(
            assertion.message,
            `断言失败: ${assertion.path} length expected ${Number(expected)} actual ${actualLength}`,
          );
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const actualNumber = toComparableNumber(actual);
      const expectedNumber = toComparableNumber(expected);
      if (actualNumber == null || expectedNumber == null) {
        return buildAssertionFailure(
          assertion.message,
          `断言失败: ${assertion.path} 无法做数值比较`,
        );
      }
      const compareMap = {
        gt: actualNumber > expectedNumber,
        gte: actualNumber >= expectedNumber,
        lt: actualNumber < expectedNumber,
        lte: actualNumber <= expectedNumber,
      };
      return compareMap[type]
        ? null
        : buildAssertionFailure(
            assertion.message,
            `断言失败: ${assertion.path} ${type} ${expectedNumber}，实际 ${actualNumber}`,
          );
    }
    case "notempty":
      return actual == null || actual === "" || (Array.isArray(actual) && !actual.length)
        ? buildAssertionFailure(assertion.message, `断言失败: ${assertion.path} 为空`)
        : null;
    case "exists":
    default:
      return actual === undefined
        ? buildAssertionFailure(assertion.message, `断言失败: ${assertion.path} 不存在`)
        : null;
  }
}

function buildAssertionContext(result) {
  return {
    response: result.response || {},
    request: result.request || {},
    retry: result.retry || {},
    responseText: result.response?.bodyText || "",
    responseBodyJson: result.response?.bodyJson,
    responseStatus: result.response?.httpStatus ?? 0,
    responseError: result.response?.transportError || "",
    responseBody: result.response?.bodyJson ?? parseJsonSafe(result.response?.bodyText) ?? result.response?.bodyText,
    responseBodyJson: result.response?.bodyJson,
  };
}

function readAssertionSource(assertion, result) {
  const source = String(assertion.source || "response.bodyJson").trim();
  const context = buildAssertionContext(result);
  switch (source) {
    case "response":
      return result.response || {};
    case "request":
      return result.request || {};
    case "response.bodyText":
      return result.response?.bodyText || "";
    case "response.status":
      return result.response?.httpStatus ?? 0;
    case "response.bodyJson":
    default:
      return result.response?.bodyJson;
  }
}

function applyScenarioAssertions(step, result) {
  const failures = [];
  for (const assertion of step.assertions || []) {
    const root = readAssertionSource(assertion, result);
    const failure = evaluateAssertion(assertion, root);
    if (failure) failures.push(failure);
  }
  return failures;
}

function readExtractSource(extract, result) {
  const source = String(extract.source || "response.bodyJson").trim();
  switch (source) {
    case "response":
      return result.response || {};
    case "request":
      return result.request || {};
    case "response.bodyText":
      return result.response?.bodyText || "";
    case "response.status":
      return result.response?.httpStatus ?? 0;
    case "response.bodyJson":
    default:
      return result.response?.bodyJson;
  }
}

function setByPath(target, rawPath, value) {
  const path = String(rawPath || "").trim();
  if (!path || path === "$") {
    return;
  }

  const normalized = path.replace(/^\$\.?/, "");
  if (!normalized) return;

  const tokens = normalized
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((item) => item.trim())
    .filter(Boolean);

  if (!tokens.length) return;

  let current = target;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    const nextToken = tokens[index + 1];
    if (current[token] == null || typeof current[token] !== "object") {
      current[token] = /^\d+$/.test(nextToken) ? [] : {};
    }
    current = current[token];
  }

  current[tokens[tokens.length - 1]] = value;
}

function applyExtracts(step, result, variables) {
  const extracted = {};
  for (const extract of step.extracts || []) {
    const root = readExtractSource(extract, result);
    let value = getByPath(root, extract.path || "$");
    if (value === undefined && Object.prototype.hasOwnProperty.call(extract, "defaultValue")) {
      value = extract.defaultValue;
    }
    variables[extract.name] = value;
    setByPath(variables, extract.name, value);
    extracted[extract.name] = value;
  }
  return extracted;
}

function mergeCaseForScenario(testCase, step, variables) {
  const requestPatch = step.request || {};
  const mergedPathParams = {
    ...(testCase.pathParams || {}),
    ...interpolateValue(requestPatch.pathParams || {}, variables),
  };
  const mergedHeaders = {
    ...(testCase.headers || {}),
    ...interpolateValue(requestPatch.headers || {}, variables),
  };

  let body = testCase.body || "";
  if (Object.prototype.hasOwnProperty.call(requestPatch, "body")) {
    body = stringifyBody(interpolateValue(requestPatch.body, variables));
  } else if (body) {
    const parsedBody = parseJsonSafe(body);
    body = parsedBody != null
      ? stringifyBody(interpolateValue(parsedBody, variables))
      : interpolateString(body, variables);
  }

  const expected = {
    ...(testCase.expected || {}),
  };
  if (step.expected && Object.prototype.hasOwnProperty.call(step.expected, "businessCode")) {
    expected.businessCode = step.expected.businessCode;
  }
  if (step.expected && Object.prototype.hasOwnProperty.call(step.expected, "messageIncludes")) {
    expected.messageIncludes = interpolateValue(step.expected.messageIncludes, variables);
  }

  return {
    ...testCase,
    pathParams: mergedPathParams,
    headers: mergedHeaders,
    body,
    expected,
  };
}

async function runScenario(settings, interfacesPayload, scenario, executionOptions = {}) {
  const startedAt = new Date().toISOString();
  const variables = {};
  const stepResults = [];

  const steps = Array.isArray(scenario?.steps) ? scenario.steps : [];
  const stepIndexById = new Map();
  steps.forEach((step, index) => {
    const id = String(step?.id || "").trim();
    if (id && !stepIndexById.has(id)) {
      stepIndexById.set(id, index);
    }
  });

  const executedStepIndexes = new Set();
  let currentIndex = 0;
  let stopReason = "";
  let guardCount = 0;
  const maxGuards = Math.max(steps.length * 5, 20);

  while (currentIndex < steps.length) {
    if (guardCount > maxGuards) {
      stopReason = "场景执行中断：检测到循环跳转，请检查 onFailure=jump 配置";
      break;
    }
    guardCount += 1;

    const step = steps[currentIndex];
    const onFailure = normalizeStepOnFailure(step);
    const nextStepId = String(step?.nextStepId || "").trim();
    executedStepIndexes.add(currentIndex);

    const now = new Date().toISOString();
    const baseFailureResult = {
      id: crypto.randomUUID(),
      stepId: step.id,
      stepName: step.name,
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      interfaceId: step.interfaceId,
      caseId: step.caseId,
      caseName: step.name,
      pass: false,
      skipped: false,
      request: {},
      response: { httpStatus: 0, bodyText: "", bodyJson: null, transportError: "" },
      extractedVariables: {},
      variablesSnapshot: JSON.parse(JSON.stringify(variables)),
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      onFailure,
      nextStepId,
      executionIndex: stepResults.length + 1,
    };

    const apiInterface = getScenarioStepInterface(interfacesPayload, step.interfaceId);
    if (!apiInterface) {
      const failures = ["场景步骤失败：接口不存在"];
      stepResults.push({
        ...baseFailureResult,
        assertionSummary: failures.join("；"),
        failures,
      });

      if (onFailure === "continue") {
        currentIndex += 1;
        continue;
      }
      if (onFailure === "jump") {
        if (!nextStepId || !stepIndexById.has(nextStepId)) {
          stopReason = `步骤失败且跳转目标无效：${step.name || step.id || currentIndex + 1}`;
          break;
        }
        currentIndex = stepIndexById.get(nextStepId);
        continue;
      }
      stopReason = `步骤失败后停止：${step.name || step.id || currentIndex + 1}`;
      break;
    }

    const testCase = getScenarioStepCase(apiInterface, step.caseId);
    if (!testCase) {
      const failures = ["场景步骤失败：用例不存在"];
      stepResults.push({
        ...baseFailureResult,
        interfaceName: apiInterface.name,
        assertionSummary: failures.join("；"),
        failures,
      });

      if (onFailure === "continue") {
        currentIndex += 1;
        continue;
      }
      if (onFailure === "jump") {
        if (!nextStepId || !stepIndexById.has(nextStepId)) {
          stopReason = `步骤失败且跳转目标无效：${step.name || step.id || currentIndex + 1}`;
          break;
        }
        currentIndex = stepIndexById.get(nextStepId);
        continue;
      }
      stopReason = `步骤失败后停止：${step.name || step.id || currentIndex + 1}`;
      break;
    }

    const scenarioCase = mergeCaseForScenario(testCase, step, variables);
    const result = await runCase(
      settings,
      apiInterface,
      scenarioCase,
      {
        ...executionOptions,
        overrideAuthProfileId: step.authProfileId || executionOptions.overrideAuthProfileId || "",
      },
      interfacesPayload,
    );

    const assertionFailures = applyScenarioAssertions(step, result);
    const extractedVariables = applyExtracts(step, result, variables);
    const failures = [...(result.failures || []), ...assertionFailures];
    const pass = failures.length === 0;

    const stepResult = {
      ...result,
      stepId: step.id,
      stepName: step.name || result.caseName,
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      caseName: step.name || result.caseName,
      failures,
      pass,
      assertionSummary: pass ? result.assertionSummary || "步骤通过" : failures.join("；"),
      extractedVariables,
      variablesSnapshot: JSON.parse(JSON.stringify(variables)),
      onFailure,
      nextStepId,
      durationMs: computeDurationMs(result.startedAt, result.finishedAt),
      executionIndex: stepResults.length + 1,
    };

    stepResults.push(stepResult);

    if (pass) {
      currentIndex += 1;
      continue;
    }

    if (onFailure === "continue") {
      currentIndex += 1;
      continue;
    }

    if (onFailure === "jump") {
      if (!nextStepId) {
        stepResult.failures = [...stepResult.failures, "onFailure=jump 但未配置 nextStepId，已停止执行"];
        stepResult.assertionSummary = stepResult.failures.join("；");
        stopReason = `步骤失败后未配置跳转目标：${step.name || step.id || currentIndex + 1}`;
        break;
      }
      if (!stepIndexById.has(nextStepId)) {
        stepResult.failures = [...stepResult.failures, `onFailure=jump 目标不存在：${nextStepId}`];
        stepResult.assertionSummary = stepResult.failures.join("；");
        stopReason = `步骤失败后跳转目标不存在：${nextStepId}`;
        break;
      }
      const targetIndex = stepIndexById.get(nextStepId);
      if (targetIndex === currentIndex) {
        stepResult.failures = [...stepResult.failures, "onFailure=jump 目标不能是当前步骤，已停止执行"];
        stepResult.assertionSummary = stepResult.failures.join("；");
        stopReason = `步骤失败后跳转到自身，已终止：${step.name || step.id || currentIndex + 1}`;
        break;
      }
      currentIndex = targetIndex;
      continue;
    }

    stopReason = `步骤失败后停止：${step.name || step.id || currentIndex + 1}`;
    break;
  }

  const skippedReason = stopReason || "已跳过：未进入当前分支";
  steps.forEach((step, index) => {
    if (executedStepIndexes.has(index)) return;
    const onFailure = normalizeStepOnFailure(step);
    const nextStepId = String(step?.nextStepId || "").trim();
    stepResults.push({
      id: crypto.randomUUID(),
      stepId: step.id,
      stepName: step.name,
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      interfaceId: step.interfaceId,
      caseId: step.caseId,
      caseName: step.name,
      pass: false,
      skipped: true,
      assertionSummary: `已跳过：${skippedReason}`,
      failures: [`已跳过：${skippedReason}`],
      request: {},
      response: { httpStatus: 0, bodyText: "", bodyJson: null, transportError: "" },
      extractedVariables: {},
      variablesSnapshot: JSON.parse(JSON.stringify(variables)),
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      onFailure,
      nextStepId,
      executionIndex: null,
    });
  });

  const finishedAt = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    startedAt,
    finishedAt,
    durationMs: computeDurationMs(startedAt, finishedAt),
    variables,
    stopReason,
    results: stepResults,
    summary: buildScenarioRunSummary(stepResults),
  };
}

module.exports = {
  runScenario,
};
