/**
 * 回响 · 核心逻辑（无 DOM 依赖，可在浏览器与 Node 测试中复用）
 *
 * 上下文隔离规则（全项目最重要的不变量）：
 *   A 的 API 上下文 = [用户启动词, A 自己的历史回答, B 的回答作为用户消息…]
 *   B 的 API 上下文 = [A 的回答作为用户消息, B 自己的历史回答, …]
 *   任一时刻发给模型的 messages 里，只包含"接收方自己的输出"与"对方传给它的发言"，
 *   绝不会把双方历史合并成一份共同对话。
 */

export const SPEAKER_KEYS = Object.freeze(['A', 'B']);

export const DEFAULT_SETTINGS = Object.freeze({
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  temperature: 0.8,
  maxTokens: 2048,
  topP: 1,
  thinkingMode: 'auto',
  rememberKey: true
});

export const THINKING_MODES = Object.freeze(['auto', 'enabled', 'disabled']);

export function normalizeThinkingMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return THINKING_MODES.includes(mode) ? mode : 'auto';
}

/**
 * 返回需要附加到 /chat/completions 请求体里的思考模式参数。
 * auto 不发送，交给模型/服务端决定；enabled/disabled 显式覆盖。
 */
export function buildThinkingRequest(mode) {
  const normalized = normalizeThinkingMode(mode);
  if (normalized === 'auto') return {};
  return { thinking: { type: normalized } };
}

export const DEFAULT_PARTICIPANTS = Object.freeze({
  A: { name: 'AI-A' },
  B: { name: 'AI-B' }
});

export const MODEL_PRESETS = Object.freeze([
  'deepseek-chat',
  'deepseek-reasoner',
  'deepseek-flash',
  'deepseek-v4-pro'
]);

export const MAX_TURNS_LIMIT = 500;
export const MIN_TURNS_LIMIT = 2;

function randomId(prefix = 'c') {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createUsage() {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 0 };
}

export function normalizeUsage(usage) {
  const result = createUsage();
  if (!usage || typeof usage !== 'object') return result;
  result.prompt_tokens = Number(usage.prompt_tokens) || 0;
  result.completion_tokens = Number(usage.completion_tokens) || 0;
  result.total_tokens = Number(usage.total_tokens) || result.prompt_tokens + result.completion_tokens;
  result.calls = 1;
  return result;
}

export function accumulateUsage(target, usage) {
  const next = target && typeof target === 'object' ? target : createUsage();
  const add = normalizeUsage(usage);
  if (add.calls === 0) return next;
  next.prompt_tokens = (Number(next.prompt_tokens) || 0) + add.prompt_tokens;
  next.completion_tokens = (Number(next.completion_tokens) || 0) + add.completion_tokens;
  next.total_tokens = (Number(next.total_tokens) || 0) + add.total_tokens;
  next.calls = (Number(next.calls) || 0) + 1;
  return next;
}

export function otherSpeaker(speaker) {
  return speaker === 'A' ? 'B' : 'A';
}

/**
 * 下一位发言者：首条永远是 A（启动词发给 A），之后严格交替。
 */
export function nextSpeaker(conversation) {
  const turns = conversation?.turns || [];
  if (turns.length === 0) return 'A';
  return otherSpeaker(turns[turns.length - 1].speaker);
}

/**
 * 构造某一方真正发送给模型的 messages。
 * 不注入任何 system prompt、人设或额外指令。
 */
export function buildMessages(conversation, speaker) {
  if (!conversation || !SPEAKER_KEYS.includes(speaker)) {
    throw new Error('构造上下文失败：会话或发言方无效');
  }
  const messages = [];

  // 只有 A 会在最开始收到用户的启动提示词。
  if (speaker === 'A') {
    messages.push({ role: 'user', content: conversation.startPrompt });
  }

  for (const turn of conversation.turns || []) {
    if (!turn || typeof turn.content !== 'string') continue;
    if (turn.speaker === speaker) {
      messages.push({ role: 'assistant', content: turn.content });
    } else {
      messages.push({ role: 'user', content: turn.content });
    }
  }

  if (messages.length === 0) {
    throw new Error('该发言方还没有可用的上下文');
  }
  return messages;
}

export function conversationTitle(startPrompt, maxLength = 40) {
  const cleaned = String(startPrompt || '')
    .replace(/\s+/g, ' ')
    .replace(/^[#>*\-\s]+/, '')
    .trim();
  if (!cleaned) return '未命名实验';
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

export function createConversation(input = {}) {
  const now = Date.now();
  const maxTurnsRaw = Number(input.maxTurns);
  const maxTurns = Number.isFinite(maxTurnsRaw)
    ? Math.min(MAX_TURNS_LIMIT, Math.max(MIN_TURNS_LIMIT, Math.round(maxTurnsRaw)))
    : 20;
  const delayRaw = Number(input.delayMs);
  const delayMs = Number.isFinite(delayRaw) ? Math.min(30000, Math.max(0, Math.round(delayRaw))) : 800;
  const nameA = String(input.participants?.A?.name || DEFAULT_PARTICIPANTS.A.name).trim().slice(0, 40) || 'AI-A';
  const nameB = String(input.participants?.B?.name || DEFAULT_PARTICIPANTS.B.name).trim().slice(0, 40) || 'AI-B';
  const params = input.params || {};

  return {
    version: 1,
    id: randomId('conv'),
    title: conversationTitle(input.startPrompt),
    startPrompt: String(input.startPrompt || '').trim(),
    participants: { A: { name: nameA }, B: { name: nameB } },
    model: String(input.model || DEFAULT_SETTINGS.model).trim(),
    thinkingMode: normalizeThinkingMode(input.thinkingMode),
    params: {
      temperature: clampNumber(params.temperature, 0, 2, DEFAULT_SETTINGS.temperature),
      maxTokens: clampNumber(params.maxTokens, 1, 393216, DEFAULT_SETTINGS.maxTokens),
      topP: clampNumber(params.topP, 0, 1, DEFAULT_SETTINGS.topP)
    },
    maxTurns,
    delayMs,
    turns: [],
    usage: createUsage(),
    balanceBaseline: null,
    balanceBaselineAt: null,
    lastBalance: null,
    status: 'idle',
    lastError: null,
    createdAt: now,
    updatedAt: now
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * 兼容旧数据 / 损坏数据；刷新页面时把"运行中"恢复为"已暂停"。
 */
export function normalizeConversation(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  const base = createConversation({
    startPrompt: raw.startPrompt,
    participants: raw.participants,
    model: raw.model,
    thinkingMode: raw.thinkingMode,
    params: raw.params,
    maxTurns: raw.maxTurns,
    delayMs: raw.delayMs
  });
  const turns = Array.isArray(raw.turns)
    ? raw.turns
        .filter((turn) => turn && SPEAKER_KEYS.includes(turn.speaker) && typeof turn.content === 'string')
        .map((turn, index) => ({
          id: String(turn.id || `turn_${index}_${randomId('x').slice(2)}`),
          speaker: turn.speaker,
          content: turn.content,
          reasoning: typeof turn.reasoning === 'string' && turn.reasoning ? turn.reasoning : undefined,
          createdAt: Number(turn.createdAt) || base.createdAt,
          model: typeof turn.model === 'string' ? turn.model : base.model,
          finishReason: typeof turn.finishReason === 'string' ? turn.finishReason : undefined,
          usage: turn.usage && typeof turn.usage === 'object' ? turn.usage : undefined
        }))
    : [];

  const statuses = new Set(['idle', 'running', 'pausing', 'paused', 'stopped', 'error', 'done']);
  let status = statuses.has(raw.status) ? raw.status : 'idle';
  if (status === 'running' || status === 'pausing') status = 'paused';
  if (turns.length >= base.maxTurns && (status === 'idle' || status === 'paused' || status === 'stopped')) {
    status = 'done';
  }

  return {
    ...base,
    id: String(raw.id),
    title: String(raw.title || conversationTitle(raw.startPrompt)),
    turns,
    usage: raw.usage ? { ...createUsage(), ...raw.usage } : createUsage(),
    balanceBaseline: raw.balanceBaseline && typeof raw.balanceBaseline === 'object' ? raw.balanceBaseline : null,
    balanceBaselineAt: Number(raw.balanceBaselineAt) || null,
    lastBalance: raw.lastBalance && typeof raw.lastBalance === 'object' ? raw.lastBalance : null,
    status,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    createdAt: Number(raw.createdAt) || base.createdAt,
    updatedAt: Number(raw.updatedAt) || base.updatedAt
  };
}

export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    baseUrl: String(source.baseUrl || DEFAULT_SETTINGS.baseUrl).trim(),
    model: String(source.model || DEFAULT_SETTINGS.model).trim(),
    temperature: clampNumber(source.temperature, 0, 2, DEFAULT_SETTINGS.temperature),
    maxTokens: clampNumber(source.maxTokens, 1, 393216, DEFAULT_SETTINGS.maxTokens),
    topP: clampNumber(source.topP, 0, 1, DEFAULT_SETTINGS.topP),
    thinkingMode: normalizeThinkingMode(source.thinkingMode),
    rememberKey: source.rememberKey !== false
  };
}

export function isLimitReached(conversation) {
  return Boolean(conversation) && conversation.turns.length >= conversation.maxTurns;
}

export function contextSummary(conversation) {
  const summary = {};
  for (const speaker of SPEAKER_KEYS) {
    try {
      const messages = buildMessages(conversation, speaker);
      summary[speaker] = {
        messages: messages.length,
        chars: messages.reduce((total, message) => total + message.content.length, 0)
      };
    } catch {
      summary[speaker] = { messages: 0, chars: 0 };
    }
  }
  return summary;
}

/**
 * 增量 SSE 解析器：按空行分块，容忍跨 chunk 截断与 CRLF。
 * push() 返回事件数组；事件形如 { data } / { done: true } / { raw }。
 */
export function createSseParser() {
  let buffer = '';
  const events = [];

  function parseBlock(block) {
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (dataLines.length === 0) return null;
    const data = dataLines.join('\n');
    if (data === '[DONE]') return { done: true };
    try {
      return { data: JSON.parse(data) };
    } catch {
      return { raw: data };
    }
  }

  return {
    push(chunk) {
      buffer += String(chunk);
      events.length = 0;
      while (true) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const event = parseBlock(block);
        if (event) events.push(event);
      }
      return events.slice();
    },
    flush() {
      events.length = 0;
      if (buffer.trim()) {
        const event = parseBlock(buffer);
        if (event) events.push(event);
      }
      buffer = '';
      return events.slice();
    }
  };
}

/**
 * 从一条 chat.completion.chunk 中提取文本、思考内容与用量。
 */
export function extractStreamPiece(payload) {
  const result = {
    content: '',
    reasoning: '',
    finishReason: null,
    usage: null,
    model: null,
    error: null
  };
  if (!payload || typeof payload !== 'object') return result;
  if (payload.error) {
    result.error = payload.error.message || JSON.stringify(payload.error);
    return result;
  }
  if (typeof payload.model === 'string') result.model = payload.model;
  if (payload.usage && typeof payload.usage === 'object') result.usage = payload.usage;

  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  if (!choice) return result;
  if (typeof choice.finish_reason === 'string') result.finishReason = choice.finish_reason;
  const delta = choice.delta || {};
  if (typeof delta.content === 'string') result.content = delta.content;
  if (typeof delta.reasoning_content === 'string') result.reasoning = delta.reasoning_content;
  else if (typeof delta.reasoning === 'string') result.reasoning = delta.reasoning;
  return result;
}

/**
 * 非流式响应兼容提取。
 */
export function extractFullResponse(payload) {
  const result = { content: '', reasoning: '', finishReason: null, usage: null, model: null, error: null };
  if (!payload || typeof payload !== 'object') return result;
  if (payload.error) {
    result.error = payload.error.message || JSON.stringify(payload.error);
    return result;
  }
  if (typeof payload.model === 'string') result.model = payload.model;
  if (payload.usage) result.usage = payload.usage;
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  if (!choice) return result;
  result.finishReason = choice.finish_reason || null;
  const message = choice.message || {};
  if (typeof message.content === 'string') result.content = message.content;
  if (typeof message.reasoning_content === 'string') result.reasoning = message.reasoning_content;
  else if (typeof message.reasoning === 'string') result.reasoning = message.reasoning;
  return result;
}

export function friendlyError(error, statusCode) {
  const message = String(error?.message || error || '未知错误');
  if (statusCode === 401 || /401|invalid.*api.?key|authentication/i.test(message)) {
    return 'API Key 无效或已过期（401）。请在设置中检查 Key。';
  }
  if (statusCode === 402 || /402|balance|quota|余额/i.test(message)) {
    return '账户余额不足（402）。请前往 DeepSeek 平台充值。';
  }
  if (statusCode === 429 || /429|rate.?limit|too many requests/i.test(message)) {
    return '请求过于频繁（429）。请稍后重试，或降低对话速度。';
  }
  if (statusCode === 400) return `请求参数被拒绝（400）：${message}`;
  if (statusCode >= 500) return `上游服务异常（${statusCode}）：${message}`;
  if (/Failed to fetch|NetworkError|network|ECONNREFUSED/i.test(message)) {
    return '无法连接本地服务。请确认 start.bat 窗口仍在运行，然后刷新页面。';
  }
  if (/aborted|AbortError|已中断/i.test(message)) return '请求已中断。';
  return message;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

export function formatTime(timestamp) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(timestamp));
  } catch {
    return '';
  }
}

/**
 * 规范化 DeepSeek /user/balance 响应。
 */
export function parseBalancePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { available: false, infos: [], error: '余额响应格式不正确' };
  }
  if (payload.error) {
    return { available: false, infos: [], error: payload.error.message || '余额查询失败' };
  }
  const infos = Array.isArray(payload.balance_infos)
    ? payload.balance_infos
        .filter((item) => item && typeof item === 'object' && item.currency)
        .map((item) => ({
          currency: String(item.currency),
          total: Number.parseFloat(item.total_balance) || 0,
          granted: Number.parseFloat(item.granted_balance) || 0,
          toppedUp: Number.parseFloat(item.topped_up_balance) || 0
        }))
    : [];
  return {
    available: payload.is_available === true,
    infos,
    error: null
  };
}

export function formatTokenCount(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 1 : 2)}M`;
  if (number >= 10_000) return `${(number / 1000).toFixed(1)}k`;
  return new Intl.NumberFormat('zh-CN').format(number);
}

export function formatBalance(currency, value) {
  const number = Number(value) || 0;
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `;
  const digits = Math.abs(number) > 0 && Math.abs(number) < 0.1 ? 4 : 2;
  return `${symbol}${number.toFixed(digits)}`;
}

/**
 * 计算当前余额相对实验开始时的变化（正数表示余额减少）。
 */
export function computeBalanceSpend(baseline, infos) {
  if (!baseline || !Array.isArray(infos) || infos.length === 0) return null;
  const rows = [];
  for (const info of infos) {
    const start = Number(baseline[info.currency]);
    if (!Number.isFinite(start)) continue;
    rows.push({
      currency: info.currency,
      start,
      current: info.total,
      spent: start - info.total
    });
  }
  return rows.length > 0 ? rows : null;
}

export function toExportJson(conversation) {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      app: 'EchoLab / 回响',
      note: '双方上下文隔离；turns 为观察记录，messages 是 API 实际输入。',
      conversation
    },
    null,
    2
  );
}

export function toExportMarkdown(conversation) {
  const lines = [];
  lines.push(`# ${conversation.title}`);
  lines.push('');
  lines.push(`- 模型：\`${conversation.model}\``);
  lines.push(`- 时间：${new Date(conversation.createdAt).toLocaleString('zh-CN')}`);
  lines.push(`- 启动提示词：${conversation.startPrompt}`);
  lines.push(`- 双方：${conversation.participants.A.name} / ${conversation.participants.B.name}`);
  lines.push(`- 思考模式：${conversation.thinkingMode || 'auto'}`);
  lines.push(`- 发言条数：${conversation.turns.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const turn of conversation.turns) {
    const name = conversation.participants[turn.speaker]?.name || turn.speaker;
    lines.push(`## ${name} · 第 ${conversation.turns.indexOf(turn) + 1} 条`);
    lines.push('');
    if (turn.reasoning) {
      lines.push('<details><summary>思维链</summary>');
      lines.push('');
      lines.push(turn.reasoning);
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
    lines.push(turn.content);
    lines.push('');
  }
  return lines.join('\n');
}
