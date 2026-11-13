// 坚果云（任意 WebDAV）增量同步。
// 规则：
//   · 每个浏览器一个子目录，自己只写自己的目录，别人的文件只读不覆盖。
//   · 全局 index.json 记录所有文件的归属、时间与总字节，避免每次列目录。
//   · 单条记录一个文件，改一条只传一条，不整包重传。
//   · 超过上限按“最久没动过”先删，删掉的 key 进墓碑表，避免别的浏览器下次又传回来。
//
// 索引从 v1 起不再保存记录 key：key 是整条记录里最长的字段（网页 URL 动辄一百多字符），
// 而每次上传都要把整个 index.json 重写一遍，key 就是流量的主要来源。
// 现在 index.files[hash] = [updated, size, deviceIndex]，需要 key 的时候从记录文件里读回来。

import * as dav from './webdav.js';

export const CLOUD_LOCAL_KEY = 'cloud';
export const PAGE_PREFIX = 'reader-page:v1:';
export const VIDEO_PREFIX = 'video-memory:';

export const CLOUD_DEFAULTS = {
  davUrl: 'https://dav.jianguoyun.com/dav/',
  davUser: '',
  davPass: '',
  davDir: '知页',
  davDevice: '',
  davDeviceId: '',
  davLimitMB: 200,
  davAuto: true,
};

const INDEX_FILE = 'index.json';
const INDEX_VERSION = 2;
const MAX_TOMBSTONES = 400;

function storage() {
  return chrome.storage.local;
}

export async function getConfig() {
  const raw = (await storage().get({ [CLOUD_LOCAL_KEY]: {} }))[CLOUD_LOCAL_KEY] || {};
  const cfg = { ...CLOUD_DEFAULTS, ...raw };
  cfg.davLimitMB = Number(cfg.davLimitMB) > 0 ? Number(cfg.davLimitMB) : CLOUD_DEFAULTS.davLimitMB;
  return cfg;
}

export async function saveConfig(patch) {
  const next = { ...(await getConfig()), ...patch };
  await storage().set({ [CLOUD_LOCAL_KEY]: next });
  return next;
}

export async function getStatus() {
  const raw = (await storage().get({ cloudStatus: null })).cloudStatus;
  return raw || { lastSync: 0, uploaded: 0, downloaded: 0, removed: 0, bytes: 0, error: '' };
}

export async function setStatus(patch) {
  const next = { ...(await getStatus()), ...patch };
  await storage().set({ cloudStatus: next });
  return next;
}

export function keyKind(key) {
  if (String(key).startsWith(PAGE_PREFIX)) return 'page';
  if (String(key).startsWith(VIDEO_PREFIX)) return 'video';
  return '';
}

export function sizeOf(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export async function sha1(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function browserSlug() {
  const ua = globalThis.navigator?.userAgent || '';
  if (/Edg\//.test(ua)) return 'edge';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'browser';
}

function randomTag() {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// 设备标识只从 storage 里取，只生成一次。
// 不信任调用方传进来的 cfg：旧 cfg 会让同一个浏览器反复生成新目录，云端就散成一堆废文件夹。
export async function ensureDevice(cfg) {
  const raw = ((await storage().get({ [CLOUD_LOCAL_KEY]: {} }))[CLOUD_LOCAL_KEY]) || {};
  const known = String(raw.davDeviceId || '');
  const label = String(raw.davDevice || cfg?.davDevice || `${browserSlug()} · 桌面`);
  if (known) {
    if (!raw.davDevice) await saveConfig({ davDevice: label });
    return { ...cfg, davDeviceId: known, davDevice: label };
  }
  const fresh = `${browserSlug()}-${randomTag()}`;
  await saveConfig({ davDeviceId: fresh, davDevice: label });
  return { ...cfg, davDeviceId: fresh, davDevice: label };
}

export function webdavConfig(cfg) {
  return {
    base: dav.normalizeBase(cfg.davUrl),
    user: String(cfg.davUser || '').trim(),
    password: String(cfg.davPass || ''),
  };
}

export function ready(cfg) {
  return Boolean(cfg?.davUser && cfg?.davPass && cfg?.davUrl);
}

function recordPath(cfg, deviceId, hash) {
  return dav.joinPath(cfg.davDir, deviceId, `${hash}.json`);
}

function indexPath(cfg) {
  return dav.joinPath(cfg.davDir, INDEX_FILE);
}

function emptyIndex(limitBytes) {
  return { version: INDEX_VERSION, limitBytes, devices: [], files: {}, deleted: {}, totalBytes: 0, updated: 0 };
}

// 设备名只在 devices 数组里存一份，条目里存下标。
function deviceIndex(index, name) {
  const id = String(name || '');
  index.devices = Array.isArray(index.devices) ? index.devices : [];
  let at = index.devices.indexOf(id);
  if (at < 0) {
    index.devices.push(id);
    at = index.devices.length - 1;
  }
  return at;
}

// 统一读出条目，屏蔽 v1（对象）与 v2（数组）两种形态。
export function entryOf(index, hash) {
  const raw = index?.files?.[hash];
  if (!raw) return null;
  if (Array.isArray(raw)) {
    return {
      hash,
      updated: Number(raw[0]) || 0,
      size: Number(raw[1]) || 0,
      device: index.devices?.[Number(raw[2]) || 0] || '',
    };
  }
  return {
    hash,
    updated: Number(raw.updated) || 0,
    size: Number(raw.size) || 0,
    device: raw.device || '',
    key: raw.key || '',
  };
}

export async function readIndex(cfg, signal) {
  const cfgdav = webdavConfig(cfg);
  const index = await dav.readJson(cfgdav, indexPath(cfg), signal);
  if (!index || typeof index !== 'object' || !index.files) {
    return emptyIndex(Math.round(cfg.davLimitMB * 1024 * 1024));
  }
  index.deleted = index.deleted || {};
  index.limitBytes = Math.round(cfg.davLimitMB * 1024 * 1024);
  if (index.version !== INDEX_VERSION) {
    // v1 的每个条目都带着 key，迁移时一次性用掉，之后 index 里不再有 key。
    const carry = new Map();
    const devices = [];
    const files = {};
    for (const [hash, entry] of Object.entries(index.files)) {
      if (!entry) continue;
      const id = String(entry.device || '');
      let at = devices.indexOf(id);
      if (at < 0) {
        devices.push(id);
        at = devices.length - 1;
      }
      files[hash] = [Number(entry.updated) || 0, Number(entry.size) || 0, at];
      if (entry.key) carry.set(hash, { key: entry.key, kind: entry.kind || keyKind(entry.key) });
    }
    index.version = INDEX_VERSION;
    index.devices = devices;
    index.files = files;
    index.carry = carry;
  }
  return index;
}

function entrySize(entry) {
  return Number(entry?.[1]) || 0;
}

function recalc(index) {
  let total = 0;
  for (const raw of Object.values(index.files)) {
    total += Array.isArray(raw) ? Number(raw[1]) || 0 : Number(raw?.size) || 0;
  }
  index.totalBytes = total;
  return index;
}

export async function writeIndex(cfg, index, signal) {
  recalc(index);
  index.updated = Date.now();
  delete index.carry;
  await dav.writeJson(webdavConfig(cfg), indexPath(cfg), index, signal);
  return index;
}

// 只收网页记录和视频记录，别的一概不碰。
export async function collectLocal() {
  const all = await storage().get(null);
  const items = [];
  for (const [key, value] of Object.entries(all)) {
    const kind = keyKind(key);
    if (!kind || !value || typeof value !== 'object') continue;
    const updated = Number(value.updated) || Number(value.created) || 0;
    items.push({ key, kind, record: value, updated });
  }
  return items;
}

// 本地记录的 hash → 条目，用来在不看 key 的情况下判断“这条我有没有、旧不旧”。
export async function hashLocal() {
  const map = new Map();
  for (const item of await collectLocal()) {
    map.set(await sha1(item.key), item);
  }
  return map;
}

function tombstone(index, key, when = Date.now()) {
  if (!key) return;
  index.deleted[key] = when;
  const keys = Object.keys(index.deleted);
  if (keys.length > MAX_TOMBSTONES) {
    keys
      .sort((a, b) => index.deleted[a] - index.deleted[b])
      .slice(0, keys.length - MAX_TOMBSTONES)
      .forEach((stale) => delete index.deleted[stale]);
  }
}

// 云端条目里没有 key，要写墓碑或删本地时得把记录读回来一次。
async function keyOfEntry(cfg, index, entry, signal) {
  const carried = index.carry?.get(entry.hash);
  if (carried?.key) return carried.key;
  try {
    const body = await dav.readJson(webdavConfig(cfg), recordPath(cfg, entry.device || cfg.davDeviceId, entry.hash), signal);
    return body?.key || '';
  } catch {
    return '';
  }
}

// 超限就从最旧的开始丢：先删云端文件，再写墓碑，最后删本地。
// localByHash 是 hashLocal() 的结果，删本地记录时要靠它反查 key。
export async function trimIndex(cfg, index, localByHash, signal) {
  const removed = [];
  recalc(index);
  if (index.totalBytes <= index.limitBytes) return removed;
  const victims = Object.keys(index.files)
    .map((hash) => entryOf(index, hash))
    .filter(Boolean)
    .sort((a, b) => a.updated - b.updated);
  for (const entry of victims) {
    if (index.totalBytes <= index.limitBytes) break;
    const local = localByHash.get(entry.hash);
    const key = local?.key || (await keyOfEntry(cfg, index, entry, signal));
    await dav
      .remove(webdavConfig(cfg), recordPath(cfg, entry.device || cfg.davDeviceId, entry.hash), signal)
      .catch(() => {});
    tombstone(index, key);
    index.totalBytes -= entry.size;
    delete index.files[entry.hash];
    index.carry?.delete(entry.hash);
    if (key) {
      removed.push(key);
      await storage().remove(key);
      localByHash.delete(entry.hash);
    }
  }
  return removed;
}

// 单条上传：一轮总结/追问刚写完就调它。
export async function pushOne(cfg, key, signal) {
  if (!ready(cfg)) throw new Error('还没填坚果云的账号和应用密码');
  const actual = await ensureDevice(cfg);
  const value = (await storage().get(key))[key];
  if (!value) return { uploaded: 0, skipped: '记录不在了' };
  const kind = keyKind(key);
  if (!kind) return { uploaded: 0, skipped: '不是记忆记录' };

  const index = await readIndex(actual, signal);
  const tomb = Number(index.deleted[key]) || 0;
  const updated = Number(value.updated) || Number(value.created) || Date.now();
  if (tomb && tomb >= updated) return { uploaded: 0, skipped: '已删除' };

  const hash = await sha1(key);
  const body = { kind, key, record: value };
  const size = sizeOf(body);
  await dav.ensureDir(webdavConfig(actual), dav.joinPath(actual.davDir, actual.davDeviceId), signal);
  await dav.writeJson(webdavConfig(actual), recordPath(actual, actual.davDeviceId, hash), body, signal);

  delete index.deleted[key];
  index.files[hash] = [updated, size, deviceIndex(index, actual.davDeviceId)];
  index.carry?.delete(hash);
  const removed = await trimIndex(actual, index, await hashLocal(), signal);
  await writeIndex(actual, index, signal);
  await setStatus({ lastSync: Date.now(), uploaded: 1, bytes: index.totalBytes, error: '' });
  return { uploaded: 1, bytes: index.totalBytes, removed };
}

// 双向整包同步：本地→云端补齐，云端→本地补回被删掉/换过浏览器的。
export async function sync(cfg, options = {}) {
  const { signal } = options;
  if (!ready(cfg)) throw new Error('还没填坚果云的账号和应用密码');
  const actual = await ensureDevice(cfg);
  const cfgdav = webdavConfig(actual);
  const index = await readIndex(actual, signal);
  const local = await collectLocal();
  const localByHash = new Map();
  for (const item of local) localByHash.set(await sha1(item.key), item);
  let uploaded = 0;
  let downloaded = 0;
  let removed = 0;
  let skipped = 0;

  await dav.ensureDir(cfgdav, dav.joinPath(actual.davDir), signal);
  await dav.ensureDir(cfgdav, dav.joinPath(actual.davDir, actual.davDeviceId), signal);

  // 1) 本地有、云端没有或更旧 → 上传
  for (const item of local) {
    const tomb = Number(index.deleted[item.key]) || 0;
    if (tomb && tomb >= item.updated) {
      await storage().remove(item.key);
      localByHash.delete(await sha1(item.key));
      skipped += 1;
      continue;
    }
    const hash = await sha1(item.key);
    const known = entryOf(index, hash);
    if (known && known.updated >= item.updated) continue;
    const body = { kind: item.kind, key: item.key, record: item.record };
    const size = sizeOf(body);
    await dav.writeJson(cfgdav, recordPath(actual, actual.davDeviceId, hash), body, signal);
    index.files[hash] = [item.updated, size, deviceIndex(index, actual.davDeviceId)];
    index.carry?.delete(hash);
    uploaded += 1;
  }

  // 2) 云端有、本地没有或更旧 → 下载（条目里没 key，从记录文件里读）
  for (const hash of Object.keys(index.files)) {
    const entry = entryOf(index, hash);
    if (!entry) continue;
    const mine = localByHash.get(hash);
    if (mine && mine.updated >= entry.updated) continue;
    let body;
    try {
      body = await dav.readJson(cfgdav, recordPath(actual, entry.device || actual.davDeviceId, hash), signal);
    } catch {
      continue;
    }
    const key = body?.key || index.carry?.get(hash)?.key;
    if (!key || !body?.record) continue;
    const tomb = Number(index.deleted[key]) || 0;
    if (tomb && tomb >= entry.updated) continue;
    await storage().set({ [key]: body.record });
    localByHash.set(hash, { key, kind: keyKind(key), record: body.record, updated: entry.updated });
    downloaded += 1;
  }

  // 3) 墓碑：本地还留着的，云端已判定删除
  for (const [key, when] of Object.entries(index.deleted)) {
    const value = (await storage().get(key))[key];
    if (!value) continue;
    const updated = Number(value.updated) || Number(value.created) || 0;
    if (Number(when) >= updated) {
      await storage().remove(key);
      localByHash.delete(await sha1(key));
      skipped += 1;
    }
  }

  // 4) 超限裁剪
  const trimmed = await trimIndex(actual, index, localByHash, signal);
  removed = trimmed.length;

  await writeIndex(actual, index, signal);
  const status = await setStatus({
    lastSync: Date.now(),
    uploaded,
    downloaded,
    removed,
    bytes: index.totalBytes,
    error: '',
  });
  return { ...status, uploaded, downloaded, removed, files: Object.keys(index.files).length };
}

// 记忆页「删除」：云端、墓碑、本地一起清，别的浏览器下次同步也会跟着删。
export async function deleteEverywhere(cfg, key, signal) {
  const actual = await ensureDevice(cfg);
  const index = await readIndex(actual, signal);
  const hash = await sha1(key);
  const entry = entryOf(index, hash);
  if (entry) {
    await dav
      .remove(webdavConfig(actual), recordPath(actual, entry.device || actual.davDeviceId, hash), signal)
      .catch(() => {});
    index.totalBytes -= entry.size;
    delete index.files[hash];
    index.carry?.delete(hash);
  }
  tombstone(index, key);
  await writeIndex(actual, index, signal);
  await storage().remove(key);
  return { deleted: key, bytes: index.totalBytes };
}

export async function testCloud(cfg, signal) {
  const actual = await ensureDevice(cfg);
  const cfgdav = webdavConfig(actual);
  await dav.ensureDir(cfgdav, dav.joinPath(actual.davDir), signal);
  const info = await dav.testConnection(cfgdav, signal);
  const index = await readIndex(actual, signal);
  return {
    ...info,
    device: actual.davDeviceId,
    folder: actual.davDir,
    files: Object.keys(index.files).length,
    bytes: index.totalBytes,
  };
}
