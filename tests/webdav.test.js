import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBase,
  joinPath,
  basicAuth,
  parseMultistatus,
  request,
} from '../lib/webdav.js';

test('normalizeBase keeps one trailing slash and drops query', () => {
  assert.equal(normalizeBase('https://dav.jianguoyun.com/dav'), 'https://dav.jianguoyun.com/dav/');
  assert.equal(normalizeBase(' https://dav.jianguoyun.com/dav/ '), 'https://dav.jianguoyun.com/dav/');
  assert.equal(normalizeBase('https://host/dav/?x=1#y'), 'https://host/dav/');
  assert.throws(() => normalizeBase(''), /地址是空的/);
  assert.throws(() => normalizeBase('not a url'), /不是合法网址/);
  assert.throws(() => normalizeBase('ftp://host/x'), /http 或 https/);
});

test('joinPath encodes every segment but keeps the separators', () => {
  assert.equal(joinPath('知页', 'edge-1a', 'abc.json'), '%E7%9F%A5%E9%A1%B5/edge-1a/abc.json');
  assert.equal(joinPath('知页', '', undefined, 'x.json'), '%E7%9F%A5%E9%A1%B5/x.json');
  assert.equal(joinPath(), '');
  assert.equal(joinPath('a/b'), 'a/b');
});

test('basicAuth encodes UTF-8 credentials', () => {
  assert.equal(basicAuth('a@b.com', 'pass'), `Basic ${Buffer.from('a@b.com:pass', 'utf8').toString('base64')}`);
  const chinese = basicAuth('谁@例子.com', '密码');
  assert.ok(chinese.startsWith('Basic '));
  assert.equal(Buffer.from(chinese.slice(6), 'base64').toString('utf8'), '谁@例子.com:密码');
});

test('parseMultistatus reads href, size, date and collections without DOMParser', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/%E7%9F%A5%E9%A1%B5/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype><D:getlastmodified>Mon, 10 Nov 2025 08:00:00 GMT</D:getlastmodified></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/%E7%9F%A5%E9%A1%B5/edge-1a/abc.json</D:href>
    <D:propstat><D:prop><D:resourcetype/><D:getcontentlength>1842</D:getcontentlength><D:getlastmodified>Mon, 10 Nov 2025 09:30:00 GMT</D:getlastmodified></D:prop></D:propstat>
  </D:response>
</D:multistatus>`;
  const items = parseMultistatus(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].dir, true);
  assert.equal(items[0].name, '知页');
  assert.equal(items[1].dir, false);
  assert.equal(items[1].name, 'abc.json');
  assert.equal(items[1].size, 1842);
  assert.equal(items[1].modified, Date.parse('Mon, 10 Nov 2025 09:30:00 GMT'));
});

test('parseMultistatus tolerates entities and unknown prefixes', () => {
  const xml = `<x:multistatus xmlns:x="DAV:"><x:response><x:href>/dav/a%26b/</x:href><x:propstat><x:prop><x:resourcetype><x:collection/></x:resourcetype></x:prop></x:propstat></x:response></x:multistatus>`;
  const items = parseMultistatus(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].path, '/dav/a&b/');
  assert.equal(items[0].dir, true);
});

test('request turns auth and rate-limit statuses into readable errors', async () => {
  const cfg = { base: 'https://dav.example.com/dav/', user: 'u', password: 'p' };
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('nope', { status: 401 });
    await assert.rejects(() => request(cfg, 'GET', 'x.json'), /应用密码/);

    globalThis.fetch = async () => new Response('', { status: 403 });
    await assert.rejects(() => request(cfg, 'GET', 'x.json'), /没有权限/);
  } finally {
    globalThis.fetch = original;
  }
});

test('request sends basic auth and the encoded path', async () => {
  const cfg = { base: 'https://dav.example.com/dav/', user: 'me@x.com', password: 'pw' };
  const original = globalThis.fetch;
  let seen = null;
  try {
    globalThis.fetch = async (url, init) => {
      seen = { url, init };
      return new Response('ok', { status: 200 });
    };
    const res = await request(cfg, 'GET', joinPath('知页', 'a b.json'));
    assert.equal(res.status, 200);
    assert.equal(seen.url, `https://dav.example.com/dav/${encodeURIComponent('知页')}/${encodeURIComponent('a b')}.json`);
    assert.equal(seen.init.headers.Authorization, `Basic ${Buffer.from('me@x.com:pw').toString('base64')}`);
    assert.equal(seen.init.method, 'GET');
  } finally {
    globalThis.fetch = original;
  }
});
