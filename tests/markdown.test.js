import test from 'node:test';
import assert from 'node:assert/strict';
import { renderInline, renderMarkdown } from '../lib/markdown.js';

test('==text== becomes a highlight mark', () => {
  assert.equal(renderInline('这是 ==关键判断== 收尾'), '这是 <mark>关键判断</mark> 收尾');
});

test('highlight and bold can coexist in one line', () => {
  const html = renderInline('**工作记忆** 只有 ==4 个槽位==');
  assert.equal(html, '<strong>工作记忆</strong> 只有 <mark>4 个槽位</mark>');
});

test('lone == pairs are left alone', () => {
  assert.equal(renderInline('a == b'), 'a == b');
  assert.equal(renderInline('=='), '==');
});

test('highlight does not swallow the timestamp button', () => {
  const html = renderInline('==注意力== 在 [02:14] 崩掉');
  assert.match(html, /<mark>注意力<\/mark>/);
  assert.match(html, /<button class="ts" data-t="02:14">02:14<\/button>/);
});

test('highlight is escaped before markup is applied', () => {
  const html = renderInline('==<script>x</script>==');
  assert.equal(html, '<mark>&lt;script&gt;x&lt;/script&gt;</mark>');
});

test('renderMarkdown keeps highlight inside list items', () => {
  const html = renderMarkdown('- **抓手** ==重点== 收尾');
  assert.match(html, /<li>/);
  assert.match(html, /<strong>抓手<\/strong>/);
  assert.match(html, /<mark>重点<\/mark>/);
});
