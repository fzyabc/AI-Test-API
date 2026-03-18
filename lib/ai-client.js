const { randomUUID } = require('crypto');
const {
  callOosTextWithSession,
  callOosTextWithPersistentProfile,
  callOosTextWithTransientBrowser,
} = require('./oos-browser-login');

const DEFAULT_OOS_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const DEFAULT_OOS_CODEX_USER_AGENT = 'openclaw/affiliate-api-auto-tests';

function parseJsonSafe(text) {
  if (!text) return null;
  try {
    return JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function normalizeAuthMode(ai = {}) {
  return String(ai.authMode || 'api_key').trim().toLowerCase() === 'oos' ? 'oos' : 'api_key';
}

function decodeBase64Url(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8');
}

function decodeJwtPayload(token) {
  const raw = String(token || '').trim().replace(/^bearer\s+/i, '');
  const parts = raw.split('.');
  if (parts.length < 2) return null;
  try {
    return parseJsonSafe(decodeBase64Url(parts[1]));
  } catch {
    return null;
  }
}

function resolveChatgptAccountId(token) {
  const payload = decodeJwtPayload(token);
  const auth = payload?.['https://api.openai.com/auth'];
  const direct = payload?.chatgpt_account_id;
  const nested = auth?.chatgpt_account_id;
  return String(direct || nested || '').trim();
}

function hasAiCredential(ai = {}) {
  const authMode = normalizeAuthMode(ai);
  if (authMode === 'oos') {
    return Boolean(
      String(ai.oosToken || '').trim()
      || String(ai.oosCookie || '').trim()
      || String(ai.oosBrowserSessionId || '').trim(),
    );
  }
  return Boolean(String(ai.apiKey || '').trim());
}

function buildEndpoint(baseUrl, wireApi, authMode = 'api_key') {
  const fallbackBase = authMode === 'oos' ? 'https://chatgpt.com' : '';
  const trimmed = String(baseUrl || fallbackBase).trim().replace(/\/$/, '');
  if (!trimmed) return '';

  if (wireApi === 'chatgpt_oos_codex') {
    const oosBase = normalizeOosBaseUrl(trimmed);
    if (/\/backend-api\/codex\/responses$/i.test(oosBase)) return oosBase;
    if (/\/backend-api\/codex$/i.test(oosBase)) return `${oosBase}/responses`;
    if (/\/backend-api$/i.test(oosBase)) return `${oosBase}/codex/responses`;
    return `${oosBase}/backend-api/codex/responses`;
  }

  if (wireApi === 'chatgpt_oos') {
    const oosBase = normalizeOosBaseUrl(trimmed);
    if (/\/backend-api\/conversation$/i.test(oosBase)) return oosBase;
    if (/\/backend-api$/i.test(oosBase)) return `${oosBase}/conversation`;
    return `${oosBase}/backend-api/conversation`;
  }

  if (wireApi === 'responses') {
    return /\/responses$/i.test(trimmed) ? trimmed : `${trimmed}/responses`;
  }

  return /\/chat\/completions$/i.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

function buildOosModelsEndpoint(baseUrl) {
  const trimmed = normalizeOosBaseUrl(baseUrl);
  if (/\/backend-api\/models$/i.test(trimmed)) return trimmed;
  if (/\/backend-api$/i.test(trimmed)) return `${trimmed}/models`;
  return `${trimmed}/backend-api/models`;
}

function normalizeOosBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/$/, '');
  if (!trimmed) return 'https://chatgpt.com';

  const isChatgpt = /^https?:\/\/([^/]+\.)?chatgpt\.com(\/|$)/i.test(trimmed);
  const isBackendApiPath = /\/backend-api(\/|$)/i.test(trimmed);
  if (isChatgpt || isBackendApiPath) return trimmed;

  return 'https://chatgpt.com';
}

function resolveWireApis(ai = {}) {
  const authMode = normalizeAuthMode(ai);
  const wireApi = String(ai.wireApi || 'auto').trim().toLowerCase();

  if (wireApi === 'chatgpt_oos_codex' || wireApi === 'oos_codex' || wireApi === 'codex') {
    return ['chatgpt_oos_codex', 'chatgpt_oos'];
  }
  if (wireApi === 'responses') return ['responses'];
  if (wireApi === 'chat' || wireApi === 'chat_completions' || wireApi === 'chat-completions') {
    return ['chat_completions'];
  }
  if (wireApi === 'chatgpt' || wireApi === 'chatgpt_oos' || wireApi === 'oos') {
    return ['chatgpt_oos'];
  }

  if (authMode === 'oos') {
    return String(ai.oosToken || '').trim()
      ? ['chatgpt_oos_codex', 'chatgpt_oos']
      : ['chatgpt_oos'];
  }
  return ['responses', 'chat_completions'];
}

function summarizeAiFailure({ endpoint, wireApi, response, rawText, body, error }) {
  if (error) {
    return `AI request failed at ${endpoint} [${wireApi}]: ${error.message || String(error)}`;
  }

  if (!response) {
    return `AI request failed before receiving a response at ${endpoint} [${wireApi}]`;
  }

  const message = body?.error?.message || body?.message || rawText || `HTTP ${response.status}`;
  return `AI request failed at ${endpoint} [${wireApi}]: HTTP ${response.status} ${response.statusText || ''}`.trim()
    + ` | ${String(message).slice(0, 500)}`;
}

function extractChatCompletionsText(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => item?.text || '').join('').trim();
  }
  return '';
}

function extractResponsesText(body) {
  if (typeof body?.output_text === 'string' && body.output_text.trim()) {
    return body.output_text;
  }

  const output = Array.isArray(body?.output) ? body.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (typeof block?.text === 'string' && block.text.trim()) {
        parts.push(block.text);
      }
      if (typeof block?.output_text === 'string' && block.output_text.trim()) {
        parts.push(block.output_text);
      }
    }
  }
  return parts.join('').trim();
}

function extractResponsesTextFromSse(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  let merged = '';
  let lastCompletedText = '';

  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payloadText = line.slice(5).trim();
    if (!payloadText || payloadText === '[DONE]') continue;
    const payload = parseJsonSafe(payloadText);
    if (!payload) continue;

    if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
      lastCompletedText = payload.output_text.trim();
    }
    if (
      (payload?.type === 'response.output_text.delta' || !payload?.type)
      && typeof payload?.delta === 'string'
    ) {
      merged += payload.delta;
    }
    if (payload?.response) {
      const text = extractResponsesText(payload.response);
      if (text) {
        lastCompletedText = text;
      }
    }
  }

  return String(lastCompletedText || merged || '').trim();
}

function extractChatgptOosText(body, rawText) {
  const parts = body?.message?.content?.parts;
  if (Array.isArray(parts) && parts.length) {
    return parts.join('\n').trim();
  }

  if (typeof body?.output_text === 'string' && body.output_text.trim()) {
    return body.output_text.trim();
  }

  if (typeof body?.text === 'string' && body.text.trim()) {
    return body.text.trim();
  }

  const lines = String(rawText || '').split(/\r?\n/);
  let lastText = '';
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payloadText = line.slice(5).trim();
    if (!payloadText || payloadText === '[DONE]') continue;
    const payload = parseJsonSafe(payloadText);
    if (!payload) continue;
    const sseParts = payload?.message?.content?.parts;
    if (Array.isArray(sseParts) && sseParts.length) {
      lastText = sseParts.join('\n').trim();
    }
  }

  return lastText;
}

function buildRequestPayloadVariants(ai, wireApi, systemPrompt, userPrompt) {
  const model = ai.model || 'gpt-4o-mini';

  if (wireApi === 'chatgpt_oos_codex') {
    const codexInstructions = String(systemPrompt || '').trim() || 'You are a helpful assistant.';
    const codexUserPrompt = String(userPrompt || '').trim() || 'Please help with this task.';
    const variants = [
      {
        variant: 'chatgpt_oos_codex_input_text_list',
        payload: {
          model,
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
      },
      {
        variant: 'chatgpt_oos_codex_input_blocks',
        payload: {
          model,
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
      },
      {
        variant: 'chatgpt_oos_codex_input_system_user_list',
        payload: {
          model,
          store: false,
          stream: true,
          instructions: codexInstructions,
          input: [
            {
              role: 'system',
              content: codexInstructions,
            },
            {
              role: 'user',
              content: codexUserPrompt,
            },
          ],
        },
      },
    ];

    if (ai.reasoningEffort) {
      for (const item of variants) {
        item.payload.reasoning = { effort: ai.reasoningEffort };
      }
    }

    return variants;
  }

  if (wireApi === 'chatgpt_oos') {
    const mergedPrompt = [systemPrompt, userPrompt].filter(Boolean).join('\n\n');
    return [
      {
        variant: 'chatgpt_oos_conversation',
        payload: {
          action: 'next',
          messages: [
            {
              id: randomUUID(),
              author: { role: 'user' },
              content: {
                content_type: 'text',
                parts: [mergedPrompt],
              },
            },
          ],
          parent_message_id: randomUUID(),
          conversation_id: null,
          model,
          stream: false,
        },
      },
    ];
  }

  if (wireApi === 'responses') {
    const variants = [
      {
        variant: 'responses_instructions',
        payload: {
          model,
          store: false,
          instructions: systemPrompt,
          input: userPrompt,
        },
      },
      {
        variant: 'responses_messages',
        payload: {
          model,
          store: false,
          input: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        },
      },
      {
        variant: 'responses_content_blocks',
        payload: {
          model,
          store: false,
          input: [
            {
              role: 'system',
              content: [{ type: 'input_text', text: systemPrompt }],
            },
            {
              role: 'user',
              content: [{ type: 'input_text', text: userPrompt }],
            },
          ],
        },
      },
    ];

    if (ai.reasoningEffort) {
      for (const item of variants) {
        item.payload.reasoning = { effort: ai.reasoningEffort };
      }
    }

    return variants;
  }

  return [
    {
      variant: 'chat_completions',
      payload: {
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      },
    },
  ];
}

function buildAuthHeaders(ai, authMode, wireApi = '') {
  const headers = {
    'Content-Type': 'application/json',
  };

  const token = authMode === 'oos'
    ? String(ai.oosToken || '').trim()
    : String(ai.apiKey || '').trim();

  if (token) {
    headers.Authorization = /^bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  }

  if (authMode === 'api_key') {
    if (ai.openaiOrganization) headers['OpenAI-Organization'] = String(ai.openaiOrganization);
    if (ai.openaiProject) headers['OpenAI-Project'] = String(ai.openaiProject);
  } else {
    headers.Accept = '*/*';
    headers['Accept-Language'] = String(ai.oosAcceptLanguage || 'zh-CN,zh;q=0.9,en;q=0.8');
    headers.Origin = 'https://chatgpt.com';
    headers.Referer = 'https://chatgpt.com/';
    headers['User-Agent'] = String(
      ai.oosUserAgent || (wireApi === 'chatgpt_oos_codex' ? DEFAULT_OOS_CODEX_USER_AGENT : DEFAULT_OOS_USER_AGENT),
    );
    headers['Sec-Fetch-Site'] = 'same-origin';
    headers['Sec-Fetch-Mode'] = 'cors';
    headers['Sec-Fetch-Dest'] = 'empty';
    if (wireApi === 'chatgpt_oos_codex') {
      headers.originator = 'openclaw';
      const accountId = resolveChatgptAccountId(token);
      if (accountId) {
        headers['ChatGPT-Account-Id'] = accountId;
      }
    }
    if (ai.oosCookie) {
      headers.Cookie = String(ai.oosCookie);
    }
  }

  return headers;
}

function extractTextByWireApi(wireApi, body, rawText) {
  if (wireApi === 'responses' || wireApi === 'chatgpt_oos_codex') {
    return extractResponsesText(body) || extractResponsesTextFromSse(rawText);
  }
  if (wireApi === 'chatgpt_oos') {
    return extractChatgptOosText(body, rawText);
  }
  return extractChatCompletionsText(body);
}

async function tryOosBrowserStrategies(ai, { systemPrompt, userPrompt }, attempts, authMode) {
  const model = ai.model || 'gpt-4o-mini';
  const browserSessionId = String(ai.oosBrowserSessionId || '').trim();

  if (browserSessionId) {
    try {
      const browserResult = await callOosTextWithSession(browserSessionId, {
        systemPrompt,
        userPrompt,
        model,
        oosToken: ai.oosToken || '',
      });
      if (browserResult.ok && browserResult.text) {
        return {
          ok: true,
          text: browserResult.text,
          raw: browserResult.raw,
          meta: {
            endpoint: 'browser-session',
            wireApi: 'chatgpt_oos_browser',
            variant: 'browser_context',
            status: browserResult.status,
            authMode,
            usedFallback: false,
            reason: '',
            attempts,
          },
        };
      }

      attempts.push({
        endpoint: 'browser-session',
        wireApi: 'chatgpt_oos_browser',
        variant: 'browser_context',
        status: browserResult.status || 0,
        reason: summarizeAiFailure({
          endpoint: 'browser-session',
          wireApi: 'chatgpt_oos_browser',
          response: browserResult.status
            ? { status: browserResult.status, statusText: '' }
            : null,
          body: browserResult.raw,
          rawText: typeof browserResult.raw === 'string' ? browserResult.raw : JSON.stringify(browserResult.raw || {}),
        }),
      });
    } catch (error) {
      attempts.push({
        endpoint: 'browser-session',
        wireApi: 'chatgpt_oos_browser',
        variant: 'browser_context',
        status: 0,
        reason: summarizeAiFailure({ endpoint: 'browser-session', wireApi: 'chatgpt_oos_browser', error }),
      });
    }
  }

  if (!browserSessionId) {
    try {
      const profileResult = await callOosTextWithPersistentProfile(ai, {
        systemPrompt,
        userPrompt,
        model,
      });
      if (profileResult.ok && profileResult.text) {
        return {
          ok: true,
          text: profileResult.text,
          raw: profileResult.raw,
          meta: {
            endpoint: 'browser-persistent-profile',
            wireApi: 'chatgpt_oos_browser',
            variant: 'browser_persistent_profile',
            status: profileResult.status,
            authMode,
            usedFallback: false,
            reason: '',
            attempts,
          },
        };
      }

      attempts.push({
        endpoint: 'browser-persistent-profile',
        wireApi: 'chatgpt_oos_browser',
        variant: 'browser_persistent_profile',
        status: profileResult.status || 0,
        reason: summarizeAiFailure({
          endpoint: 'browser-persistent-profile',
          wireApi: 'chatgpt_oos_browser',
          response: profileResult.status
            ? { status: profileResult.status, statusText: '' }
            : null,
          body: profileResult.raw,
          rawText:
            typeof profileResult.raw === 'string'
              ? profileResult.raw
              : JSON.stringify(profileResult.raw || {}),
        }),
      });
    } catch (error) {
      attempts.push({
        endpoint: 'browser-persistent-profile',
        wireApi: 'chatgpt_oos_browser',
        variant: 'browser_persistent_profile',
        status: 0,
        reason: summarizeAiFailure({ endpoint: 'browser-persistent-profile', wireApi: 'chatgpt_oos_browser', error }),
      });
    }
  }

  try {
    const transientResult = await callOosTextWithTransientBrowser(ai, {
      systemPrompt,
      userPrompt,
      model,
    });
    if (transientResult.ok && transientResult.text) {
      return {
        ok: true,
        text: transientResult.text,
        raw: transientResult.raw,
        meta: {
          endpoint: 'browser-transient',
          wireApi: 'chatgpt_oos_browser',
          variant: 'browser_transient_context',
          status: transientResult.status,
          authMode,
          usedFallback: false,
          reason: '',
          attempts,
        },
      };
    }

    attempts.push({
      endpoint: 'browser-transient',
      wireApi: 'chatgpt_oos_browser',
      variant: 'browser_transient_context',
      status: transientResult.status || 0,
      reason: summarizeAiFailure({
        endpoint: 'browser-transient',
        wireApi: 'chatgpt_oos_browser',
        response: transientResult.status
          ? { status: transientResult.status, statusText: '' }
          : null,
        body: transientResult.raw,
        rawText:
          typeof transientResult.raw === 'string'
            ? transientResult.raw
            : JSON.stringify(transientResult.raw || {}),
      }),
    });
  } catch (error) {
    attempts.push({
      endpoint: 'browser-transient',
      wireApi: 'chatgpt_oos_browser',
      variant: 'browser_transient_context',
      status: 0,
      reason: summarizeAiFailure({ endpoint: 'browser-transient', wireApi: 'chatgpt_oos_browser', error }),
    });
  }

  return null;
}

async function callAiText(ai, { systemPrompt, userPrompt }) {
  const authMode = normalizeAuthMode(ai);
  if (!hasAiCredential(ai)) {
    return {
      ok: false,
      text: '',
      raw: null,
      meta: {
        endpoint: '',
        wireApi: String(ai.wireApi || 'auto'),
        variant: '',
        status: 0,
        usedFallback: true,
        reason: `AI credential missing for authMode=${authMode}`,
        attempts: [],
      },
    };
  }

  const wireApis = resolveWireApis(ai);
  const attempts = [];
  const preferHttpFirst = authMode === 'oos'
    && Boolean(String(ai.oosToken || '').trim())
    && wireApis.includes('chatgpt_oos_codex');

  if (authMode === 'oos' && !preferHttpFirst) {
    const browserResult = await tryOosBrowserStrategies(ai, { systemPrompt, userPrompt }, attempts, authMode);
    if (browserResult) return browserResult;
  }

  for (const wireApi of wireApis) {
    const endpoint = buildEndpoint(ai.url, wireApi, authMode);
    const variants = buildRequestPayloadVariants(ai, wireApi, systemPrompt, userPrompt);

    for (const attemptVariant of variants) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: buildAuthHeaders(ai, authMode, wireApi),
          body: JSON.stringify(attemptVariant.payload),
        });

        const rawText = await response.text();
        const parsedBody = parseJsonSafe(rawText);
        const body = parsedBody || { rawText };
        const text = extractTextByWireApi(wireApi, parsedBody || {}, rawText);

        if (response.ok && text) {
          return {
            ok: true,
            text,
            raw: body,
            meta: {
              endpoint,
              wireApi,
              variant: attemptVariant.variant,
              status: response.status,
              authMode,
              usedFallback: false,
              reason: '',
              attempts,
            },
          };
        }

        attempts.push({
          endpoint,
          wireApi,
          variant: attemptVariant.variant,
          status: response.status,
          reason: summarizeAiFailure({ endpoint, wireApi, response, rawText, body }),
        });
      } catch (error) {
        attempts.push({
          endpoint,
          wireApi,
          variant: attemptVariant.variant,
          status: 0,
          reason: summarizeAiFailure({ endpoint, wireApi, error }),
        });
      }
    }
  }

  if (authMode === 'oos' && preferHttpFirst) {
    const browserResult = await tryOosBrowserStrategies(ai, { systemPrompt, userPrompt }, attempts, authMode);
    if (browserResult) return browserResult;
  }

  const lastAttempt = attempts[attempts.length - 1] || {
    endpoint: buildEndpoint(ai.url, wireApis[0] || 'responses', authMode),
    wireApi: wireApis[0] || 'responses',
    status: 0,
    reason: 'AI request failed before any attempt was executed.',
  };
  const primaryAttempt = attempts.find((item) => item.status && item.status !== 404) || lastAttempt;

  return {
    ok: false,
    text: '',
    raw: null,
    meta: {
      ...primaryAttempt,
      authMode,
      usedFallback: true,
      attempts,
    },
  };
}

async function verifyOosLogin(ai = {}) {
  const authMode = normalizeAuthMode({ ...ai, authMode: 'oos' });
  const token = String(ai.oosToken || '').trim();
  if (!token) {
    return {
      ok: false,
      endpoint: '',
      status: 0,
      reason: 'Missing oosToken',
      authMode,
    };
  }

  const endpoint = buildOosModelsEndpoint(ai.url);
  try {
    const headers = buildAuthHeaders({ ...ai, authMode: 'oos' }, authMode, 'chatgpt_oos_verify');
    delete headers['Content-Type'];
    const response = await fetch(endpoint, {
      method: 'GET',
      headers,
    });
    const rawText = await response.text();
    const body = parseJsonSafe(rawText) || { rawText };

    if (!response.ok) {
      return {
        ok: false,
        endpoint,
        status: response.status,
        reason: summarizeAiFailure({
          endpoint,
          wireApi: 'chatgpt_oos_verify',
          response,
          rawText,
          body,
        }),
        authMode,
      };
    }

    return {
      ok: true,
      endpoint,
      status: response.status,
      authMode,
      account: body?.account || null,
      accountId: body?.account?.id || resolveChatgptAccountId(token) || null,
      modelCount: Array.isArray(body?.models) ? body.models.length : null,
    };
  } catch (error) {
    return {
      ok: false,
      endpoint,
      status: 0,
      authMode,
      reason: summarizeAiFailure({ endpoint, wireApi: 'chatgpt_oos_verify', error }),
    };
  }
}

module.exports = {
  parseJsonSafe,
  normalizeAuthMode,
  hasAiCredential,
  resolveWireApis,
  callAiText,
  summarizeAiFailure,
  verifyOosLogin,
};
