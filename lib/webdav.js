// 最小 WebDAV 客户端，只跑在 service worker 里。
// 为什么不能从侧栏/设置页直接 fetch：坚果云不给 Access-Control-Allow-Origin，
// 扩展页面的 fetch 会被浏览器当跨域请求拦掉；service worker 带 host 权限则不受 CORS 约束。

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop>
<d:resourcetype/><d:getcontentlength/><d:getlastmodified/>
</d:prop></d:propfind>`;

const TIMEOUT_MS = 20000;
const RETRY_DELAYS = [1000, 4000, 16000];

export function normalizeBase(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('WebDAV 地址是空的');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('WebDAV 地址不是合法网址');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('WebDAV 地址必须是 http 或 https');
  url.search = '';
  url.hash = '';
  let path = url.pathname || '/';
  if (!path.endsWith('/')) path += '/';
  url.pathname = path;
  return url.toString();
}

// 把若干路径段拼成 WebDAV 路径，逐段编码，保留分隔符。
export function joinPath(...parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && part !== '')
    .map((part) => String(part).split('/').filter(Boolean).map(encodeURIComponent).join('/'))
    .filter(Boolean)
    .join('/');
}

export function basicAuth(user, password) {
  const text = `${user}:${password}`;
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

const RE_RESPONSE = /<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi;
const RE_HREF = /<(?:[\w.-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?href>/i;
const RE_LENGTH = /<(?:[\w.-]+:)?getcontentlength\b[^>]*>(\d+)</i;
const RE_MODIFIED = /<(?:[\w.-]+:)?getlastmodified\b[^>]*>([^<]*)</i;
const RE_COLLECTION = /<(?:[\w.-]+:)?collection\b/i;

// service worker 里没有 DOMParser，PROPFIND 的 multistatus 只能自己拆。
export function parseMultistatus(xml) {
  const out = [];
  const text = String(xml || '');
  RE_RESPONSE.lastIndex = 0;
  let match;
  while ((match = RE_RESPONSE.exec(text))) {
    const chunk = match[1] || '';
    const hrefMatch = chunk.match(RE_HREF);
    if (!hrefMatch) continue;
    const href = decodeEntities(hrefMatch[1]).trim();
    const lengthMatch = chunk.match(RE_LENGTH);
    const modifiedMatch = chunk.match(RE_MODIFIED);
    out.push({
      href,
      path: safeDecode(href),
      name: lastSegment(href),
      dir: RE_COLLECTION.test(chunk),
      size: lengthMatch ? Number(lengthMatch[1]) : 0,
      modified: modifiedMatch ? Date.parse(modifiedMatch[1]) || 0 : 0,
    });
  }
  return out;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function lastSegment(href) {
  const clean = safeDecode(String(href || '')).replace(/\/+$/, '');
  const parts = clean.split('/');
  return parts[parts.length - 1] || '';
}

function authHeaders(cfg, extra) {
  return {
    Authorization: basicAuth(cfg.user, cfg.password),
    ...extra,
  };
}

function withTimeout(signalOuter) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), TIMEOUT_MS);
  if (signalOuter) {
    if (signalOuter.aborted) controller.abort(signalOuter.reason);
    else signalOuter.addEventListener('abort', () => controller.abort(signalOuter.reason), { once: true });
  }
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function shouldRetry(status) {
  return status === 429 || status === 503 || status === 502 || status === 500;
}

// cfg = { base, user, password }；path 是相对 base 的路径（不带前导斜杠）。
export async function request(cfg, method, path = '', options = {}) {
  if (!cfg?.base) throw new Error('还没配置 WebDAV 地址');
  // path 由调用方用 joinPath() 编好，这里只去掉前导斜杠，避免二次编码。
  const url = cfg.base + String(path || '').replace(/^\/+/, '');
  const { body, headers = {}, signal } = options;
  let lastError;

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
    const guard = withTimeout(signal);
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: authHeaders(cfg, headers),
        body,
        signal: guard.signal,
        redirect: 'follow',
        cache: 'no-store',
      });
    } catch (error) {
      guard.done();
      if (signal?.aborted) throw new Error('已取消');
      lastError = new Error(`连不上 WebDAV：${error?.message || error}`);
      if (attempt === RETRY_DELAYS.length) throw lastError;
      await sleep(RETRY_DELAYS[attempt]);
      continue;
    }
    guard.done();

    if (shouldRetry(response.status) && attempt < RETRY_DELAYS.length) {
      await sleep(RETRY_DELAYS[attempt]);
      continue;
    }

    const text = method === 'PROPFIND' || method === 'GET' ? await response.text() : await response.text().catch(() => '');
    if (response.status === 401) throw new Error('坚果云拒绝了账号或应用密码（401）');
    if (response.status === 403) throw new Error('这个应用密码没有权限（403）');
    if (response.status === 429) throw new Error('坚果云限流了，等几分钟再试（429）');
    if (response.status === 503) throw new Error('坚果云暂时不可用或请求太频繁（503）');
    if (!response.ok) {
      const snippet = String(text || '').slice(0, 120).replace(/\s+/g, ' ');
      throw new Error(`${method} ${path || '/'} 失败：${response.status}${snippet ? ` · ${snippet}` : ''}`);
    }
    return { status: response.status, text, headers: response.headers };
  }
  throw lastError || new Error('WebDAV 请求失败');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function list(cfg, path = '', signal) {
  const { text } = await request(cfg, 'PROPFIND', path, {
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    body: PROPFIND_BODY,
    signal,
  });
  return parseMultistatus(text);
}

export async function readJson(cfg, path, signal) {
  try {
    const { text } = await request(cfg, 'GET', path, { signal });
    return JSON.parse(text);
  } catch (error) {
    if (/404/.test(error?.message || '')) return null;
    // 空文件或被截断的 JSON 当作没有，不阻塞同步。
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeJson(cfg, path, value, signal) {
  const body = JSON.stringify(value);
  await request(cfg, 'PUT', path, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body,
    signal,
  });
  return body.length;
}

// MKCOL 已存在会回 405，当成成功。
export async function ensureDir(cfg, path, signal) {
  try {
    await request(cfg, 'MKCOL', path, { signal });
  } catch (error) {
    if (/405/.test(error?.message || '') || /409/.test(error?.message || '')) return;
    throw error;
  }
}

export async function remove(cfg, path, signal) {
  try {
    await request(cfg, 'DELETE', path, { signal });
  } catch (error) {
    if (/404/.test(error?.message || '')) return;
    throw error;
  }
}

export async function testConnection(cfg, signal) {
  const items = await list(cfg, '', signal);
  return {
    ok: true,
    entries: items.filter((item) => item.name).length,
    reachable: true,
  };
}
