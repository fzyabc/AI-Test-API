function normalizeExpectedBusinessCode(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const text = String(value).trim();
  if (!text) return null;
  return text;
}

function extractBusinessCode(responseJson) {
  if (!responseJson || typeof responseJson !== "object") return null;
  const candidates = [
    responseJson.code,
    responseJson.businessCode,
    responseJson.bizCode,
    responseJson.errorCode,
    responseJson.errCode,
    responseJson.status,
  ];
  for (const value of candidates) {
    const normalized = normalizeExpectedBusinessCode(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function businessCodeEquals(left, right) {
  const a = normalizeExpectedBusinessCode(left);
  const b = normalizeExpectedBusinessCode(right);
  if (a === null || b === null) return false;
  return String(a) === String(b);
}

function isExpectedSuccessBusinessCode(value) {
  const normalized = normalizeExpectedBusinessCode(value);
  return normalized !== null && String(normalized) === "200";
}

module.exports = {
  normalizeExpectedBusinessCode,
  extractBusinessCode,
  businessCodeEquals,
  isExpectedSuccessBusinessCode,
};
