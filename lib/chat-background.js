import { chatStream, getSettings } from './llm.js';
import { buildChatMessages } from './conversation.js';
import { researchWeb } from './web-research.js';
import { loadPersona } from './persona.js';

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
      let firstTokenTimedOut = false,firstTokenTimer;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 180000);
      try {
        const stored = await getSettings();
        const persona = await loadPersona();
        const fast=!!msg.web && stored.webMode!=='deep';
        const settings=fast?{...stored,reasoningEffort:'none',maxTokens:Math.min(Number(stored.maxTokens)||8192,8192),contextChars:16000,historyTurns:Math.min(Number(stored.historyTurns??8),4)}:stored;
        if (!settings.apiKey) throw new Error('请先在右上角设置中填写模型 API Key。');
        settings.persona = persona;
        send({type:'status',text:fast?'快速联网：提取关键词，准备并发检索…':'正在准备视频资料…'});
        let sources = [];
        const useWeb = !!msg.web;
        if (useWeb) {
          try {
            const research = await researchWeb(msg,settings,controller.signal,send);
            const query=research.query;
            sources=research.sources;
            send({type:'sources', sources, query});
            if(!sources.length) send({type:'answer-scope',web:true,note:'本次搜索服务未返回网页。AI 仍会结合视频和已有知识回答，外部补充会标为未联网核实。'});
            else if(research.failed) send({type:'answer-scope',web:true,note:'部分搜索未成功，以下综合已取得的网页与视频回答。'});
          } catch(error) {
            controller.signal.throwIfAborted();
            send({type:'answer-scope',web:true,note:'本次检索发生故障；AI 仍会结合视频和已有知识回答，外部补充会标为未联网核实。'});
          }
        }
        controller.signal.throwIfAborted();
        send({type:'status', text:useWeb ? '正在综合视频、检索结果与相关知识…' : '正在阅读视频内容…'});
        const frames = Array.isArray(msg.frames) ? msg.frames : [];
        if (frames.length > 8 || frames.some(f => !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(f.url || '') || f.url.length > 2000000)) throw new Error('识屏图片无效或过大，请减少采样数量。');
        const messages = buildChatMessages({...msg, web:useWeb, sources, settings, frames});
        let completion;
        let lastReasoning=0;
        firstTokenTimer=setTimeout(()=>{firstTokenTimedOut=true;controller.abort();},fast?45000:90000);
        const full = await chatStream({messages, settings, signal:controller.signal,
          maxContinuations:fast?0:1,
          onFinish:info => {completion = info;},
          onReasoning:() => {if(Date.now()-lastReasoning>10000){lastReasoning=Date.now();send({type:'status',text:'模型正在分析资料，正文尚未返回…'});}},
          onDelta:(delta, full) => {clearTimeout(firstTokenTimer);send({type:'delta',delta,full});}});
        if (!full.trim()) throw new Error('模型没有返回正文，请重试或检查模型设置。');
        send({type:'done',full,truncated:completion?.truncated,usage:completion?.usage});
      } catch (error) {
        send(firstTokenTimedOut ? {type:'error',error:'模型长时间未返回正文，已停止请求。可切换快速联网或降低思考强度后重试。'} : timedOut ? {type:'error',error:'回答超时，已停止请求；已收到的文字已保留。'} : controller.signal.aborted
          ? {type:'aborted'} : {type:'error',error:error?.message || String(error)});
      } finally { clearTimeout(timeout);clearTimeout(firstTokenTimer); }
    });
  });
}
