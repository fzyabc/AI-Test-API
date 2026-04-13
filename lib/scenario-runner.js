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

function buildScenarioRunSummary(stepResults = []) {
  const total = stepResults.length;
  const passed = stepResults.filter((item) => item.pass).length;
  const failed = total - passed;
  return {
    total,
    passed,
    failed,
  };
}

function buildAssertionFailure(message, fallback) {
  return message || fallback;
}

function evaluateAssertion(assertion, context) {
  const actual = getByPath(context, assertion.path || "$");
  const expected = assertion.expected;
  const type = String(assertion.type || "exists").toLowerCase();

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

function applyExtracts(step, result, variables) {
  const extracted = {};
  for (const extract of step.extracts || []) {
    const root = readExtractSource(extract, result);
    let value = getByPath(root, extract.path || "$");
    if (value === undefined && Object.prototype.hasOwnProperty.call(extract, "defaultValue")) {
      value = extract.defaultValue;
    }
    variables[extract.name] = value;
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
  let stopped = false;

  for (const step of scenario.steps || []) {
    const apiInterface = getScenarioStepInterface(interfacesPayload, step.interfaceId);
    if (!apiInterface) {
      stepResults.push({
        id: crypto.randomUUID(),
        stepId: step.id,
        stepName: step.name,
        interfaceId: step.interfaceId,
        caseId: step.caseId,
        pass: false,
        skipped: false,
        assertionSummary: "场景步骤失败：接口不存在",
        failures: ["场景步骤失败：接口不存在"],
        request: {},
        response: { httpStatus: 0, bodyText: "", bodyJson: null, transportError: "" },
        extractedVariables: {},
      });
      if (step.stopOnFailure !== false) {
        stopped = true;
        break;
      }
      continue;
    }

    const testCase = getScenarioStepCase(apiInterface, step.caseId);
    if (!testCase) {
      stepResults.push({
        id: crypto.randomUUID(),
        stepId: step.id,
        stepName: step.name,
        interfaceId: step.interfaceId,
        caseId: step.caseId,
        pass: false,
        skipped: false,
        assertionSummary: "场景步骤失败：用例不存在",
        failures: ["场景步骤失败：用例不存在"],
        request: {},
        response: { httpStatus: 0, bodyText: "", bodyJson: null, transportError: "" },
        extractedVariables: {},
      });
      if (step.stopOnFailure !== false) {
        stopped = true;
        break;
      }
      continue;
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

    stepResults.push({
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
    });

    if (!pass && step.stopOnFailure !== false) {
      stopped = true;
      break;
    }
  }

  if (stopped && stepResults.length < (scenario.steps || []).length) {
    const executedStepIds = new Set(stepResults.map((item) => item.stepId));
    for (const step of scenario.steps || []) {
      if (executedStepIds.has(step.id)) continue;
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
        assertionSummary: "已跳过：前置步骤失败",
        failures: ["已跳过：前置步骤失败"],
        request: {},
        response: { httpStatus: 0, bodyText: "", bodyJson: null, transportError: "" },
        extractedVariables: {},
        variablesSnapshot: JSON.parse(JSON.stringify(variables)),
      });
    }
  }

  const finishedAt = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    startedAt,
    finishedAt,
    variables,
    results: stepResults,
    summary: buildScenarioRunSummary(stepResults),
  };
}

module.exports = {
  runScenario,
};
