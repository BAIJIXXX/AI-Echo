/**
 * 回响 · 浏览器端应用
 *
 * 只负责观察界面与实验运行；上下文隔离由 engine.js 的 buildMessages 保证。
 * API Key 只存在浏览器 storage 与本页内存；所有模型请求经本地 server.mjs 代理。
 */
import {
  DEFAULT_SETTINGS,
  MAX_TURNS_LIMIT,
  MIN_TURNS_LIMIT,
  accumulateUsage,
  buildMessages,
  buildThinkingRequest,
  contextSummary,
  computeBalanceSpend,
  createConversation,
  createSseParser,
  extractFullResponse,
  extractStreamPiece,
  formatBalance,
  formatTime,
  formatTokenCount,
  friendlyError,
  isLimitReached,
  nextSpeaker,
  normalizeConversation,
  normalizeSettings,
  normalizeThinkingMode,
  otherSpeaker,
  parseBalancePayload,
  toExportMarkdown,
  toExportJson
} from './engine.js';
import { escapeHtml, renderMarkdown } from './markdown.js';

const STORAGE_CONVERSATIONS = 'echolab.conversations.v1';
const STORAGE_SETTINGS = 'echolab.settings.v1';
const STORAGE_KEY_LOCAL = 'echolab.apiKey.local';
const STORAGE_KEY_SESSION = 'echolab.apiKey.session';

const $ = (id) => document.getElementById(id);
const ICON = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

class RunCanceledError extends Error {
  constructor() {
    super('运行已取消');
    this.name = 'RunCanceledError';
  }
}

const els = {
  app: $('app'),
  sidebarBackdrop: $('sidebarBackdrop'),
  sidebar: $('sidebar'),
  menuBtn: $('menuBtn'),
  newBtn: $('newBtn'),
  historyList: $('historyList'),
  historyCount: $('historyCount'),
  importBtn: $('importBtn'),
  importInput: $('importInput'),
  settingsBtn: $('settingsBtn'),
  topbarEyebrow: $('topbarEyebrow'),
  topbarTitle: $('topbarTitle'),
  modelPill: $('modelPill'),
  balanceBtn: $('balanceBtn'),
  balanceDot: $('balanceDot'),
  balanceValue: $('balanceValue'),
  balancePopover: $('balancePopover'),
  balanceUpdated: $('balanceUpdated'),
  balanceRefreshBtn: $('balanceRefreshBtn'),
  balanceBody: $('balanceBody'),
  exportBtn: $('exportBtn'),
  exportMenu: $('exportMenu'),
  inspectorBtn: $('inspectorBtn'),
  newView: $('newView'),
  newForm: $('newForm'),
  startPrompt: $('startPrompt'),
  promptCount: $('promptCount'),
  nameA: $('nameA'),
  nameB: $('nameB'),
  maxTurns: $('maxTurns'),
  delayMs: $('delayMs'),
  modelInput: $('modelInput'),
  thinkingMode: $('thinkingMode'),
  temperature: $('temperature'),
  maxTokens: $('maxTokens'),
  topP: $('topP'),
  keyStatus: $('keyStatus'),
  keyStatusText: $('keyStatusText'),
  startBtn: $('startBtn'),
  convView: $('convView'),
  experimentTitle: $('experimentTitle'),
  experimentPills: $('experimentPills'),
  promptQuote: $('promptQuote'),
  promptText: $('promptText'),
  statTurns: $('statTurns'),
  statTokens: $('statTokens'),
  statSpend: $('statSpend'),
  statModel: $('statModel'),
  progressBar: $('progressBar'),
  errorBanner: $('errorBanner'),
  errorText: $('errorText'),
  errorRetryBtn: $('errorRetryBtn'),
  transcriptScroll: $('transcriptScroll'),
  transcript: $('transcript'),
  transcriptEnd: $('transcriptEnd'),
  scrollBottomBtn: $('scrollBottomBtn'),
  runDot: $('runDot'),
  runState: $('runState'),
  runDetail: $('runDetail'),
  btnStep: $('btnStep'),
  btnPause: $('btnPause'),
  btnStop: $('btnStop'),
  btnPrimary: $('btnPrimary'),
  inspector: $('inspector'),
  inspectorCloseBtn: $('inspectorCloseBtn'),
  ctxTabA: $('ctxTabA'),
  ctxTabB: $('ctxTabB'),
  ctxMeta: $('ctxMeta'),
  ctxList: $('ctxList'),
  ctxRaw: $('ctxRaw'),
  settingsDialog: $('settingsDialog'),
  settingsForm: $('settingsForm'),
  settingsHint: $('settingsHint'),
  settingBaseUrl: $('settingBaseUrl'),
  settingApiKey: $('settingApiKey'),
  settingRemember: $('settingRemember'),
  settingModel: $('settingModel'),
  settingThinkingMode: $('settingThinkingMode'),
  settingTemperature: $('settingTemperature'),
  settingMaxTokens: $('settingMaxTokens'),
  settingTopP: $('settingTopP'),
  toggleKeyBtn: $('toggleKeyBtn'),
  testConnectionBtn: $('testConnectionBtn'),
  testResult: $('testResult'),
  settingsCloseBtn: $('settingsCloseBtn'),
  settingsCancelBtn: $('settingsCancelBtn'),
  settingsSaveBtn: $('settingsSaveBtn'),
  clearDataBtn: $('clearDataBtn'),
  confirmDialog: $('confirmDialog'),
  confirmTitle: $('confirmTitle'),
  confirmMessage: $('confirmMessage'),
  confirmCancelBtn: $('confirmCancelBtn'),
  confirmOkBtn: $('confirmOkBtn'),
  toastStack: $('toastStack')
};

const state = {
  conversations: [],
  activeId: null,
  settings: { ...DEFAULT_SETTINGS },
  apiKey: '',
  inspectorSpeaker: 'A',
  inspectorOpen: true,
  pinned: true,
  running: null,
  stream: null,
  balance: {
    loading: false,
    infos: [],
    available: false,
    error: null,
    updatedAt: null
  },
  balanceAttempt: 0,
  balanceInFlight: null,
  quotaWarned: false,
  runSequence: 0
};

let confirmResolver = null;

/* --------------------------------------------------------------------------
   工具
   -------------------------------------------------------------------------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function randomId(prefix = 'turn') {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function formatClock(timestamp) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(timestamp));
  } catch {
    return '';
  }
}

function formatDelay(ms) {
  const number = Number(ms) || 0;
  if (number <= 0) return '无间隔';
  if (number < 1000) return `${number}ms`;
  return `${(number / 1000).toFixed(number % 1000 === 0 ? 0 : 1)}s`;
}

function formatCharCount(value) {
  const length = String(value || '').length;
  return `${new Intl.NumberFormat('zh-CN').format(length)} 字`;
}

function thinkingLabel(mode) {
  switch (normalizeThinkingMode(mode)) {
    case 'enabled':
      return '开启';
    case 'disabled':
      return '关闭';
    default:
      return '自动';
  }
}

function hostOf(input) {
  try {
    return new URL(input).host;
  } catch {
    return input || '';
  }
}

function displayName(conv, speaker) {
  return conv?.participants?.[speaker]?.name || (speaker === 'A' ? 'AI-A' : 'AI-B');
}

function activeConv() {
  return state.conversations.find((conversation) => conversation.id === state.activeId) || null;
}

function getApiKey() {
  return state.apiKey.trim();
}

function isActiveConversation(conv) {
  return Boolean(conv) && state.activeId === conv.id;
}

function safeStorageGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(storage, key, value) {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeStorageRemove(storage, key) {
  try {
    storage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function saveConversations() {
  if (!safeStorageSet(localStorage, STORAGE_CONVERSATIONS, JSON.stringify(state.conversations))) {
    if (!state.quotaWarned) {
      state.quotaWarned = true;
      toast('浏览器本地空间不足，实验记录可能无法保存。请导出后清理旧记录。', 'error', 6000);
    }
  }
}

function loadConversations() {
  const raw = safeStorageGet(localStorage, STORAGE_CONVERSATIONS);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set();
    return parsed
      .map((item) => normalizeConversation(item))
      .filter((item) => {
        if (!item || seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);
  } catch {
    return [];
  }
}

function saveSettings() {
  safeStorageSet(localStorage, STORAGE_SETTINGS, JSON.stringify(state.settings));
}

function loadSettings() {
  const raw = safeStorageGet(localStorage, STORAGE_SETTINGS);
  if (!raw) return normalizeSettings(DEFAULT_SETTINGS);
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS);
  }
}

function loadApiKey() {
  const local = safeStorageGet(localStorage, STORAGE_KEY_LOCAL) || '';
  const session = safeStorageGet(sessionStorage, STORAGE_KEY_SESSION) || '';
  return state.settings.rememberKey ? local || session : session;
}

function updateHash() {
  const base = `${location.pathname}${location.search}`;
  const next = state.activeId ? `${base}#${encodeURIComponent(state.activeId)}` : base;
  try {
    history.replaceState(null, '', next);
  } catch {
    /* ignore */
  }
}

function toast(message, type = 'info', duration = 3400) {
  if (!els.toastStack) return;
  const node = el('div', `toast${type === 'error' ? ' is-error' : type === 'success' ? ' is-success' : ''}`, message);
  els.toastStack.append(node);
  setTimeout(() => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 220);
  }, duration);
}

/* --------------------------------------------------------------------------
   弹层 / 抽屉
   -------------------------------------------------------------------------- */

function closeBalancePopover() {
  els.balancePopover.hidden = true;
  els.balanceBtn.setAttribute('aria-expanded', 'false');
}

function closeExportMenu() {
  els.exportMenu.hidden = true;
  els.exportBtn.setAttribute('aria-expanded', 'false');
}

function closeMenus() {
  els.app.classList.remove('menu-open');
  els.sidebarBackdrop.hidden = true;
}

function openMenu() {
  els.app.classList.add('menu-open');
  els.sidebarBackdrop.hidden = false;
}

function applyInspectorState() {
  els.app.classList.toggle('inspector-open', state.inspectorOpen);
  els.app.classList.toggle('inspector-closed', !state.inspectorOpen);
  els.inspectorBtn.setAttribute('aria-pressed', String(state.inspectorOpen));
}

function toggleInspector(force) {
  state.inspectorOpen = force === undefined ? !state.inspectorOpen : Boolean(force);
  applyInspectorState();
  if (state.inspectorOpen) renderInspector();
}

/* --------------------------------------------------------------------------
   主渲染
   -------------------------------------------------------------------------- */

function applyView() {
  const conv = activeConv();
  els.newView.classList.toggle('hidden', Boolean(conv));
  els.convView.classList.toggle('hidden', !conv);
}

function renderAll() {
  applyView();
  applyInspectorState();
  renderTopbar();
  renderHistory();
  renderKeyStatus();
  renderBalance();
  const conv = activeConv();
  if (conv) {
    renderExperimentHeader(conv);
    renderMessages(conv);
    renderStats(conv);
    renderControls(conv);
    renderError(conv);
    renderInspector(conv);
  }
}

function renderTopbar() {
  const conv = activeConv();
  if (!conv) {
    els.topbarEyebrow.textContent = 'NEW EXPERIMENT';
    els.topbarTitle.textContent = '新实验';
    els.modelPill.textContent = state.settings.model || '—';
    els.exportBtn.disabled = true;
    els.inspectorBtn.disabled = true;
    return;
  }

  const running = Boolean(state.running && state.running.convId === conv.id);
  els.topbarEyebrow.textContent = running ? 'EXPERIMENT / LIVE' : 'EXPERIMENT / RECORD';
  els.topbarTitle.textContent = conv.title;
  els.modelPill.textContent = conv.model || '—';
  els.modelPill.title = `当前实验使用 ${conv.model}`;
  els.exportBtn.disabled = false;
  els.inspectorBtn.disabled = false;
}

function renderHistory() {
  els.historyCount.textContent = String(state.conversations.length);
  els.historyList.replaceChildren();

  if (state.conversations.length === 0) {
    const empty = el('div', 'history-empty');
    empty.textContent = '还没有实验记录。输入一条启动词，让两个 AI 开始互相回应。';
    els.historyList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const conv of state.conversations) {
    const item = el('div', `history-item${conv.id === state.activeId ? ' is-active' : ''}`);
    item.dataset.id = conv.id;
    item.setAttribute('role', 'listitem');
    item.tabIndex = 0;

    const top = el('div', 'history-top');
    const statusClass =
      conv.status === 'paused' || conv.status === 'stopped'
        ? 'is-paused'
        : conv.status === 'error'
          ? 'is-error'
          : conv.status === 'done'
            ? 'is-done'
            : conv.status === 'running' || conv.status === 'pausing'
              ? 'is-running'
              : '';
    const dot = el('span', `history-status ${statusClass}`.trim());
    const title = el('span', 'history-title', conv.title);
    title.title = conv.title;
    top.append(dot, title);
    item.append(top);

    const meta = el('div', 'history-meta');
    meta.append(el('span', '', `${conv.turns.length}/${conv.maxTurns} 条`));
    meta.append(el('span', '', formatTime(conv.updatedAt)));
    item.append(meta);

    const del = el('button', 'history-delete');
    del.type = 'button';
    del.dataset.deleteId = conv.id;
    del.title = '删除实验';
    del.setAttribute('aria-label', `删除实验：${conv.title}`);
    del.innerHTML = ICON('trash');
    item.append(del);

    fragment.append(item);
  }
  els.historyList.append(fragment);
}

function renderKeyStatus() {
  const hasKey = Boolean(getApiKey());
  els.keyStatus.classList.toggle('is-ok', hasKey);
  els.keyStatus.classList.toggle('is-missing', !hasKey);
  els.keyStatusText.textContent = hasKey
    ? `API Key 已配置 · ${hostOf(state.settings.baseUrl)}`
    : '未配置 API Key · 点击设置';
  els.keyStatus.title = hasKey ? '点击打开设置' : '点击填写 DeepSeek API Key';
}

function renderExperimentHeader(conv) {
  els.experimentTitle.textContent = conv.title;
  els.experimentPills.replaceChildren();

  const modelPill = el('span', 'exp-pill', conv.model);
  const nameA = el('span', 'exp-pill is-a', displayName(conv, 'A'));
  const nameB = el('span', 'exp-pill is-b', displayName(conv, 'B'));
  const thinkingPill = el('span', 'exp-pill is-thinking', `思维链 ${thinkingLabel(conv.thinkingMode)}`);
  thinkingPill.title = '思考模式：自动跟随模型；开启会请求 reasoning_content，仅部分模型/端点支持。';
  const delayPill = el('span', 'exp-pill', formatDelay(conv.delayMs));
  els.experimentPills.append(modelPill, nameA, nameB, thinkingPill, delayPill);

  els.promptText.textContent = conv.startPrompt;
  els.promptQuote.title = conv.startPrompt;
}

function renderStats(conv = activeConv()) {
  if (!conv) return;
  els.statTurns.textContent = `${conv.turns.length} / ${conv.maxTurns}`;
  els.statTokens.textContent = formatTokenCount(conv.usage?.total_tokens || 0);
  els.statModel.textContent = conv.model;
  els.progressBar.style.width = `${Math.min(100, (conv.turns.length / conv.maxTurns) * 100)}%`;
  els.statSpend.textContent = spendLabel(conv);
  els.statSpend.title = '以实验开始时查询到的账户余额为基准；余额查询仅支持 DeepSeek 官方端点。';
}

function spendLabel(conv) {
  const infos = conv.lastBalance?.infos;
  const rows = computeBalanceSpend(conv.balanceBaseline, infos || []);
  if (!rows || rows.length === 0) return conv.balanceBaseline ? '待刷新' : '未校准';
  return rows
    .map((row) => {
      if (row.spent >= 0) return `−${formatBalance(row.currency, row.spent)}`;
      return `+${formatBalance(row.currency, Math.abs(row.spent))}`;
    })
    .join(' / ');
}

function buildMessageElement(conv, turn, index) {
  const article = el('article', 'message');
  article.dataset.speaker = turn.speaker;
  article.dataset.turnId = turn.id;

  const avatar = el('div', 'avatar', turn.speaker);
  avatar.setAttribute('aria-hidden', 'true');

  const card = el('div', 'message-card');
  const head = el('div', 'message-head');
  head.append(el('span', 'message-name', displayName(conv, turn.speaker)));
  head.append(el('span', 'message-index', `#${String(index + 1).padStart(2, '0')}`));
  head.append(el('span', 'message-time', formatTime(turn.createdAt)));

  const copy = el('button', 'copy-btn');
  copy.type = 'button';
  copy.dataset.copyTurn = turn.id;
  copy.title = '复制这条回复';
  copy.setAttribute('aria-label', '复制这条回复');
  copy.innerHTML = ICON('copy');
  head.append(copy);
  card.append(head);

  if (turn.reasoning) {
    const details = document.createElement('details');
    details.className = 'reasoning';
    const summary = document.createElement('summary');
    summary.append(
      el('span', 'reasoning-label', '思维链'),
      el('span', 'reasoning-meta', `${formatCharCount(turn.reasoning)} · 模型原始输出`)
    );
    const body = el('div', 'reasoning-body', turn.reasoning);
    details.append(summary, body);
    card.append(details);
  }

  const body = el('div', 'message-body');
  body.innerHTML = renderMarkdown(turn.content || '');
  card.append(body);

  const foot = el('div', 'message-foot');
  if (turn.model) foot.append(el('span', '', turn.model));
  if (turn.usage) {
    const promptTokens = Number(turn.usage.prompt_tokens) || 0;
    const completionTokens = Number(turn.usage.completion_tokens) || 0;
    const totalTokens = Number(turn.usage.total_tokens) || promptTokens + completionTokens;
    foot.append(el('span', '', `in ${formatTokenCount(promptTokens)} · out ${formatTokenCount(completionTokens)} · 共 ${formatTokenCount(totalTokens)}`));
  }
  if (turn.finishReason === 'length') {
    foot.append(el('span', 'finish-warning', '达到 max_tokens，可能被截断'));
  } else if (turn.finishReason === 'content_filter') {
    foot.append(el('span', 'finish-warning', '内容被上游过滤'));
  }
  if (foot.childElementCount > 0) card.append(foot);

  article.append(avatar, card);
  return article;
}

function renderMessages(conv = activeConv()) {
  if (!conv) return;
  if (state.stream && state.stream.convId === conv.id) return;

  els.transcript.replaceChildren();
  if (conv.turns.length === 0) {
    const empty = el('div', 'transcript-empty');
    const orbit = el('div', 'empty-orbit');
    empty.append(orbit, el('strong', '', conv.status === 'error' ? '这一条没有成功生成' : '实验已就绪'));
    empty.append(
      el(
        'span',
        '',
        conv.status === 'error'
          ? '点击下方「重试下一条」或错误提示中的重试。'
          : '点击下方开始，A 会先回答启动词；之后双方自动交替。'
      )
    );
    els.transcript.append(empty);
  } else {
    const fragment = document.createDocumentFragment();
    conv.turns.forEach((turn, index) => {
      fragment.append(buildMessageElement(conv, turn, index));
    });
    els.transcript.append(fragment);
  }

  if (state.pinned) requestAnimationFrame(() => scrollToBottom(false, true));
}

function renderError(conv = activeConv()) {
  const visible = Boolean(conv && conv.status === 'error' && conv.lastError);
  els.errorBanner.classList.toggle('hidden', !visible);
  if (visible) els.errorText.textContent = conv.lastError;
}

function renderControls(conv = activeConv()) {
  if (!conv) return;
  const run = state.running && state.running.convId === conv.id ? state.running : null;
  const running = Boolean(run);
  const limit = isLimitReached(conv);
  let stateText = '就绪';
  let detail = '点击开始，A 会先回答启动词';
  let dotClass = '';

  if (running) {
    if (run.pauseAfterTurn) {
      stateText = '暂停中';
      detail = '本条回答结束后暂停';
      dotClass = 'is-pausing';
    } else if (run.phase === 'baseline') {
      stateText = '准备中';
      detail = '正在校准余额基准…';
      dotClass = 'is-running';
    } else if (run.phase === 'waiting') {
      stateText = '等待中';
      detail = `${formatDelay(conv.delayMs)} 后继续`;
      dotClass = 'is-running';
    } else if (run.phase === 'stopping') {
      stateText = '正在停止';
      detail = '立即中断当前请求';
      dotClass = 'is-pausing';
    } else {
      stateText = '运行中';
      detail = run.speaker
        ? `${displayName(conv, run.speaker)} 正在生成第 ${conv.turns.length + 1} 条…`
        : '正在生成…';
      dotClass = 'is-running';
    }
  } else {
    switch (conv.status) {
      case 'paused':
        stateText = '已暂停';
        detail = `下一条由 ${displayName(conv, nextSpeaker(conv))} 发言`;
        dotClass = 'is-paused';
        break;
      case 'stopped':
        stateText = '已停止';
        detail = `已保留 ${conv.turns.length} 条发言`;
        dotClass = 'is-paused';
        break;
      case 'error':
        stateText = '已中断';
        detail = '查看错误信息后重试下一条';
        dotClass = 'is-error';
        break;
      case 'done':
        stateText = '已完成';
        detail = `已达到 ${conv.maxTurns} 条发言上限`;
        dotClass = 'is-done';
        break;
      default:
        stateText = '就绪';
        detail = conv.turns.length > 0 ? `下一条由 ${displayName(conv, nextSpeaker(conv))} 发言` : '点击开始，A 会先回答启动词';
        break;
    }
  }

  els.runState.textContent = stateText;
  els.runDetail.textContent = detail;
  els.runDot.className = `run-dot ${dotClass}`.trim();

  els.btnPause.classList.toggle('hidden', !running);
  els.btnStop.classList.toggle('hidden', !running);
  els.btnStep.classList.toggle('hidden', running || limit);
  els.btnPrimary.classList.toggle('hidden', running);

  if (running) {
    els.btnPause.innerHTML = `${ICON('pause')}${run.pauseAfterTurn ? '继续' : '暂停'}`;
    els.btnPause.title = run.pauseAfterTurn ? '取消本次暂停，继续自动对话' : '在本条回答完成后暂停';
    els.btnStop.disabled = run.phase === 'stopping';
    return;
  }

  els.btnStop.disabled = false;
  let label = '开始自动对话';
  if (conv.status === 'paused' || conv.status === 'stopped') label = '继续对话';
  if (conv.status === 'error') label = '重试下一条';
  if (limit || conv.status === 'done') label = '已完成';

  const span = els.btnPrimary.querySelector('span');
  if (span) span.textContent = label;
  els.btnPrimary.disabled = limit || conv.status === 'done';
  els.btnStep.disabled = limit || conv.status === 'done';
  els.btnStep.title = '只生成下一条，然后暂停';
}

function renderInspector(conv = activeConv()) {
  if (!conv) {
    els.ctxMeta.textContent = '';
    els.ctxList.replaceChildren();
    els.ctxRaw.textContent = '';
    return;
  }
  const speaker = state.inspectorSpeaker;
  els.ctxTabA.classList.toggle('is-active', speaker === 'A');
  els.ctxTabB.classList.toggle('is-active', speaker === 'B');
  els.ctxTabA.setAttribute('aria-selected', String(speaker === 'A'));
  els.ctxTabB.setAttribute('aria-selected', String(speaker === 'B'));

  let messages = [];
  let error = '';
  try {
    messages = buildMessages(conv, speaker);
  } catch (err) {
    error = err.message;
  }

  const chars = messages.reduce((total, message) => total + message.content.length, 0);
  els.ctxMeta.textContent = `${displayName(conv, speaker)} · ${messages.length} 条 messages · ${formatTokenCount(chars)} 字符 · 无 system prompt`;
  els.ctxList.replaceChildren();

  if (messages.length === 0) {
    const empty = el('div', 'ctx-empty');
    empty.textContent = error || '还没有可用的上下文。A 需要先回答启动词，B 才拥有第一条输入。';
    els.ctxList.append(empty);
    els.ctxRaw.textContent = error ? JSON.stringify({ error }, null, 2) : '[]';
    return;
  }

  const fragment = document.createDocumentFragment();
  messages.forEach((message, index) => {
    const block = el('div', 'ctx-message');
    const role = el('div', `ctx-role ${message.role}`);
    role.append(el('span', '', message.role));
    let note;
    if (message.role === 'assistant') {
      note = `${displayName(conv, speaker)} 自己先前的输出（仅本侧可见）`;
    } else if (speaker === 'A' && index === 0) {
      note = '用户启动提示词';
    } else {
      note = `来自 ${displayName(conv, otherSpeaker(speaker))} 的发言`;
    }
    role.append(el('span', 'ctx-role-note', note));
    const content = el('div', 'ctx-content', message.content);
    block.append(role, content);
    fragment.append(block);
  });
  els.ctxList.append(fragment);
  els.ctxRaw.textContent = JSON.stringify(messages, null, 2);
}

/* --------------------------------------------------------------------------
   滚动
   -------------------------------------------------------------------------- */

function distanceFromBottom() {
  const scroller = els.transcriptScroll;
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
}

function updateScrollBottomButton() {
  const distance = distanceFromBottom();
  state.pinned = distance < 90;
  els.scrollBottomBtn.hidden = distance < 160;
}

function scrollToBottom(smooth = false, force = false) {
  if (!force && !state.pinned) return;
  els.transcriptScroll.scrollTo({ top: els.transcriptScroll.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  state.pinned = true;
  els.scrollBottomBtn.hidden = true;
}

/* --------------------------------------------------------------------------
   流式展示
   -------------------------------------------------------------------------- */

function showStreamingCard(conv, speaker, index) {
  if (!isActiveConversation(conv)) return;
  const article = el('article', 'message is-streaming');
  article.dataset.speaker = speaker;
  const name = escapeHtml(displayName(conv, speaker));

  article.innerHTML = `
    <div class="avatar" aria-hidden="true">${speaker}</div>
    <div class="message-card">
      <div class="message-head">
        <span class="message-name">${name}</span>
        <span class="message-index">#${String(index).padStart(2, '0')}</span>
        <span class="message-time">${formatClock(Date.now())}</span>
      </div>
      <details class="reasoning" hidden>
        <summary>
          <span class="reasoning-label">思维链</span>
          <span class="reasoning-meta">等待模型输出…</span>
        </summary>
        <div class="reasoning-body"></div>
      </details>
      <div class="message-body"><div class="stream-placeholder">正在等待首个 token…</div></div>
      <div class="message-foot"><span>生成中</span></div>
    </div>
  `;
  els.transcript.querySelector('.transcript-empty')?.remove();
  els.transcript.append(article);
  state.stream = {
    convId: conv.id,
    article,
    body: article.querySelector('.message-body'),
    reasoning: article.querySelector('.reasoning'),
    reasoningBody: article.querySelector('.reasoning-body'),
    reasoningMeta: article.querySelector('.reasoning-meta'),
    content: '',
    reasoningText: '',
    timer: null,
    lastPaint: 0
  };
  if (state.pinned) scrollToBottom(false, true);
}

function scheduleStreamingPaint() {
  const stream = state.stream;
  if (!stream || stream.timer) return;
  const delay = Math.max(0, 45 - (performance.now() - stream.lastPaint));
  stream.timer = setTimeout(() => {
    if (!state.stream || state.stream !== stream) return;
    stream.timer = null;
    stream.lastPaint = performance.now();
    if (!stream.content) {
      stream.body.innerHTML = '<div class="stream-placeholder">正在等待首个 token…</div>';
    } else {
      stream.body.innerHTML = renderMarkdown(stream.content);
    }
    if (stream.reasoningText) {
      stream.reasoning.hidden = false;
      stream.reasoningBody.textContent = stream.reasoningText;
      stream.reasoningMeta.textContent = stream.content
        ? `${formatCharCount(stream.reasoningText)} · 模型原始输出`
        : `${formatCharCount(stream.reasoningText)} · 生成中…`;
    }
    if (state.pinned) scrollToBottom(false, true);
  }, delay);
}

function updateStreamingContent(content, reasoning) {
  const stream = state.stream;
  if (!stream) return;
  stream.content = content;
  stream.reasoningText = reasoning;
  scheduleStreamingPaint();
}

function removeStreamingCard() {
  const stream = state.stream;
  if (!stream) return;
  if (stream.timer) clearTimeout(stream.timer);
  stream.article.remove();
  state.stream = null;
}

/* --------------------------------------------------------------------------
   余额
   -------------------------------------------------------------------------- */

async function queryBalanceRaw({ timeoutMs = 15000, signal = null } = {}) {
  const apiKey = getApiKey();
  if (!apiKey) return { ok: false, status: 0, error: 'no-key' };

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch('/api/balance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, baseUrl: state.settings.baseUrl }),
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: payload?.error?.message || `查询失败（HTTP ${response.status}）`
      };
    }
    if (!payload) return { ok: false, status: response.status, error: '余额服务返回了无法解析的响应' };
    const parsed = parseBalancePayload(payload);
    if (parsed.error) return { ok: false, status: response.status, error: parsed.error };
    return { ok: true, status: response.status, parsed };
  } catch (error) {
    if (error?.name === 'AbortError') return { ok: false, status: 0, error: '查询超时或已取消', aborted: true };
    return { ok: false, status: 0, error: '无法连接本地服务' };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function friendlyBalanceError(result) {
  if (result.status === 401) return 'API Key 无效或已过期（401），无法查询余额。';
  if (result.status === 403) return '该端点拒绝余额查询（403）。';
  if (result.status === 404) return '该 API 地址不提供 /user/balance。余额查询仅支持 DeepSeek 官方端点。';
  return result.error || '余额查询失败。';
}

async function refreshBalance({ silent = true, force = false } = {}) {
  if (!getApiKey()) {
    state.balance = { loading: false, infos: [], available: false, error: 'no-key', updatedAt: null };
    renderBalance();
    return;
  }
  if (state.balanceInFlight) return state.balanceInFlight;
  if (!force && Date.now() - state.balanceAttempt < 2500) return;

  state.balanceAttempt = Date.now();
  state.balance = { ...state.balance, loading: true, error: null };
  renderBalance();

  state.balanceInFlight = (async () => {
    const result = await queryBalanceRaw();
    if (result.ok) {
      const updatedAt = Date.now();
      state.balance = {
        loading: false,
        infos: result.parsed.infos,
        available: result.parsed.available,
        error: null,
        updatedAt
      };
      const conv = activeConv();
      if (conv) {
        conv.lastBalance = { infos: result.parsed.infos, available: result.parsed.available, at: updatedAt };
        saveConversations();
        renderStats(conv);
      }
    } else if (result.error === 'no-key') {
      state.balance = { loading: false, infos: [], available: false, error: 'no-key', updatedAt: null };
    } else {
      const message = friendlyBalanceError(result);
      state.balance = { ...state.balance, loading: false, error: message };
      if (!silent) toast(message, 'error', 5000);
    }
    state.balanceInFlight = null;
    renderBalance();
  })();
  return state.balanceInFlight;
}

function applyBaseline(conv, infos) {
  if (!conv || !Array.isArray(infos) || infos.length === 0) return false;
  conv.balanceBaseline = {};
  for (const info of infos) conv.balanceBaseline[info.currency] = info.total;
  conv.balanceBaselineAt = Date.now();
  return true;
}

async function ensureBalanceBaseline(conv, run) {
  if (conv.balanceBaseline) return true;
  if (state.balance.infos?.length && !state.balance.error && Date.now() - (state.balance.updatedAt || 0) < 90_000) {
    applyBaseline(conv, state.balance.infos);
    conv.lastBalance = { infos: state.balance.infos, available: state.balance.available, at: state.balance.updatedAt };
    saveConversations();
    return true;
  }
  if (!getApiKey()) return false;

  const controller = new AbortController();
  run.baselineController = controller;
  const result = await queryBalanceRaw({ timeoutMs: 6000, signal: controller.signal });
  run.baselineController = null;
  if (!result.ok || run.endReason) return false;

  if (applyBaseline(conv, result.parsed.infos)) {
    conv.lastBalance = { infos: result.parsed.infos, available: result.parsed.available, at: Date.now() };
    state.balance = {
      loading: false,
      infos: result.parsed.infos,
      available: result.parsed.available,
      error: null,
      updatedAt: Date.now()
    };
    saveConversations();
    renderBalance();
    return true;
  }
  return false;
}

function maybeRefreshBalance() {
  if (!getApiKey()) return;
  if (Date.now() - state.balanceAttempt < 2500) return;
  refreshBalance({ silent: true });
}

function renderBalance() {
  const balance = state.balance;
  const hasKey = Boolean(getApiKey());
  let dotClass = '';
  let value = '—';

  if (!hasKey) {
    value = '设置';
  } else if (balance.loading && balance.infos.length === 0) {
    dotClass = 'is-loading';
    value = '…';
  } else if (balance.infos.length > 0) {
    dotClass = balance.available ? 'is-ok' : 'is-warning';
    value = formatBalance(balance.infos[0].currency, balance.infos[0].total);
  } else if (balance.error) {
    dotClass = 'is-error';
    value = '—';
  }

  els.balanceDot.className = `balance-dot ${dotClass}`.trim();
  els.balanceValue.textContent = value;

  if (!hasKey) els.balanceUpdated.textContent = '尚未配置 API Key';
  else if (balance.loading && balance.infos.length === 0) els.balanceUpdated.textContent = '正在查询…';
  else if (balance.error) els.balanceUpdated.textContent = '查询失败';
  else if (balance.updatedAt) els.balanceUpdated.textContent = `更新于 ${formatClock(balance.updatedAt)}`;
  else els.balanceUpdated.textContent = '尚未查询';

  const body = els.balanceBody;
  body.replaceChildren();

  if (!hasKey) {
    const empty = el('div', 'balance-empty', '请先在设置中填写 DeepSeek API Key。余额查询只针对 DeepSeek 官方端点；自定义兼容端点会显示为不可用，但不影响对话。');
    const btn = el('button', 'ghost-btn', '打开设置');
    btn.type = 'button';
    btn.style.marginTop = '10px';
    btn.addEventListener('click', () => {
      closeBalancePopover();
      openSettings();
    });
    empty.append(btn);
    body.append(empty);
    return;
  }

  if (balance.loading && balance.infos.length === 0) {
    body.append(el('div', 'balance-empty', '正在向 DeepSeek 查询账户余额…'));
    return;
  }

  if (balance.error && balance.infos.length === 0) {
    body.append(el('div', 'balance-empty', balance.error));
    return;
  }

  if (balance.infos.length === 0) {
    body.append(el('div', 'balance-empty', 'DeepSeek 没有返回余额信息。'));
    return;
  }

  for (const info of balance.infos) {
    const line = el('div', 'balance-line');
    line.append(
      el('span', 'balance-currency', info.currency === 'CNY' ? '人民币 CNY' : info.currency === 'USD' ? '美元 USD' : info.currency),
      el('span', 'balance-amount', formatBalance(info.currency, info.total))
    );
    body.append(line);
    const detail = el('div', 'balance-detail');
    detail.append(el('span', '', `赠金 ${formatBalance(info.currency, info.granted)}`));
    detail.append(el('span', '', `充值 ${formatBalance(info.currency, info.toppedUp)}`));
    body.append(detail);
  }

  if (!balance.available) {
    body.append(el('div', 'balance-warning', '账户当前不可用（is_available = false），请确认账户状态。'));
  }

  const conv = activeConv();
  if (conv && conv.balanceBaseline) {
    const rows = computeBalanceSpend(conv.balanceBaseline, balance.infos);
    if (rows && rows.length > 0) {
      const spend = el('div', 'balance-spend');
      spend.append(el('span', '', '本实验消耗（按余额差估算）'));
      const values = el('span');
      values.textContent = rows
        .map((row) => (row.spent >= 0 ? formatBalance(row.currency, row.spent) : `+${formatBalance(row.currency, Math.abs(row.spent))}`))
        .join(' / ');
      spend.append(values);
      body.append(spend);
    }
  } else if (conv) {
    body.append(el('div', 'popover-foot', '开始运行后将自动记录余额基准，用于估算本实验消耗。'));
  }
}

/* --------------------------------------------------------------------------
   运行循环
   -------------------------------------------------------------------------- */

function setPhase(run, phase) {
  run.phase = phase;
  if (state.running === run && isActiveConversation(activeConv())) renderControls();
}

function markStatus(conv, status, error) {
  conv.status = status;
  if (error !== undefined) conv.lastError = error;
  conv.updatedAt = Date.now();
  saveConversations();
  if (isActiveConversation(conv)) {
    renderControls(conv);
    renderError(conv);
    renderHistory();
    renderTopbar();
  }
}

function isRunAlive(run) {
  return Boolean(run) && state.running === run && !run.endReason;
}

function cancelRunWait(run) {
  if (run.timer) {
    clearTimeout(run.timer);
    run.timer = null;
  }
  if (run.wake) {
    const wake = run.wake;
    run.wake = null;
    wake();
  }
}

function waitDelay(ms, run) {
  return new Promise((resolve) => {
    const done = () => {
      if (run.timer) {
        clearTimeout(run.timer);
        run.timer = null;
      }
      run.wake = null;
      resolve();
    };
    run.wake = done;
    run.timer = setTimeout(done, ms);
  });
}

async function apiErrorFromResponse(response) {
  let text = '';
  try {
    text = await response.text();
  } catch {
    /* ignore */
  }
  let message = '';
  try {
    const parsed = JSON.parse(text);
    message = parsed?.error?.message || parsed?.message || '';
  } catch {
    message = text;
  }
  return new ApiError(message || `上游返回 HTTP ${response.status}`, response.status);
}

async function generateTurn(conv, speaker, run) {
  const messages = buildMessages(conv, speaker);
  const controller = new AbortController();
  run.controller = controller;
  run.speaker = speaker;

  if (isActiveConversation(conv)) {
    renderMessages(conv);
    showStreamingCard(conv, speaker, conv.turns.length + 1);
    renderInspector(conv);
  }

  let content = '';
  let reasoning = '';
  let usage = null;
  let usedModel = conv.model;
  let finishReason = null;
  let streamDone = false;

  const consumeEvent = (event) => {
    if (!event || event.done || !event.data) return;
    const piece = extractStreamPiece(event.data);
    if (piece.error) throw new ApiError(piece.error, 502);
    if (piece.model) usedModel = piece.model;
    if (piece.usage) usage = piece.usage;
    if (piece.finishReason) finishReason = piece.finishReason;
    if (piece.reasoning) reasoning += piece.reasoning;
    if (piece.content) content += piece.content;
    if (piece.content || piece.reasoning) updateStreamingContent(content, reasoning);
  };

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: getApiKey(),
        baseUrl: state.settings.baseUrl,
        model: conv.model,
        messages,
        stream: true,
        temperature: conv.params.temperature,
        maxTokens: conv.params.maxTokens,
        topP: conv.params.topP,
        ...buildThinkingRequest(conv.thinkingMode)
      }),
      signal: controller.signal
    });

    if (!response.ok) throw await apiErrorFromResponse(response);

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ApiError('上游返回了无法解析的 JSON', 502);
      }
      if (payload?.error) throw new ApiError(payload.error.message || '上游返回错误', 502);
      const full = extractFullResponse(payload);
      content = full.content || '';
      reasoning = full.reasoning || '';
      usage = full.usage || null;
      usedModel = full.model || usedModel;
      finishReason = full.finishReason || null;
      updateStreamingContent(content, reasoning);
    } else {
      if (!response.body) throw new ApiError('上游响应没有可读取的内容', 502);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();

      while (!streamDone) {
        const { value, done } = await reader.read();
        if (done) {
          const tail = decoder.decode();
          if (tail) {
            for (const event of parser.push(tail)) {
              if (event.done) {
                streamDone = true;
                break;
              }
              consumeEvent(event);
            }
          }
          if (!streamDone) {
            const trailing = parser.flush();
            for (const event of trailing) consumeEvent(event);
          }
          break;
        }
        const chunk = decoder.decode(value, { stream: true });
        const events = parser.push(chunk);
        for (const event of events) {
          if (event.done) {
            streamDone = true;
            break;
          }
          consumeEvent(event);
        }
      }
      if (!streamDone) reader.cancel().catch(() => {});
    }
  } catch (error) {
    removeStreamingCard();
    if (run.endReason || error?.name === 'AbortError') throw new RunCanceledError();
    throw error;
  } finally {
    run.controller = null;
  }

  if (run.endReason) {
    removeStreamingCard();
    throw new RunCanceledError();
  }

  const finalContent = content.trim();
  if (!finalContent) {
    removeStreamingCard();
    throw new ApiError('模型没有返回正文内容（可能全部消耗在思考，或达到了 max_tokens）。可以调高 max tokens 后重试。', 502);
  }

  const turn = {
    id: randomId('turn'),
    speaker,
    content: finalContent,
    reasoning: reasoning.trim() || undefined,
    createdAt: Date.now(),
    model: usedModel,
    finishReason: finishReason || undefined,
    usage: usage || undefined
  };
  conv.turns.push(turn);
  accumulateUsage(conv.usage, usage || {});
  conv.updatedAt = Date.now();
  saveConversations();
  removeStreamingCard();

  if (isActiveConversation(conv)) {
    renderMessages(conv);
    renderStats(conv);
    renderHistory();
    renderInspector(conv);
    renderControls(conv);
    if (state.pinned) requestAnimationFrame(() => scrollToBottom(false, true));
  }
  maybeRefreshBalance();
  return turn;
}

async function runLoop(run, conv) {
  while (isRunAlive(run)) {
    if (isLimitReached(conv)) {
      markStatus(conv, 'done');
      break;
    }

    const speaker = nextSpeaker(conv);
    run.speaker = speaker;
    setPhase(run, 'generating');

    try {
      await generateTurn(conv, speaker, run);
    } catch (error) {
      removeStreamingCard();
      if (run.endReason || error instanceof RunCanceledError) {
        markStatus(conv, run.endReason === 'stop' ? 'stopped' : 'paused');
      } else {
        const message = friendlyError(error, error?.status);
        markStatus(conv, 'error', message);
      }
      if (isActiveConversation(conv)) {
        renderMessages(conv);
        renderInspector(conv);
        renderStats(conv);
      }
      break;
    }

    run.speaker = null;
    if (isLimitReached(conv)) {
      markStatus(conv, 'done');
      break;
    }
    if (run.endReason === 'stop') {
      markStatus(conv, 'stopped');
      break;
    }
    if (run.pauseAfterTurn || run.stepOnce) {
      markStatus(conv, 'paused');
      break;
    }

    if (conv.delayMs > 0) {
      setPhase(run, 'waiting');
      await waitDelay(conv.delayMs, run);
      if (!isRunAlive(run)) break;
      if (run.pauseAfterTurn) {
        markStatus(conv, 'paused');
        break;
      }
    }
  }

  if (conv.status === 'running' || conv.status === 'pausing' || conv.status === 'idle') {
    if (isLimitReached(conv)) markStatus(conv, 'done');
    else if (run.endReason === 'stop') markStatus(conv, 'stopped');
    else markStatus(conv, 'paused');
  }
}

async function beginRun({ stepOnce = false } = {}) {
  if (state.running) return;
  const conv = activeConv();
  if (!conv) return;
  if (isLimitReached(conv)) {
    markStatus(conv, 'done');
    renderAll();
    return;
  }
  if (!getApiKey()) {
    toast('请先在设置中填写 API Key。', 'error');
    openSettings();
    return;
  }
  if (!conv.model.trim()) {
    toast('请先为这场实验填写模型名称。', 'error');
    return;
  }

  const run = {
    id: ++state.runSequence,
    convId: conv.id,
    controller: null,
    baselineController: null,
    endReason: null,
    phase: 'starting',
    speaker: null,
    pauseAfterTurn: false,
    stepOnce: Boolean(stepOnce),
    timer: null,
    wake: null
  };
  state.running = run;
  conv.status = 'running';
  conv.lastError = null;
  conv.updatedAt = Date.now();
  saveConversations();
  renderTopbar();
  renderHistory();
  renderControls(conv);
  renderError(conv);

  try {
    setPhase(run, 'baseline');
    await ensureBalanceBaseline(conv, run);
    if (!isRunAlive(run)) {
      markStatus(conv, run.endReason === 'stop' ? 'stopped' : 'paused');
      return;
    }
    if (run.pauseAfterTurn) {
      markStatus(conv, 'paused');
      return;
    }
    await runLoop(run, conv);
  } catch (error) {
    if (run.endReason) {
      markStatus(conv, run.endReason === 'stop' ? 'stopped' : 'paused');
    } else {
      markStatus(conv, 'error', friendlyError(error, error?.status));
    }
  } finally {
    if (state.running === run) state.running = null;
    if (run.timer) {
      clearTimeout(run.timer);
      run.timer = null;
    }
    if (['running', 'pausing', 'idle'].includes(conv.status)) {
      if (isLimitReached(conv)) markStatus(conv, 'done');
      else if (run.endReason === 'stop') markStatus(conv, 'stopped');
      else markStatus(conv, 'paused');
    }
    conv.updatedAt = Date.now();
    saveConversations();
    if (isActiveConversation(conv)) {
      renderAll();
      if (state.pinned) requestAnimationFrame(() => scrollToBottom(false, true));
      if (getApiKey() && conv.balanceBaseline) {
        refreshBalance({ silent: true, force: true });
      }
    }
  }
}

function interruptActiveRun(reason = 'pause') {
  const run = state.running;
  if (!run) return;
  run.endReason = reason;
  run.pauseAfterTurn = false;
  run.phase = 'stopping';
  removeStreamingCard();
  try {
    run.controller?.abort();
  } catch {
    /* ignore */
  }
  try {
    run.baselineController?.abort();
  } catch {
    /* ignore */
  }
  cancelRunWait(run);
  if (isActiveConversation(activeConv())) {
    renderMessages(activeConv());
    renderControls(activeConv());
  }
}

function stopRun() {
  const run = state.running;
  if (!run) return;
  run.endReason = 'stop';
  run.pauseAfterTurn = false;
  run.phase = 'stopping';
  removeStreamingCard();
  try {
    run.controller?.abort();
  } catch {
    /* ignore */
  }
  try {
    run.baselineController?.abort();
  } catch {
    /* ignore */
  }
  cancelRunWait(run);
  const conv = activeConv();
  if (conv) {
    renderMessages(conv);
    renderControls(conv);
  }
}

function togglePause() {
  const run = state.running;
  if (!run || run.endReason || run.phase === 'stopping') return;
  if (run.pauseAfterTurn) {
    run.pauseAfterTurn = false;
    run.stepOnce = false;
    renderControls();
    return;
  }
  run.pauseAfterTurn = true;
  run.phase = 'pausing';
  cancelRunWait(run);
  renderControls();
}

/* --------------------------------------------------------------------------
   选择 / 新建 / 删除
   -------------------------------------------------------------------------- */

function showNewView({ focus = false } = {}) {
  if (state.running) interruptActiveRun('pause');
  state.activeId = null;
  updateHash();
  closeMenus();
  closeBalancePopover();
  closeExportMenu();
  applyView();
  renderAll();
  if (focus) setTimeout(() => els.startPrompt?.focus(), 40);
}

function selectConversation(id) {
  const conv = state.conversations.find((item) => item.id === id);
  if (!conv) return;
  if (state.activeId === id) {
    closeMenus();
    return;
  }
  if (state.running) interruptActiveRun('pause');
  state.activeId = id;
  state.pinned = true;
  updateHash();
  closeMenus();
  applyView();
  renderAll();
  requestAnimationFrame(() => scrollToBottom(false, true));
}

async function deleteConversation(id) {
  const conv = state.conversations.find((item) => item.id === id);
  if (!conv) return;
  const ok = await askConfirm({
    title: '删除这个实验？',
    message: `「${conv.title}」的 ${conv.turns.length} 条发言将从本机浏览器删除，无法恢复。建议先导出。`,
    okText: '删除'
  });
  if (!ok) return;

  if (state.running?.convId === id) stopRun();
  state.conversations = state.conversations.filter((item) => item.id !== id);
  if (state.activeId === id) {
    state.activeId = null;
    updateHash();
  }
  saveConversations();
  renderAll();
  toast('实验已删除。', 'success');
}

async function askConfirm({ title, message, okText = '确认' }) {
  if (confirmResolver) {
    const previous = confirmResolver;
    confirmResolver = null;
    previous(false);
  }
  els.confirmTitle.textContent = title;
  els.confirmMessage.textContent = message;
  els.confirmOkBtn.textContent = okText;
  return new Promise((resolve) => {
    confirmResolver = resolve;
    if (typeof els.confirmDialog.showModal === 'function') {
      if (!els.confirmDialog.open) els.confirmDialog.showModal();
    } else {
      els.confirmDialog.setAttribute('open', '');
    }
  });
}

function settleConfirm(value) {
  const resolve = confirmResolver;
  confirmResolver = null;
  if (els.confirmDialog.open) els.confirmDialog.close();
  else els.confirmDialog.removeAttribute('open');
  if (resolve) resolve(value);
}

/* --------------------------------------------------------------------------
   设置
   -------------------------------------------------------------------------- */

function populateSettingsForm() {
  els.settingBaseUrl.value = state.settings.baseUrl;
  els.settingApiKey.value = state.apiKey;
  els.settingRemember.checked = state.settings.rememberKey;
  els.settingModel.value = state.settings.model;
  els.settingThinkingMode.value = normalizeThinkingMode(state.settings.thinkingMode);
  els.settingTemperature.value = String(state.settings.temperature);
  els.settingMaxTokens.value = String(state.settings.maxTokens);
  els.settingTopP.value = String(state.settings.topP);
  els.settingApiKey.type = 'password';
  els.toggleKeyBtn.setAttribute('aria-label', '显示 Key');
  els.testResult.className = 'test-result';
  els.testResult.textContent = '会发送一条最小的测试消息，不写入任何实验。';
  updateSettingsHint();
}

function updateSettingsHint() {
  const raw = els.settingBaseUrl.value.trim() || state.settings.baseUrl;
  let official = false;
  try {
    official = /(^|\.)deepseek\.com$/i.test(new URL(raw).hostname);
  } catch {
    official = false;
  }
  els.settingsHint.textContent = official
    ? '使用 DeepSeek 的 OpenAI 兼容 Chat Completions 接口；余额查询也会调用 DeepSeek /user/balance。所有请求通过本机服务转发。'
    : '检测到自定义兼容端点。对话会使用该地址的 /chat/completions；余额查询通常不可用，界面会优雅降级。Key 只保存在本机浏览器。';
  els.settingsHint.classList.toggle('is-accent', !official);
}

function openSettings() {
  closeMenus();
  closeBalancePopover();
  closeExportMenu();
  populateSettingsForm();
  if (typeof els.settingsDialog.showModal === 'function') {
    if (!els.settingsDialog.open) els.settingsDialog.showModal();
  } else {
    els.settingsDialog.setAttribute('open', '');
  }
}

function closeSettings() {
  if (els.settingsDialog.open) els.settingsDialog.close();
  else els.settingsDialog.removeAttribute('open');
}

function persistApiKey(key) {
  if (state.settings.rememberKey) {
    if (key) safeStorageSet(localStorage, STORAGE_KEY_LOCAL, key);
    else safeStorageRemove(localStorage, STORAGE_KEY_LOCAL);
    safeStorageRemove(sessionStorage, STORAGE_KEY_SESSION);
  } else {
    if (key) safeStorageSet(sessionStorage, STORAGE_KEY_SESSION, key);
    else safeStorageRemove(sessionStorage, STORAGE_KEY_SESSION);
    safeStorageRemove(localStorage, STORAGE_KEY_LOCAL);
  }
  state.apiKey = key;
}

function saveSettingsFromForm() {
  const baseUrl = els.settingBaseUrl.value.trim() || DEFAULT_SETTINGS.baseUrl;
  const baseUrlChanged = baseUrl !== state.settings.baseUrl;
  state.settings = normalizeSettings({
    baseUrl,
    model: els.settingModel.value.trim() || DEFAULT_SETTINGS.model,
    thinkingMode: els.settingThinkingMode.value,
    temperature: els.settingTemperature.value,
    maxTokens: els.settingMaxTokens.value,
    topP: els.settingTopP.value,
    rememberKey: els.settingRemember.checked
  });
  state.settings.baseUrl = baseUrl;
  saveSettings();
  persistApiKey(els.settingApiKey.value.trim());
  if (baseUrlChanged) {
    state.balance = { loading: false, infos: [], available: false, error: null, updatedAt: null };
    state.balanceAttempt = 0;
    for (const conv of state.conversations) {
      conv.balanceBaseline = null;
      conv.balanceBaselineAt = null;
      conv.lastBalance = null;
    }
    saveConversations();
  }
  syncNewFormDefaults();
  renderKeyStatus();
  renderBalance();
  closeSettings();
  toast(getApiKey() ? '设置已保存。' : '设置已保存，API Key 为空。', 'success');
  if (getApiKey()) setTimeout(() => refreshBalance({ silent: true, force: true }), 150);
}

function syncNewFormDefaults() {
  els.modelInput.value = state.settings.model;
  els.thinkingMode.value = normalizeThinkingMode(state.settings.thinkingMode);
  els.temperature.value = String(state.settings.temperature);
  els.maxTokens.value = String(state.settings.maxTokens);
  els.topP.value = String(state.settings.topP);
}

async function testConnection() {
  const apiKey = els.settingApiKey.value.trim();
  const baseUrl = els.settingBaseUrl.value.trim() || DEFAULT_SETTINGS.baseUrl;
  const model = els.settingModel.value.trim() || DEFAULT_SETTINGS.model;
  if (!apiKey) {
    els.testResult.className = 'test-result is-error';
    els.testResult.textContent = '请先填写 API Key。';
    return;
  }

  els.testConnectionBtn.disabled = true;
  els.testResult.className = 'test-result is-loading';
  els.testResult.textContent = '正在发送测试消息…';
  const startedAt = Date.now();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey,
        baseUrl,
        model,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
        temperature: 0,
        maxTokens: 32,
        ...buildThinkingRequest(els.settingThinkingMode.value)
      })
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new ApiError(payload?.error?.message || `HTTP ${response.status}`, response.status);
    }
    if (!payload) throw new ApiError('上游返回了无法解析的响应', 502);
    if (payload.error) throw new ApiError(payload.error.message || '上游返回错误', 502);
    const full = extractFullResponse(payload);
    const reply = (full.content || '').trim().replace(/\s+/g, ' ');
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    els.testResult.className = 'test-result is-ok';
    els.testResult.textContent = `连接成功 · ${elapsed}s${reply ? ` · 回复：${reply.slice(0, 60)}` : ' · 模型未返回文本'}`;
  } catch (error) {
    els.testResult.className = 'test-result is-error';
    els.testResult.textContent = friendlyError(error, error?.status);
  } finally {
    els.testConnectionBtn.disabled = false;
  }
}

async function clearAllData() {
  const ok = await askConfirm({
    title: '清空全部本机数据？',
    message: '所有实验记录、设置与浏览器中保存的 API Key 都会被删除。此操作无法撤销，但不会影响 DeepSeek 账户。',
    okText: '全部清空'
  });
  if (!ok) return;

  if (state.running) {
    const run = state.running;
    run.endReason = 'stop';
    try {
      run.controller?.abort();
    } catch {
      /* ignore */
    }
    try {
      run.baselineController?.abort();
    } catch {
      /* ignore */
    }
    cancelRunWait(run);
    removeStreamingCard();
    state.running = null;
  }
  safeStorageRemove(localStorage, STORAGE_CONVERSATIONS);
  safeStorageRemove(localStorage, STORAGE_SETTINGS);
  safeStorageRemove(localStorage, STORAGE_KEY_LOCAL);
  safeStorageRemove(sessionStorage, STORAGE_KEY_SESSION);
  state.conversations = [];
  state.activeId = null;
  state.settings = normalizeSettings(DEFAULT_SETTINGS);
  state.apiKey = '';
  state.balance = { loading: false, infos: [], available: false, error: null, updatedAt: null };
  state.balanceAttempt = 0;
  updateHash();
  closeSettings();
  syncNewFormDefaults();
  renderAll();
  toast('本机数据已清空。', 'success');
}

/* --------------------------------------------------------------------------
   新建 / 导入 / 导出
   -------------------------------------------------------------------------- */

function handleNewSubmit(event) {
  event.preventDefault();
  const startPrompt = els.startPrompt.value.trim();
  if (!startPrompt) {
    toast('请先输入一条启动提示词。', 'error');
    els.startPrompt.focus();
    return;
  }
  if (!getApiKey()) {
    toast('请先在设置中填写 API Key，再开始实验。', 'error');
    openSettings();
    return;
  }

  const maxTurns = Math.min(
    MAX_TURNS_LIMIT,
    Math.max(MIN_TURNS_LIMIT, Number.parseInt(els.maxTurns.value, 10) || 100)
  );
  const model = els.modelInput.value.trim() || state.settings.model;
  if (!model) {
    toast('请填写模型名称。', 'error');
    els.modelInput.focus();
    return;
  }

  const conv = createConversation({
    startPrompt,
    participants: {
      A: { name: els.nameA.value.trim() || 'AI-A' },
      B: { name: els.nameB.value.trim() || 'AI-B' }
    },
    model,
    thinkingMode: els.thinkingMode.value,
    params: {
      temperature: els.temperature.value,
      maxTokens: els.maxTokens.value,
      topP: els.topP.value
    },
    maxTurns,
    delayMs: els.delayMs.value
  });

  state.conversations.unshift(conv);
  state.activeId = conv.id;
  state.pinned = true;
  saveConversations();
  updateHash();
  els.startPrompt.value = '';
  updatePromptCount();
  applyView();
  renderAll();
  requestAnimationFrame(() => scrollToBottom(false, true));
  beginRun();
}

function updatePromptCount() {
  els.promptCount.textContent = `${els.startPrompt.value.length} / 12000`;
}

async function importConversations(file) {
  let text;
  try {
    text = await file.text();
  } catch {
    toast('无法读取这个文件。', 'error');
    return;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    toast('导入失败：文件不是合法 JSON。', 'error');
    return;
  }

  const candidates = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.conversations)
      ? raw.conversations
      : [raw?.conversation || raw];

  const imported = [];
  for (const candidate of candidates) {
    const conv = normalizeConversation(candidate);
    if (!conv) continue;
    conv.id = randomId('conv');
    conv.status = conv.status === 'done' ? 'done' : 'paused';
    conv.lastError = null;
    conv.updatedAt = Date.now();
    imported.push(conv);
  }

  if (imported.length === 0) {
    toast('这个文件里没有可导入的实验。', 'error');
    return;
  }

  state.conversations = [...imported, ...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  saveConversations();
  selectConversation(imported[0].id);
  toast(`已导入 ${imported.length} 个实验。`, 'success');
}

function exportCurrent(kind) {
  const conv = activeConv();
  if (!conv) return;
  let content;
  let extension;
  let mime;
  if (kind === 'json') {
    const base = JSON.parse(toExportJson(conv));
    const contexts = {};
    for (const speaker of ['A', 'B']) {
      try {
        contexts[speaker] = buildMessages(conv, speaker);
      } catch {
        contexts[speaker] = null;
      }
    }
    const payload = {
      ...base,
      contexts,
      contextSummary: contextSummary(conv)
    };
    content = JSON.stringify(payload, null, 2);
    extension = 'json';
    mime = 'application/json;charset=utf-8';
  } else {
    content = toExportMarkdown(conv);
    extension = 'md';
    mime = 'text/markdown;charset=utf-8';
  }

  const safeTitle = conv.title.replace(/[\\/:*?"<>|]/g, ' ').slice(0, 40).trim() || 'experiment';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  downloadFile(`回响-${safeTitle}-${stamp}.${extension}`, content, mime);
  closeExportMenu();
  toast('已导出当前实验。', 'success');
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板。', 'success', 1800);
    return;
  } catch {
    /* fall through */
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    document.execCommand('copy');
    toast('已复制到剪贴板。', 'success', 1800);
  } catch {
    toast('复制失败，请手动选择文本。', 'error');
  }
  area.remove();
}

/* --------------------------------------------------------------------------
   事件绑定
   -------------------------------------------------------------------------- */

function bindEvents() {
  els.newBtn.addEventListener('click', () => showNewView({ focus: true }));
  els.menuBtn.addEventListener('click', () => {
    if (els.app.classList.contains('menu-open')) closeMenus();
    else openMenu();
  });
  els.sidebarBackdrop.addEventListener('click', closeMenus);

  els.historyList.addEventListener('click', (event) => {
    const del = event.target.closest('.history-delete');
    if (del) {
      event.stopPropagation();
      deleteConversation(del.dataset.deleteId);
      return;
    }
    const item = event.target.closest('.history-item');
    if (item) selectConversation(item.dataset.id);
  });
  els.historyList.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.closest('.history-delete')) return;
    const item = event.target.closest('.history-item');
    if (item) {
      event.preventDefault();
      selectConversation(item.dataset.id);
    }
  });

  els.importBtn.addEventListener('click', () => els.importInput.click());
  els.importInput.addEventListener('change', () => {
    const file = els.importInput.files?.[0];
    if (file) importConversations(file);
    els.importInput.value = '';
    closeMenus();
  });
  els.settingsBtn.addEventListener('click', openSettings);

  els.balanceBtn.addEventListener('click', () => {
    const willOpen = els.balancePopover.hidden;
    closeExportMenu();
    els.balancePopover.hidden = !willOpen;
    els.balanceBtn.setAttribute('aria-expanded', String(willOpen));
    if (willOpen && Date.now() - state.balanceAttempt > 10_000) refreshBalance({ silent: true, force: true });
  });
  els.balanceRefreshBtn.addEventListener('click', () => refreshBalance({ silent: false, force: true }));

  els.exportBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!activeConv()) return;
    const willOpen = els.exportMenu.hidden;
    closeBalancePopover();
    els.exportMenu.hidden = !willOpen;
    els.exportBtn.setAttribute('aria-expanded', String(willOpen));
  });
  els.exportMenu.addEventListener('click', (event) => {
    const button = event.target.closest('[data-export]');
    if (button) exportCurrent(button.dataset.export);
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('#balancePopover') && !event.target.closest('#balanceBtn')) closeBalancePopover();
    if (!event.target.closest('#exportMenu') && !event.target.closest('#exportBtn')) closeExportMenu();
  });

  els.inspectorBtn.addEventListener('click', () => toggleInspector());
  els.inspectorCloseBtn.addEventListener('click', () => toggleInspector(false));
  els.ctxTabA.addEventListener('click', () => {
    state.inspectorSpeaker = 'A';
    renderInspector();
  });
  els.ctxTabB.addEventListener('click', () => {
    state.inspectorSpeaker = 'B';
    renderInspector();
  });

  els.newForm.addEventListener('submit', handleNewSubmit);
  els.startPrompt.addEventListener('input', updatePromptCount);
  els.startPrompt.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      els.newForm.requestSubmit();
    }
  });
  els.keyStatus.addEventListener('click', openSettings);
  els.keyStatus.setAttribute('role', 'button');
  els.keyStatus.tabIndex = 0;
  els.keyStatus.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openSettings();
    }
  });

  els.btnPrimary.addEventListener('click', () => beginRun());
  els.btnStep.addEventListener('click', () => beginRun({ stepOnce: true }));
  els.btnPause.addEventListener('click', togglePause);
  els.btnStop.addEventListener('click', stopRun);
  els.errorRetryBtn.addEventListener('click', () => beginRun());

  els.transcript.addEventListener('click', (event) => {
    const copy = event.target.closest('[data-copy-turn]');
    if (!copy) return;
    const conv = activeConv();
    if (!conv) return;
    const turn = conv.turns.find((item) => item.id === copy.dataset.copyTurn);
    if (turn) copyText(turn.content);
  });

  els.transcriptScroll.addEventListener('scroll', updateScrollBottomButton);
  els.scrollBottomBtn.addEventListener('click', () => {
    state.pinned = true;
    scrollToBottom(true, true);
  });

  els.settingsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveSettingsFromForm();
  });
  els.settingsCloseBtn.addEventListener('click', closeSettings);
  els.settingsCancelBtn.addEventListener('click', closeSettings);
  els.settingBaseUrl.addEventListener('input', updateSettingsHint);
  els.toggleKeyBtn.addEventListener('click', () => {
    const visible = els.settingApiKey.type === 'text';
    els.settingApiKey.type = visible ? 'password' : 'text';
    els.toggleKeyBtn.setAttribute('aria-label', visible ? '显示 Key' : '隐藏 Key');
  });
  els.testConnectionBtn.addEventListener('click', testConnection);
  els.clearDataBtn.addEventListener('click', clearAllData);

  els.confirmCancelBtn.addEventListener('click', () => settleConfirm(false));
  els.confirmOkBtn.addEventListener('click', () => settleConfirm(true));
  els.confirmDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    settleConfirm(false);
  });
  els.confirmDialog.addEventListener('close', () => {
    if (confirmResolver) {
      const resolve = confirmResolver;
      confirmResolver = null;
      resolve(false);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeBalancePopover();
      closeExportMenu();
      closeMenus();
      return;
    }
    const target = event.target;
    const typing =
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable);
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.toLowerCase() === 'n') {
      event.preventDefault();
      showNewView({ focus: true });
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && getApiKey() && Date.now() - state.balanceAttempt > 30_000) {
      refreshBalance({ silent: true });
    }
  });
}

/* --------------------------------------------------------------------------
   启动
   -------------------------------------------------------------------------- */

function init() {
  state.settings = loadSettings();
  state.apiKey = loadApiKey();
  state.conversations = loadConversations();
  state.inspectorOpen = window.matchMedia('(min-width: 1181px)').matches;

  let hashId = '';
  try {
    hashId = decodeURIComponent(location.hash.replace(/^#/, ''));
  } catch {
    hashId = '';
  }
  if (hashId && state.conversations.some((conv) => conv.id === hashId)) {
    state.activeId = hashId;
  } else {
    state.activeId = null;
    if (hashId) updateHash();
  }

  bindEvents();
  updatePromptCount();
  syncNewFormDefaults();
  renderAll();
  if (state.activeId) requestAnimationFrame(() => scrollToBottom(false, true));

  setTimeout(() => {
    if (getApiKey()) refreshBalance({ silent: true });
  }, 500);

  setInterval(() => {
    if (document.visibilityState === 'visible' && getApiKey() && Date.now() - state.balanceAttempt > 30_000) {
      refreshBalance({ silent: true });
    }
  }, 30_000);
}

init();
