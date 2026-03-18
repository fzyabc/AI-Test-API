const { expect, request: playwrightRequest } = require('@playwright/test');

async function createAuthedContext(token, baseURL) {
  return playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
}

async function createPublicContext(baseURL) {
  return playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
    },
  });
}

async function readJson(response) {
  const body = await response.json();
  return body;
}

async function getJson(context, path) {
  const response = await context.get(path, { failOnStatusCode: false });
  return {
    response,
    body: await readJson(response),
  };
}

async function postJson(context, path, payload) {
  const response = await context.post(path, {
    data: payload,
    failOnStatusCode: false,
  });
  return {
    response,
    body: await readJson(response),
  };
}

function expectBusinessSuccess(body, message) {
  expect(body.code).toBe(200);
  if (message) {
    expect(body.message).toBe(message);
  }
}

function expectBusinessError(body, code, message) {
  expect(body.code).toBe(code);
  expect(body.message).toBe(message);
}

function expectSecondTimestamps(items) {
  for (const item of items) {
    expect(String(item.createdAt)).toHaveLength(10);
    expect(String(item.updatedAt)).toHaveLength(10);
  }
}

function expectSortedByCreatedDesc(items) {
  for (let i = 0; i < items.length - 1; i += 1) {
    expect(Number(items[i].createdAt)).toBeGreaterThanOrEqual(Number(items[i + 1].createdAt));
  }
}

function uniqueCode(prefix = 'T') {
  return `${prefix}${Date.now().toString().slice(-8)}`.toUpperCase();
}

module.exports = {
  createAuthedContext,
  createPublicContext,
  expectBusinessError,
  expectBusinessSuccess,
  expectSecondTimestamps,
  expectSortedByCreatedDesc,
  getJson,
  postJson,
  uniqueCode,
};
