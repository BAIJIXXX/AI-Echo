import http from 'node:http';

const port = Number(process.env.MOCK_PORT || 9901);
let chatRequests = [];
let balanceQueries = 0;
let balanceValue = 100;

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/__state') {
    json(res, 200, { chatRequests, balanceQueries, balanceValue });
    return;
  }
  if (req.method === 'POST' && req.url === '/__reset') {
    chatRequests = [];
    balanceQueries = 0;
    balanceValue = 100;
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET' && req.url === '/user/balance') {
    balanceQueries += 1;
    balanceValue = Math.max(0, Number((balanceValue - 0.0123).toFixed(4)));
    json(res, 200, {
      is_available: true,
      balance_infos: [
        {
          currency: 'CNY',
          total_balance: balanceValue.toFixed(4),
          granted_balance: '5.0000',
          topped_up_balance: (balanceValue - 5).toFixed(4)
        }
      ]
    });
    return;
  }
  if (req.method === 'POST' && /\/chat\/completions$/.test(req.url || '')) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const index = chatRequests.length + 1;
    const speakerTurn = body.messages.filter((message) => message.role === 'assistant').length + 1;
    const reply = `这是第 ${index} 次请求的回答（本侧第 ${speakerTurn} 条）。上下文共有 ${body.messages.length} 条消息。`;
    chatRequests.push({
      path: req.url,
      auth: req.headers.authorization,
      body
    });

    if (body.stream === false) {
      json(res, 200, {
        id: `mock-${index}`,
        model: body.model,
        choices: [{ message: { content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10 + index, completion_tokens: 8, total_tokens: 18 + index }
      });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    const pieces = [`这是第 ${index} 次请求`, `的回答（本侧第 ${speakerTurn} 条）。`, `上下文共有 ${body.messages.length} 条消息。`];
    let cursor = 0;
    const timer = setInterval(() => {
      if (cursor < pieces.length) {
        res.write(`data: ${JSON.stringify({ id: `mock-${index}`, model: body.model, choices: [{ delta: { content: pieces[cursor] } }] })}\n\n`);
        cursor += 1;
        return;
      }
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10 + index, completion_tokens: 16, total_tokens: 26 + index }
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      clearInterval(timer);
      res.end();
    }, 40);
    req.on('close', () => clearInterval(timer));
    return;
  }
  json(res, 404, { error: { message: 'mock: not found' } });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock deepseek listening on http://127.0.0.1:${port}`);
});
