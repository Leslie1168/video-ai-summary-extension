import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const PREFIX = 'reader-page:v1:';
const store = {
  [`${PREFIX}https://tieba.baidu.com/p/1`]: {
    version: 1,
    url: 'https://tieba.baidu.com/p/1',
    title: '风扇一直响',
    page: { site: 'tieba', host: 'tieba.baidu.com', url: 'https://tieba.baidu.com/p/1' },
    turns: [{ question: '换的什么显卡', answer: '5070 Ti', complete: true }],
    updated: 200,
  },
  [`${PREFIX}https://www.zhihu.com/question/2`]: {
    version: 1,
    url: 'https://www.zhihu.com/question/2',
    title: '显卡怎么选',
    page: { site: 'zhihu', host: 'www.zhihu.com', url: 'https://www.zhihu.com/question/2' },
    turns: [],
    updated: 100,
  },
  'video-memory:abc': { video: { title: '一个视频' }, turns: [], updated: 300 },
  mode: 'auto',
  readerStyle: 'standard',
};

globalThis.chrome = { storage: { local: { get: async () => ({ ...store }) } } };
const { listPageMemories } = await import('../lib/archive.js');

test('page memories are read from the reader prefix only', async () => {
  const pages = await listPageMemories();
  assert.equal(pages.length, 2);
  assert.ok(pages.every(p => p.kind === 'page'));
  assert.ok(pages.every(p => p.key.startsWith(PREFIX)));
  assert.ok(!pages.some(p => p.id.includes('video-memory')));
});

test('page memories are sorted newest first and keep their url as id', async () => {
  const pages = await listPageMemories();
  assert.deepEqual(pages.map(p => p.id), ['https://tieba.baidu.com/p/1', 'https://www.zhihu.com/question/2']);
  assert.equal(pages[0].title, '风扇一直响');
  assert.equal(pages[0].page.host, 'tieba.baidu.com');
  assert.equal(pages[0].turns.length, 1);
});

test('a page record without turns still lists', async () => {
  const pages = await listPageMemories();
  const zhihu = pages.find(p => p.page.host === 'www.zhihu.com');
  assert.ok(zhihu);
  assert.deepEqual(zhihu.turns, []);
});

test('memory page wires the video and page views together', async () => {
  const fs = await import('node:fs');
  const load = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const html = load('memory/memory.html');
  assert.match(html, /id="tab-video"/);
  assert.match(html, /id="tab-page"/);
  assert.match(html, /id="empty-hint"/);
  const js = load('memory/memory.js');
  assert.match(js, /listPageMemories/);
  assert.match(js, /downloadPage/);
  assert.match(js, /record\.kind==='page'/);
  assert.match(js, /reader-page:v1:/);
  assert.match(js, /function selectPage/);
  assert.match(load('memory/memory.css'), /\.tab\.active/);
});

test('记忆页的删除按钮连到了云端与本地', () => {
  const html = readFileSync(new URL('../memory/memory.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../memory/memory.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../memory/memory.css', import.meta.url), 'utf8');

  assert.ok(html.includes('id="delete-one"'), '详情区要有删除按钮');
  // 网页记录用全传 key，视频记录用 video-memory: + id，必须一致，否则云端删不到
  assert.ok(js.includes('function storageKey'), '要有统一的 key 推导');
  assert.ok(js.includes('`video-memory:${record.id}`'), '视频 key 要拼对前缀');
  assert.ok(js.includes("type: 'CLOUD_DELETE'"), '已配置云端时走 CLOUD_DELETE');
  assert.ok(js.includes('chrome.storage.local.remove(key)'), '未配置云端时直接删本地');
  assert.ok(js.includes('confirm('), '删除前要确认');
  assert.ok(css.includes('.actions button.danger'), '删除按钮要有危险样式');
});

