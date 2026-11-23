import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = path.join(ROOT, 'public', 'index.html');
const APP_PATH = path.join(ROOT, 'public', 'app.js');

test('app.js 只查询 index.html 中真实存在的元素 id', async () => {
  const [html, app] = await Promise.all([readFile(INDEX_PATH, 'utf8'), readFile(APP_PATH, 'utf8')]);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const lookups = [...app.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);

  assert.ok(lookups.length > 50, 'expected app.js to look up the interface elements');
  const missing = [...new Set(lookups)].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `app.js references missing DOM ids: ${missing.join(', ')}`);
});

test('app.js 使用的图标都存在 SVG sprite 中', async () => {
  const [html, app] = await Promise.all([readFile(INDEX_PATH, 'utf8'), readFile(APP_PATH, 'utf8')]);
  const symbols = new Set([...html.matchAll(/<symbol[^>]*\bid="i-([^"]+)"/g)].map((match) => match[1]));
  const used = [...app.matchAll(/ICON\('([^']+)'\)/g)].map((match) => match[1]);

  assert.ok(used.length > 0);
  const missing = [...new Set(used)].filter((name) => !symbols.has(name));
  assert.deepEqual(missing, [], `app.js uses missing icons: ${missing.join(', ')}`);
});

test('index.html 的静态资源都存在，且移动端可打开上下文检查器', async () => {
  const html = await readFile(INDEX_PATH, 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="\/([^"#?]+)"/g)]
    .map((match) => match[1])
    .filter((asset) => /\.(?:js|css|svg)$/.test(asset));

  assert.ok(assets.length >= 3);
  for (const asset of assets) {
    await access(path.join(ROOT, 'public', asset));
  }

  const inspectorButton = html.match(/<button[^>]*\bid="inspectorBtn"[^>]*>/)?.[0] || '';
  assert.ok(inspectorButton, 'inspector button must exist');
  assert.ok(!inspectorButton.includes('hide-narrow'), 'inspector button must remain available on narrow screens');
  assert.match(html, /<meta[^>]+name="viewport"/);
});

test('index.html 引入前端模块且模块文件可被解析', async () => {
  const html = await readFile(INDEX_PATH, 'utf8');
  assert.match(html, /<script[^>]+type="module"[^>]+src="\/app\.js"/);
  assert.match(html, /id="settingsDialog"/);
  assert.match(html, /id="confirmDialog"/);
  assert.match(html, /id="toastStack"/);
  assert.match(html, /id="thinkingMode"/);
  assert.match(html, /id="settingThinkingMode"/);

  for (const file of ['app.js', 'engine.js', 'markdown.js']) {
    const source = await readFile(path.join(ROOT, 'public', file), 'utf8');
    assert.ok(source.length > 0, `${file} must not be empty`);
  }
});
