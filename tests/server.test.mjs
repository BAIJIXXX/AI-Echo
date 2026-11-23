import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  createAppServer,
  normalizeBalanceEndpoint,
  normalizeChatEndpoint
} from '../server.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

let upstreamServer;
let appServer;
let upstreamBase;
let appBase;
let lastChatRequest = null;

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

before(async () => {
  upstreamServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');

    if (req.url === '/user/balance') {
      if (req.headers.authorization === 'Bearer bad-key') {
        sendJson(res, 401, { error: { message: 'invalid api key' } });
        return;
      }
      sendJson(res, 200, {
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '88.80', granted_balance: '8.80', topped_up_balance: '80.00' }
        ]
      });
      return;
    }

    if (req.url === '/chat/completions' || req.url === '/v1/chat/completions') {
      if (req.headers.authorization === 'Bearer bad-key') {
        sendJson(res, 401, { error: { message: 'invalid api key' } });
        return;
      }
      const body = JSON.parse(raw);
      lastChatRequest = {
        url: req.url,
        auth: req.headers.authorization,
        body
      };

      if (body.stream === false) {
        sendJson(res, 200, {
          id: 'chatcmpl-test',
          model: body.model,
          choices: [{ message: { content: '非流式回答' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
        });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.write('data: {"id":"chatcmpl-test","model":"deepseek-chat","choices":[{"delta":{"content":"你"}}]}\n\n');
      setTimeout(() => {
        res.write(
          'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n'
        );
        res.write('data: [DONE]\n\n');
        res.end();
      }, 5);
      return;
    }

    sendJson(res, 404, { error: { message: 'not found' } });
  });

  const upstreamPort = await listen(upstreamServer);
  upstreamBase = `http://127.0.0.1:${upstreamPort}`;

  appServer = createAppServer();
  const appPort = await listen(appServer);
  appBase = `http://127.0.0.1:${appPort}`;
});

after(async () => {
  if (appServer) await close(appServer);
  if (upstreamServer) await close(upstreamServer);
});

test('normalizeChatEndpoint 接受 base URL 或完整端点并拒绝非 http(s)', () => {
  assert.equal(normalizeChatEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions');
  assert.equal(
    normalizeChatEndpoint('api.deepseek.com/v1'),
    'https://api.deepseek.com/v1/chat/completions'
  );
  assert.equal(
    normalizeChatEndpoint('http://127.0.0.1:1234/v1/chat/completions'),
    'http://127.0.0.1:1234/v1/chat/completions'
  );
  assert.throws(() => normalizeChatEndpoint('ftp://example.com'), /只支持 http/);
  assert.throws(() => normalizeChatEndpoint('   '), /不能为空/);
});

test('normalizeBalanceEndpoint 去掉 /chat/completions 和 /v1', () => {
  assert.equal(normalizeBalanceEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com/user/balance');
  assert.equal(normalizeBalanceEndpoint('https://api.deepseek.com/v1'), 'https://api.deepseek.com/user/balance');
  assert.equal(
    normalizeBalanceEndpoint('https://api.deepseek.com/v1/chat/completions'),
    'https://api.deepseek.com/user/balance'
  );
});

test('健康检查、静态页面与安全响应头', async () => {
  const health = await fetch(`${appBase}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const index = await fetch(`${appBase}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await index.text(), /id="app"/);

  const favicon = await fetch(`${appBase}/favicon.svg`);
  assert.equal(favicon.status, 200);
  assert.match(favicon.headers.get('content-type'), /image\/svg\+xml/);

  const missing = await fetch(`${appBase}/no-such-file.js`);
  assert.equal(missing.status, 404);
});

test('聊天代理拒绝缺少 API Key 的请求', async () => {
  const response = await fetch(`${appBase}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /API Key/);
});

test('聊天代理透传 SSE、附加 include_usage 并原样转发鉴权头', async () => {
  lastChatRequest = null;
  const response = await fetch(`${appBase}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'test-key',
      baseUrl: upstreamBase,
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: '启动词' }],
      stream: true,
      temperature: 0.3,
      maxTokens: 64,
      topP: 0.9,
      thinking: { type: 'enabled' },
      reasoning_effort: 'high'
    })
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /"content":"你"/);
  assert.match(text, /"content":"好"/);
  assert.match(text, /data: \[DONE\]/);

  assert.ok(lastChatRequest);
  assert.equal(lastChatRequest.auth, 'Bearer test-key');
  assert.equal(lastChatRequest.url, '/chat/completions');
  assert.equal(lastChatRequest.body.model, 'deepseek-chat');
  assert.equal(lastChatRequest.body.stream, true);
  assert.deepEqual(lastChatRequest.body.stream_options, { include_usage: true });
  assert.equal(lastChatRequest.body.temperature, 0.3);
  assert.equal(lastChatRequest.body.max_tokens, 64);
  assert.equal(lastChatRequest.body.top_p, 0.9);
  assert.deepEqual(lastChatRequest.body.thinking, { type: 'enabled' });
  assert.equal(lastChatRequest.body.reasoning_effort, 'high');
  assert.deepEqual(lastChatRequest.body.messages, [{ role: 'user', content: '启动词' }]);
});

test('聊天代理支持非流式 JSON 与自定义 /v1 地址', async () => {
  lastChatRequest = null;
  const response = await fetch(`${appBase}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'test-key',
      baseUrl: `${upstreamBase}/v1`,
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false
    })
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const payload = await response.json();
  assert.equal(payload.choices[0].message.content, '非流式回答');
  assert.equal(lastChatRequest.url, '/v1/chat/completions');
  assert.equal(lastChatRequest.body.stream, false);
  assert.equal(lastChatRequest.body.stream_options, undefined);
});

test('上游 401 会保留状态码和错误体，供前端翻译', async () => {
  const response = await fetch(`${appBase}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'bad-key',
      baseUrl: upstreamBase,
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true
    })
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal((await response.json()).error.message, 'invalid api key');
});

test('余额代理调用 /user/balance 并透传官方响应', async () => {
  const response = await fetch(`${appBase}/api/balance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 'test-key', baseUrl: `${upstreamBase}/v1/chat/completions` })
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const payload = await response.json();
  assert.equal(payload.is_available, true);
  assert.equal(payload.balance_infos[0].total_balance, '88.80');
});

test('余额代理保留上游错误状态', async () => {
  const response = await fetch(`${appBase}/api/balance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 'bad-key', baseUrl: upstreamBase })
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.message, 'invalid api key');
});

test('不支持的方法返回 405', async () => {
  const chat = await fetch(`${appBase}/api/chat`);
  assert.equal(chat.status, 405);
  const balance = await fetch(`${appBase}/api/balance`);
  assert.equal(balance.status, 405);
});

test('静态服务拒绝编码后的目录穿越', async () => {
  const status = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: Number(new URL(appBase).port),
        path: '/%2e%2e%2f%2e%2e%2fserver.mjs',
        method: 'GET'
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      }
    );
    request.on('error', reject);
    request.end();
  });
  assert.ok(status === 403 || status === 404, `expected 403/404, got ${status}`);
});
