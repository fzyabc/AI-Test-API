const { callAiText, hasAiCredential, normalizeAuthMode } = require('./ai-client');

function hasAiTransportConfig(ai = {}) {
  const authMode = normalizeAuthMode(ai);
  if (authMode === 'oos') return true;
  return Boolean(String(ai.url || '').trim());
}

function buildFallbackMarkdown(run) {
  const failed = run.results.filter((item) => !item.pass);
  const lines = [
    '# AI 分析结果',
    '',
    `执行记录：${run.id}`,
    `开始时间：${run.startedAt}`,
    `通过数：${run.summary.passed}`,
    `失败数：${run.summary.failed}`,
    '',
  ];

  if (!failed.length) {
    lines.push('本次没有失败用例，暂未生成缺陷候选项。');
    return lines.join('\n');
  }

  lines.push('## 失败摘要', '');
  for (const item of failed) {
    lines.push(`### ${item.interfaceName} / ${item.caseName}`);
    lines.push(`- 请求：${item.method} ${item.path}`);
    lines.push(`- 断言结果：${item.assertionSummary}`);
    lines.push(`- 返回码：${item.response.bodyJson?.code ?? item.response.httpStatus}`);
    lines.push(`- 返回消息：${item.response.bodyJson?.message ?? ''}`);
    lines.push('');
  }

  return lines.join('\n');
}

async function analyzeRunWithAi(settings, run) {
  const ai = settings.ai || {};
  if (!ai.enabled || !hasAiTransportConfig(ai) || !hasAiCredential(ai)) {
    return {
      markdown: buildFallbackMarkdown(run),
      provider: 'fallback',
      meta: {
        endpoint: '',
        wireApi: String(ai.wireApi || 'auto'),
        usedFallback: true,
        reason: 'AI is disabled or incomplete configuration.',
      },
    };
  }

  const prompt = [
    '你是 API 测试分析助手。',
    '请分析下面失败的测试用例，并输出中文 markdown 报告。',
    '每个疑似缺陷请包含：缺陷标题、缺陷描述、影响的接口/用例、实际结果、预期结果、建议跟进动作。',
    '',
    JSON.stringify(
      {
        runId: run.id,
        summary: run.summary,
        failedCases: run.results.filter((item) => !item.pass).map((item) => ({
          interfaceName: item.interfaceName,
          caseName: item.caseName,
          method: item.method,
          path: item.path,
          assertionSummary: item.assertionSummary,
          response: item.response.bodyJson || item.response.bodyText,
        })),
      },
      null,
      2,
    ),
  ].join('\n');

  const response = await callAiText(ai, {
    systemPrompt: '请仅输出中文 markdown，不要输出多余解释。',
    userPrompt: prompt,
  });

  if (response.ok) {
    return {
      markdown: response.text,
      provider: 'remote-ai',
      raw: response.raw,
      meta: response.meta,
    };
  }

  return {
    markdown: `${buildFallbackMarkdown(run)}\n\n## AI 调用异常\n\n${response.meta.reason}\n`,
    provider: 'fallback',
    raw: response.raw,
    meta: response.meta,
  };
}

module.exports = {
  analyzeRunWithAi,
  buildFallbackMarkdown,
};
