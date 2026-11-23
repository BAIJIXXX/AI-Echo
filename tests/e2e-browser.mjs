import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:8799';
const MOCK_URL = process.env.MOCK_URL || 'http://127.0.0.1:9901';
const DEBUG_URL = process.env.DEBUG_URL || 'http://127.0.0.1:9222';
const ARTIFACT_DIR = path.resolve('artifacts');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await fetch(`${MOCK_URL}/__reset`, { method: 'POST' });

  const targets = await (await fetch(`${DEBUG_URL}/json/list`)).json();
  const target = targets.find((item) => item.type === 'page' && item.url.startsWith(APP_URL));
  if (!target) throw new Error('没有找到应用页面，请确认 headless Edge 已打开应用地址');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const problems = [];
  const consoleErrors = [];

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${message.error.message} (${waiter.method})`));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params.exceptionDetails?.text || 'unknown exception');
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(message.params.entry.text);
    }
  });

  function cdp(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const response = await cdp('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ||
          response.exceptionDetails.text ||
          '页面脚本执行失败'
      );
    }
    return response.result.value;
  }

  async function waitFor(expression, description, timeout = 20000) {
    const started = Date.now();
    let lastError = null;
    while (Date.now() - started < timeout) {
      try {
        const value = await evaluate(expression);
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await sleep(120);
    }
    throw new Error(`等待超时：${description}${lastError ? `（最后错误：${lastError.message}）` : ''}`);
  }

  async function screenshot(name) {
    const { data } = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const file = path.join(ARTIFACT_DIR, name);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`screenshot: ${file}`);
  }

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Log.enable');

  // 预置设置和 Key，然后重新加载，走真实初始化路径。
  await evaluate(`
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('echolab.settings.v1', JSON.stringify({
      baseUrl: ${JSON.stringify(MOCK_URL)},
      model: 'deepseek-chat',
      temperature: 0.7,
      maxTokens: 256,
      topP: 1,
      rememberKey: true
    }));
    localStorage.setItem('echolab.apiKey.local', 'mock-api-key');
    true;
  `);
  await cdp('Page.reload', { ignoreCache: true });
  await sleep(900);
  await waitFor(`document.readyState === 'complete' && !!document.getElementById('newForm')`, '页面初始化');

  const initial = await evaluate(`({
    title: document.title,
    keyStatus: document.getElementById('keyStatusText').textContent,
    balance: document.getElementById('balanceValue').textContent,
    errors: document.querySelectorAll('#transcript .message').length
  })`);
  console.log('initial:', initial);
  if (!initial.keyStatus.includes('已配置')) throw new Error('API Key 未正确加载');

  await screenshot('e2e-desktop-new.png');
  await waitFor(`document.getElementById('balanceValue').textContent !== '…'`, '启动时余额查询完成');

  const configured = await evaluate(`(() => {
    const query = (id) => document.getElementById(id);
    query('startPrompt').value = '请从“回声是否意味着孤独”开始，给出你的第一个观点。';
    query('maxTurns').value = '8';
    query('delayMs').value = '800';
    query('nameA').value = '观测者 A';
    query('nameB').value = '观测者 B';
    query('modelInput').value = 'deepseek-chat';
    document.getElementById('newForm').requestSubmit();
    return true;
  })()`);
  if (!configured) throw new Error('表单提交失败');

  await waitFor(`document.querySelectorAll('#transcript .message:not(.is-streaming)').length >= 3`, '至少 3 条自动对话', 25000);
  await screenshot('e2e-desktop-running.png');

  const mid = await evaluate(`({
    status: document.getElementById('runState').textContent,
    detail: document.getElementById('runDetail').textContent,
    messages: [...document.querySelectorAll('#transcript .message:not(.is-streaming)')].map((node) => ({
      speaker: node.dataset.speaker,
      body: node.querySelector('.message-body')?.textContent.trim()
    })),
    turns: document.getElementById('statTurns').textContent,
    tokens: document.getElementById('statTokens').textContent,
    spend: document.getElementById('statSpend').textContent,
    balance: document.getElementById('balanceValue').textContent,
    prompt: document.getElementById('promptText').textContent,
    pills: document.getElementById('experimentPills').textContent
  })`);
  console.log('mid:', JSON.stringify(mid, null, 2));
  if (!mid.status.includes('运行') && !mid.status.includes('暂停') && !mid.status.includes('等待')) {
    throw new Error(`对话未在运行：${mid.status}`);
  }
  if (mid.messages.length < 3) throw new Error('消息数量不足');
  for (let index = 1; index < mid.messages.length; index += 1) {
    if (mid.messages[index].speaker === mid.messages[index - 1].speaker) throw new Error('发言者没有交替');
  }
  if (!mid.messages.some((message) => message.speaker === 'A') || !mid.messages.some((message) => message.speaker === 'B')) {
    throw new Error('双方没有都发言');
  }

  // 暂停：点击后等当前一条落盘，再确认状态不再推进。
  await evaluate(`document.getElementById('btnPause').click(); true`);
  await waitFor(`document.getElementById('runState').textContent.includes('已暂停')`, '暂停状态', 15000);
  const pausedCount = await evaluate(`document.querySelectorAll('#transcript .message:not(.is-streaming)').length`);
  await sleep(1600);
  const pausedCountAfter = await evaluate(`document.querySelectorAll('#transcript .message:not(.is-streaming)').length`);
  console.log('pause:', { pausedCount, pausedCountAfter });
  if (pausedCount !== pausedCountAfter) throw new Error('暂停后仍在继续生成');

  // 继续后立即停止，确认中断生效且条数不再增长。
  await evaluate(`document.getElementById('btnPrimary').click(); true`);
  await waitFor(`document.getElementById('runState').textContent.includes('运行') || document.getElementById('runState').textContent.includes('等待')`, '恢复运行');
  await sleep(250);
  await evaluate(`document.getElementById('btnStop').click(); true`);
  await waitFor(`document.getElementById('runState').textContent.includes('已停止')`, '停止状态', 15000);
  const stoppedCount = await evaluate(`document.querySelectorAll('#transcript .message:not(.is-streaming)').length`);
  await sleep(1500);
  const stoppedCountAfter = await evaluate(`document.querySelectorAll('#transcript .message:not(.is-streaming)').length`);
  console.log('stop:', { stoppedCount, stoppedCountAfter });
  if (stoppedCount !== stoppedCountAfter) throw new Error('停止后仍在继续生成');

  const finalView = await evaluate(`({
    status: document.getElementById('runState').textContent,
    turns: document.getElementById('statTurns').textContent,
    tokens: document.getElementById('statTokens').textContent,
    spend: document.getElementById('statSpend').textContent,
    balance: document.getElementById('balanceValue').textContent,
    storedStatus: JSON.parse(localStorage.getItem('echolab.conversations.v1'))[0].status,
    storedTurns: JSON.parse(localStorage.getItem('echolab.conversations.v1'))[0].turns.length
  })`);
  console.log('final:', finalView);
  if (finalView.storedStatus !== 'stopped') throw new Error(`停止后存档状态错误：${finalView.storedStatus}`);
  if (!finalView.spend.includes('¥')) throw new Error(`消耗未显示：${finalView.spend}`);
  if (!finalView.balance.includes('¥')) throw new Error(`余额未显示：${finalView.balance}`);

  // 检查器：B 侧上下文不应含 system，也不应含启动词。
  await evaluate(`document.getElementById('ctxTabB').click(); true`);
  const contextB = await evaluate(`({
    meta: document.getElementById('ctxMeta').textContent,
    raw: JSON.parse(document.getElementById('ctxRaw').textContent)
  })`);
  console.log('contextB:', contextB.meta, contextB.raw);
  if (!Array.isArray(contextB.raw)) throw new Error('B 上下文无法解析');
  if (contextB.raw.some((message) => message.role === 'system')) throw new Error('B 上下文混入了 system prompt');
  if (contextB.raw.some((message) => message.content === '请从“回声是否意味着孤独”开始，给出你的第一个观点。')) {
    throw new Error('B 上下文泄露了启动提示词');
  }

  // 用 mock 的请求日志二次验证真正的模型输入。
  const mockState = await (await fetch(`${MOCK_URL}/__state`)).json();
  console.log('mock balance queries:', mockState.balanceQueries, 'chat requests:', mockState.chatRequests.length);
  const requests = mockState.chatRequests;
  if (requests.length < 2) throw new Error('mock 没有收到足够请求');
  for (const request of requests) {
    if (request.body.messages.some((message) => message.role === 'system')) throw new Error('请求里出现 system prompt');
  }
  const first = requests[0].body.messages;
  if (first[0]?.content !== '请从“回声是否意味着孤独”开始，给出你的第一个观点。') throw new Error('A 的第一条输入不是启动词');
  if (first.some((message) => message.role === 'assistant')) throw new Error('A 的第一条请求不应带 assistant 历史');

  const second = requests[1].body.messages;
  if (second.length !== 1 || second[0].role !== 'user') throw new Error('B 的首条上下文应只有 A 的一条 user 消息');
  if (second[0].content.includes('回声是否意味着孤独')) throw new Error('B 的首条上下文泄露启动词');

  const third = requests[2].body.messages;
  if (third.length !== 3) throw new Error(`A 的第二次请求应有 3 条消息，实际 ${third.length}`);
  if (third[0].role !== 'user' || third[1].role !== 'assistant' || third[2].role !== 'user') {
    throw new Error('A 的第二次请求角色序列错误');
  }

  await screenshot('e2e-desktop-stopped.png');

  // 余额浮层：当前实验应显示余额与消耗。
  await evaluate(`document.getElementById('balanceBtn').click(); true`);
  await waitFor(`!document.getElementById('balancePopover').hidden`, '打开余额浮层');
  const balancePanel = await evaluate(`document.getElementById('balanceBody').textContent`);
  console.log('balance panel:', balancePanel.replace(/\\s+/g, ' ').trim());
  if (!balancePanel.includes('本实验消耗')) throw new Error('余额浮层未显示本实验消耗');
  await evaluate(`document.getElementById('balanceBtn').click(); true`);

  // 手机视口：确认没有横向溢出，检查器按钮可见且能打开。
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true
  });
  await cdp('Page.reload', { ignoreCache: true });
  await sleep(900);
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('.history-item')`, '移动端恢复记录');
  const mobile = await evaluate(`(() => {
    const inspectorButton = document.getElementById('inspectorBtn');
    const rect = inspectorButton.getBoundingClientRect();
    const style = getComputedStyle(inspectorButton);
    return {
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      inspectorVisible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
      transcriptMessages: document.querySelectorAll('#transcript .message').length
    };
  })()`);
  console.log('mobile:', mobile);
  if (!mobile.inspectorVisible) throw new Error('移动端检查器按钮不可见');
  if (mobile.scrollWidth > mobile.width + 2) throw new Error(`移动端出现横向溢出：${mobile.scrollWidth} > ${mobile.width}`);
  await evaluate(`document.getElementById('inspectorBtn').click(); true`);
  await waitFor(`document.getElementById('app').classList.contains('inspector-open')`, '移动端打开检查器');
  await screenshot('e2e-mobile.png');
  await evaluate(`document.getElementById('inspectorCloseBtn').click(); true`);
  await waitFor(`!document.getElementById('app').classList.contains('inspector-open')`, '移动端关闭检查器');
  await screenshot('e2e-mobile-conversation.png');
  await evaluate(`document.getElementById('menuBtn').click(); true`);
  await waitFor(`document.getElementById('app').classList.contains('menu-open')`, '移动端打开侧栏');
  await sleep(350);
  await screenshot('e2e-mobile-sidebar.png');

  if (consoleErrors.length > 0) {
    console.log('console errors:', consoleErrors);
    throw new Error(`浏览器控制台出现错误：${consoleErrors.join(' | ')}`);
  }
  if (problems.length > 0) throw new Error(problems.join(' | '));

  console.log('E2E PASS');
  socket.close();
}

main().catch(async (error) => {
  console.error('E2E FAIL:', error.message);
  process.exitCode = 1;
});
