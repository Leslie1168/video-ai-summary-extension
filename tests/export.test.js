import test from 'node:test';
import assert from 'node:assert/strict';
import { pageMarkdown, pagePlainText, pageFileName } from '../reader/lib/export.js';

const record = {
  title: '5070 Ti 换了之后风扇一直响',
  page: {
    site: 'tieba',
    host: 'tieba.baidu.com',
    author: '硬件小白鼠',
    published: '2025-11-08',
    url: 'https://tieba.baidu.com/p/11092190102',
    blocks: [{ id: 'P1' }, { id: 'P2' }, { id: 'P3' }],
    extractedChars: 8600,
    truncated: false,
  },
  turns: [
    { question: '', answer: '## 🎯 一句话总结\n\n电源 **750W** 够用。[P3]', complete: true, sources: [] },
    {
      question: '楼主最后换的什么显卡？',
      answer: '**5070 Ti**，理由是 ==不想再等驱动修 bug==。[P3]',
      complete: true,
      sources: [{ id: 'W1', title: '驱动说明', url: 'https://example.com/driver' }],
    },
  ],
};

test('page markdown carries title, page facts and every turn', () => {
  const md = pageMarkdown(record);
  assert.match(md, /^# 5070 Ti 换了之后风扇一直响/);
  assert.match(md, /tieba\.baidu\.com · 硬件小白鼠 · 2025-11-08/);
  assert.match(md, /来源：https:\/\/tieba\.baidu\.com\/p\/11092190102/);
  assert.match(md, /读取：3 段 · 8600 字/);
  assert.match(md, /## 页面总结/);
  assert.match(md, /## 楼主最后换的什么显卡？/);
  assert.match(md, /\[P3\]/);
});

test('external sources are listed under their turn', () => {
  const md = pageMarkdown(record);
  assert.match(md, /外部来源：/);
  assert.match(md, /- \[W1\] 驱动说明 — https:\/\/example\.com\/driver/);
});

test('unfinished turn is flagged in the export', () => {
  const md = pageMarkdown({ title: 'x', page: {}, turns: [{ question: 'q', answer: '半截', complete: false }] });
  assert.match(md, /这一轮没有跑完。/);
});

test('empty record still produces a usable header', () => {
  const md = pageMarkdown({});
  assert.match(md, /^# 未命名页面/);
  assert.match(md, /（还没有总结或追问）/);
});

test('plain text drops markdown decoration', () => {
  const text = pagePlainText(record);
  assert.doesNotMatch(text, /\*\*/);
  assert.doesNotMatch(text, /==/);
  assert.doesNotMatch(text, /^#/m);
  assert.match(text, /5070 Ti，理由是 不想再等驱动修 bug。\[P3\]/);
  assert.match(text, /页面总结/);
});

test('file name strips characters windows rejects', () => {
  const name = pageFileName({ title: 'a/b:c*?  "d"|e', page: {} });
  assert.match(name, /^知页-a b c d e-\d{8}-\d{4}\.md$/);
  assert.doesNotMatch(name, /[\\/:*?"|]/);
});

test('missing title falls back instead of producing an empty name', () => {
  assert.match(pageFileName({ page: {} }), /^知页-网页-\d{8}-\d{4}\.md$/);
});
