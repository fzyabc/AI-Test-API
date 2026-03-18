const { parseJsonSafe } = require('./ai-client');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringifyBody(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return JSON.stringify(value, null, 2);
}

function placeholderName(path) {
  return path[path.length - 1] || 'value';
}

function buildTemplateFromExample(value, path = [], indent = 0) {
  const currentIndent = '  '.repeat(indent);
  const nextIndent = '  '.repeat(indent + 1);

  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${nextIndent}${buildTemplateFromExample(value[0], [...path, 'item'], indent + 1)}\n${currentIndent}]`;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    return `{\n${entries
      .map(
        ([key, childValue]) =>
          `${nextIndent}${JSON.stringify(key)}: ${buildTemplateFromExample(childValue, [...path, key], indent + 1)}`,
      )
      .join(',\n')}\n${currentIndent}}`;
  }

  const token = `{{${placeholderName(path)}}}`;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return token;
  }
  return JSON.stringify(token);
}

function buildExampleLookup(value, path = [], lookup = {}) {
  if (Array.isArray(value)) {
    if (value.length) {
      buildExampleLookup(value[0], [...path, 'item'], lookup);
    }
    return lookup;
  }

  if (isPlainObject(value)) {
    for (const [key, childValue] of Object.entries(value)) {
      buildExampleLookup(childValue, [...path, key], lookup);
    }
    return lookup;
  }

  const leafName = placeholderName(path);
  if (!(leafName in lookup)) {
    lookup[leafName] = value;
  }
  return lookup;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function repairTemplateQuotes(template, exampleValue) {
  let normalized = stringifyBody(template);
  if (!normalized || !normalized.includes('{{')) return normalized;
  if (!exampleValue) return normalized;

  const lookup = buildExampleLookup(exampleValue);
  for (const [key, sampleValue] of Object.entries(lookup)) {
    if (typeof sampleValue === 'string' || sampleValue == null) {
      normalized = normalized.replace(
        new RegExp(`("${escapeRegExp(key)}"\\s*:\\s*){{\\s*${escapeRegExp(key)}\\s*}}`, 'g'),
        `$1"{{${key}}}"`,
      );
    }
  }

  return normalized;
}

function templateToSampleJsonText(template) {
  const raw = stringifyBody(template);
  if (!raw) return '';

  return raw
    .replace(/"{{\s*([a-zA-Z0-9_.-]+)\s*}}"/g, (_match, key) => JSON.stringify(`sample-${key.split('.').pop()}`))
    .replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, '0');
}

function parseTemplateBodyObject(template) {
  const raw = stringifyBody(template).trim();
  if (!raw) return null;

  const direct = parseJsonSafe(raw);
  if (direct != null) return direct;
  return parseJsonSafe(templateToSampleJsonText(raw));
}

function findExampleBody(caseInputs = [], bodyTemplateInput) {
  for (const item of caseInputs || []) {
    const parsed = parseTemplateBodyObject(item?.body);
    if (parsed != null) return parsed;
  }

  if (typeof bodyTemplateInput === 'string' && bodyTemplateInput.includes('{{')) {
    return null;
  }

  return parseTemplateBodyObject(bodyTemplateInput);
}

function normalizeInterfaceBodyTemplate(bodyTemplateInput, caseInputs = []) {
  const raw = stringifyBody(bodyTemplateInput).trim();
  if (!raw) return '';

  const exampleBody = findExampleBody(caseInputs, bodyTemplateInput);
  if (raw.includes('{{')) {
    return repairTemplateQuotes(raw, exampleBody);
  }

  if (exampleBody != null) {
    return buildTemplateFromExample(exampleBody);
  }

  return raw;
}

function normalizeCaseBody(bodyInput, exampleBody = null) {
  const raw = stringifyBody(bodyInput).trim();
  if (!raw) return '';
  if (raw.includes('{{') && exampleBody != null) {
    return JSON.stringify(exampleBody, null, 2);
  }
  return raw;
}

module.exports = {
  buildTemplateFromExample,
  findExampleBody,
  normalizeCaseBody,
  normalizeInterfaceBodyTemplate,
  parseTemplateBodyObject,
  stringifyBody,
};
