const BAD = /[\\/:*?"<>|\r\n\t]+/g;

function slug(text, fallback) {
  const cleaned = String(text || '').replace(BAD, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || fallback).slice(0, 60);
}

function stamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function pageMetaLines(page, record) {
  const lines = [];
  const facts = [page.host, page.author, page.published].filter(Boolean).join(' · ');
  if (facts) lines.push(`> ${facts}`);
  lines.push(`> 来源：${page.url || record.url || '未记录'}`);
  const blocks = Array.isArray(page.blocks) ? page.blocks.length : 0;
  if (blocks) lines.push(`> 读取：${blocks} 段 · ${Number(page.extractedChars) || 0} 字${page.truncated ? '（仅前段可见内容）' : ''}`);
  return lines;
}

export function pageMarkdown(record = {}) {
  const page = record.page || {};
  const turns = Array.isArray(record.turns) ? record.turns : [];
  const title = record.title || page.title || '未命名页面';
  const lines = [`# ${title}`, '', ...pageMetaLines(page, record), '', '---', ''];

  for (const turn of turns) {
    const question = String(turn.question || '').trim();
    lines.push(`## ${question || '页面总结'}`, '');
    const answer = String(turn.answer || '').trim();
    lines.push(answer || '（无内容）');
    if (!turn.complete) lines.push('', '> 这一轮没有跑完。');
    const sources = Array.isArray(turn.sources) ? turn.sources : [];
    if (sources.length) {
      lines.push('', '外部来源：');
      for (const s of sources) lines.push(`- [${s.id}] ${s.title} — ${s.url}`);
    }
    lines.push('');
  }

  if (!turns.length) lines.push('（还没有总结或追问）', '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function pagePlainText(record = {}) {
  return pageMarkdown(record)
    .replace(/^---$/gm, '――――――')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^-\s+/gm, '· ')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/==([^=\n]+)==/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function pageFileName(record = {}) {
  const title = slug(record.title || record.page?.title, '网页');
  return `知页-${title}-${stamp()}.md`;
}

function download(name, body, type) {
  const blob = new Blob([body], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return name;
}

export function downloadPage(record = {}) {
  return download(pageFileName(record), pageMarkdown(record), 'text/markdown;charset=utf-8');
}

export function pagesMarkdown(records = []) {
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  if (!list.length) return '# 知页 · 网页阅读\n\n（还没有保存的网页记录）\n';
  if (list.length === 1) return pageMarkdown(list[0]);
  const head = ['# 知页 · 网页阅读交接', '', `导出时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong' })}`, `共 ${list.length} 个页面。`, ''];
  return head.concat(list.map(pageMarkdown)).join('\n');
}

export function downloadPages(records = [], format = 'md') {
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  if (!list.length) return '';
  const json = format === 'json';
  const body = json
    ? JSON.stringify(list.map(r => ({ title: r.title, page: r.page, turns: r.turns, updated: r.updated })), null, 2)
    : pagesMarkdown(list);
  return download(`知页-网页记录-${stamp()}.${json ? 'json' : 'md'}`, body, json ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8');
}
