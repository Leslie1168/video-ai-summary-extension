/**
 * 轻量 Markdown 渲染器
 * 只覆盖总结输出用到的语法，零依赖，避免 CSP 与打包问题。
 * 特殊处理：[03:12] 形式的行内时间戳会渲染成可点击按钮。
 */

export const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

const TS_RE = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;

export function renderInline(text) {
  let s = escapeHtml(text);
  // 行内代码（先处理，避免内部内容被后续规则二次替换）
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // 粗体
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Highlight: ==text== -> <mark>
  s = s.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
  // 斜体
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // 时间戳
  s = s.replace(TS_RE, (_, t) => `<button class="ts" data-t="${t}">${t}</button>`);
  // 链接
  s = s.replace(
    /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
  );
  // 还原代码
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

export function renderMarkdown(md) {
  const lines = String(md ?? '').replace(/\r/g, '').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) {
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      // 保持原始层级：提示词要求模型用 ###，
      // 因此这里必须映射成 <h3>，否则会落到没有样式的 <h5> 上
      const level = Math.min(Math.max(heading[1].length, 1), 6);
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      closeList();
      out.push(`<blockquote>${renderInline(line.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      closeList();
      out.push('<hr />');
      continue;
    }

    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ol) {
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${renderInline(ol[2])}</li>`);
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${renderInline(ul[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${renderInline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}
