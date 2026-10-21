import { chatStream, getSettings } from './llm.js';
import { buildChatMessages, buildSearchQuery } from './conversation.js';
import { searchWeb } from './search.js';

export function registerChatPort() {
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'video-chat') return;
    const controller = new AbortController();
    let started = false;
    let closed = false;
    const send = message => { if (!closed) { try { port.postMessage(message); } catch { controller.abort(); } } };
    port.onDisconnect.addListener(() => { closed = true; controller.abort(); });
    port.onMessage.addListener(async msg => {
      if (msg?.type === 'abort') { controller.abort(); return; }
      if (msg?.type === 'ping') { send({type:'pong', version: chrome.runtime.getManifest().version}); return; }
      if (msg?.type !== 'start' || started) return;
      started = true;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 180000);
      try {
        const settings = await getSettings();
        if (!settings.apiKey) throw new Error('请先在右上角设置中填写模型 API Key。');
        let sources = [];
        if (msg.web) {
          const query = buildSearchQuery(msg.question, msg.video, msg.history);
          send({type:'status', text:'正在搜索网页…'});
          sources = await searchWeb(query, settings, controller.signal);
          send({type:'sources', sources, query});
        }
        controller.signal.throwIfAborted();
        send({type:'status', text:msg.web ? '已检索网页，正在综合回答…' : '正在阅读视频内容…'});
        const messages = buildChatMessages({...msg, sources});
        const full = await chatStream({messages, settings, signal:controller.signal,
          onReasoning:() => send({type:'status',text:'模型正在思考…'}),
          onDelta:(delta, full) => send({type:'delta',delta,full})});
        if (!full.trim()) throw new Error('模型没有返回正文，请重试或检查模型设置。');
        send({type:'done',full});
      } catch (error) {
        send(timedOut ? {type:'error',error:'回答超时，请缩短问题后重试。'} : controller.signal.aborted
          ? {type:'aborted'} : {type:'error',error:error?.message || String(error)});
      } finally { clearTimeout(timeout); }
    });
  });
}
