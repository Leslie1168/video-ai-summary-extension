import {safeSource} from './search.js';

const PREFIX = 'video-memory:';
const PAGE_PREFIX = 'reader-page:v1:';
let writes = Promise.resolve();
export const legacyId = key => `legacy:${key}`;
export function cleanRecord(record) {
  const video = record.video || {};
  return {
    id:String(record.id), videoKey:String(record.videoKey || ''),
    video:{title:String(video.title || '未命名视频'),url:String(video.url || ''),author:String(video.author || ''),platform:String(video.platform || ''),duration:Number(video.duration) || 0},
    created:Number(record.created) || Date.now(),updated:Number(record.updated) || Date.now(),
    summary:String(record.summary || ''),
    model:String(record.model || ''),summaryPending:!!record.summaryPending,
    summaryTrace:(Array.isArray(record.summaryTrace)?record.summaryTrace:[]).map(step=>({text:String(step.text || ''),at:Number(step.at)||0})),
    turns:(Array.isArray(record.turns) ? record.turns : []).map(t=>({question:String(t.question || ''),answer:String(t.answer || ''),complete:!!t.complete,web:!!t.web,
      query:String(t.query || ''),searchNote:String(t.searchNote || ''),error:String(t.error || ''),frameRange:String(t.frameRange || ''),truncated:!!t.truncated,created:Number(t.created) || 0,
      finished:Number(t.finished)||0,trace:(Array.isArray(t.trace)?t.trace:[]).slice(-80).map(step=>({text:String(step.text || ''),at:Number(step.at)||0})),
      usage:t.usage?{prompt_tokens:Number.isFinite(t.usage.prompt_tokens)?t.usage.prompt_tokens:undefined,completion_tokens:Number.isFinite(t.usage.completion_tokens)?t.usage.completion_tokens:undefined,partial:!!t.usage.partial}:undefined,
      sources:(t.sources || []).map(safeSource).filter(Boolean)})),
  };
}
export async function getMemory(id) {
  await writes.catch(()=>{});
  const key=PREFIX+id;
  const value=(await chrome.storage.local.get(key))[key];
  return value?cleanRecord(value):null;
}
export function saveArchive(snapshot) {
  const record=cleanRecord({...snapshot,id:snapshot.memoryId || snapshot.id});
  const operation=writes.catch(()=>{}).then(()=>chrome.storage.local.set({[PREFIX+record.id]:record}));
  writes=operation;return operation;
}
export function saveConversation(cacheKey, snapshot) {
  // Capture the state before yielding so navigation/new-chat cannot change this write.
  const record=cleanRecord({...snapshot,id:snapshot.memoryId,videoKey:cacheKey.slice('video-chat:'.length)});
  const copy=structuredClone({...record,memoryId:record.id});
  const operation=writes.catch(()=>{}).then(()=>chrome.storage.local.set({[cacheKey]:copy,[PREFIX+record.id]:record}));
  writes=operation;
  return operation;
}
async function migrate() {
  // Read only old conversation caches into the archive. Never export settings/keys.
  const local=await chrome.storage.local.get(null);
  let session={};
  try {session=await chrome.storage.session.get(null);} catch { /* old session may be unavailable */ }
  const pending={};
  for (const key of new Set([...Object.keys(local),...Object.keys(session)])) {
    if (!key.startsWith('video-chat:')) continue;
    const a=local[key],b=session[key];
    const cache=(b?.updated || 0) > (a?.updated || 0) ? b : a;
    if (!cache || (!cache.summary && !cache.turns?.length)) continue;
    const videoKey=key.slice('video-chat:'.length);
    const id=cache.memoryId || legacyId(videoKey);
    const record=cleanRecord({...cache,id,videoKey,video:cache.video || {title:videoKey,url:/^https?:/.test(videoKey)?videoKey:''}});
    if (!local[PREFIX+id]) pending[PREFIX+id]=record;
  }
  if (Object.keys(pending).length) await chrome.storage.local.set(pending);
}
export function migrateLegacy() {
  const operation=writes.catch(()=>{}).then(migrate);
  writes=operation;
  return operation;
}
export async function listMemories() {
  await writes.catch(()=>{});
  await migrateLegacy();
  const all=await chrome.storage.local.get(null);
  return Object.entries(all).filter(([key])=>key.startsWith(PREFIX)).map(([,record])=>cleanRecord(record)).sort((a,b)=>b.updated-a.updated);
}
// 网页记录由 reader/lib/session.js 按 URL 写入 chrome.storage.local，这里只读，不参与视频归档的写入链。
export async function listPageMemories() {
  const all=await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key])=>key.startsWith(PAGE_PREFIX))
    .map(([key,record])=>{
      const page=record?.page || {};
      return {
        id:key.slice(PAGE_PREFIX.length),
        kind:'page',
        key,
        updated:Number(record?.updated) || 0,
        title:String(record?.title || page.title || page.url || '未命名页面'),
        page,
        turns:Array.isArray(record?.turns)?record.turns:[],
      };
    })
    .sort((a,b)=>b.updated-a.updated);
}
export function memoryMarkdown(records) {
  records=records.map(cleanRecord);
  const process=(steps,start)=>steps.map(step=>`- ${start && step.at?Math.max(0,Math.floor((step.at-start)/1000))+' 秒 · ':''}${step.text}`);
  return ['# 视频学习交接笔记','',`导出时间：${new Date().toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong'})}`,'',
    '> 本文包含已保存或当前已收到的总结、完整追问和实际检索/处理记录。处理记录是可见的工作过程摘要，不是模型内部推理原文。未完成内容已注明。','',...records.flatMap(record=>[
    `## ${record.video.title}`,'',`来源：${record.video.url || '旧缓存未记录链接'}`,`作者：${record.video.author || '未记录'}`,`更新时间：${new Date(record.updated).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong'})}`,'',
    ...(record.model?[`模型：${record.model}`,'']:[]),
    '### 交接概况','',`- 共 ${record.turns.length} 轮追问；${record.turns.filter(t=>!t.complete || t.truncated).length} 轮未完成或待补完。`,
    ...(record.summaryPending?['- 导出时视频总结仍未完成；以下为当时已收到的部分。']:[]),
    ...(record.turns.length?[`- 最近问题：${record.turns.at(-1).question}`]:[]),'',
    '### 视频总结','',record.summary || '暂无总结','',
    ...(record.summaryTrace.length?['#### 总结处理记录','',...process(record.summaryTrace,record.summaryTrace[0].at),'']:[]),
    ...record.turns.flatMap((turn,i)=>[`### 对话 ${i+1}`,'',`**我：** ${turn.question}`,'',`**AI${turn.web?'（联网）':''}：**`,'',turn.answer || '未生成回答',
      ...(turn.query?['',`搜索词：${turn.query}`]:[]),...(turn.searchNote?['',turn.searchNote]:[]),...(turn.frameRange?['',`识屏范围：${turn.frameRange}`]:[]),
      ...(!turn.complete || turn.error || turn.truncated?['',`状态：${turn.error || (turn.truncated?'达到长度上限，待继续补完':'尚未完成，以下交接需继续核对')}`]:[]),
      ...(turn.trace.length?['','#### 检索与处理记录','',...process(turn.trace,turn.created)]:[]),
      ...(turn.usage?['',`接口用量${turn.usage.partial?'（部分请求）':''}：输入 ${turn.usage.prompt_tokens ?? '未知'} / 输出 ${turn.usage.completion_tokens ?? '未知'} token`]:[]),
      ...(turn.sources.length?['','#### 参考来源','']:[]),
      ...turn.sources.map((s,n)=>`${n+1}. ${s.title} — ${s.url}`),'']),
    '---','',
  ])].join('\n');
}
export function downloadMemory(records,format='json') {
  const text=format==='md'?memoryMarkdown(records):JSON.stringify({format:'video-ai-memory',version:1,exportedAt:new Date().toISOString(),records:records.map(cleanRecord)},null,2);
  const blob=new Blob([text],{type:format==='md'?'text/markdown;charset=utf-8':'application/json;charset=utf-8'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=`视频学习记忆-${records.length===1?'单条':'全部'}-${new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Hong_Kong'})}.${format}`;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  return a.download;
}

