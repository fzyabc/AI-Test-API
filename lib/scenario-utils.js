const crypto = require("crypto");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeExtract(input = {}) {
  return {
    name: String(input.name || "").trim(),
    source: String(input.source || "response.bodyJson").trim() || "response.bodyJson",
    path: String(input.path || "$"),
    defaultValue:
      Object.prototype.hasOwnProperty.call(input, "defaultValue")
        ? input.defaultValue
        : undefined,
  };
}

function normalizeAssertion(input = {}) {
  return {
    type: String(input.type || "exists").trim().toLowerCase(),
    source: String(input.source || "response.bodyJson").trim() || "response.bodyJson",
    path: String(input.path || "$"),
    expected:
      Object.prototype.hasOwnProperty.call(input, "expected")
        ? input.expected
        : undefined,
    message: String(input.message || "").trim(),
  };
}

function normalizeScenarioStep(input = {}) {
  const request = isPlainObject(input.request) ? input.request : {};
  const expected = isPlainObject(input.expected) ? input.expected : {};
  return {
    id: input.id || crypto.randomUUID(),
    name: String(input.name || "").trim(),
    interfaceId: String(input.interfaceId || "").trim(),
    caseId: String(input.caseId || "").trim(),
    authProfileId: String(input.authProfileId || "").trim(),
    request: {
      pathParams: isPlainObject(request.pathParams) ? request.pathParams : {},
      headers: isPlainObject(request.headers) ? request.headers : {},
      body: Object.prototype.hasOwnProperty.call(request, "body")
        ? request.body
        : undefined,
    },
    expected: {
      businessCode:
        expected.businessCode === undefined ? undefined : expected.businessCode,
      messageIncludes:
        expected.messageIncludes === undefined
          ? undefined
          : expected.messageIncludes,
    },
    extracts: Array.isArray(input.extracts)
      ? input.extracts.map((item) => normalizeExtract(item)).filter((item) => item.name)
      : [],
    assertions: Array.isArray(input.assertions)
      ? input.assertions.map((item) => normalizeAssertion(item))
      : [],
    stopOnFailure: input.stopOnFailure !== false,
  };
}

function normalizeScenario(input = {}) {
  return {
    id: input.id || crypto.randomUUID(),
    name: String(input.name || "").trim(),
    description: String(input.description || "").trim(),
    steps: Array.isArray(input.steps)
      ? input.steps.map((item) => normalizeScenarioStep(item))
      : [],
    updatedAt: new Date().toISOString(),
  };
}

module.exports = {
  isPlainObject,
  normalizeScenario,
  normalizeScenarioStep,
};
