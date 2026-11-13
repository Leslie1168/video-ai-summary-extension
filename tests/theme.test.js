import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('主题：五个样式表都只认 data-theme，不再看系统设置', () => {
  const files = ['panel/panel.css', 'panel/studio.css', 'panel/typography.css', 'options/options.css', 'memory/memory.css'];
  for (const file of files) {
    const css = read(file);
    assert.equal(css.includes('prefers-color-scheme'), false, `${file} 还留着 prefers-color-scheme`);
    assert.ok(css.includes('html[data-theme="dark"]'), `${file} 缺少深色选择器`);
  }
});

test('主题：theme.js 先出深色选择器再加分号，避免整块失效', () => {
  const css = read('panel/panel.css');
  assert.ok(/html\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark;/.test(css));
  assert.ok(css.includes('--bg: #0c0c0c;'));
});

test('主题：四个页面都挂了 theme.js', () => {
  const pages = {
    'panel/panel.html': 'theme.js',
    'reader/panel/panel.html': '../../panel/theme.js',
    'options/options.html': '../panel/theme.js',
    'memory/memory.html': '../panel/theme.js',
  };
  for (const [page, src] of Object.entries(pages)) {
    assert.ok(read(page).includes(src), `${page} 没有引入 ${src}`);
  }
  assert.ok(existsSync(join(ROOT, 'panel/theme.js')));
});

test('主题：设置页能选跟随系统、浅、深三档', () => {
  const html = read('options/options.html');
  const start = html.indexOf('id="themeMode"');
  assert.ok(start > 0);
  const block = html.slice(start, html.indexOf('</select>', start));
  for (const value of ['auto', 'light', 'dark']) {
    assert.ok(block.includes(`value="${value}"`), `缺少 ${value}`);
  }
  const js = read('options/options.js');
  assert.ok(js.includes("themeMode: 'auto'"));
  assert.ok(js.includes("themeMode: $('themeMode')"));
  assert.ok(js.includes('themeMode: fields.themeMode.value'));
});

test('主题：侧栏外壳也跟着换，且不再有墨绿残色', () => {
  const router = read('panel/router.html');
  assert.ok(router.includes('data-theme="dark"'));
  assert.ok(router.includes('theme.js'));
  for (const color of ['#f7f8f4', '#1b2e25', '#14221e', '#edf7ed']) {
    assert.equal(router.includes(color), false, `router.html 还留着 ${color}`);
  }
});

test('联网：网页侧与视频侧共用一个 webEnabled 开关', () => {
  const js = read('reader/panel/panel.js');
  assert.ok(js.includes('readerMode'));
  assert.ok(js.includes('webEnabled:next!==\'page\''));
  assert.ok(js.includes('chrome.storage.sync.get({readerMode:null,webEnabled:true})'));
  assert.equal(js.includes('chrome.storage.local.set({mode:'), false, '还在只写本地 mode');
  const chat = read('panel/chat.js');
  assert.ok(chat.includes('webEnabled'), '视频侧没读同一个键');
});

test('联网：界面上不再有两个「联网模式」', () => {
  for (const page of ['options/options.html', 'panel/panel.html']) {
    assert.equal(read(page).includes('联网模式'), false, `${page} 还有歧义标签`);
  }
  const options = read('options/options.html');
  assert.ok(options.includes('联网后的思考档<select id="webMode">'));
});
