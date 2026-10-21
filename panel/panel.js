import { initChat } from './chat.js';
import { getSettings, saveSettings } from '../lib/llm.js';
import { renderMarkdown, escapeHtml as esc } from '../lib/markdown.js';

const $ = (id) => document.getElementById(id);

const el = {
  viewEmpty: $('view-empty'),
  viewVideo: $('view-video'),
  viewResult: $('view-result'),
  cover: $('cover'),
  title: $('v-title'),
  author: $('v-author'),
  stats: $('v-stats'),
  badges: $('v-badges'),
  btnCopyData: $('btn-copy-data'),
  notes: $('notes'),
  status: $('status'),
  output: $('output'),
  error: $('error'),
  styleSeg: $('style-seg'),
  btnGenerate: $('btn-generate'),
  btnCopy: $('btn-copy'),
  btnExport: $('btn-export'),
  btnStop: $('btn-stop'),
  btnRefresh: $('btn-refresh'),
  btnOptions: $('btn-options'),
};

const state = {
  tabId: null,
  video: null,
  style: 'standard',
  markdown: '',
  port: null,
  generating: false,
  renderTimer: null,
};

let collectEpoch = 0;
let lastUrl = '';
const chat = initChat({
  getContext: () => ({video:state.video, summary:state.markdown, generating:state.generating}),
  restoreSummary: summary => {
    if (!summary) return;
    state.markdown = summary; paint(false); show(el.viewResult,true);
    el.btnGenerate.textContent = '重新生成'; chat.update();
  },
  seek: time => { if (state.tabId) chrome.tabs.sendMessage(state.tabId,{type:'SEEK_VIDEO',time:tsToSec(time)}).catch(()=>{}); },
});

// ---------------------------------------------------------------- 工具

const show = (node, on = true) => node.classList.toggle('hidden', !on);

function setStatus(text, spinning = false) {
  if (!text) {
    show(el.status, false);
    return;
  }
  show(el.status, true);
  el.status.innerHTML = '';
  if (spinning) {
    const s = document.createElement('span');
    s.className = 'spinner';
    el.status.appendChild(s);
  }
  const t = document.createElement('span');
  t.textContent = text;
  el.status.appendChild(t);
}

function setError(html) {
  if (!html) {
    show(el.error, false);
    return;
  }
  show(el.error, true);
  el.error.innerHTML = html;
}

const fmtNum = (n) => {
  if (n == null || n === '') return '';
  const v = Number(String(n).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(v)) return String(n);
  if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return String(v);
};

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${p(h)}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
}

const tsToSec = (t) => {
  const parts = String(t).split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(t) || 0;
};

// ------------------------------------------------ Markdown（实现见 lib/markdown.js）

function paint(withCursor = false) {
  if (state.renderTimer) return;
  state.renderTimer = requestAnimationFrame(() => {
    state.renderTimer = null;
    el.output.innerHTML = renderMarkdown(state.markdown);
    if (withCursor) el.output.classList.add('cursor');
    else el.output.classList.remove('cursor');
  });
}

// ---------------------------------------------------------------- 采集

const SUPPORTED = /(^https?:\/\/[^/]*\.?bilibili\.com\/(video|list|bangumi\/play)\/)|(^https?:\/\/[^/]*\.?douyin\.com\/)/i;

async function collectFromActiveTab() {
  const epoch = ++collectEpoch;
  chat.abort();
  if (state.generating) {
    try { state.port?.postMessage({type:'abort'}); } catch { /* disconnected */ }
    finish('');
  }
  await chat.setVideo(null);
  if (epoch !== collectEpoch) return;
  state.video = null;
  setError('');
  show(el.viewResult, false);
  state.markdown = '';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (epoch !== collectEpoch) return;
  state.tabId = tab?.id ?? null;
  lastUrl = tab?.url || '';
  chat.update();

  if (!tab?.url || !SUPPORTED.test(tab.url)) {
    show(el.viewEmpty, true);
    show(el.viewVideo, false);
    setStatus('');
    return;
  }

  show(el.viewEmpty, false);
  show(el.viewVideo, true);
  setStatus('正在读取页面数据…', true);
  el.btnGenerate.disabled = true;

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'COLLECT_VIDEO' });
    if (epoch !== collectEpoch) return;
    if (!res?.ok) throw new Error(res?.error || '页面脚本没有响应');
    state.video = res.data;
    renderVideo(res.data);
    await chat.setVideo(res.data);
    if (epoch !== collectEpoch) return;
    chat.update();
    setStatus('');
    el.btnGenerate.disabled = false;
  } catch (err) {
    if (epoch !== collectEpoch) return;
    state.video = null;
    setStatus('');
    el.btnGenerate.disabled = true;
    setError(
      `读取失败：${esc(err?.message || err)}<br />如果是刚安装扩展，请在视频页按 <b>F5</b> 刷新一次再试。`
    );
  }
}

function renderVideo(v) {
  el.cover.src = v.cover || '';
  el.cover.onerror = () => {
    el.cover.src = '';
  };
  el.title.textContent = v.title || '（无标题）';
  el.author.textContent = [v.author, v.publishTime, v.duration ? fmtTime(v.duration) : '']
    .filter(Boolean)
    .join(' · ');

  const statParts = Object.entries(v.stats || {})
    .filter(([, val]) => val != null && val !== '')
    .map(([k, val]) => `${k} ${fmtNum(val)}`);
  el.stats.textContent = statParts.join('  ·  ');

  // 素材来源徽章
  const CHANNEL_LABEL = {
    'player/wbi/v2(签名)': '签名接口',
    'view/conclusion/get': 'B站官方文稿',
    'player/v2(未签名·低置信)': '未签名·低置信',
  };
  const badges = [];
  const s = v.sources || {};
  if (v.subtitleLines?.length) {
    const chan = v.subtitleChannel || '';
    const label = CHANNEL_LABEL[chan] || '';
    const low = chan.includes('未签名');
    badges.push(
      `<span class="badge ${low ? 'warn' : 'on'}"${low ? ' title="字幕来自无 WBI 签名的接口，可能被风控降级返回其它视频的字幕，请核对内容"' : ''}>` +
        `字幕 ${v.subtitleLines.length} 句${v.subtitleLang ? ` · ${esc(v.subtitleLang)}` : ''}${label ? ` · ${esc(label)}` : ''}</span>`
    );
  } else {
    badges.push('<span class="badge off">无字幕</span>');
  }
  if (v.danmaku?.length) badges.push(`<span class="badge on">弹幕采样 ${v.danmaku.length}</span>`);
  if (v.comments?.length) badges.push(`<span class="badge on">评论 ${v.comments.length}</span>`);
  if (v.desc) badges.push('<span class="badge">含文案</span>');
  if (v.hashtags?.length) badges.push(`<span class="badge">话题 ${v.hashtags.length}</span>`);
  el.badges.innerHTML = badges.join('');

  // 质量提示
  const notes = [...(v.notes || [])];
  if (s.subtitle && s.danmaku && s.comments) notes.unshift('素材完整度：佳（字幕 + 弹幕 + 评论）。');
  if (notes.length) {
    el.notes.innerHTML = notes.map((n) => `<p>· ${esc(n)}</p>`).join('');
    show(el.notes, true);
  } else {
    show(el.notes, false);
  }

  show(el.viewVideo, true);
}

// ---------------------------------------------------------------- 生成

function startGenerate() {
  if (!state.video || state.generating) return;

  chat.abort();
  state.generating = true;
  chat.update();
  state.markdown = '';
  el.output.innerHTML = '';
  setError('');
  show(el.viewResult, true);
  el.btnGenerate.disabled = true;
  show(el.btnStop, true);
  setStatus('正在请求 DeepSeek…', true);

  const port = chrome.runtime.connect({ name: 'summarize' });
  state.port = port;

  let firstChunk = false;
  const generationEpoch = collectEpoch;

  port.onMessage.addListener((msg) => {
    if (state.port !== port || generationEpoch !== collectEpoch) return;
    if (msg.type === 'thinking') {
      // deepseek-flash 默认开思考模式，正文到来前会先有一段推理
      if (!firstChunk) setStatus('模型正在思考…', true);
    } else if (msg.type === 'delta') {
      if (!firstChunk) {
        firstChunk = true;
        setStatus('正在生成…', true);
      }
      state.markdown = msg.full;
      paint(true);
    } else if (msg.type === 'done') {
      state.markdown = msg.full || state.markdown;
      paint(false);
      finish('总结完成');
    } else if (msg.type === 'aborted') {
      paint(false);
      finish('已停止');
    } else if (msg.type === 'error') {
      paint(false);
      finish('');
      handleGenError(msg.error);
    }
  });

  port.onDisconnect.addListener(() => {
    if (state.generating && state.port === port) { finish(''); setError('生成连接已中断，请重试。'); }
  });

  port.postMessage({ type: 'start', video: state.video, style: state.style });
}

function finish(statusText) {
  state.generating = false;
  el.btnGenerate.disabled = false;
  el.btnGenerate.textContent = state.markdown ? '重新生成' : '生成总结';
  show(el.btnStop, false);
  if (statusText) setStatus(statusText, false);
  else setStatus('');
  try {
    state.port?.disconnect();
  } catch {
    /* ignore */
  }
  state.port = null;
  chat.update();
  if (statusText === '总结完成') void chat.save();
}

function handleGenError(message) {
  const m = String(message || '');
  if (m.includes('NO_API_KEY')) {
    setError(
      '还没有配置 DeepSeek API Key。<br />点右上角 <b>⚙</b> 打开设置，填入 Key 即可（免费申请地址见设置页说明）。'
    );
    return;
  }
  if (/401|authentication|invalid.*key|api key/i.test(m)) {
    setError(`API Key 无效或已过期。请到设置页检查。<br /><span style="opacity:.7">${esc(m)}</span>`);
    return;
  }
  if (/402|insufficient|balance|余额/i.test(m)) {
    setError(`账户余额不足，请到 DeepSeek 充值后重试。<br /><span style="opacity:.7">${esc(m)}</span>`);
    return;
  }
  if (/429|rate/i.test(m)) {
    setError(`请求过于频繁，稍等几秒再试。<br /><span style="opacity:.7">${esc(m)}</span>`);
    return;
  }
  setError(`生成失败：${esc(m)}`);
}

// ---------------------------------------------------------------- 事件

el.btnGenerate.addEventListener('click', startGenerate);
el.btnRefresh.addEventListener('click', collectFromActiveTab);
el.btnOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

el.btnStop.addEventListener('click', () => {
  try {
    state.port?.postMessage({ type: 'abort' });
  } catch {
    /* ignore */
  }
  finish('已停止');
});

el.styleSeg.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-style]');
  if (!btn) return;
  state.style = btn.dataset.style;
  [...el.styleSeg.children].forEach((b) => b.classList.toggle('active', b === btn));
  await saveSettings({ style: state.style });
});

el.btnCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.markdown);
    el.btnCopy.textContent = '已复制';
    setTimeout(() => (el.btnCopy.textContent = '复制'), 1400);
  } catch {
    setError('复制失败，请手动选中内容复制。');
  }
});

// 把采集到的原始数据复制出去，交给 WorkBuddy Skill 复用
el.btnCopyData.addEventListener('click', async () => {
  if (!state.video) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(state.video, null, 2));
    el.btnCopyData.textContent = '✓ 已复制，可粘贴给 WorkBuddy';
    setTimeout(() => (el.btnCopyData.textContent = '⧉ 复制数据'), 2000);
  } catch {
    setError('复制失败，请检查剪贴板权限。');
  }
});

el.btnExport.addEventListener('click', () => {
  const v = state.video || {};
  const head = [
    `# ${v.title || '视频总结'}`,
    '',
    `> 来源：${v.url || ''}`,
    v.author ? `> 作者：${v.author}` : '',
    `> 生成时间：${new Date().toLocaleString('zh-CN')}`,
    `> 模型：${state.modelName || 'DeepSeek'}`,
    '',
    '---',
    '',
  ]
    .filter((x) => x !== '')
    .join('\n');

  const blob = new Blob([head + state.markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(v.title || '视频总结').replace(/[\\/:*?"<>|]/g, '_').slice(0, 50)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
});

// 点击时间戳跳转播放
el.output.addEventListener('click', (e) => {
  const btn = e.target.closest('.ts');
  if (!btn || !state.tabId) return;
  const sec = tsToSec(btn.dataset.t);
  chrome.tabs.sendMessage(state.tabId, { type: 'SEEK_VIDEO', time: sec }).catch(() => {});
});

// 键盘：Ctrl/Cmd + Enter 生成
document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('#chat-section')) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    startGenerate();
  }
});

// ---------------------------------------------------------------- 启动

(async () => {
  const settings = await getSettings();
  state.style = settings.style || 'standard';
  state.modelName = settings.model;
  [...el.styleSeg.children].forEach((b) =>
    b.classList.toggle('active', b.dataset.style === state.style)
  );

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.model) state.modelName = changes.model.newValue;
  });

  await collectFromActiveTab();

  // 页面切换/SPA 跳转后自动重新读取
  setInterval(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || tab.url === lastUrl) return;
    collectFromActiveTab();
  }, 1200);

  if (!settings.apiKey) {
    setError(
      '尚未配置 DeepSeek API Key。点右上角 <b>⚙</b> 填入后即可使用（<a href="#" id="go-opt">现在去设置</a>）。'
    );
    document.getElementById('go-opt')?.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  }
})();
