import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  accumulateUsage,
  buildMessages,
  buildThinkingRequest,
  computeBalanceSpend,
  contextSummary,
  createConversation,
  createSseParser,
  createUsage,
  extractFullResponse,
  extractStreamPiece,
  formatBalance,
  formatTokenCount,
  friendlyError,
  isLimitReached,
  nextSpeaker,
  normalizeConversation,
  normalizeSettings,
  normalizeThinkingMode,
  normalizeUsage,
  otherSpeaker,
  parseBalancePayload,
  toExportJson,
  toExportMarkdown
} from '../public/engine.js';

import { escapeHtml, renderMarkdown } from '../public/markdown.js';

function conversationWithTurns() {
  const conv = createConversation({
    startPrompt: '  请开始一场关于时间的对话  ',
    participants: { A: { name: '甲' }, B: { name: '乙' } },
    maxTurns: 10
  });
  conv.turns.push(
    { id: 't1', speaker: 'A', content: 'A1', createdAt: 1, usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    { id: 't2', speaker: 'B', content: 'B1', createdAt: 2 },
    { id: 't3', speaker: 'A', content: 'A2', createdAt: 3 },
    { id: 't4', speaker: 'B', content: 'B2', createdAt: 4 }
  );
  return conv;
}

test('上下文隔离：A 的启动词只出现在 A 的上下文，双方历史不合并', () => {
  const conv = conversationWithTurns();
  const messagesA = buildMessages(conv, 'A');
  const messagesB = buildMessages(conv, 'B');

  assert.deepEqual(messagesA, [
    { role: 'user', content: '请开始一场关于时间的对话' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'B1' },
    { role: 'assistant', content: 'A2' },
    { role: 'user', content: 'B2' }
  ]);
  assert.deepEqual(messagesB, [
    { role: 'user', content: 'A1' },
    { role: 'assistant', content: 'B1' },
    { role: 'user', content: 'A2' },
    { role: 'assistant', content: 'B2' }
  ]);

  for (const messages of [messagesA, messagesB]) {
    assert.ok(messages.every((message) => message.role !== 'system'));
    assert.ok(messages.every((message) => ['user', 'assistant'].includes(message.role)));
  }

  // B 的上下文里没有任何 A 的 assistant 消息；A 的上下文里也没有 B 的 assistant 消息。
  assert.ok(!messagesB.some((message) => message.role === 'assistant' && message.content.startsWith('A')));
  assert.ok(!messagesA.some((message) => message.role === 'assistant' && message.content.startsWith('B')));

  // 每一侧都只把“自己说过的话”标成 assistant。
  const ownA = messagesA.filter((message) => message.role === 'assistant').map((message) => message.content);
  const ownB = messagesB.filter((message) => message.role === 'assistant').map((message) => message.content);
  assert.deepEqual(ownA, ['A1', 'A2']);
  assert.deepEqual(ownB, ['B1', 'B2']);
});

test('上下文隔离：B 没有启动提示词，A 的第一条发言后才会有 B 的上下文', () => {
  const conv = createConversation({ startPrompt: '启动' });
  assert.deepEqual(buildMessages(conv, 'A'), [{ role: 'user', content: '启动' }]);
  assert.throws(() => buildMessages(conv, 'B'), /还没有可用的上下文/);

  conv.turns.push({ id: 't1', speaker: 'A', content: '第一句', createdAt: 1 });
  assert.deepEqual(buildMessages(conv, 'B'), [{ role: 'user', content: '第一句' }]);

  conv.turns.push({ id: 't2', speaker: 'B', content: '第二句', createdAt: 2 });
  assert.deepEqual(buildMessages(conv, 'A'), [
    { role: 'user', content: '启动' },
    { role: 'assistant', content: '第一句' },
    { role: 'user', content: '第二句' }
  ]);
});

test('nextSpeaker 首条 A，之后严格交替', () => {
  const conv = createConversation({ startPrompt: 'x' });
  assert.equal(nextSpeaker(conv), 'A');
  conv.turns.push({ id: 't1', speaker: 'A', content: 'a', createdAt: 1 });
  assert.equal(nextSpeaker(conv), 'B');
  conv.turns.push({ id: 't2', speaker: 'B', content: 'b', createdAt: 2 });
  assert.equal(nextSpeaker(conv), 'A');
  assert.equal(otherSpeaker('A'), 'B');
  assert.equal(otherSpeaker('B'), 'A');
});

test('contextSummary 能反映每条侧实际 messages 数量与字符数', () => {
  const summary = contextSummary(conversationWithTurns());
  assert.deepEqual(summary.A, { messages: 5, chars: 20 });
  assert.deepEqual(summary.B, { messages: 4, chars: 8 });
});

test('createConversation 会修剪、夹紧参数并生成可读标题', () => {
  const conv = createConversation({
    startPrompt: '   #   标题\n第二行  ',
    participants: { A: { name: '  ' }, B: { name: 'B 方' } },
    maxTurns: 9999,
    delayMs: -50,
    params: { temperature: 9, maxTokens: -1, topP: 5 }
  });
  assert.equal(conv.startPrompt, '#   标题\n第二行');
  assert.equal(conv.title, '标题 第二行');
  assert.equal(conv.maxTurns, 500);
  assert.equal(conv.delayMs, 0);
  assert.equal(conv.participants.A.name, 'AI-A');
  assert.equal(conv.participants.B.name, 'B 方');
  assert.equal(conv.params.temperature, 2);
  assert.equal(conv.params.maxTokens, 1);
  assert.equal(conv.params.topP, 1);
  assert.equal(conv.thinkingMode, 'auto');
  assert.equal(conv.status, 'idle');
  assert.deepEqual(conv.usage, createUsage());
  assert.equal(isLimitReached(conv), false);
});

test('思考模式会被规范化，并生成正确的请求参数', () => {
  assert.equal(normalizeThinkingMode('ENABLED'), 'enabled');
  assert.equal(normalizeThinkingMode('disabled'), 'disabled');
  assert.equal(normalizeThinkingMode('bogus'), 'auto');
  assert.deepEqual(buildThinkingRequest('auto'), {});
  assert.deepEqual(buildThinkingRequest('enabled'), { thinking: { type: 'enabled' } });
  assert.deepEqual(buildThinkingRequest('disabled'), { thinking: { type: 'disabled' } });

  const conv = createConversation({ startPrompt: 'x', thinkingMode: 'enabled' });
  assert.equal(conv.thinkingMode, 'enabled');
  const restored = normalizeConversation({ ...conv, thinkingMode: 'disabled' });
  assert.equal(restored.thinkingMode, 'disabled');
  assert.equal(normalizeConversation({ ...conv, thinkingMode: 'bogus' }).thinkingMode, 'auto');
});

test('normalizeConversation 兼容旧数据、过滤坏记录并恢复暂停状态', () => {
  const raw = {
    id: 'conv_old',
    startPrompt: '旧实验',
    maxTurns: 2,
    status: 'running',
    turns: [
      { id: 'a', speaker: 'A', content: 'ok' },
      { id: 'bad', speaker: 'C', content: 'drop' },
      { id: 'null', speaker: 'B', content: null },
      { id: 'b', speaker: 'B', content: 'also ok' },
      { id: 'c', speaker: 'A', content: 'third' }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, calls: 2 },
    balanceBaseline: { CNY: 12.5 },
    balanceBaselineAt: 123,
    lastBalance: { infos: [] }
  };
  const conv = normalizeConversation(raw);
  assert.ok(conv);
  assert.equal(conv.id, 'conv_old');
  assert.equal(conv.turns.length, 3);
  assert.equal(conv.turns[0].content, 'ok');
  assert.equal(conv.turns[1].content, 'also ok');
  assert.equal(conv.turns[2].content, 'third');
  assert.equal(conv.status, 'done');
  assert.deepEqual(conv.balanceBaseline, { CNY: 12.5 });
  assert.equal(conv.balanceBaselineAt, 123);
  assert.equal(conv.usage.total_tokens, 15);
  assert.equal(normalizeConversation(null), null);
});

test('normalizeSettings 对缺失/越界值使用安全默认值', () => {
  const settings = normalizeSettings({ baseUrl: '  http://example.test/v1 ', temperature: -1, maxTokens: 'abc', topP: 3, rememberKey: false });
  assert.equal(settings.baseUrl, 'http://example.test/v1');
  assert.equal(settings.model, DEFAULT_SETTINGS.model);
  assert.equal(settings.temperature, 0);
  assert.equal(settings.maxTokens, DEFAULT_SETTINGS.maxTokens);
  assert.equal(settings.topP, 1);
  assert.equal(settings.thinkingMode, 'auto');
  assert.equal(settings.rememberKey, false);
  assert.equal(normalizeSettings(null).rememberKey, true);
  assert.equal(normalizeSettings({ thinkingMode: 'enabled' }).thinkingMode, 'enabled');
});

test('usage 规范化和累计', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 3, completion_tokens: 2 }), {
    prompt_tokens: 3,
    completion_tokens: 2,
    total_tokens: 5,
    calls: 1
  });
  const usage = createUsage();
  accumulateUsage(usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  accumulateUsage(usage, { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 });
  assert.deepEqual(usage, { prompt_tokens: 14, completion_tokens: 3, total_tokens: 17, calls: 2 });
});

test('SSE 解析器容忍跨 chunk、CRLF 与 [DONE]', () => {
  const parser = createSseParser();
  assert.deepEqual(parser.push('data: {"choices":'), []);
  assert.deepEqual(parser.push('[{"delta":{"content":"你"}}]}\n\n'), [
    { data: { choices: [{ delta: { content: '你' } }] } }
  ]);
  assert.deepEqual(parser.push('data: {"a":1}\r\n\r\n'), [{ data: { a: 1 } }]);
  assert.deepEqual(parser.push('data: [DONE]\r\n\r\n'), [{ done: true }]);
  assert.deepEqual(parser.flush(), []);
});

test('SSE 解析器 flush 处理没有结尾空行的最后一块', () => {
  const parser = createSseParser();
  assert.deepEqual(parser.push('data: {"choices":[]}'), []);
  assert.deepEqual(parser.flush(), [{ data: { choices: [] } }]);
});

test('extractStreamPiece / extractFullResponse 提取正文、思考、用量和错误', () => {
  const piece = extractStreamPiece({
    model: 'deepseek-reasoner',
    choices: [{ delta: { content: '回答', reasoning_content: '思考' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
  });
  assert.equal(piece.content, '回答');
  assert.equal(piece.reasoning, '思考');
  assert.equal(piece.finishReason, 'stop');
  assert.equal(piece.model, 'deepseek-reasoner');
  assert.equal(piece.usage.total_tokens, 5);
  assert.equal(extractStreamPiece({ error: { message: 'bad' } }).error, 'bad');

  const full = extractFullResponse({
    model: 'deepseek-chat',
    choices: [{ message: { content: '完整回答', reasoning_content: '完整思考' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  });
  assert.equal(full.content, '完整回答');
  assert.equal(full.reasoning, '完整思考');
  assert.equal(full.finishReason, 'stop');
  assert.equal(full.usage.total_tokens, 2);
});

test('friendlyError 把常见失败翻译成可操作的中文', () => {
  assert.match(friendlyError(new Error('invalid api key'), 401), /API Key/);
  assert.match(friendlyError(new Error('quota'), 402), /余额不足/);
  assert.match(friendlyError(new Error('rate limit'), 429), /频繁/);
  assert.match(friendlyError(new Error('bad request'), 400), /400/);
  assert.match(friendlyError(new Error('boom'), 503), /上游服务异常/);
  assert.match(friendlyError(new Error('Failed to fetch')), /本地服务/);
  assert.match(friendlyError(new Error('AbortError')), /已中断/);
  assert.equal(friendlyError(new Error('自定义错误')), '自定义错误');
});

test('余额解析、格式化和本实验消耗估算', () => {
  const parsed = parseBalancePayload({
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '99.50', granted_balance: '20.00', topped_up_balance: '79.50' },
      { currency: 'USD', total_balance: '3.2' },
      { total_balance: 'ignore' }
    ]
  });
  assert.equal(parsed.available, true);
  assert.equal(parsed.error, null);
  assert.equal(parsed.infos.length, 2);
  assert.deepEqual(parsed.infos[0], { currency: 'CNY', total: 99.5, granted: 20, toppedUp: 79.5 });
  assert.equal(parsed.infos[1].total, 3.2);

  assert.equal(parseBalancePayload(null).available, false);
  assert.equal(parseBalancePayload({ error: { message: 'no' } }).error, 'no');
  assert.equal(formatTokenCount(1234), '1,234');
  assert.equal(formatTokenCount(12500), '12.5k');
  assert.equal(formatTokenCount(2_500_000), '2.50M');
  assert.equal(formatBalance('CNY', 12.345), '¥12.35');
  assert.equal(formatBalance('USD', 0.0123), '$0.0123');

  const spend = computeBalanceSpend({ CNY: 100, USD: 10 }, [
    { currency: 'CNY', total: 97.25 },
    { currency: 'USD', total: 10.5 },
    { currency: 'EUR', total: 1 }
  ]);
  assert.deepEqual(spend, [
    { currency: 'CNY', start: 100, current: 97.25, spent: 2.75 },
    { currency: 'USD', start: 10, current: 10.5, spent: -0.5 }
  ]);
  assert.equal(computeBalanceSpend(null, []), null);
});

test('导出 JSON / Markdown 包含实验内容和双方名称', () => {
  const conv = conversationWithTurns();
  const json = JSON.parse(toExportJson(conv));
  assert.equal(json.app, 'EchoLab / 回响');
  assert.equal(json.conversation.id, conv.id);
  assert.equal(json.conversation.turns.length, 4);

  const markdown = toExportMarkdown(conv);
  assert.match(markdown, /^# 请开始一场关于时间的对话/m);
  assert.match(markdown, /甲 · 第 1 条/);
  assert.match(markdown, /乙 · 第 2 条/);
  assert.match(markdown, /A1/);
  assert.match(markdown, /B2/);
});

test('Markdown 渲染默认转义原始 HTML，只允许安全链接', () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');

  const html = renderMarkdown('# 标题\n\n- 项目一\n- **加粗** 与 `code`\n\n[安全](https://example.com) [危险](javascript:alert(1))');
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<ul><li>项目一<\/li>/);
  assert.match(html, /<strong>加粗<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /href="https:\/\/example\.com\/"/);
  assert.ok(!html.includes('href="javascript'));

  const escaped = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!escaped.includes('<script>'));
  assert.ok(escaped.includes('&lt;script&gt;'));

  const code = renderMarkdown('```js\nif (a < b) alert("<x>")\n```');
  assert.match(code, /<pre><code class="language-js">/);
  assert.ok(code.includes('&lt;'));
});
