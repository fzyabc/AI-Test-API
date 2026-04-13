const { validationError } = require("./http-errors");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ensurePlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw validationError(`${label} must be an object`);
  }
  return value;
}

function ensureString(value, label, options = {}) {
  const { allowEmpty = true, trim = true } = options;
  if (value === undefined || value === null) {
    throw validationError(`${label} is required`);
  }
  const normalized = trim ? String(value).trim() : String(value);
  if (!allowEmpty && !normalized) {
    throw validationError(`${label} is required`);
  }
  return normalized;
}

function ensureOptionalString(value, label, options = {}) {
  if (value === undefined || value === null) {
    return "";
  }
  return ensureString(value, label, { ...options, allowEmpty: true });
}

function ensureArray(value, label) {
  if (!Array.isArray(value)) {
    throw validationError(`${label} must be an array`);
  }
  return value;
}

function ensureBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw validationError(`${label} must be a boolean`);
  }
  return value;
}

function ensureHeaders(value, label) {
  if (value === undefined) return {};
  ensurePlainObject(value, label);
  return value;
}

function ensureHistory(value, label) {
  if (value === undefined) return [];
  return ensureArray(value, label);
}

function validateSettingsInput(body) {
  const payload = ensurePlainObject(body, "settings");
  if (payload.baseUrl !== undefined && typeof payload.baseUrl !== "string") {
    throw validationError("baseUrl must be a string");
  }
  if (payload.authProfiles !== undefined && !Array.isArray(payload.authProfiles)) {
    throw validationError("authProfiles must be an array");
  }
  if (payload.ai !== undefined && !isPlainObject(payload.ai)) {
    throw validationError("ai must be an object");
  }
  return payload;
}

function validateInterfaceInput(body) {
  const payload = ensurePlainObject(body, "interface");
  ensureString(payload.name, "interface.name", { allowEmpty: false });
  ensureString(payload.path, "interface.path", { allowEmpty: false });
  if (payload.method !== undefined) {
    ensureString(payload.method, "interface.method", { allowEmpty: false });
  }
  if (payload.headers !== undefined) {
    ensureHeaders(payload.headers, "interface.headers");
  }
  if (payload.cases !== undefined && !Array.isArray(payload.cases)) {
    throw validationError("interface.cases must be an array");
  }
  return payload;
}

function validateCaseInput(body) {
  const payload = ensurePlainObject(body, "case");
  ensureString(payload.name, "case.name", { allowEmpty: false });
  if (payload.headers !== undefined) {
    ensureHeaders(payload.headers, "case.headers");
  }
  if (payload.pathParams !== undefined) {
    ensureHeaders(payload.pathParams, "case.pathParams");
  }
  if (payload.expected !== undefined && !isPlainObject(payload.expected)) {
    throw validationError("case.expected must be an object");
  }
  return payload;
}

function validateDocContextInput(body) {
  const payload = ensurePlainObject(body, "docContext");
  const content = ensureString(payload.content, "content", { allowEmpty: false, trim: false });
  const filename = payload.filename === undefined ? undefined : ensureOptionalString(payload.filename, "filename", { trim: true });
  if (payload.analysis !== undefined && payload.analysis !== null && !isPlainObject(payload.analysis)) {
    throw validationError("analysis must be an object");
  }
  return { ...payload, content, filename };
}

function validateAiChatInput(body) {
  const payload = ensurePlainObject(body, "aiChat");
  const message = ensureString(payload.message, "message", { allowEmpty: false });
  const history = ensureHistory(payload.history, "history");
  if (payload.autoApply !== undefined) {
    ensureBoolean(payload.autoApply, "autoApply");
  }
  return { ...payload, message, history };
}

function validateRunAllInput(body) {
  const payload = body === undefined ? {} : ensurePlainObject(body, "run request");
  if (payload.authProfileId !== undefined && typeof payload.authProfileId !== "string") {
    throw validationError("authProfileId must be a string");
  }
  if (payload.aiInstruction !== undefined && typeof payload.aiInstruction !== "string") {
    throw validationError("aiInstruction must be a string");
  }
  if (payload.aiContext !== undefined && typeof payload.aiContext !== "string") {
    throw validationError("aiContext must be a string");
  }
  if (payload.onlyUnverified !== undefined) {
    ensureBoolean(payload.onlyUnverified, "onlyUnverified");
  }
  return payload;
}

function validateImportDocInput(body) {
  const payload = ensurePlainObject(body, "import doc");
  const content = ensureString(payload.content, "content", { allowEmpty: false, trim: false });
  const filename = ensureOptionalString(payload.filename, "filename");
  return { ...payload, content, filename };
}

function validateBugUpdateInput(body) {
  const payload = ensurePlainObject(body, "bug update");
  const hasStatus = Object.prototype.hasOwnProperty.call(payload, "status");
  const hasNote = Object.prototype.hasOwnProperty.call(payload, "note");
  if (!hasStatus && !hasNote) {
    throw validationError("At least one of status or note is required");
  }
  if (hasStatus && typeof payload.status !== "string") {
    throw validationError("status must be a string");
  }
  if (hasNote && typeof payload.note !== "string") {
    throw validationError("note must be a string");
  }
  return payload;
}

function validateAiRunChatInput(body) {
  const payload = ensurePlainObject(body, "ai run chat");
  const message = ensureString(payload.message, "message", { allowEmpty: false });
  const history = ensureHistory(payload.history, "history");
  if (payload.runId !== undefined && typeof payload.runId !== "string") {
    throw validationError("runId must be a string");
  }
  if (payload.autoApplyBugActions !== undefined) {
    ensureBoolean(payload.autoApplyBugActions, "autoApplyBugActions");
  }
  return { ...payload, message, history };
}

function validateRunCaseInput(body) {
  const payload = body === undefined ? {} : ensurePlainObject(body, "run case request");
  if (payload.authProfileId !== undefined && typeof payload.authProfileId !== "string") {
    throw validationError("authProfileId must be a string");
  }
  if (payload.bodyOverride !== undefined && typeof payload.bodyOverride !== "string") {
    throw validationError("bodyOverride must be a string");
  }
  return payload;
}

function validateScenarioInput(body) {
  const payload = ensurePlainObject(body, "scenario");
  const name = ensureString(payload.name, "scenario.name", { allowEmpty: false });
  if (payload.description !== undefined && typeof payload.description !== "string") {
    throw validationError("scenario.description must be a string");
  }
  const steps = ensureArray(payload.steps, "scenario.steps");
  for (const step of steps) {
    ensurePlainObject(step, "scenario.step");
    ensureString(step.name, "scenario.step.name", { allowEmpty: false });
    ensureString(step.interfaceId, "scenario.step.interfaceId", { allowEmpty: false });
    ensureString(step.caseId, "scenario.step.caseId", { allowEmpty: false });
    if (step.authProfileId !== undefined && typeof step.authProfileId !== "string") {
      throw validationError("scenario.step.authProfileId must be a string");
    }
    if (step.request !== undefined && !isPlainObject(step.request)) {
      throw validationError("scenario.step.request must be an object");
    }
    if (step.expected !== undefined && !isPlainObject(step.expected)) {
      throw validationError("scenario.step.expected must be an object");
    }
    if (step.extracts !== undefined && !Array.isArray(step.extracts)) {
      throw validationError("scenario.step.extracts must be an array");
    }
    if (step.assertions !== undefined && !Array.isArray(step.assertions)) {
      throw validationError("scenario.step.assertions must be an array");
    }
  }
  return { ...payload, name };
}

module.exports = {
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
};
