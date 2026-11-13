import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionStore,pageKey} from '../reader/lib/session.js';
function memory(){const data={};return {data,async get(key){return {[key]:data[key]};},async set(items){Object.assign(data,items);}};}
test('URL memory separates posts and restores across store instances / browser restart',async()=>{
  const storage=memory(),store=createSessionStore(storage);
  const a='https://tieba.baidu.com/p/123?from=bar#floor4';
  const b='https://tieba.baidu.com/p/456?from=bar';
  assert.equal(pageKey(a),'https://tieba.baidu.com/p/123?from=bar');
  await store.save(a,{page:{site:'贴吧',blocks:[]},turns:[{question:'',answer:'A 的总结',complete:true}]});
  await store.save(b,{page:{site:'贴吧',blocks:[]},turns:[{question:'',answer:'B 的总结',complete:true}]});
  const reopened=createSessionStore(storage);
  assert.equal((await reopened.load('https://tieba.baidu.com/p/123?from=bar#another')).turns[0].answer,'A 的总结');
  assert.equal((await reopened.load(b)).turns[0].answer,'B 的总结');
  assert.equal(await reopened.load('https://tieba.baidu.com/p/999'),null);
});
test('snapshot is captured before asynchronous write and incomplete response survives',async()=>{
  const storage=memory(),store=createSessionStore(storage);
  const state={turns:[{question:'为什么？',answer:'部分回答',complete:false,sources:[]}],page:{url:'https://example.com/article'}};
  const saving=store.save('https://example.com/article',state);
  state.turns[0].answer='被下一页覆盖';state.page.url='https://elsewhere.example';
  await saving;
  const restored=await store.load('https://example.com/article');
  assert.equal(restored.turns[0].answer,'部分回答');
  assert.equal(restored.turns[0].complete,false);
  assert.equal(restored.page.url,'https://example.com/article');
});
test('serializes writes to prevent old streaming fragments overwriting completed output',async()=>{
  const storage=memory(),store=createSessionStore(storage),url='https://example.com/article';
  await Promise.all([store.save(url,{turns:[{answer:'片段',complete:false}]}),store.save(url,{turns:[{answer:'已完成',complete:true}]})]);
  assert.equal((await store.load(url)).turns[0].answer,'已完成');
});
