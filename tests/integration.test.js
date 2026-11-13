import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root=new URL('../',import.meta.url);
const load=path=>fs.readFileSync(new URL(path,root),'utf8');

test('single panel router preserves old video interface and delegates text pages',async()=>{
  const listeners={},frames=[],messages=new Set();
  let tab={id:7,url:'https://www.bilibili.com/video/BV0000000000',title:'video'};
  const event=key=>({addListener(fn){listeners[key]=fn;}});
  const body={append(frame){frames.push(frame);}};
  const window={addEventListener(_,fn){messages.add(fn);},removeEventListener(_,fn){messages.delete(fn);}};
  const document={body,querySelector(){return frames.findLast(f=>!f.removed)||null;},getElementById(){return {remove(){},textContent:''};},createElement(){const frame={remove(){this.removed=true;}};frame.contentWindow={postMessage(payload){for(const fn of messages)fn({source:frame.contentWindow,origin:'chrome-extension://test',data:{type:'route-away-done',token:payload.token}});}};return frame;}};
  const chrome={tabs:{query:async()=>[tab],onActivated:event('activated'),onUpdated:event('updated')},windows:{onFocusChanged:event('focus')}};
  vm.runInNewContext(load('panel/router.js'),{chrome,document,window,location:{origin:'chrome-extension://test'},URL,setTimeout,clearTimeout,Math,Date});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(frames.at(-1).src,'panel.html');
  tab={id:8,url:'https://tieba.baidu.com/p/11092190102',title:'text'};
  listeners.activated();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(frames.at(-1).src,'../reader/panel/panel.html');
  assert.equal(frames.at(-2).removed,true);
  tab={id:9,url:'https://github.com/example/repo',title:'docs'};
  listeners.activated();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(frames.length,3);
  tab={id:7,url:'https://www.bilibili.com/video/BV0000000000',title:'video'};
  listeners.activated();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(frames.at(-1).src,'panel.html');
});

test('router waits for old frame to acknowledge saved session before replacing it',async()=>{
  const listeners={},messages=new Set(),frames=[];let tab={id:1,url:'https://github.com/a'};let acknowledge;
  const event=key=>({addListener(fn){listeners[key]=fn;}});
  const window={addEventListener(_,fn){messages.add(fn);},removeEventListener(_,fn){messages.delete(fn);}};
  const document={body:{append(f){frames.push(f);}},querySelector(){return frames.findLast(f=>!f.removed)||null;},getElementById(){return {remove(){}};},createElement(){const frame={remove(){this.removed=true;}};frame.contentWindow={postMessage(payload){acknowledge=()=>{for(const fn of messages)fn({source:frame.contentWindow,origin:'chrome-extension://test',data:{type:'route-away-done',token:payload.token}});};}};return frame;}};
  const chrome={tabs:{query:async()=>[tab],onActivated:event('activate'),onUpdated:event('update')},windows:{onFocusChanged:event('focus')}};
  vm.runInNewContext(load('panel/router.js'),{chrome,document,window,location:{origin:'chrome-extension://test'},URL,setTimeout,clearTimeout,Math,Date});
  await new Promise(resolve=>setImmediate(resolve));
  tab={id:2,url:'https://www.bilibili.com/video/BV001'};listeners.activate();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(frames.length,1);assert.equal(frames[0].removed,undefined);
  acknowledge();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(frames.length,2);assert.equal(frames[0].removed,true);assert.equal(frames[1].src,'panel.html');
});

test('text panel requests current site permission on direct click and stops on denial',async()=>{
  const nodes=new Map(),listeners={};let requested,connected=false;
  const document={getElementById(id){if(!nodes.has(id))nodes.set(id,{textContent:'',value:'auto',classList:{add(){},remove(){},toggle(){}},children:[],replaceChildren(){},querySelector(){return {disabled:false};},addEventListener(name,fn){listeners[id+':'+name]=fn;}});return nodes.get(id);}};
  const chrome={tabs:{query:async()=>[{id:12,url:'https://tieba.baidu.com/p/11092190102',title:'贴吧'}]},permissions:{request(args){requested=args;return Promise.resolve(false);}},storage:{local:{get:async()=>({readerStyle:'standard'}),set:async()=>{}},sync:{get:async()=>({readerMode:'auto'}),set:async()=>{}}},runtime:{connect(){connected=true;}}};
  const store={load:async()=>null,save:async()=>{},flush:async()=>{}};
  vm.runInNewContext(load('reader/panel/panel.js').replace(/^import[^\n]+\n/gm,''),{chrome,document,URL,window:{addEventListener(){}},location:{origin:'chrome-extension://test'},createSessionStore:()=>store,pageKey:url=>url,pagePlainText:()=>'',downloadPage:()=>'x.md'});
  await new Promise(resolve=>setImmediate(resolve));
  listeners['summarize:click']();
  assert.deepEqual(Array.from(requested.origins),['https://tieba.baidu.com/*']);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(nodes.get('status').textContent,/未授予/);
  assert.equal(connected,false);
});

test('text panel sends the chosen depth with the request',async()=>{
  const nodes=new Map(),listeners={};let posted=null;
  const segChildren=['brief','standard','detailed'].map(style=>({dataset:{style},classList:{toggle(){}}}));
  const document={getElementById(id){
    if(!nodes.has(id))nodes.set(id,{textContent:'',value:'auto',disabled:false,classList:{add(){},remove(){},toggle(){}},children:id==='style-seg'?segChildren:[],append(){},replaceChildren(){},querySelector(){return {disabled:false};},addEventListener(name,fn){listeners[id+':'+name]=fn;}});
    return nodes.get(id);
  }};
  document.createElement=()=>({className:'',textContent:'',append(){},scrollIntoView(){},parentElement:{append(){}},replaceChildren(){}});
  const chrome={
    tabs:{query:async()=>[{id:12,url:'https://tieba.baidu.com/p/11092190102',title:'贴吧'}]},
    permissions:{request:async()=>true},
    storage:{local:{get:async()=>({readerStyle:'detailed'}),set:async()=>{}},sync:{get:async()=>({readerMode:'web'}),set:async()=>{}}},
    runtime:{connect(){return {postMessage(payload){posted=payload;},disconnect(){},onMessage:{addListener(){}},onDisconnect:{addListener(){}}};}}
  };
  const store={load:async()=>null,save:async()=>{},flush:async()=>{}};
  vm.runInNewContext(load('reader/panel/panel.js').replace(/^import[^\n]+\n/gm,''),{chrome,document,URL,window:{addEventListener(){}},location:{origin:'chrome-extension://test'},createSessionStore:()=>store,pageKey:url=>url,pagePlainText:()=>'',downloadPage:()=>'x.md'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(nodes.get('mode').value,'web');
  listeners['summarize:click']();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(posted.type,'run');
  assert.equal(posted.style,'detailed');
  assert.equal(posted.mode,'web');
});

test('web depth presets scale task wording, scope and output budget',async()=>{
  const {WEB_STYLE_PRESETS,webStylePreset}=await import('../lib/prompts.js');
  assert.deepEqual(Object.keys(WEB_STYLE_PRESETS),['brief','standard','detailed']);
  assert.equal(webStylePreset('brief').label,'精简');
  assert.equal(webStylePreset('detailed').label,'精读');
  assert.equal(webStylePreset('nonsense').label,'标准');
  assert.ok(WEB_STYLE_PRESETS.brief.maxTokens<WEB_STYLE_PRESETS.standard.maxTokens);
  assert.ok(WEB_STYLE_PRESETS.standard.maxTokens<WEB_STYLE_PRESETS.detailed.maxTokens);
  assert.match(load('reader/panel/panel.html'),/data-style="brief"[\s\S]*data-style="standard"[\s\S]*data-style="detailed"/);
  assert.match(load('reader/background.js'),/webStylePreset\(msg\.style\)/);
  assert.match(load('reader/panel/panel.js'),/readerStyle/);
});

test('text panel renders a page card with site, author and coverage',()=>{
  const html=load('reader/panel/panel.html');
  for(const id of ['page-card','p-mark','p-title','p-sub','p-stats','p-badges'])assert.match(html,new RegExp(`id="${id}"`),id);
  const panel=load('reader/panel/panel.js');
  assert.match(panel,/function renderPageCard/);
  assert.match(panel,/SITE_INFO/);
  assert.match(panel,/classList\.add\('ready'\)/);
  const extract=load('reader/lib/extract.js');
  for(const key of ['author','published','siteStats','hostname'])assert.match(extract,new RegExp(key));
  assert.match(load('reader/panel/panel.css'),/\.page-card\.ready\s*\{\s*display:\s*flex/);
});

test('manifest points at router and registers one shared service worker',()=>{
  const manifest=JSON.parse(load('manifest.json'));
  assert.equal(manifest.side_panel.default_path,'panel/router.html');
  assert.ok(manifest.optional_host_permissions.includes('https://*/*'));
  assert.ok(manifest.host_permissions.includes('https://www.bing.com/*'));
  assert.match(load('background.js'),/import '\.\/reader\/background\.js'/);
  assert.match(load('reader/background.js'),/getSettings/);
  assert.match(load('reader/background.js'),/chatStream/);
  assert.match(load('reader/panel/panel.js'),/chrome\.permissions\.request\(\{origins:\[origin\]\}\)/);
  assert.match(load('reader/panel/panel.js'),/if\(!granted\)/);
  assert.match(load('reader/panel/panel.js'),/tab\.url!==initial\.url/);
  assert.match(load('panel/panel.js'),/COLLECT_VIDEO/);
});
