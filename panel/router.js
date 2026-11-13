// Switch the visible view by active tab, saving partial output before replacing its frame.
const VIDEO = /^https?:\/\/([^/]+\.)?bilibili\.com\/(video|list|bangumi\/play)\/|^https?:\/\/([^/]+\.)?douyin\.com\//i;
let currentKey='',epoch=0;
function identity(url){try{const parsed=new URL(url);parsed.hash='';return parsed.href;}catch{return url||'';}}
function handoff(frame){return new Promise(resolve=>{
  const token=`${Date.now()}:${Math.random()}`;
  const timer=setTimeout(done,1400);
  function done(){clearTimeout(timer);window.removeEventListener('message',onMessage);resolve();}
  function onMessage(event){if(event.source===frame.contentWindow&&event.origin===location.origin&&event.data?.type==='route-away-done'&&event.data.token===token)done();}
  window.addEventListener('message',onMessage);
  try{frame.contentWindow.postMessage({type:'route-away',token},location.origin);}catch{done();}
});}
async function route(){
  const myEpoch=++epoch;
  let tab;
  try{[tab]=await chrome.tabs.query({active:true,currentWindow:true});}
  catch(error){document.getElementById('message').textContent=error.message;return;}
  if(myEpoch!==epoch)return;
  const key=`${tab?.id||''}:${identity(tab?.url)}`;
  if(key===currentKey)return;
  const old=document.querySelector('#screen');
  if(old){await handoff(old);if(myEpoch!==epoch)return;old.remove();}
  currentKey=key;
  const frame=document.createElement('iframe');frame.id='screen';frame.title='当前网页 AI 阅读侧栏';
  frame.src=VIDEO.test(tab?.url||'')?'panel.html':'../reader/panel/panel.html';
  document.getElementById('message')?.remove();document.body.append(frame);
}
chrome.tabs.onActivated.addListener(route);
chrome.tabs.onUpdated.addListener((_tabId,change)=>{if(change.url||change.status==='complete')route();});
chrome.windows.onFocusChanged.addListener(route);
route();
