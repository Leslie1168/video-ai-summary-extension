import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {quickWebDecision,normalizeDecision} from '../reader/lib/decision.js';

test('page-only mode overrides realtime keywords',()=>assert.equal(quickWebDecision('今天有什么新消息','page').web,false));
test('forced web overrides page question',()=>assert.equal(quickWebDecision('这页写了什么','web').web,true));
test('current events trigger web',()=>assert.equal(quickWebDecision('这个项目最新版本是什么').web,true));
test('outside source triggers web',()=>assert.equal(quickWebDecision('去官网核实一下').web,true));
test('page reference stays on page',()=>assert.equal(quickWebDecision('本文作者的主要论点是什么').web,false));
test('ambiguous question falls back to classifier',()=>assert.equal(quickWebDecision('这能实现吗'),null));
test('classifier accepts fenced JSON and rejects malformed',()=>{
 assert.deepEqual(normalizeDecision('```json\n{"needWeb":true,"reason":"需外部信息","query":"github release"}\n```'),{web:true,reason:'需外部信息',query:'github release'});
 assert.equal(normalizeDecision('not json').web,false);
});
test('manifest contains side panel and no broad permanent site permissions',()=>{
 const m=JSON.parse(fs.readFileSync(new URL('../manifest.json',import.meta.url),'utf8'));
 assert.equal(m.manifest_version,3);
 assert.equal(m.background.type,'module');
 assert.ok(m.permissions.includes('activeTab'));
 assert.ok(m.side_panel.default_path);
 assert.ok(!m.host_permissions.some(p=>p.includes('*://*/*')));
});