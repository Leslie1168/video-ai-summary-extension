import {createSessionStore,pageKey} from '../lib/session.js';
import {downloadPage,pagePlainText} from '../lib/export.js';
const $=id=>document.getElementById(id);
const store=createSessionStore(chrome.storage.local);
let tabId=null,page=null,port=null,turns=[],busy=false,displayedTab=null,activeUrl='',saveTimer=null,runEpoch=0,style='standard';
const STYLES=['brief','standard','detailed'];
function applyStyle(next){style=STYLES.includes(next)?next:'standard';for(const btn of $('style-seg').children)btn.classList.toggle('active',btn.dataset.style===style);}
function status(text){$('status').textContent=text;}
function syncActions(){const bar=$('reader-actions');if(bar)bar.classList.toggle('ready',turns.length>0);}
function setBusy(value){busy=value;$('summarize').disabled=value;$('stop').disabled=!value;$('ask').querySelector('button').disabled=value;}
function textBubble(role,text=''){const el=document.createElement('div');el.className='bubble '+role;const label=document.createElement('div');label.className='label';label.textContent=role==='user'?'你':'网页 AI';const body=document.createElement('div');body.textContent=text;el.append(label,body);$('conversation').append(el);el.scrollIntoView({block:'end'});return body;}
function renderRefs(container,sources=[]){const box=document.createElement('div');box.className='refs';for(const s of sources){const a=document.createElement('a');a.textContent=`[${s.id}] ${s.title}`;a.href=s.url;a.target='_blank';a.rel='noopener noreferrer';box.append(a);}if(sources.length)container.parentElement.append(box);}
function linkPageRefs(container,answer){const fragment=document.createDocumentFragment();for(const segment of answer.split(/(\[P\d+\])/g)){const match=/^\[(P\d+)\]$/.exec(segment);if(match&&page?.blocks?.some(b=>b.id===match[1])){const a=document.createElement('a');a.className='jump';a.textContent=segment;a.href='#';a.addEventListener('click',async e=>{e.preventDefault();const block=page.blocks.find(b=>b.id===match[1]);await chrome.runtime.sendMessage({type:'focus',tabId,anchor:block.anchor});});fragment.append(a);}else fragment.append(document.createTextNode(segment));}container.replaceChildren(fragment);}
async function currentTab(){const [tab]=await chrome.tabs.query({active:true,currentWindow:true});return tab;}
const SITE_INFO={github:{label:'GitHub',mark:'GH'},zhihu:{label:'知乎',mark:'知'},csdn:{label:'CSDN',mark:'CS'},tieba:{label:'贴吧',mark:'帖'},generic:{label:'网页',mark:'网'}};
function renderPageCard(current,cut=false){
  const card=$('page-card');
  if(!card)return;
  if(!current){card.classList.remove('ready');$('meta').textContent='';return;}
  const info=SITE_INFO[current.site]||SITE_INFO.generic;
  const mark=$('p-mark');
  mark.textContent=info.mark;
  mark.classList.toggle('wide',info.mark.length>1);
  $('p-title').textContent=current.title||'(未取到标题)';
  const sub=[current.host,current.author,current.published].filter(Boolean);
  $('p-sub').textContent=sub.join(' · ')||'来源未知';
  const chars=Number(current.extractedChars)||0;
  const stats=[String(current.siteStats||'').replace(/\s+/g,' ').trim(),`${(current.blocks||[]).length} 段`,chars>=1000?`${(chars/1000).toFixed(1)}k 字`:`${chars} 字`].filter(Boolean);
  $('p-stats').textContent=stats.join(' · ');
  const badges=[info.label,'已读取'];
  if(current.truncated)badges.push('仅前段');
  if(cut)badges.push('仅可见部分');
  $('p-badges').innerHTML=badges.map(text=>`<span class="badge">${text}</span>`).join('');
  $('meta').textContent=cut?'页面较长，只读取了可见的前一部分。':'';
  card.classList.add('ready');
}
function snapshot(){return {title:displayedTab?.title||activeUrl,page,turns};}
// 每轮写完就单独传这一条；失败不影响本地，只在状态栏提一句。
function uploadOne(url){
  if(!url)return;
  try{
    chrome.runtime.sendMessage({type:'CLOUD_PUT',key:'reader-page:v1:'+url}).then(res=>{
      if(res&&res.ok===false)console.warn('[知页] 云同步失败',res.error);
    }).catch(error=>console.warn('[知页] 云同步失败',error));
  }catch(error){console.warn('[知页] 云同步失败',error);}
}

function persist(){if(!activeUrl||!turns.length)return Promise.resolve();return store.save(activeUrl,snapshot()).catch(error=>{status('记录保存失败：'+(error?.message||error));});}
function queueSave(){if(saveTimer)return;saveTimer=setTimeout(()=>{saveTimer=null;void persist();},400);}
async function flush(){if(saveTimer){clearTimeout(saveTimer);saveTimer=null;}await persist();await store.flush();}
function restore(record){page=record?.page||null;turns=Array.isArray(record?.turns)?record.turns:[];$('conversation').replaceChildren();renderPageCard(page);for(const turn of turns){if(turn.question)textBubble('user',turn.question);const answer=textBubble('assistant');if(turn.complete)linkPageRefs(answer,turn.answer||'');else answer.textContent=(turn.answer||'')+'\n[未完成 · 切换页面或连接中断，可重新提问]';renderRefs(answer,turn.sources||[]);}syncActions();status(turns.length?'已恢复当前页面的总结与追问。':'打开文字网页，点击「读取并总结」。');}
async function initialize(){const tab=await currentTab();displayedTab=tab;$('site').textContent=tab?.title||'当前页面';if(!tab?.url)return;try{activeUrl=pageKey(tab.url);tabId=tab.id;restore(await store.load(activeUrl));}catch{activeUrl='';}}
async function run(question=''){
  if(busy)return;
  // A site permission prompt must originate directly in the button/submit gesture.
  const initial=displayedTab;
  if(!initial?.id){status('正在识别标签页，请稍后重试。');return;}
  let origin;
  try{const url=new URL(initial.url);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw new Error('文字阅读支持 HTTPS 网页及本机 HTTP 页面。');origin=url.origin+'/*';}
  catch(error){status(error.message||'此页面无法读取。');return;}
  let permissionPromise,granted;
  try{permissionPromise=chrome.permissions.request({origins:[origin]});}catch(error){status('申请当前站点权限失败：'+error.message);return;}
  try{granted=await permissionPromise;}catch(error){status('申请当前站点权限失败：'+error.message);return;}
  if(!granted){status('未授予 '+new URL(initial.url).hostname+' 的网页读取权限，点击后重试。');return;}
  const tab=await currentTab();
  if(!tab?.id||tab.id!==initial.id||tab.url!==initial.url){status('标签页已切换，请在目标网页重新点击读取。');return;}
  const url=pageKey(tab.url),same=tabId===tab.id&&pageKey(page?.url||tab.url)===url;
  if(activeUrl!==url){await flush();activeUrl=url;restore(await store.load(url));}
  tabId=tab.id;displayedTab=tab;$('site').textContent=tab.title||tab.url||'当前页面';
  const turn={question,answer:'',sources:[],complete:false,created:Date.now()};
  turns.push(turn);syncActions();if(question)textBubble('user',question);const answer=textBubble('assistant');
  let current;try{current=chrome.runtime.connect({name:'reader'});}catch(error){turn.answer='连接后台失败：'+error.message;answer.textContent=turn.answer;await persist();return;}
  port=current;const epoch=++runEpoch;setBusy(true);status('正在读取当前页面…');void persist();
  let settled=false;
  const finish=async(message)=>{if(settled)return;settled=true;setBusy(false);status(message);if(saveTimer){clearTimeout(saveTimer);saveTimer=null;}await persist();void uploadOne(activeUrl);try{current.disconnect();}catch{}if(port===current)port=null;};
  current.onMessage.addListener(event=>{
    if(epoch!==runEpoch||current!==port)return;
    if(event.type==='page'){page=event.page;renderPageCard(page,!!event.cut);status(event.cut?'页面较长，只读取了可见的前一部分。':'');queueSave();}
    else if(event.type==='status')status(event.text);
    else if(event.type==='decision')status(`联网判断：${event.web?'需要':'不需要'} · ${event.reason}`);
    else if(event.type==='sources'){turn.sources=event.sources||[];queueSave();if(event.searchError)status(`检索失败：${event.searchError}；继续依据当前页回答。`);else status(`已检索 ${turn.sources.length} 条外部摘要，正在生成回答…`);}
    else if(event.type==='delta'){turn.answer+=event.delta;answer.textContent=turn.answer;queueSave();}
    else if(event.type==='done'){turn.answer=event.full||turn.answer;turn.complete=true;linkPageRefs(answer,turn.answer);renderRefs(answer,turn.sources);void finish('完成。页内引用可点击回跳；外部来源显示在回答下方。');}
    else if(event.type==='aborted'||event.type==='error'){if(!turn.answer){turn.answer=event.error||'已停止';answer.textContent=turn.answer;}void finish(event.error||'已停止；部分内容已保存。');}
  });
  current.onDisconnect.addListener(()=>{if(!settled&&epoch===runEpoch){void finish('连接中断；部分内容已保存。');}});
  const history=turns.slice(0,-1).filter(t=>t.complete).flatMap(t=>[{role:'user',content:t.question||'请总结本页'},{role:'assistant',content:t.answer}]);
  current.postMessage({type:'run',tabId,page:same?page:null,question,history,mode:$('mode').value,style});
}
$('summarize').addEventListener('click',()=>void run());
$('ask').addEventListener('submit',e=>{e.preventDefault();const q=$('question').value.trim();if(!q)return;$('question').value='';void run(q);});
$('stop').addEventListener('click',()=>port?.postMessage({type:'stop'}));
$('btn-copy').addEventListener('click',async()=>{if(!turns.length)return;try{await navigator.clipboard.writeText(pagePlainText(snapshot()));status('已复制本页对话，可以直接粘贴。');}catch(error){status('复制失败：'+(error?.message||error));}});
$('btn-export').addEventListener('click',()=>{if(!turns.length)return;try{status('已导出 '+downloadPage(snapshot())+' 到下载目录。');}catch(error){status('导出失败：'+(error?.message||error));}});
$('settings').addEventListener('click',()=>chrome.runtime.openOptionsPage());
$('mode').addEventListener('change',()=>{const next=$('mode').value;chrome.storage.sync.set({readerMode:next,webEnabled:next!=='page'});status(next==='page'?'联网已关闭：只依据本页内容回答。':'联网已开启，与视频侧共用一个开关。');});
$('style-seg').addEventListener('click',e=>{const btn=e.target.closest('button[data-style]');if(!btn||busy)return;applyStyle(btn.dataset.style);chrome.storage.local.set({readerStyle:style});status(`总结详细程度：${btn.textContent}。下一次读取按此执行。`);});
window.addEventListener('message',event=>{if(event.source!==window.parent||event.origin!==location.origin||event.data?.type!=='route-away')return;(async()=>{if(busy){runEpoch++;try{port?.postMessage({type:'stop'});port?.disconnect();}catch{}port=null;setBusy(false);status('已切换页面；未完成内容已保存。');}try{await flush();}finally{window.parent.postMessage({type:'route-away-done',token:event.data.token},location.origin);}})();});
Promise.all([
  chrome.storage.sync.get({readerMode:null,webEnabled:true}),
  chrome.storage.local.get({readerStyle:'standard'}),
]).then(([sync,local])=>{const mode=sync.readerMode||(sync.webEnabled===false?'page':'auto');$('mode').value=mode;applyStyle(local.readerStyle);});
void initialize().catch(()=>status('恢复页面记录失败，请重新打开侧栏。'));
