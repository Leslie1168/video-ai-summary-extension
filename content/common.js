/**
 * 内容脚本公共工具（classic script，挂到 window.__VB 上供同帧其它脚本使用）
 */
(() => {
  if (window.__VB) return;

  const VB = {};

  /** 协议相对 URL 补全 */
  VB.absUrl = (u) => {
    if (!u) return '';
    if (u.startsWith('//')) return 'https:' + u;
    if (u.startsWith('http')) return u;
    return u;
  };

  VB.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  VB.fmtTime = (sec) => {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
  };

  VB.cleanText = (t) =>
    String(t || '')
      .replace(/\u200b/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  /** 带 cookie 的 JSON 请求 */
  VB.fetchJson = async (url, { timeout = 15000 } = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        credentials: 'include',
        signal: ctrl.signal,
        headers: { Accept: 'application/json, text/plain, */*' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };

  /** 带 cookie 的文本请求（弹幕 XML 等） */
  VB.fetchText = async (url, { timeout = 15000 } = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { credentials: 'include', signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  };

  /** 解析弹幕 XML -> 文本数组 */
  VB.parseDanmakuXml = (xml) => {
    const out = [];
    const re = /<d\s+p="[^"]*">([\s\S]*?)<\/d>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const t = VB.cleanText(decodeXml(m[1]));
      if (t) out.push(t);
    }
    return out;
  };

  const decodeXml = (s) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');

  VB.decodeXml = decodeXml;

  /** 均匀采样，保留首尾与分布 */
  VB.sampleEven = (arr, n) => {
    if (!Array.isArray(arr) || arr.length <= n) return arr || [];
    const step = arr.length / n;
    const out = [];
    for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
    return out;
  };

  /** 过滤低信息量弹幕 */
  VB.filterNoise = (list) => {
    const noise = /^(哈+|6+|前+|awsl|来了|打卡|前排|火钳|沙发|沙发|顶|1|2|3|。|，|\?|！)$/i;
    return list.filter((t) => t.length >= 2 && !noise.test(t));
  };

  /** 从字幕轨列表里挑一条最合适的中文轨 */
  VB.pickSubtitle = (subs) => {
    if (!Array.isArray(subs) || !subs.length) return null;
    const score = (s) => {
      const lan = String(s.lan || '');
      let v = 0;
      if (lan === 'zh-Hans' || lan === 'zh-CN') v += 100;
      if (lan === 'ai-zh') v += 90;
      if (lan.startsWith('zh')) v += 60;
      if (lan === 'ai-en') v += 10;
      return v;
    };
    return [...subs].sort((a, b) => score(b) - score(a))[0];
  };

  /** B站字幕 JSON -> 行数组 */
  VB.parseBiliSubtitle = (json) =>
    (json?.body || [])
      .map((x) => ({ from: x.from, to: x.to, text: VB.cleanText(x.content) }))
      .filter((x) => x.text);

  /** WebVTT / SRT 文本 -> 行数组 */
  VB.parseVtt = (text) => {
    const src = String(text || '').replace(/\r/g, '');
    const lines = [];
    const blocks = src.split(/\n{2,}/);
    const toSec = (ts) => {
      const m = ts.match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
      if (!m) return 0;
      return (
        Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000
      );
    };
    for (const block of blocks) {
      const rows = block.split('\n').filter(Boolean);
      const timeIdx = rows.findIndex((r) => r.includes('-->'));
      if (timeIdx < 0) continue;
      const [a, b] = rows[timeIdx].split('-->');
      const content = VB.cleanText(rows.slice(timeIdx + 1).join(' '));
      if (!content || /^WEBVTT/i.test(content)) continue;
      lines.push({ from: toSec(a), to: toSec(b), text: content });
    }
    return lines;
  };

  /** 行数组 -> 纯文本 */
  VB.linesToText = (lines) => (lines || []).map((l) => l.text).join('\n');

  /** DOM 文本安全取值 */
  VB.textOf = (root, selectors) => {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        const t = VB.cleanText(el?.textContent);
        if (t) return t;
      } catch {
        /* 选择器非法 */
      }
    }
    return '';
  };

  /** 等待某个选择器出现 */
  VB.waitFor = async (selectors, timeout = 8000, interval = 250) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el) return el;
        } catch {
          /* ignore */
        }
      }
      await VB.sleep(interval);
    }
    return null;
  };

  /** 统一的视频数据收集消息通道 */
  VB.respond = (handler) => {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === 'PING_TAB') {
        sendResponse({ ok: true, platform: VB.PLATFORM });
        return false;
      }
      if (msg?.type === 'COLLECT_VIDEO') {
        handler()
          .then((data) => sendResponse({ ok: true, data }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
      }
      if (msg?.type === 'SEEK_VIDEO') {
        try {
          const v = document.querySelector('video');
          if (v && Number.isFinite(msg.time)) {
            v.currentTime = msg.time;
            v.play?.().catch(() => {});
          }
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return false;
      }
      return false;
    });
  };

  window.__VB = VB;
})();
