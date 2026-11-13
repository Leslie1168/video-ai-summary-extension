import {listMemories,listPageMemories,downloadMemory} from '../lib/archive.js';
import {downloadPage,downloadPages} from '../reader/lib/export.js';
import {renderChatMarkdown} from '../panel/chat.js';
import {safeSource} from '../lib/search.js';
const $=id=>document.getElementById(id);
let records=[],selected=null,mode='video';
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
function renderTurns(body,turns){
  if(!turns.length){body.append(node('p','这条记忆还没有对话。','turn-note'));return;}
  turns.forEach((turn,i)=>{
    const section=node('section','','turn');
    section.append(node('p',`${i+1} · ${turn.question || '页面总结'}`,'question'));
    const answer=node('div','','answer');answer.innerHTML=renderChatMarkdown(turn.answer || '未生成回答');section.append(answer);
    if(turn.error || !turn.complete) section.append(node('p',turn.error || '回答未完成','turn-note'));
    for(const source of turn.sources || []){const a=node('a',source.title,'source');a.href=source.url;a.target='_blank';a.rel='noopener noreferrer';section.append(a);}
    body.append(section);
  });
}
function selectPage(record){
  selected=record;$('empty').hidden=true;$('detail').hidden=false;
  $('record-title').textContent=record.title;
  const facts=[record.page.host,record.page.author,record.page.published].filter(Boolean).join(' · ');
  $('record-meta').textContent=`${date(record.updated)} · ${record.turns.length} 轮追问${facts?' · '+facts:''}`;
  const source=safeSource({url:record.page.url || ''});
  $('record-url').hidden=!source;
  $('record-url').textContent='打开原网页 ↗';
  if(source) $('record-url').href=source.url;else $('record-url').removeAttribute('href');
  const body=$('record-body');body.replaceChildren();
  body.append(node('h3','页面信息','section-title'));
  const blocks=(record.page.blocks || []).length;
  const chars=Number(record.page.extractedChars) || 0;
  body.append(node('p',[facts,blocks?`${blocks} 段`:'' ,chars?`${chars} 字`:''].filter(Boolean).join(' · ')||'未记录页面信息','turn-note'));
  if(record.page.url){const a=node('a',record.page.url,'source');a.href=record.page.url;a.target='_blank';a.rel='noopener noreferrer';body.append(a);}
  body.append(node('h3','对话回顾','section-title'));
  renderTurns(body,record.turns);
  renderList();
}
function select(record) {
  if(record.kind==='page'){selectPage(record);return;}
  if(sidebar){selected=record;openThread(record);renderList();return;}
  selected=record;$('empty').hidden=true;$('detail').hidden=false;
  $('record-title').textContent=record.video.title;
  $('record-meta').textContent=`${date(record.updated)} · ${record.turns.length} 轮对话${record.video.author?' · '+record.video.author:''}`;
  const source=safeSource({url:record.video.url});$('record-url').hidden=!source;
  $('record-url').textContent='打开原视频 ↗';
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
function haystack(record) {
  if(record.kind==='page') return [record.title,record.page.host,record.page.author,...record.turns.flatMap(t=>[t.question,t.answer])].join('\n');
  return [record.video.title,record.video.author,record.summary,...record.turns.flatMap(t=>[t.question,t.answer])].join('\n');
}
function renderList() {
  const query=$('filter').value.toLowerCase().trim();
  const shown=records.filter(r=>!query || haystack(r).toLowerCase().includes(query));
  if(mode==='page'){
    $('stats').textContent=`${new Set(records.map(r=>r.page.host).filter(Boolean)).size} 个站点 · ${records.length} 个页面${query?' · 匹配 '+shown.length+' 个':''}`;
  }else{
    $('stats').textContent=`${new Set(records.map(r=>r.videoKey)).size} 个视频 · ${records.length} 段记忆${query?' · 匹配 '+shown.length+' 段':''}`;
  }
  const list=$('records');list.replaceChildren();
  for(const record of shown){
    const page=record.kind==='page';
    const button=node('button','','record'+(selected?.id===record.id?' active':''));
    button.type='button';
    const preview=page
      ? (record.turns.at(-1)?.question || String(record.turns[0]?.answer || '').replace(/[#*>=\-`]/g,' ').trim().slice(0,100) || '只记录了页面，还没有总结')
      : (record.turns.at(-1)?.question || record.summary.slice(0,100));
    button.append(
      node('strong',page?record.title:record.video.title),
      node('p',preview),
      node('small',page?`${date(record.updated)} · ${record.turns.length} 轮 · ${record.page.host || '网页'}`:`${date(record.updated)} · ${record.turns.length} 轮对话`)
    );
    button.addEventListener('click',()=>select(record));
    list.append(button);
  }
  if(!shown.length) list.append(node('p',query?'没有匹配的记忆。':(mode==='page'?'还没有保存的网页记录。侧栏总结过的网页会出现在这里。':'还没有保存的对话。'),'turn-note'));
  for(const id of ['export-all-md','export-all-json']) $(id).disabled=!records.length;
  $('export-one-md').disabled=!selected;
  $('export-one-json').disabled=!selected;
  $('delete-one').disabled=!selected;
}
function storageKey(record) {
  // 网页记录已经带全传 key；视频记录的 key 是固定前缀 + id
  return record.kind === 'page' ? record.key : `video-memory:${record.id}`;
}
async function deleteRecord(record) {
  const name = record.kind === 'page' ? record.title : record.video.title;
  const key = storageKey(record);
  const what = record.kind === 'page' ? '页面' : '视频';
  if (!confirm(`删除这条${what}记录？\n\n「${name}」\n\n本机记录会删掉；已开启罐果云时，云端文件和删除标记一起写，别的浏览器下次同步也会删掉这条。`)) return;
  const line = $('notice');
  const button = $('delete-one');
  button.disabled = true;
  try {
    const status = await chrome.runtime.sendMessage({ type: 'CLOUD_STATUS' }).catch(() => null);
    if (status?.ok && status.configured) {
      if (line) line.textContent = '正在删除（含云端）…';
      const res = await chrome.runtime.sendMessage({ type: 'CLOUD_DELETE', key });
      if (!res?.ok) throw new Error(res?.error || '云端删除失败');
    } else {
      await chrome.storage.local.remove(key);
    }
    selected = null;
    $('detail').hidden = true;
    $('empty').hidden = false;
    await refresh();
    if (line) line.textContent = '已删除。';
  } catch (error) {
    if (line) line.textContent = `删除失败：${error?.message || error}`;
  } finally {
    button.disabled = !selected;
  }
}
async function refresh() {
  $('notice').textContent='正在读取本机记忆…';
  try{
    records=mode==='page'?await listPageMemories():await listMemories();
    $('notice').textContent='';
    renderList();
    if(!sidebar){
      if(selected){
        const fresh=records.find(r=>r.id===selected.id);
        if(fresh)select(fresh);else{selected=null;$('detail').hidden=true;$('empty').hidden=false;renderList();}
      }else if(records.length)select(records[0]);
    }
  }
  catch(error){$('notice').textContent=`读取失败：${error.message || error}。原记录不会被删除。`;}
}
function setMode(next){
  if(next===mode)return;
  mode=next;selected=null;$('detail').hidden=true;$('empty').hidden=false;
  for(const kind of ['video','page']){const tab=$('tab-'+kind);const on=kind===next;tab.classList.toggle('active',on);tab.setAttribute('aria-selected',String(on));}
  $('filter').placeholder=next==='page'?'网页标题、域名、问题或回答…':'视频标题、问题或回答…';
  $('empty-hint').textContent=next==='page'?'网页总结和追问会自动保存到这里。':'视频总结和追问会自动保存到这里。';
  $('eyebrow').textContent=next==='page'?'WEB NOTES':'VIDEO NOTES';
  $('page-title').textContent=next==='page'?'我的阅读记录':'我的视频记忆';
  $('tagline').textContent=next==='page'?'把读过的页面和聊过的问题，留在一起。':'把看过的视频和聊过的问题，留在一起。';
  document.body.dataset.mode=next;
  void refresh();
}
$('filter').addEventListener('input',renderList);
$('refresh').addEventListener('click',refresh);
$('tab-video').addEventListener('click',()=>setMode('video'));
$('tab-page').addEventListener('click',()=>setMode('page'));
for(const format of ['md','json']){
  $(`export-all-${format}`).addEventListener('click',()=>{
    if(!records.length)return;
    const name=mode==='page'?downloadPages(records,format):downloadMemory(records,format);
    if(name)$('notice').textContent=`已导出 ${name} 到浏览器的下载文件夹。`;
  });
  $(`export-one-${format}`).addEventListener('click',()=>{
    if(!selected)return;
    const name=selected.kind==='page'
      ? (format==='json'?downloadPages([selected],'json'):downloadPage(selected))
      : downloadMemory([selected],format);
    if(name)$('notice').textContent=`已导出 ${name} 到浏览器的下载文件夹。`;
  });
}
$('delete-one').addEventListener('click',()=>{if(selected)void deleteRecord(selected);});
let refreshTimer;
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area!=='local')return;
  const keys=Object.keys(changes);
  if(keys.some(k=>k.startsWith('video-memory:')||k.startsWith('reader-page:v1:'))){clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,400);}
});

﻿/** 云端那一行：只在有配置或出错时出现，不占地方 */
async function paintCloud() {
  const line = $('cloud-line');
  if (!line) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'CLOUD_STATUS' });
    if (!res?.ok || !res.configured) { line.hidden = true; return; }
    const st = res.status || {};
    const parts = [];
    if (st.lastSync) parts.push(`上次同步 ${new Date(st.lastSync).toLocaleString('zh-CN', { hour12: false })}`);
    if (st.bytes) parts.push(`${(st.bytes / 1048576).toFixed(2)} MB`);
    parts.push(`子目录 ${res.dir}/${res.deviceId || '自动'}`);
    line.textContent = `坚果云：${parts.join(' · ')}`;
    line.className = 'cloud-line';
    line.hidden = false;
  } catch {
    line.hidden = true;
  }
}

$('btn-cloud').addEventListener('click', async () => {
  const line = $('cloud-line');
  const button = $('btn-cloud');
  const status = await chrome.runtime.sendMessage({ type: 'CLOUD_STATUS' }).catch(() => null);
  if (!status?.ok || !status.configured) {
    if (line) {
      line.textContent = '还没配置坚果云：设置页 → 5 · 坚果云同步';
      line.className = 'cloud-line err';
      line.hidden = false;
    }
    return;
  }
  if (line) { line.textContent = '同步中…'; line.className = 'cloud-line'; line.hidden = false; }
  button.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'CLOUD_SYNC' });
    if (!res?.ok) {
      if (line) { line.textContent = `同步失败：${res?.error || '未知错误'}`; line.className = 'cloud-line err'; }
      return;
    }
    if (line) {
      line.textContent = `同步完成 ✓ 上传 ${res.uploaded} · 下载 ${res.downloaded} · 删除 ${res.removed} · 云端 ${res.files} 条 ${(res.bytes / 1048576).toFixed(2)} MB`;
      line.className = 'cloud-line ok';
    }
    await refresh();
  } catch (error) {
    if (line) { line.textContent = `同步失败：${error?.message || error}`; line.className = 'cloud-line err'; }
  } finally {
    button.disabled = false;
    void paintCloud();
  }
});

void refresh();
void paintCloud();
