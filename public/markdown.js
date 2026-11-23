/**
 * 回响 · 轻量 Markdown 渲染器
 *
 * 目标：足够阅读 AI 输出的标题 / 列表 / 引用 / 表格 / 代码 / 粗体等格式，
 * 同时默认不信任模型输出：原始 HTML 一律转义，链接只允许 http(s)/mailto。
 * 不依赖任何第三方库。
 */

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ESCAPE_MAP[character]);
}

function safeUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (!/^(https?:|mailto:)/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

const INLINE_PLACEHOLDER = '\u0000';

function renderInline(rawText) {
  const tokens = [];
  const store = (html) => {
    tokens.push(html);
    return `${INLINE_PLACEHOLDER}${tokens.length - 1}${INLINE_PLACEHOLDER}`;
  };

  let text = String(rawText ?? '');

  // 行内代码优先，避免内部星号、方括号被误解析。
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => store(`<code>${escapeHtml(code)}</code>`));

  // 链接：只渲染安全协议；不安全的写法保留为纯文本。
  text = text.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (match, label, url) => {
    const safe = safeUrl(url);
    if (!safe) return match;
    return store(
      `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
    );
  });

  text = escapeHtml(text);

  // 粗体 / 删除线 / 斜体。
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?，。！？、；：])/g, '$1<em>$2</em>');

  // 还原占位符（内容已在生成时转义）。
  text = text.replace(/\u0000(\d+)\u0000/g, (_match, index) => tokens[Number(index)] || '');
  return text;
}

function isSpecialLine(line) {
  return (
    /^\s*$/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*([-*+]|\d+[.)])\s+/.test(line) ||
    /^\s*([-*_])\1{2,}\s*$/.test(line) ||
    /^\s*```/.test(line) ||
    looksLikeTableStart(line)
  );
}

function splitTableRow(line) {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  return value.split('|').map((cell) => cell.trim());
}

function looksLikeTableStart(line) {
  return /^\s*\|?.*\|.*$/.test(line) && line.includes('|');
}

function isTableSeparator(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function renderTable(lines, startIndex) {
  const header = splitTableRow(lines[startIndex]);
  const separator = splitTableRow(lines[startIndex + 1]);
  const rows = [];
  let index = startIndex + 2;
  while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }
  const align = separator.map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
  const headHtml = header
    .map((cell, cellIndex) => `<th style="text-align:${align[cellIndex] || 'left'}">${renderInline(cell)}</th>`)
    .join('');
  const bodyHtml = rows
    .map((row) => {
      const cells = header.map((_unused, cellIndex) => `<td>${renderInline(row[cellIndex] || '')}</td>`).join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return {
    html: `<div class="md-table-wrap"><table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`,
    nextIndex: index
  };
}

function renderTextBlocks(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (/^\s*$/.test(line)) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      html.push('<hr>');
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      html.push(`<blockquote>${quoted.map((item) => renderInline(item)).join('<br>')}</blockquote>`);
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (index < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[index])) {
        const itemText = lines[index].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        items.push(`<li>${renderInline(itemText)}</li>`);
        index += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    if (looksLikeTableStart(line) && isTableSeparator(lines[index + 1] || '')) {
      const table = renderTable(lines, index);
      html.push(table.html);
      index = table.nextIndex;
      continue;
    }

    // 普通段落：收集到空行或另一个块级元素之前，保留软换行。
    const paragraph = [];
    while (index < lines.length && !isSpecialLine(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length > 0) {
      html.push(`<p>${paragraph.map((item) => renderInline(item)).join('<br>')}</p>`);
    } else {
      // 兜底，避免任意异常输入造成死循环。
      html.push(`<p>${renderInline(line)}</p>`);
      index += 1;
    }
  }

  return html.join('');
}

/**
 * 把 Markdown 字符串转换成安全 HTML。
 */
export function renderMarkdown(markdown) {
  const source = String(markdown ?? '').replace(/\r\n?/g, '\n');
  const fencePattern = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/g;
  let output = '';
  let cursor = 0;
  let match;

  while ((match = fencePattern.exec(source)) !== null) {
    const before = source.slice(cursor, match.index);
    output += renderTextBlocks(before);
    const language = String(match[1] || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9+#._-]/g, '');
    const code = match[2].replace(/\n$/, '');
    output += `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(code)}</code></pre>`;
    cursor = match.index + match[0].length;
  }

  output += renderTextBlocks(source.slice(cursor));
  return output;
}
