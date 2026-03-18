const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const sessions = new Map();
const profileDir = path.resolve(__dirname, '..', 'data', 'oos-browser-profile');

function resolveChromium() {
  try {
    // eslint-disable-next-line global-require
    return require('playwright').chromium;
  } catch (firstError) {
    try {
      // eslint-disable-next-line global-require
      return require('@playwright/test').chromium;
    } catch {
      const error = new Error(
        `Playwright chromium is not available. Install dependencies first. (${firstError.message || firstError})`,
      );
      error.code = 'PLAYWRIGHT_UNAVAILABLE';
      throw error;
    }
  }
}

function buildCookieHeader(cookies = []) {
  return cookies
    .filter((item) => item && item.name && item.value)
    .map((item) => `${item.name}=${item.value}`)
    .join('; ');
}

function extractCookieValue(cookies, name) {
  const found = (cookies || []).find((item) => item?.name === name);
  return found?.value || '';
}

function parseCookieHeader(cookieHeader = '') {
  return String(cookieHeader || '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const index = item.indexOf('=');
      if (index <= 0) return null;
      return {
        name: item.slice(0, index).trim(),
        value: item.slice(index + 1).trim(),
      };
    })
    .filter(Boolean);
}

async function applyCookieHeaderToContext(context, cookieHeader) {
  const cookies = parseCookieHeader(cookieHeader);
  if (!cookies.length) return;
  await context.addCookies(
    cookies.map((item) => ({
      name: item.name,
      value: item.value,
      domain: 'chatgpt.com',
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    })),
  );
}

function getSession(sessionId) {
  const session = sessions.get(String(sessionId || ''));
  if (!session) {
    const error = new Error('OOS browser session not found');
    error.code = 'OOS_SESSION_NOT_FOUND';
    throw error;
  }
  return session;
}

async function getReadablePage(context, preferredPage = null) {
  if (preferredPage && !preferredPage.isClosed()) return preferredPage;
  const pages = context.pages();
  for (const page of pages) {
    if (!page.isClosed()) return page;
  }
  return context.newPage();
}

async function collectLoginStatus(session) {
  const page = await getReadablePage(session.context, session.page);
  session.page = page;

  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');
  const cookies = await session.context.cookies('https://chatgpt.com');
  const cookieHeader = buildCookieHeader(cookies);
  const hasSessionCookie = Boolean(extractCookieValue(cookies, '__Secure-next-auth.session-token'));
  const hasCfClearance = Boolean(extractCookieValue(cookies, 'cf_clearance'));

  const modelsProbe = await page.evaluate(async () => {
    try {
      const response = await fetch('/backend-api/models', {
        method: 'GET',
        credentials: 'include',
      });
      const text = await response.text();
      return {
        status: response.status,
        ok: response.ok,
        snippet: String(text || '').slice(0, 240),
      };
    } catch (error) {
      return {
        status: 0,
        ok: false,
        snippet: String(error?.message || error || ''),
      };
    }
  });

  const authSessionProbe = await page.evaluate(async () => {
    try {
      const response = await fetch('/api/auth/session', {
        method: 'GET',
        credentials: 'include',
      });
      const text = await response.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      return {
        status: response.status,
        ok: response.ok,
        accessToken: String(body?.accessToken || ''),
      };
    } catch (error) {
      return {
        status: 0,
        ok: false,
        accessToken: '',
        error: String(error?.message || error || ''),
      };
    }
  });

  const ok = modelsProbe.status === 200;
  return {
    ok,
    modelStatus: modelsProbe.status,
    modelSnippet: modelsProbe.snippet,
    sessionStatus: authSessionProbe.status,
    hasSessionCookie,
    hasCfClearance,
    oosToken: authSessionProbe.accessToken || '',
    oosCookie: cookieHeader,
    userAgent: userAgent || session.launchUserAgent || '',
  };
}

async function startOosBrowserLogin({ headless = false } = {}) {
  for (const item of sessions.values()) {
    if (item && item.context) {
      return {
        reused: true,
        sessionId: item.id,
        startedAt: item.startedAt,
        loginUrl: item.loginUrl,
        message: 'Browser session is already running. Complete login in the opened window.',
      };
    }
  }

  await fs.mkdir(profileDir, { recursive: true });
  const chromium = resolveChromium();
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: Boolean(headless),
    viewport: null,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await getReadablePage(context);
  const loginUrl = 'https://chatgpt.com/';
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront().catch(() => {});

  const id = crypto.randomUUID();
  const launchUserAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');
  const session = {
    id,
    startedAt: new Date().toISOString(),
    loginUrl,
    context,
    page,
    launchUserAgent,
  };
  sessions.set(id, session);

  context.on('close', () => {
    sessions.delete(id);
  });

  return {
    reused: false,
    sessionId: id,
    startedAt: session.startedAt,
    loginUrl,
    message: 'Browser opened. Please complete ChatGPT login in that window.',
  };
}

async function getOosBrowserLoginStatus(sessionId) {
  const session = getSession(sessionId);
  const status = await collectLoginStatus(session);
  return {
    sessionId: session.id,
    startedAt: session.startedAt,
    loginUrl: session.loginUrl,
    ...status,
  };
}

async function applyOosBrowserLogin(sessionId, { getSettings, saveSettings }) {
  const session = getSession(sessionId);
  const status = await collectLoginStatus(session);
  const hasAnyCredential = Boolean(
    String(status.oosCookie || '').trim()
      || String(status.oosToken || '').trim()
      || String(status.userAgent || '').trim()
      || status.hasSessionCookie,
  );

  if (!hasAnyCredential) {
    return {
      ok: false,
      sessionId: session.id,
      reason: 'Login is not ready yet. No cookie/token/user-agent captured.',
      ...status,
    };
  }

  const settings = await getSettings();
  settings.ai = {
    ...(settings.ai || {}),
    enabled: true,
    authMode: 'oos',
    url: 'https://chatgpt.com',
    oosToken: status.oosToken || String(settings.ai?.oosToken || ''),
    oosCookie: status.oosCookie || String(settings.ai?.oosCookie || ''),
    oosUserAgent: status.userAgent || String(settings.ai?.oosUserAgent || ''),
    oosBrowserSessionId: session.id,
  };
  await saveSettings(settings);

  return {
    ok: true,
    sessionId: session.id,
    partial: !status.ok,
    reason: status.ok ? '' : 'Credentials applied, but model probe is not ready yet.',
    ai: settings.ai,
    status,
  };
}

async function closeOosBrowserLogin(sessionId) {
  const session = getSession(sessionId);
  sessions.delete(session.id);
  await session.context.close();
  return { ok: true, sessionId: session.id };
}

async function callOosTextByPage(page, { systemPrompt, userPrompt, model, oosToken = '' }) {
  const mergedPrompt = [systemPrompt, userPrompt].filter(Boolean).join('\n\n');
  const codexInstructions = String(systemPrompt || '').trim() || 'You are a helpful assistant.';
  const codexUserPrompt = String(userPrompt || '').trim() || 'Please help with this task.';
  const conversationPayload = {
    action: 'next',
    messages: [
      {
        id: crypto.randomUUID(),
        author: { role: 'user' },
        content: {
          content_type: 'text',
          parts: [mergedPrompt],
        },
      },
    ],
    parent_message_id: crypto.randomUUID(),
    conversation_id: null,
    model: model || 'gpt-4o-mini',
    stream: false,
  };

  const codexPayloads = [
    {
      model: model || 'gpt-4o-mini',
      store: false,
      stream: true,
      instructions: codexInstructions,
      input: [
        {
          role: 'user',
          content: codexUserPrompt,
        },
      ],
    },
    {
      model: model || 'gpt-4o-mini',
      store: false,
      stream: true,
      instructions: codexInstructions,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: codexUserPrompt }],
        },
      ],
    },
  ];

  return page.evaluate(async ({ codexVariants, requestPayload, authToken }) => {
    function safeJsonParse(text) {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }

    function extractCodexText(body) {
      if (typeof body?.output_text === 'string' && body.output_text.trim()) {
        return body.output_text.trim();
      }
      const output = Array.isArray(body?.output) ? body.output : [];
      const parts = [];
      for (const item of output) {
        const content = Array.isArray(item?.content) ? item.content : [];
        for (const block of content) {
          if (typeof block?.text === 'string' && block.text.trim()) parts.push(block.text);
          if (typeof block?.output_text === 'string' && block.output_text.trim()) parts.push(block.output_text);
        }
      }
      return parts.join('').trim();
    }

    function extractCodexTextFromSse(rawText) {
      const lines = String(rawText || '').split(/\r?\n/);
      let merged = '';
      let lastCompletedText = '';

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payloadText = line.slice(5).trim();
        if (!payloadText || payloadText === '[DONE]') continue;
        const payload = safeJsonParse(payloadText);
        if (!payload) continue;

        if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
          lastCompletedText = payload.output_text.trim();
        }
        if (typeof payload?.delta === 'string') {
          merged += payload.delta;
        }
        if (payload?.type === 'response.output_text.delta' && typeof payload?.delta === 'string') {
          merged += payload.delta;
        }
        if (payload?.response) {
          const doneText = extractCodexText(payload.response);
          if (doneText) lastCompletedText = doneText;
        }
      }

      return String(merged || lastCompletedText || '').trim();
    }

    async function tryCodex() {
      let lastFailure = null;
      for (const codexPayload of codexVariants || []) {
        try {
          const headers = {
            'Content-Type': 'application/json',
            Accept: '*/*',
            originator: 'openclaw',
          };
          if (authToken) {
            headers.Authorization = /^bearer\s+/i.test(authToken) ? authToken : `Bearer ${authToken}`;
          }
          const response = await fetch('/backend-api/codex/responses', {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify(codexPayload),
          });
          const rawText = await response.text();
          const body = safeJsonParse(rawText);
          const text = extractCodexText(body) || extractCodexTextFromSse(rawText);
          if (response.ok && text) {
            return {
              ok: true,
              status: response.status,
              text,
              raw: body || { rawText: String(rawText || '').slice(0, 6000) },
            };
          }
          lastFailure = {
            ok: false,
            status: response.status,
            text: '',
            raw: body || { rawText: String(rawText || '').slice(0, 6000) },
          };
        } catch (error) {
          lastFailure = {
            ok: false,
            status: 0,
            text: '',
            raw: { error: String(error?.message || error || '') },
          };
        }
      }
      return lastFailure || {
        ok: false,
        status: 0,
        text: '',
        raw: { error: 'codex payload is empty' },
      };
    }

    async function tryConversation() {
      try {
        const response = await fetch('/backend-api/conversation', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            Accept: '*/*',
          },
          body: JSON.stringify(requestPayload),
        });

        const rawText = await response.text();
        const body = safeJsonParse(rawText);
        let text = '';
        const parts = body?.message?.content?.parts;
        if (Array.isArray(parts) && parts.length) {
          text = parts.join('\n').trim();
        }
        if (!text) {
          const lines = String(rawText || '').split(/\r?\n/);
          let lastText = '';
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const payloadText = line.slice(5).trim();
            if (!payloadText || payloadText === '[DONE]') continue;
            const sseBody = safeJsonParse(payloadText);
            const sseParts = sseBody?.message?.content?.parts;
            if (Array.isArray(sseParts) && sseParts.length) {
              lastText = sseParts.join('\n').trim();
            }
          }
          text = lastText;
        }

        return {
          ok: response.ok,
          status: response.status,
          text,
          raw: body || { rawText: String(rawText || '').slice(0, 6000) },
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          text: '',
          raw: { error: String(error?.message || error || '') },
        };
      }
    }

    try {
      const codexResult = await tryCodex();
      if (codexResult?.ok && codexResult?.text) return codexResult;
      const conversationResult = await tryConversation();
      if (conversationResult?.ok && conversationResult?.text) return conversationResult;
      return {
        ok: false,
        status: conversationResult?.status || codexResult?.status || 0,
        text: '',
        raw: {
          codex: codexResult?.raw || null,
          conversation: conversationResult?.raw || null,
        },
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        text: '',
        raw: {
          error: String(error?.message || error || ''),
        },
      };
    }
  }, {
    codexVariants: codexPayloads,
    requestPayload: conversationPayload,
    authToken: String(oosToken || ''),
  });
}

async function callOosTextWithSession(sessionId, { systemPrompt, userPrompt, model, oosToken = '' }) {
  const session = getSession(sessionId);
  const page = await getReadablePage(session.context, session.page);
  session.page = page;

  if (!String(page.url() || '').startsWith('https://chatgpt.com')) {
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
  }

  return callOosTextByPage(page, { systemPrompt, userPrompt, model, oosToken });
}

async function callOosTextWithTransientBrowser(ai = {}, { systemPrompt, userPrompt, model }) {
  const chromium = resolveChromium();
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1365, height: 865 },
      userAgent: String(ai.oosUserAgent || ''),
      extraHTTPHeaders: {
        'Accept-Language': String(ai.oosAcceptLanguage || 'zh-CN,zh;q=0.9,en;q=0.8'),
      },
    });
    await applyCookieHeaderToContext(context, ai.oosCookie || '');
    const page = await context.newPage();
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
    const resolvedModel = model || ai.model || 'gpt-4o-mini';
    return await callOosTextByPage(page, {
      systemPrompt,
      userPrompt,
      model: resolvedModel,
      oosToken: String(ai.oosToken || ''),
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

async function callOosTextWithPersistentProfile(ai = {}, { systemPrompt, userPrompt, model }) {
  await fs.mkdir(profileDir, { recursive: true });
  const chromium = resolveChromium();
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: Boolean(ai.oosPersistentHeadless),
    viewport: null,
    userAgent: String(ai.oosUserAgent || ''),
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const page = await getReadablePage(context);
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
    const resolvedModel = model || ai.model || 'gpt-4o-mini';
    return await callOosTextByPage(page, {
      systemPrompt,
      userPrompt,
      model: resolvedModel,
      oosToken: String(ai.oosToken || ''),
    });
  } finally {
    await context.close().catch(() => {});
  }
}

module.exports = {
  startOosBrowserLogin,
  getOosBrowserLoginStatus,
  applyOosBrowserLogin,
  closeOosBrowserLogin,
  callOosTextWithSession,
  callOosTextWithPersistentProfile,
  callOosTextWithTransientBrowser,
};
