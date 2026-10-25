import {listMemories,downloadMemory} from '../lib/archive.js';
import {renderChatMarkdown} from '../panel/chat.js';
import {safeSource} from '../lib/search.js';
const $=id=>document.getElementById(id);
let records=[],selected=null;
const sidebar=new URLSearchParams(location.search).get('sidebar')==='1';
let liveId='';
const threads=new Map();
const host=document.createElement('section');host.id='thread-host';host.hidden=true;document.body.append(host);
if(sidebar){
  document.body.classList.add('sidebar-mode');
  const back=node('button','‹ 返回本视频');back.id='memory-return-video';
  back.addEventListener('click',()=>window.parent.postMessage({type:'memory-close'},location.origin));document.querySelector('header').prepend(back);
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin)return;
    if(event.source===window.parent && event.data?.type==='current-session')liveId=event.data.id;
    if([...threads.values()].some(frame=>frame.contentWindow===event.source) && event.data?.type==='archive-back'){
      host.hidden=true;document.body.classList.remove('thread-open');void refresh();
    }
  });
  window.parent.postMessage({type:'memory-ready'},location.origin);
}
function openThread(record){
  if(record.id===liveId){window.parent.postMessage({type:'memory-open-live'},location.origin);return;}
  let frame=threads.get(record.id);
  if(!frame){frame=document.createElement('iframe');frame.title=record.video.title;frame.src=chrome.runtime.getURL('panel/panel.html')+'?memory='+encodeURIComponent(record.id);threads.set(record.id,frame);host.append(frame);}
  for(const child of threads.values())child.hidden=child!==frame;
  host.hidden=false;document.body.classList.add('thread-open');
}
function node(tag,text,className='') {const el=document.createElement(tag);el.textContent=text;el.className=className;return el;}
function date(ms) {return new Date(ms).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong'});}
function select(record) {
  if(sidebar){selected=record;openThread(record);renderList();return;}
  selected=record;$('empty').hidden=true;$('detail').hidden=false;
  $('record-title').textContent=record.video.title;
  $('record-meta').textContent=`${date(record.updated)} · ${record.turns.length} 轮对话${record.video.author?' · '+record.video.author:''}`;
  const source=safeSource({url:record.video.url});$('record-url').hidden=!source;
  if(source) $('record-url').href=source.url;else $('record-url').removeAttribute('href');
  const body=$('record-body');body.replaceChildren(node('h3','视频总结','section-title'));
  const summary=node('div','','answer');summary.innerHTML=renderChatMarkdown(record.summary || '暂无总结');body.append(summary);
  body.append(node('h3','对话回顾','section-title'));
  if(!record.turns.length) body.append(node('p','这段记忆只有视频总结。','turn-note'));
  record.turns.forEach((turn,i)=>{
    const section=node('section','','turn');section.append(node('p',`${i+1} · ${turn.question}`,'question'));
    const answer=node('div','','answer');answer.innerHTML=renderChatMarkdown(turn.answer || '未生成回答');section.append(answer);
    if(turn.query) section.append(node('p',`搜索词：${turn.query}`,'turn-note'));
    if(turn.searchNote) section.append(node('p',turn.searchNote,'turn-note'));
    if(turn.frameRange) section.append(node('p',`识屏范围：${turn.frameRange}`,'turn-note'));
    if(turn.error || !turn.complete) section.append(node('p',turn.error || '回答未完成','turn-note'));
    for(const source of turn.sources){const a=node('a',source.title,'source');a.href=source.url;a.target='_blank';a.rel='noopener noreferrer';section.append(a);}
    body.append(section);
  });
  renderList();
}
function renderList() {
  const query=$('filter').value.toLowerCase().trim();
  const shown=records.filter(r=>!query || [r.video.title,r.video.author,r.summary,...r.turns.flatMap(t=>[t.question,t.answer])].join('\n').toLowerCase().includes(query));
  $('stats').textContent=`${new Set(records.map(r=>r.videoKey)).size} 个视频 · ${records.length} 段记忆${query?' · 匹配 '+shown.length+' 段':''}`;
  const list=$('records');list.replaceChildren();
  for(const record of shown){const button=node('button','','record'+(selected?.id===record.id?' active':''));button.type='button';button.append(node('strong',record.video.title),node('p',record.turns.at(-1)?.question || record.summary.slice(0,100)),node('small',`${date(record.updated)} · ${record.turns.length} 轮对话`));button.addEventListener('click',()=>select(record));list.append(button);}
  if(!shown.length) list.append(node('p',query?'没有匹配的记忆。':'还没有保存的对话。','turn-note'));
  for(const id of ['export-all-md','export-all-json']) $(id).disabled=!records.length;
}
async function refresh() {
  $('notice').textContent='正在读取本机记忆…';
  try{records=await listMemories();$('notice').textContent='';renderList();if(!sidebar){if(selected){const fresh=records.find(r=>r.id===selected.id);if(fresh)select(fresh);}else if(records.length)select(records[0]);}}
  catch(error){$('notice').textContent=`读取失败：${error.message || error}。原记录不会被删除。`;}
}
$('filter').addEventListener('input',renderList);
$('refresh').addEventListener('click',refresh);
for(const format of ['md','json']){
  $(`export-all-${format}`).addEventListener('click',()=>downloadMemory(records,format));
  $(`export-one-${format}`).addEventListener('click',()=>{if(selected)downloadMemory([selected],format);});
}
let refreshTimer;
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local' && Object.keys(changes).some(k=>k.startsWith('video-memory:'))){clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,400);}});
void refresh();

