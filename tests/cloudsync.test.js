import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 一个内存版 WebDAV：够跑通 MKCOL / PUT / GET / DELETE / PROPFIND。
// 只记录 PUT 次数，用来断言“改一条只传一条”。
function installServer() {
  const files = new Map();
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname);
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, path });
    if (method === 'PUT') {
      files.set(path, String(init.body ?? ''));
      return new Response('', { status: 201 });
    }
    if (method === 'GET') {
      if (!files.has(path)) return new Response('', { status: 404 });
      return new Response(files.get(path), { status: 200 });
    }
    if (method === 'DELETE') {
      files.delete(path);
      // 204 不能带 body，否则 undici 直接抛，会被重试逻辑拖成 21 秒。
      return new Response(null, { status: 204 });
    }
    if (method === 'MKCOL') return new Response('', { status: 201 });
    return new Response('', { status: 207 });
  };
  return { files, calls };
}

function installStorage(initial) {
  const data = { ...initial };
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys === null) return { ...data };
          if (typeof keys === 'string') return { [keys]: data[keys] };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, data[k]]));
          const out = { ...keys };
          for (const key of Object.keys(keys)) if (key in data) out[key] = data[key];
          return out;
        },
        async set(patch) {
          Object.assign(data, patch);
        },
        async remove(key) {
          for (const k of Array.isArray(key) ? key : [key]) delete data[k];
        },
      },
    },
  };
  return data;
}

Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0 Safari/537.36' },
  configurable: true,
});

const BASE = {
  davUrl: 'https://dav.example.com/dav',
  davUser: 'me@example.com',
  davPass: 'app-pass',
  davDir: '知页',
  davLimitMB: 50,
  davAuto: true,
};

function pageRecord(url, answer, updated) {
  return { version: 1, url, title: `标题 ${url}`, page: { host: 'tieba.baidu.com' }, turns: [{ question: '', answer, complete: true }], updated };
}

test('pushOne writes one file under the device folder and registers it in index', async () => {
  const server = installServer();
  installStorage({});
  const cloudsync = await import('../lib/cloudsync.js');
  const cfg = await cloudsync.saveConfig(BASE);
  const key = `reader-page:v1:https://tieba.baidu.com/p/1`;
  await globalThis.chrome.storage.local.set({ [key]: pageRecord(key.slice(17), '答', 1000) });

  const result = await cloudsync.pushOne(cfg, key);
  assert.equal(result.uploaded, 1);

  const device = (await cloudsync.getConfig()).davDeviceId;
  assert.match(device, /^chrome-[0-9a-f]{6}$/);

  const puts = server.calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.filter((c) => c.path.endsWith('.json') && !c.path.endsWith('index.json')).length, 1);
  assert.ok(puts.some((c) => c.path === `/dav/知页/${device}/index.json`) === false);
  assert.ok(puts.some((c) => c.path === '/dav/知页/index.json'));

  const index = JSON.parse(server.files.get('/dav/知页/index.json'));
  const hashes = Object.keys(index.files);
  assert.equal(hashes.length, 1);
  assert.equal(index.version, 2);
  const entry = cloudsync.entryOf(index, hashes[0]);
  assert.equal(entry.device, device);
  assert.ok(entry.size > 0);
  // v2 起索引里不再保存记录 key：每次上传都要重写整份索引，key 是最长的字段。
  assert.equal(JSON.stringify(index).includes('tieba.baidu.com'), false);
});

test('pushing the same record twice overwrites instead of duplicating', async () => {
  const server = installServer();
  installStorage({});
  const cloudsync = await import('../lib/cloudsync.js');
  const cfg = await cloudsync.saveConfig(BASE);
  const key = 'reader-page:v1:https://zhuanlan.zhihu.com/p/2';
  await globalThis.chrome.storage.local.set({ [key]: pageRecord(key.slice(17), '一', 2000) });
  await cloudsync.pushOne(cfg, key);
  await globalThis.chrome.storage.local.set({ [key]: pageRecord(key.slice(17), '二', 3000) });
  await cloudsync.pushOne(cfg, key);

  const index = JSON.parse(server.files.get('/dav/知页/index.json'));
  assert.equal(Object.keys(index.files).length, 1);
  const [hash] = Object.keys(index.files);
  const stored = JSON.parse([...server.files.entries()].find(([path]) => path.endsWith(`${hash}.json`))[1]);
  assert.equal(stored.record.turns[0].answer, '二');
});

test('over the byte limit the oldest record is deleted everywhere', async () => {
  const server = installServer();
  installStorage({});
  const cloudsync = await import('../lib/cloudsync.js');
  const cfg = await cloudsync.saveConfig({ ...BASE, davLimitMB: 0.0007 }); // 约 734 字节
  const older = 'reader-page:v1:https://tieba.baidu.com/p/old';
  const newer = 'reader-page:v1:https://tieba.baidu.com/p/new';
  await globalThis.chrome.storage.local.set({
    [older]: pageRecord(older.slice(17), '旧记录'.repeat(30), 1000),
    [newer]: pageRecord(newer.slice(17), '新记录'.repeat(30), 9000),
  });
  await cloudsync.pushOne(cfg, older);
  const result = await cloudsync.pushOne(cfg, newer);

  assert.equal(result.uploaded, 1);
  assert.deepEqual(result.removed, [older]);

  const index = JSON.parse(server.files.get('/dav/知页/index.json'));
  assert.equal(Object.keys(index.files).length, 1);
  assert.ok(index.deleted[older] > 0);
  const left = await globalThis.chrome.storage.local.get(null);
  assert.ok(!(older in left), '本地旧记录也要删');
  assert.ok(newer in left);
});

test('sync pulls records this browser never had', async () => {
  const server = installServer();
  installStorage({});
  const cloudsync = await import('../lib/cloudsync.js');
  const cfg = await cloudsync.saveConfig(BASE);

  // 假装另一个浏览器早就传过一条
  const foreignKey = 'reader-page:v1:https://github.com/a/b';
  const foreign = pageRecord(foreignKey.slice(17), '别的浏览器存的', 5000);
  const body = JSON.stringify({ kind: 'page', key: foreignKey, record: foreign });
  server.files.set(`/dav/知页/edge-aaaaaa/${await cloudsync.sha1(foreignKey)}.json`, body);
  server.files.set(
    '/dav/知页/index.json',
    JSON.stringify({
      version: 1,
      limitBytes: 52428800,
      files: { [await cloudsync.sha1(foreignKey)]: { key: foreignKey, kind: 'page', updated: 5000, size: body.length, device: 'edge-aaaaaa' } },
      deleted: {},
      totalBytes: body.length,
      updated: 5000,
    })
  );

  const result = await cloudsync.sync(cfg);
  assert.equal(result.downloaded, 1);
  const local = await globalThis.chrome.storage.local.get(foreignKey);
  assert.equal(local[foreignKey].turns[0].answer, '别的浏览器存的');
});

test('a tombstone removes the record on the next sync', async () => {
  const server = installServer();
  const key = 'reader-page:v1:https://www.zhihu.com/question/9';
  const local = installStorage({ [key]: pageRecord(key.slice(17), '该删了', 1000) });
  const cloudsync = await import('../lib/cloudsync.js');
  const cfg = await cloudsync.saveConfig(BASE);
  await cloudsync.ensureDevice(cfg);

  server.files.set(
    '/dav/知页/index.json',
    JSON.stringify({ version: 1, limitBytes: 52428800, files: {}, deleted: { [key]: 2000 }, totalBytes: 0, updated: 2000 })
  );

  await cloudsync.sync(cfg);
  assert.ok(!(key in local), '墓碑时间比记录新，本地就该删');
});

test('deleteEverywhere removes the cloud file and leaves a tombstone', async () => {
  const server = installServer();
  installStorage({});
  const cloudsync = await import('../lib/cloudsync.js');
  const cfg = await cloudsync.saveConfig(BASE);
  const key = 'reader-page:v1:https://csdn.net/a/1';
  await globalThis.chrome.storage.local.set({ [key]: pageRecord(key.slice(17), '删我', 4000) });
  await cloudsync.pushOne(cfg, key);

  const before = JSON.parse(server.files.get('/dav/知页/index.json'));
  const hash = Object.keys(before.files)[0];
  const filePath = [...server.files.keys()].find((path) => path.endsWith(`${hash}.json`));
  assert.ok(filePath);

  await cloudsync.deleteEverywhere(cfg, key);
  assert.ok(!server.files.has(filePath));
  const after = JSON.parse(server.files.get('/dav/知页/index.json'));
  assert.equal(Object.keys(after.files).length, 0);
  assert.ok(after.deleted[key] > 0);
  const left = await globalThis.chrome.storage.local.get(key);
  assert.equal(left[key], undefined);
});

test('pushOne refuses to resurrect a record deleted in the cloud', async () => {
  installServer();
  installStorage({});
  const cloudsync = await import('../lib/cloudsync.js');
  const cfg = await cloudsync.saveConfig(BASE);
  const key = 'reader-page:v1:https://tieba.baidu.com/p/gone';
  await globalThis.chrome.storage.local.set({ [key]: pageRecord(key.slice(17), '别传', 1000) });
  await cloudsync.saveConfig({ cloudDeleted: {} });

  const { files } = installServer();
  await cloudsync.ensureDevice(cfg);
  const index = { version: 1, limitBytes: 52428800, files: {}, deleted: { [key]: 5000 }, totalBytes: 0, updated: 5000 };
  files.set('/dav/知页/index.json', JSON.stringify(index));

  const result = await cloudsync.pushOne(await cloudsync.getConfig(), key);
  assert.equal(result.uploaded, 0);
  assert.equal(result.skipped, '已删除');
});

test('a v2 index without keys still pulls a record by reading its file', async () => {
  const server = installServer();
  installStorage({});
  const cloudsync = await import('../lib/cloudsync.js');
  const cfg = await cloudsync.saveConfig(BASE);
  const key = 'reader-page:v1:https://example.com/v2-index';
  const record = pageRecord(key.slice(17), '新索引里没有 key 也要能拉回来', 7000);
  const body = JSON.stringify({ kind: 'page', key, record });
  const hash = await cloudsync.sha1(key);
  server.files.set(`/dav/知页/edge-bbbbbb/${hash}.json`, body);
  server.files.set(
    '/dav/知页/index.json',
    JSON.stringify({
      version: 2,
      limitBytes: 209715200,
      devices: ['edge-bbbbbb'],
      files: { [hash]: [7000, body.length, 0] },
      deleted: {},
      totalBytes: body.length,
      updated: 7000,
    })
  );

  const result = await cloudsync.sync(cfg);
  assert.equal(result.downloaded, 1);
  const local = await globalThis.chrome.storage.local.get(key);
  assert.equal(local[key].turns[0].answer, '新索引里没有 key 也要能拉回来');
});

test('the default ceiling is 200 MB and the picker offers bigger sizes', async () => {
  installStorage({});
  const cloudsync = await import('../lib/cloudsync.js');
  assert.equal((await cloudsync.getConfig()).davLimitMB, 200);

  const html = readFileSync(new URL('../options/options.html', import.meta.url), 'utf8');
  // 只看上限那个 select，别把“最近 20 轮”历史选项当成上限档位
  const at = html.indexOf('id="davLimitMB"');
  assert.ok(at > 0, '设置页应该有上限下拉');
  const picker = html.slice(at, html.indexOf('</select>', at));
  assert.ok(picker.includes('value="200" selected'), '默认选 200 MB');
  assert.ok(picker.includes('value="500"'));
  assert.ok(picker.includes('value="1000"'));
  assert.equal(picker.includes('<option value="20">'), false, '20 MB 太小，已经下架');
});
