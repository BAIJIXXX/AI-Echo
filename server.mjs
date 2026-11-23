/**
 * 回响 · 本地服务
 *
 * 作用：
 *   1. 托管 public/ 下的静态页面；
 *   2. 把浏览器里的 /api/chat 请求转发给 DeepSeek（或任意 OpenAI 兼容端点），
 *      并原样转发 SSE 流，从而绕开浏览器跨域限制。
 *
 * 本服务不持久化 API Key，也不会把请求内容写入日志。
 */
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'"
  );
}

function sendJson(res, status, payload) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, status, text) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('请求体过大');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 把用户填写的 base URL 规范化为 chat/completions 端点。
 * - https://api.deepseek.com          -> https://api.deepseek.com/chat/completions
 * - https://api.deepseek.com/v1       -> https://api.deepseek.com/v1/chat/completions
 * - https://.../v1/chat/completions   -> 原样保留
 */
export function normalizeChatEndpoint(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new Error('API 地址不能为空');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('API 地址格式不正确');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('API 地址只支持 http/https');
  }

  url.hash = '';
  let pathname = url.pathname.replace(/\/+$/, '');
  if (!/\/chat\/completions$/i.test(pathname)) {
    pathname = `${pathname}/chat/completions`;
  }
  url.pathname = pathname.replace(/\/{2,}/g, '/');
  return url.toString();
}

/**
 * DeepSeek 余额端点：/user/balance（不挂在 /v1 下）。
 */
export function normalizeBalanceEndpoint(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new Error('API 地址不能为空');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('API 地址格式不正确');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('API 地址只支持 http/https');
  }
  url.hash = '';
  url.search = '';
  let pathname = url.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/\/chat\/completions$/i, '').replace(/\/v1$/i, '');
  url.pathname = `${pathname}/user/balance`.replace(/\/{2,}/g, '/');
  return url.toString();
}

async function handleBalance(req, res) {
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req, 64 * 1024));
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: { message: '请求体不是合法 JSON' } });
    return;
  }
  const apiKey = typeof parsed?.apiKey === 'string' ? parsed.apiKey.trim() : '';
  if (!apiKey) {
    sendJson(res, 400, { error: { message: '缺少 API Key' } });
    return;
  }

  let endpoint;
  try {
    endpoint = normalizeBalanceEndpoint(parsed.baseUrl);
  } catch (error) {
    sendJson(res, 400, { error: { message: error.message } });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const abortUpstream = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', abortUpstream);

  try {
    const upstream = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal
    });
    const text = await upstream.text();
    clearTimeout(timeout);
    res.off('close', abortUpstream);
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(text || JSON.stringify({ error: { message: `上游返回 HTTP ${upstream.status}` } }));
  } catch (error) {
    clearTimeout(timeout);
    res.off('close', abortUpstream);
    if (res.writableEnded) return;
    const detail = error?.name === 'AbortError' ? '请求超时' : (error?.cause?.code || error?.message || '网络错误');
    sendJson(res, 502, {
      error: {
        message: `无法查询余额（${detail}）。余额查询仅支持 DeepSeek 官方端点；其他兼容服务会显示为不可用。`
      }
    });
  }
}

function validateChatRequest(body) {
  if (!body || typeof body !== 'object') throw new Error('请求体必须是 JSON 对象');
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!apiKey) throw new Error('缺少 API Key');
  if (apiKey.length > 1000) throw new Error('API Key 格式不正确');

  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model) throw new Error('缺少模型名称');

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error('messages 必须是非空数组');
  }
  const allowedRoles = new Set(['system', 'user', 'assistant']);
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') throw new Error('messages 中存在非法项');
    if (!allowedRoles.has(message.role)) throw new Error('messages 中存在不支持的 role');
    if (typeof message.content !== 'string') throw new Error('当前版本仅支持字符串 content');
  }

  const endpoint = normalizeChatEndpoint(body.baseUrl);
  return { apiKey, model, endpoint, messages: body.messages, body };
}

function numberInRange(value, min, max) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return undefined;
  return number;
}

async function handleChat(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: { message: error.message } });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: { message: '请求体不是合法 JSON' } });
    return;
  }

  let request;
  try {
    request = validateChatRequest(parsed);
  } catch (error) {
    sendJson(res, 400, { error: { message: error.message } });
    return;
  }

  const { apiKey, model, endpoint, messages, body } = request;
  const stream = body.stream !== false;
  const upstreamPayload = {
    model,
    messages,
    stream
  };

  const temperature = numberInRange(body.temperature, 0, 2);
  const topP = numberInRange(body.topP, 0, 1);
  const maxTokens = numberInRange(body.maxTokens, 1, 393216);
  if (temperature !== undefined) upstreamPayload.temperature = temperature;
  if (topP !== undefined) upstreamPayload.top_p = topP;
  if (maxTokens !== undefined) upstreamPayload.max_tokens = maxTokens;
  if (stream) upstreamPayload.stream_options = { include_usage: true };
  if (typeof body.thinking === 'object' && body.thinking) {
    upstreamPayload.thinking = body.thinking;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('上游请求超时')), UPSTREAM_TIMEOUT_MS);
  const abortUpstream = () => {
    if (!res.writableEnded) controller.abort(new Error('客户端已断开'));
  };
  res.on('close', abortUpstream);

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(upstreamPayload),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeout);
    res.off('close', abortUpstream);
    if (res.writableEnded) return;
    const detail = error?.cause?.code || error?.name || '网络错误';
    sendJson(res, 502, {
      error: {
        message: `无法连接上游 API（${detail}）。请检查网络、API 地址或代理设置。`
      }
    });
    return;
  }

  const contentType = upstream.headers.get('content-type') || (stream ? 'text/event-stream; charset=utf-8' : 'application/json');
  res.statusCode = upstream.status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  const requestId = upstream.headers.get('x-request-id');
  if (requestId) res.setHeader('X-Request-Id', requestId);

  if (!upstream.ok) {
    let text = '';
    try {
      text = await upstream.text();
    } catch {
      /* ignore */
    }
    clearTimeout(timeout);
    res.off('close', abortUpstream);
    if (!res.headersSent) {
      const payload = text || JSON.stringify({ error: { message: `上游返回 HTTP ${upstream.status}` } });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(payload));
      res.end(payload);
    } else {
      res.end();
    }
    return;
  }

  res.flushHeaders?.();

  try {
    if (!upstream.body) throw new Error('上游响应没有内容');
    for await (const chunk of upstream.body) {
      if (res.destroyed) break;
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    if (!res.destroyed) {
      const message = error?.name === 'AbortError' ? '请求已中断' : (error?.message || '读取上游响应失败');
      if (!res.writableEnded) {
        try {
          res.write(`data: ${JSON.stringify({ error: { message } })}\n\n`);
        } catch {
          /* ignore */
        }
        res.end();
      }
    }
  } finally {
    clearTimeout(timeout);
    res.off('close', abortUpstream);
  }
}

async function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, 'Bad Request');
    return;
  }

  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  const publicRoot = path.resolve(PUBLIC_DIR);
  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${path.sep}`)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      const indexPath = path.join(filePath, 'index.html');
      fileStat = await stat(indexPath);
      return await serveFile(req, res, indexPath, fileStat);
    }
  } catch {
    sendText(res, 404, 'Not Found');
    return;
  }

  return serveFile(req, res, filePath, fileStat);
}

function serveFile(req, res, filePath, fileStat) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': fileStat.size,
    'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache'
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) sendText(res, 500, 'Internal Server Error');
    else res.destroy();
  });
  stream.pipe(res);
}

export function createAppServer() {
  return http.createServer(async (req, res) => {
    applySecurityHeaders(res);

    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      sendText(res, 400, 'Bad Request');
      return;
    }

    if (url.pathname === '/api/health') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
        return;
      }
      sendJson(res, 200, { ok: true, name: 'echolab', time: new Date().toISOString() });
      return;
    }

    if (url.pathname === '/api/chat') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
        return;
      }
      await handleChat(req, res);
      return;
    }

    if (url.pathname === '/api/balance') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
        return;
      }
      await handleBalance(req, res);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method Not Allowed');
      return;
    }

    await serveStatic(req, res, url.pathname);
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function openBrowser(url) {
  if (process.env.NO_OPEN === '1' || process.env.NO_OPEN === 'true') return;
  try {
    let child;
    if (process.platform === 'win32') {
      child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    child.on('error', () => {});
    child.unref();
  } catch {
    /* 打开浏览器失败时，用户仍可手动访问终端里打印的地址 */
  }
}

export async function startFromCli() {
  const host = process.env.HOST || '127.0.0.1';
  const preferredPort = Number(process.env.PORT) || 8787;

  for (let port = preferredPort; port < preferredPort + 25; port += 1) {
    const server = createAppServer();
    try {
      await listen(server, port, host);
      const url = `http://${host}:${port}`;
      console.log('');
      console.log('  ┌────────────────────────────────────────────┐');
      console.log('  │  回响 · 双 AI 自对话观测台                 │');
      console.log('  └────────────────────────────────────────────┘');
      console.log(`  本地地址：${url}`);
      console.log('  按 Ctrl+C 停止服务。API Key 只在浏览器与本机内存中。');
      console.log('');
      openBrowser(url);

      const shutdown = () => {
        console.log('\n正在停止服务…');
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return server;
    } catch (error) {
      server.close();
      if (error.code !== 'EADDRINUSE') {
        console.error('启动失败：', error.message);
        process.exitCode = 1;
        return null;
      }
    }
  }

  console.error(`端口 ${preferredPort}-${preferredPort + 24} 都被占用，请设置 PORT 环境变量后重试。`);
  process.exitCode = 1;
  return null;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  startFromCli();
}
