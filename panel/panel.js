import {getMemory,downloadMemory} from '../lib/archive.js';
import { initControls } from './controls.js';
import { initChat } from './chat.js';
import { getSettings, saveSettings } from '../lib/llm.js';
import { renderMarkdown, escapeHtml as esc } from '../lib/markdown.js';

const $ = (id) => document.getElementById(id);
const archiveId=new URLSearchParams(location.search).get('memory');
let memoryOpen=false,memoryLoaded=false;
const memoryFrame=$('memory-frame');
function sendLiveSession(){if(memoryLoaded)memoryFrame.contentWindow.postMessage({type:'current-session',id:chat.snapshot().id},location.origin);}
function closeMemory(){memoryOpen=false;$('memory-layer').classList.add('hidden');el.btnRefresh.disabled=false;$('btn-memory').setAttribute('aria-pressed','false');$('btn-memory').textContent='▤';$('btn-memory').title='查看和下载历史记忆';$('btn-memory').setAttribute('aria-label','查看和下载历史记忆');}
async function openMemory(){
  if(archiveId){window.parent.postMessage({type:'archive-back'},location.origin);return;}
  if(memoryOpen){closeMemory();return;}
  await chat.save();
  memoryOpen=true;$('memory-layer').style.top=document.querySelector('.topbar').getBoundingClientRect().bottom+'px';$('memory-layer').classList.remove('hidden');el.btnRefresh.disabled=true;$('btn-memory').setAttribute('aria-pressed','true');
  $('btn-memory').textContent='↩';$('btn-memory').title='返回本视频，生成任务保持运行';$('btn-memory').setAttribute('aria-label','返回本视频');
  if(!memoryLoaded){memoryLoaded=true;memoryFrame.src=chrome.runtime.getURL('memory/memory.html')+'?sidebar=1';}else sendLiveSession();
}
$('btn-memory').addEventListener('click',()=>void openMemory());
$('btn-archive-back').addEventListener('click',()=>window.parent.postMessage({type:'archive-back'},location.origin));
memoryFrame.addEventListener('load',sendLiveSession);
window.addEventListener('message',event=>{if(event.origin!==location.origin || event.source!==memoryFrame.contentWindow)return;if(event.data?.type==='memory-ready')sendLiveSession();if(['memory-close','memory-open-live'].includes(event.data?.type))closeMemory();});
window.addEventListener('resize',()=>{if(memoryOpen)$('memory-layer').style.top=document.querySelector('.topbar').getBoundingClientRect().bottom+'px';});
void initControls();

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
  summaryTrace: [],
};

let collectEpoch = 0;
let lastUrl = '';
const chat = initChat({
  getContext: () => ({video:state.video, summary:state.markdown, generating:state.generating, tabId:state.tabId, model:state.modelName, summaryTrace:state.summaryTrace,summaryPending:state.archiveSummaryPending}),
  restoreSummary: (summary,record) => {
    if(record){
      state.summaryTrace=record.summaryTrace || [];state.archiveSummaryPending=!!record.summaryPending;
      show($('btn-summary-continue'),!!record.summaryPending && !!summary);
      if(record.summaryPending)setStatus('上次切换页面时总结未完成；已恢复收到的内容。');
    }
    if (!summary) return;
    state.markdown = summary; paint(false); show(el.viewResult,true);
    el.btnGenerate.textContent = '重新生成'; chat.update();
  },
  seek: time => { if (state.tabId) chrome.tabs.sendMessage(state.tabId,{type:'SEEK_VIDEO',time:tsToSec(time)}).catch(()=>{}); },
});

// The router waits for this acknowledgement before destroying the video iframe.
window.addEventListener('message',event=>{
  if(event.source!==window.parent||event.origin!==location.origin||event.data?.type!=='route-away')return;
  (async()=>{
    if(state.generating){
      state.archiveSummaryPending=true;
      try{state.port?.postMessage({type:'abort'});}catch{}
      finish('已切换页面；总结未完成，已保存收到的内容。');
    }
    if(chat.isBusy())chat.abort();
    try{await chat.save();uploadRecord();}
    finally{window.parent.postMessage({type:'route-away-done',token:event.data.token},location.origin);}
  })();
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
  state.summaryTrace=[];state.archiveSummaryPending=false;
  show($('btn-summary-continue'),false);

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
    el.cover.onerror=null;el.cover.removeAttribute('src');el.cover.hidden=true;
  };
  el.cover.hidden=!v.cover;
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
  if (!state.video || state.video.archived || state.generating) return;

  chat.abort();
  state.generating = true;
  chat.update();
  state.markdown = '';
  state.summaryTrace=[{at:Date.now(),text:'开始根据视频素材生成总结'}];
  state.archiveSummaryPending=false;
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
      if (!firstChunk) {setStatus('模型正在思考…', true);if(state.summaryTrace.at(-1)?.text!=='模型正在分析素材')state.summaryTrace.push({at:Date.now(),text:'模型正在分析素材'});}
    } else if (msg.type === 'delta') {
      if (!firstChunk) {
        firstChunk = true;
        state.summaryTrace.push({at:Date.now(),text:'开始输出视频总结'});
        setStatus('正在生成…', true);
      }
      state.markdown = msg.full;
      paint(true);
    } else if (msg.type === 'done') {
      show($('btn-summary-continue'),!!msg.truncated);
      state.markdown = msg.full || state.markdown;
      paint(false);
      finish(msg.truncated ? '已达到输出上限，可在追问中要求继续补完。' : '总结完成');
      if (msg.truncated) void chat.save();
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

/** 记忆记录写进本地之后，立刻把这一条推到坚果云 */
function uploadRecord() {
  try {
    const record = chat.snapshot();
    if (!record?.memoryId) return;
    chrome.runtime
      .sendMessage({ type: 'CLOUD_PUT', key: `video-memory:${record.memoryId}` })
      .then((res) => {
        if (res && res.ok === false) console.warn('[知页] 云同步失败', res.error);
      })
      .catch((error) => console.warn('[知页] 云同步失败', error));
  } catch (error) {
    console.warn('[知页] 云同步失败', error);
  }
}

function finish(statusText) {
  state.generating = false;
  if(state.summaryTrace.length)state.summaryTrace.push({at:Date.now(),text:statusText || '生成中断'});
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
  if (statusText === '总结完成') {
    void chat.save().then(() => uploadRecord());
  }
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

el.btnExport.addEventListener('click', () => {downloadMemory([chat.snapshot()],'md');});

// 点击时间戳跳转播放
el.output.addEventListener('click', (e) => {
  const btn = e.target.closest('.ts');
  if (!btn || !state.tabId) return;
  const sec = tsToSec(btn.dataset.t);
  chrome.tabs.sendMessage(state.tabId, { type: 'SEEK_VIDEO', time: sec }).catch(() => {});
});

// 键盘：Ctrl/Cmd + Enter 生成
document.addEventListener('keydown', (e) => {
  if(memoryOpen || archiveId)return;
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

  if(archiveId){
    document.body.classList.add('archive-mode');show($('archive-banner'),true);
    try{
      const record=await getMemory(archiveId);if(!record)throw new Error('找不到这条记忆；请返回记忆列表刷新。');
      state.video={...record.video,archived:true};state.markdown=record.summary;state.summaryTrace=record.summaryTrace || [];state.archiveSummaryPending=record.summaryPending;state.modelName=record.model || settings.model;
      $('archive-title').textContent=record.video.title;renderVideo(state.video);show(el.viewEmpty,false);show(el.viewResult,true);
      await chat.loadRecord(record);paint(false);
    }catch(error){setError(esc(error.message || error));}
    return;
  }
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
