const crypto = require("crypto");
const {
  normalizeCaseBody,
  normalizeInterfaceBodyTemplate,
  parseTemplateBodyObject,
} = require("./body-utils");
const { normalizeAuthMode, parseJsonSafe } = require("./ai-client");
const { normalizeExpectedBusinessCode } = require("./business-code");

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function normalizeInterface(input, existingCases = []) {
  return {
    id: input.id || crypto.randomUUID(),
    name: input.name || "",
    method: (input.method || "GET").toUpperCase(),
    path: input.path || "",
    description: input.description || "",
    headers: input.headers || {},
    bodyTemplate: normalizeInterfaceBodyTemplate(input.bodyTemplate, [
      ...existingCases,
      ...(input.cases || []),
    ]),
    cases: input.cases || existingCases || [],
  };
}

function normalizeCase(input, apiInterface = null) {
  const exampleBody = parseTemplateBodyObject(apiInterface?.bodyTemplate || "");
  return {
    id: input.id || crypto.randomUUID(),
    name: input.name || "",
    description: input.description || "",
    authProfileId: input.authProfileId || "",
    headers: input.headers || {},
    pathParams: input.pathParams || {},
    body: normalizeCaseBody(input.body, exampleBody),
    expected: {
      businessCode: normalizeExpectedBusinessCode(input.expected?.businessCode),
      messageIncludes: input.expected?.messageIncludes ?? "",
    },
  };
}

function normalizeExecutionMode(value) {
  return String(value || "")
    .trim()
    .toLowerCase() === "case_runner"
    ? "case_runner"
    : "ai_agent";
}

function hasAiTransportConfig(ai = {}) {
  const authMode = normalizeAuthMode(ai);
  if (authMode === "oos") return true;
  return Boolean(String(ai.url || "").trim());
}

function collectJsonCandidates(text) {
  const source = String(text || "").trim();
  if (!source) return [];
  const candidates = [];
  const push = (value) => {
    if (value && typeof value === "object") candidates.push(value);
  };

  push(parseJsonSafe(source));

  const fenced = [...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const match of fenced) {
    push(parseJsonSafe(match[1].trim()));
  }

  const firstBrace = source.indexOf("{");
  const lastBrace = source.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    push(parseJsonSafe(source.slice(firstBrace, lastBrace + 1)));
  }

  return candidates.filter(Boolean);
}

function normalizeAiChatAction(action) {
  if (!action || typeof action !== "object") return null;
  const rawType = String(action.type || "")
    .trim()
    .toLowerCase();
  const typeAliases = {
    add_interface: "create_interface",
    create_interface: "create_interface",
    update_interface: "update_interface",
    modify_interface: "update_interface",
    delete_interface: "delete_interface",
    remove_interface: "delete_interface",
    add_case: "create_case",
    create_case: "create_case",
    update_case: "update_case",
    modify_case: "update_case",
    delete_case: "delete_case",
    remove_case: "delete_case",
  };
  const type = typeAliases[rawType] || "";
  if (!type) return null;

  return {
    type,
    interfaceId: String(action.interfaceId || action.id || "").trim(),
    interfaceName: String(action.interfaceName || "").trim(),
    caseId: String(action.caseId || "").trim(),
    caseName: String(action.caseName || action.case_id || "").trim(),
    interface:
      action.interface && typeof action.interface === "object"
        ? action.interface
        : null,
    case:
      action.case && typeof action.case === "object"
        ? action.case
        : action.casePatch && typeof action.casePatch === "object"
          ? action.casePatch
          : null,
  };
}

function parseAiChatPayload(text) {
  const candidates = collectJsonCandidates(text);
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      continue;
    const reply = String(candidate.reply || candidate.message || "").trim();
    const notes = Array.isArray(candidate.notes)
      ? candidate.notes.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const actions = (Array.isArray(candidate.actions) ? candidate.actions : [])
      .map((item) => normalizeAiChatAction(item))
      .filter(Boolean);
    if (!reply && !actions.length) continue;
    return {
      reply: reply || "已分析你的修改请求。",
      notes,
      actions,
    };
  }
  return null;
}

function findInterfaceIndex(payload, interfaceId) {
  if (!interfaceId) return -1;
  return (payload.interfaces || []).findIndex(
    (item) => item.id === interfaceId,
  );
}

function normalizeTextForMatch(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function findInterfaceIndexFlexible(payload, interfaceId, interfaceName) {
  const interfaces = payload.interfaces || [];
  const byId = findInterfaceIndex(payload, interfaceId);
  if (byId !== -1) return byId;
  const nameNorm = normalizeTextForMatch(interfaceName);
  if (!nameNorm) return -1;
  return interfaces.findIndex(
    (item) => normalizeTextForMatch(item.name) === nameNorm,
  );
}

function findCaseIndexFlexible(apiInterface, caseId, caseName) {
  const cases = apiInterface.cases || [];
  if (caseId) {
    const byId = cases.findIndex((item) => item.id === caseId);
    if (byId !== -1) return byId;
  }
  const nameNorm = normalizeTextForMatch(caseName);
  if (!nameNorm) return -1;
  const exact = cases.findIndex(
    (item) => normalizeTextForMatch(item.name) === nameNorm,
  );
  if (exact !== -1) return exact;
  return cases.findIndex((item) =>
    normalizeTextForMatch(item.name).includes(nameNorm),
  );
}

function applyAiChatActions(payload, actions) {
  const next = {
    interfaces: [...(payload.interfaces || [])],
  };
  const applied = [];
  const skipped = [];

  for (const action of actions || []) {
    if (!action || !action.type) continue;

    if (action.type === "create_interface" && action.interface) {
      const created = normalizeInterface(
        action.interface,
        action.interface.cases || [],
      );
      next.interfaces.push(created);
      applied.push({ type: action.type, interfaceId: created.id });
      continue;
    }

    if (action.type === "update_interface" && action.interface) {
      const idx = findInterfaceIndexFlexible(
        next,
        action.interfaceId || action.interface.id,
        action.interfaceName,
      );
      if (idx === -1) {
        skipped.push({
          type: action.type,
          reason: "interface not found",
          interfaceId: action.interfaceId,
          interfaceName: action.interfaceName,
        });
        continue;
      }
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

    if (action.type === "delete_interface") {
      const idx = findInterfaceIndexFlexible(
        next,
        action.interfaceId,
        action.interfaceName,
      );
      if (idx === -1) {
        skipped.push({
          type: action.type,
          reason: "interface not found",
          interfaceId: action.interfaceId,
          interfaceName: action.interfaceName,
        });
        continue;
      }
      const [removed] = next.interfaces.splice(idx, 1);
      applied.push({ type: action.type, interfaceId: removed.id });
      continue;
    }

    if (action.type === "create_case" && action.case) {
      const idx = findInterfaceIndexFlexible(
        next,
        action.interfaceId,
        action.interfaceName,
      );
      if (idx === -1) {
        skipped.push({
          type: action.type,
          reason: "interface not found",
          interfaceId: action.interfaceId,
          interfaceName: action.interfaceName,
        });
        continue;
      }
      const apiInterface = next.interfaces[idx];
      const createdCase = normalizeCase(action.case, apiInterface);
      next.interfaces[idx] = {
        ...apiInterface,
        cases: [...(apiInterface.cases || []), createdCase],
      };
      applied.push({
        type: action.type,
        interfaceId: apiInterface.id,
        caseId: createdCase.id,
      });
      continue;
    }

    if (action.type === "update_case" && action.case) {
      const idx = findInterfaceIndexFlexible(
        next,
        action.interfaceId,
        action.interfaceName,
      );
      if (idx === -1) {
        skipped.push({
          type: action.type,
          reason: "interface not found",
          interfaceId: action.interfaceId,
          interfaceName: action.interfaceName,
        });
        continue;
      }
      const apiInterface = next.interfaces[idx];
      const caseIdx = findCaseIndexFlexible(
        apiInterface,
        action.caseId,
        action.caseName || action.case?.name,
      );
      if (caseIdx === -1) {
        skipped.push({
          type: action.type,
          reason: "case not found",
          interfaceId: apiInterface.id,
          caseId: action.caseId,
          caseName: action.caseName || action.case?.name || "",
        });
        continue;
      }
      const currentCase = apiInterface.cases[caseIdx];
      const nextCase = {
        ...normalizeCase({ ...currentCase, ...action.case }, apiInterface),
        id: currentCase.id,
      };
      const cases = [...(apiInterface.cases || [])];
      cases[caseIdx] = nextCase;
      next.interfaces[idx] = { ...apiInterface, cases };
      applied.push({
        type: action.type,
        interfaceId: apiInterface.id,
        caseId: currentCase.id,
      });
      continue;
    }

    if (action.type === "delete_case") {
      const idx = findInterfaceIndexFlexible(
        next,
        action.interfaceId,
        action.interfaceName,
      );
      if (idx === -1) {
        skipped.push({
          type: action.type,
          reason: "interface not found",
          interfaceId: action.interfaceId,
          interfaceName: action.interfaceName,
        });
        continue;
      }
      const apiInterface = next.interfaces[idx];
      const existingCases = apiInterface.cases || [];
      const caseIdx = findCaseIndexFlexible(
        apiInterface,
        action.caseId,
        action.caseName,
      );
      if (caseIdx === -1) {
        skipped.push({
          type: action.type,
          reason: "case not found",
          interfaceId: apiInterface.id,
          caseId: action.caseId,
          caseName: action.caseName || "",
        });
        continue;
      }
      const removedCase = existingCases[caseIdx];
      const cases = existingCases.filter((item) => item.id !== removedCase.id);
      next.interfaces[idx] = { ...apiInterface, cases };
      applied.push({
        type: action.type,
        interfaceId: apiInterface.id,
        caseId: removedCase.id,
      });
    }
  }

  return {
    payload: next,
    applied,
    skipped,
    updated: applied.length > 0,
  };
}

module.exports = {
  asyncHandler,
  normalizeInterface,
  normalizeCase,
  normalizeExecutionMode,
  hasAiTransportConfig,
  collectJsonCandidates,
  parseAiChatPayload,
  applyAiChatActions,
};
