import { getSettings } from '../lib/llm.js';
import { renderMarkdown } from '../lib/markdown.js';
import { SEARCH_ORIGINS, safeSource } from '../lib/search.js';

const $ = id => document.getElementById(id);
// Keep the original summary renderer intact; sanitize its HTML on the new chat surface.
export function renderChatMarkdown(markdown) {
  const template = document.createElement('template');
  template.innerHTML = renderMarkdown(markdown);
  const allowed = new Set(['P','H1','H2','H3','H4','H5','H6','STRONG','EM','BLOCKQUOTE','UL','OL','LI','HR','CODE','BUTTON','A']);
  for (const node of template.content.querySelectorAll('*')) {
    if (!allowed.has(node.tagName)) { node.replaceWith(document.createTextNode(node.textContent || '')); continue; }
    const href = node.getAttribute('href'), time = node.dataset.t;
    for (const attr of [...node.attributes]) node.removeAttribute(attr.name);
    if (node.tagName === 'A') {
      const source = safeSource({url:href});
      if (!source) { node.replaceWith(document.createTextNode(node.textContent || '')); continue; }
      node.href=source.url; node.target='_blank'; node.rel='noopener noreferrer';
    }
    if (node.tagName === 'BUTTON') {
      if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(time || '')) { node.replaceWith(document.createTextNode(node.textContent || '')); continue; }
      node.type='button'; node.className='ts'; node.dataset.t=time;
    }
  }
  return template.innerHTML;
}
export function initChat({getContext, restoreSummary, seek}) {
  let turns = [], web = false, busy = false, port = null, key = '', epoch = 0, timer = null;
  let heartbeat = null;
  let backgroundOk = null;
  const scroller = $('summary-main');
  const list = $('chat-messages'), input = $('chat-input'), status = $('chat-status');
  const toggle = $('btn-web'), send = $('btn-send'), stop = $('btn-chat-stop');
  const placeholder = $('chat-placeholder');
  const cacheKey = () => `video-chat:${key}`;
  const ready = () => !!getContext().video && !!getContext().summary && !getContext().generating;
  function update() {
    send.disabled = busy || !ready() || !input.value.trim();
    input.disabled = !ready();
    toggle.disabled = busy || !ready();
    $('btn-chat-clear').disabled = busy || !turns.length;
    stop.classList.toggle('hidden', !busy);
    send.classList.toggle('hidden', busy);
    toggle.setAttribute('aria-pressed', String(web));
    toggle.classList.toggle('active', web);
    $('chat-scope').textContent = web ? '视频 + 网页资料' : '仅依据本视频';
    input.placeholder = ready() ? '继续追问这个视频…' : '生成总结后，就可以开始提问';
    placeholder.classList.toggle('hidden', turns.length > 0 || !ready());
  }
  const warning = $('bg-warning');
  function setBackgroundWarning(show) {
    backgroundOk = !show;
    warning?.classList.toggle('hidden', !show);
  }
  // 侧边栏的页面资源每次打开都会从磁盘重新读取，但扩展的 Service Worker
  // 只有在「重新加载扩展」之后才会更新。更新扩展文件后若不重新加载，
  // 面板是新版、后台还是旧版：连接能建立，可旧后台没有 video-chat 监听器，
  // 消息石沉大海，输入框就会永远停在“正在准备回答…”。
  // 所以这里先探活，失败就直接告诉用户怎么修，而不是让追问无声卡死。
  async function probeBackground() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await new Promise((resolve) => {
        let probePort = null;
        let settled = false;
        const done = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { probePort?.disconnect(); } catch { /* 已断开 */ }
          resolve(value);
        };
        const timer = setTimeout(() => done({ ok: false, reason: 'timeout' }), attempt === 0 ? 1500 : 4000);
        try {
          probePort = chrome.runtime.connect({ name: 'video-chat' });
        } catch (err) {
          clearTimeout(timer);
          resolve({ ok: false, reason: 'connect', error: String(err) });
          return;
        }
        probePort.onMessage.addListener((msg) => {
          if (msg?.type === 'pong') done({ ok: true, version: msg.version });
        });
        probePort.onDisconnect.addListener(() => done({ ok: false, reason: 'disconnected' }));
        try { probePort.postMessage({ type: 'ping' }); } catch (err) { done({ ok: false, reason: 'post', error: String(err) }); }
      });
      if (result.ok) {
        const manifestVersion = chrome.runtime.getManifest().version;
        if (result.version && result.version !== manifestVersion) {
          status.textContent = `后台脚本版本 ${result.version} 与当前扩展 ${manifestVersion} 不一致。`;
          setBackgroundWarning(true);
          return;
        }
        setBackgroundWarning(false);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    setBackgroundWarning(true);
  }
  const trimCache = async (area) => {
    const all = await area.get(null);
    const older = Object.keys(all).filter(k => k.startsWith('video-chat:'))
      .sort((a,b) => (all[b]?.updated || 0) - (all[a]?.updated || 0)).slice(10);
    if (older.length) await area.remove(older);
  };
  async function save() {
    if (!key) return;
    const itemKey = cacheKey();
    const snapshot = {summary:getContext().summary, turns:turns.slice(-30), updated:Date.now()};
    try {
      // storage.session 只存活于当前浏览器会话，而且「重新加载扩展」会清空它；
      // 再写一份 local，既能在重载扩展后恢复总结/对话，也能在下次打开同一视频时恢复。
      await Promise.all([
        chrome.storage.session.set({[itemKey]:snapshot}),
        chrome.storage.local.set({[itemKey]:snapshot}),
      ]);
      await Promise.all([trimCache(chrome.storage.session), trimCache(chrome.storage.local)]);
    } catch { status.textContent = '本地缓存写入失败；当前对话仍可继续。'; }
  }
  function drawSources(container, sources) {
    if (!sources?.length) return;
    const refs = document.createElement('div'); refs.className = 'source-list';
    sources.map(safeSource).filter(Boolean).forEach((s,i) => {
      const a = document.createElement('a'); a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.className = 'source-card'; a.title = s.url;
      const title = document.createElement('span'); title.textContent = `${i+1}. ${s.title}`;
      const domain = document.createElement('small'); domain.textContent = new URL(s.url).hostname;
      a.append(title,domain); refs.append(a);
    });
    container.append(refs);
  }
  function render(forceScroll = false) {
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    list.replaceChildren();
    for (const turn of turns) {
      const user = document.createElement('div'); user.className = 'message user';
      const text = document.createElement('p'); text.textContent = turn.question; user.append(text); list.append(user);
      const assistant = document.createElement('div'); assistant.className = 'message assistant';
      const label = document.createElement('div'); label.className = 'message-label';
      label.textContent = turn.web ? '✦ AI · 联网回答' : '✦ AI · 视频回答'; assistant.append(label);
      const body = document.createElement('div'); body.className = 'markdown';
      body.innerHTML = renderChatMarkdown(turn.answer || (busy && turn === turns.at(-1) ? '正在准备回答…' : '未生成回答。'));
      assistant.append(body);
      if (turn.error) { const error = document.createElement('p'); error.className = 'chat-error'; error.textContent = turn.error; assistant.append(error); }
      drawSources(assistant,turn.sources);
      list.append(assistant);
    }
    update();
    if (forceScroll || nearBottom) scroller.scrollTop = scroller.scrollHeight;
  }
  function scheduleRender() {
    if (timer) return;
    timer = requestAnimationFrame(() => { timer = null; render(); });
  }
  function finish(text = '') {
    busy = false;
    clearInterval(heartbeat); heartbeat = null;
    const oldPort = port; port = null;
    try { oldPort?.disconnect(); } catch { /* already disconnected */ }
    status.textContent = text; render(); void save();
  }
  function abort() {
    if (!busy) return;
    const turn = turns.at(-1);
    if (turn) turn.error = '已停止；未完成的回答不会进入后续上下文。';
    try { port?.postMessage({type:'abort'}); } catch { /* disconnected */ }
    finish('已停止');
  }
  async function submit(question = input.value) {
    question = String(question).trim();
    if (!question || busy || !ready()) return;
    if (question.length > 4000) { status.textContent = '问题请控制在 4000 字以内。'; return; }
    const ctx = getContext(), history = turns.slice();
    const turn = {question, answer:'', complete:false, web, sources:[]};
    turns.push(turn); busy = true; input.value = ''; input.style.height = '';
    status.textContent = web ? '正在准备联网检索…' : '正在准备回答…'; render(true);
    const requestEpoch = epoch;
    let firstReplyTimer = null;
    const clearFirstReplyTimer = () => {
      if (firstReplyTimer) { clearTimeout(firstReplyTimer); firstReplyTimer = null; }
    };
    try {
      const current = chrome.runtime.connect({name:'video-chat'}); port = current;
      heartbeat = setInterval(() => { try { current.postMessage({type:'ping'}); } catch { /* onDisconnect handles it */ } }, 20000);
      // 兜底：若后台是旧版（没有监听器）或扩展刚被更新，连接能建立却永远不回消息。
      // 12 秒内连“正在阅读视频内容…”这种首条状态都没等到，就直接报错，别让用户干等。
      firstReplyTimer = setTimeout(() => {
        if (requestEpoch !== epoch || port !== current || !busy) return;
        turn.error = '扩展后台没有响应（最常见的原因：更新扩展后没有重新加载）。请点面板顶部的「重新加载扩展」后重试。';
        setBackgroundWarning(true);
        try { current.postMessage({type:'abort'}); } catch { /* 已断开 */ }
        finish('后台没有响应');
      }, 12000);
      current.onMessage.addListener(msg => {
        if (requestEpoch !== epoch || port !== current) return;
        clearFirstReplyTimer();
        if (backgroundOk !== true) setBackgroundWarning(false);
        if (msg.type === 'status') status.textContent = msg.text;
        if (msg.type === 'sources') { turn.sources = msg.sources; turn.query = msg.query; render(); }
        if (msg.type === 'delta') { turn.answer = msg.full; status.textContent = '正在回答…'; scheduleRender(); }
        if (msg.type === 'done') { turn.answer = msg.full; turn.complete = true; finish('回答完成'); }
        if (msg.type === 'error') { turn.error = msg.error; input.value = question; finish('回答失败，可修改问题后重试'); }
        if (msg.type === 'aborted') abort();
      });
      current.onDisconnect.addListener(() => {
        clearFirstReplyTimer();
        if (requestEpoch === epoch && busy && port === current) {
          turn.error = '连接中断，请重试。'; input.value = question; finish('连接已中断');
        }
      });
      current.postMessage({type:'start',video:ctx.video,summary:ctx.summary,question,history,web});
    } catch (err) {
      clearFirstReplyTimer();
      turn.error = `无法连接扩展后台：${err?.message || err}。请重新加载扩展后再试。`;
      input.value = question;
      setBackgroundWarning(true);
      finish('无法连接扩展后台');
    }
  }
  toggle.addEventListener('click', async () => {
    if (busy) return;
    if (web) { web = false; update(); return; }
    try {
      // Request from the direct click to preserve Chrome's user gesture.
      const granted = await chrome.permissions.request({origins:[...SEARCH_ORIGINS, 'https://api.tavily.com/*']});
      if (!granted) { status.textContent = '未授权搜索站点，仍按本视频回答。'; return; }
      const cfg = await getSettings();
      if (cfg.searchProvider === 'tavily') {
        const {tavilyKey} = await chrome.storage.local.get('tavilyKey');
        if (!tavilyKey) { status.textContent = '请在设置中填写 Tavily Key，或选择自动搜索。'; return; }
      }
      web = true; status.textContent = '已开启联网；问题及视频标题将用于搜索。'; update();
    } catch (err) { status.textContent = `无法开启联网：${err.message}`; }
  });
  $('chat-form').addEventListener('submit', e => { e.preventDefault(); void submit(); });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 130)}px`; update(); });
  input.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); void submit(); }
  });
  stop.addEventListener('click',abort);
  $('btn-reload-ext')?.addEventListener('click', async () => {
    status.textContent = '正在重新加载扩展…';
    try {
      // 重新加载会清空 storage.session；先把追问缓存搬到 local，避免总结和对话丢失。
      const all = await chrome.storage.session.get(null);
      const items = Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith('video-chat:')));
      if (Object.keys(items).length) await chrome.storage.local.set(items);
    } catch { /* 迁移失败不影响重新加载 */ }
    try {
      chrome.runtime.reload();
    } catch (err) {
      status.textContent = `重新加载失败：${err?.message || err}。请到 edge://extensions 手动点「重新加载」。`;
    }
  });
  $('btn-chat-clear').addEventListener('click', () => { if (!busy) { turns=[]; status.textContent='已开始新对话'; render(); void save(); } });
  $('chat-suggestions').addEventListener('click', e => { const button = e.target.closest('[data-question]'); if (button) void submit(button.dataset.question); });
  list.addEventListener('click', e => { const ts = e.target.closest('.ts'); if (ts) seek(ts.dataset.t); });
  void probeBackground();
  return {
    update,
    save,
    abort,
    async setVideo(video) {
      abort(); epoch++; const thisEpoch=epoch;
      key = video ? String(video.url || `${video.platform}:${video.title}`).slice(0, 600) : '';
      turns = []; web = false; input.value = ''; status.textContent = ''; render();
      if (!key) return;
      try {
        let data = (await chrome.storage.session.get(cacheKey()))[cacheKey()];
        if (!data) data = (await chrome.storage.local.get(cacheKey()))[cacheKey()];
        if (epoch !== thisEpoch) return;
        if (data) { turns=Array.isArray(data.turns) ? data.turns : []; restoreSummary(data.summary || ''); render(); }
      } catch { /* session cache optional */ }
    },
  };
}
