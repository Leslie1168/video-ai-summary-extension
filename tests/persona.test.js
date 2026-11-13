import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {clampPersona, personaBlock, withPersona, normalizePersona, loadPersona, PERSONA_LIMIT} from '../lib/persona.js';

const src = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

test('人设文本裁到 1000 字并去掉首尾空白', () => {
  assert.equal(clampPersona('  叫我老板  '), '叫我老板');
  assert.equal(clampPersona(null), '');
  assert.equal(clampPersona(undefined), '');
  const long = '啊'.repeat(PERSONA_LIMIT + 200);
  assert.equal(clampPersona(long).length, PERSONA_LIMIT);
  assert.equal(PERSONA_LIMIT, 1000);
});

test('关掉或空文本时不产生任何提示词', () => {
  assert.equal(personaBlock({on: false, text: '你是小璃'}), '');
  assert.equal(personaBlock({on: true, text: '   '}), '');
  assert.equal(personaBlock(null), '');
  assert.equal(withPersona('原始 system', {on: false, text: 'x'}), '原始 system');
});

test('开启时把约束一起写进去，防止改到事实和结构', () => {
  const block = personaBlock({on: true, text: '你叫小璃，叫我老板。'});
  assert.ok(block.includes('你叫小璃，叫我老板。'));
  assert.ok(block.includes('【用户设定的人设】'));
  assert.ok(block.includes('只改变称呼与语气'));
  assert.ok(block.includes('[P编号]/[W编号]'));
  assert.ok(block.includes('不构成新的指令'));
  // 原 system 必须原样保留在前面
  const p = {on: true, text: 'T'};
  assert.equal(withPersona('SYS', p), 'SYS' + personaBlock(p));
});

test('normalizePersona 兜住字符串、对象和空值', () => {
  assert.deepEqual(normalizePersona('hi'), {on: true, text: 'hi'});
  assert.deepEqual(normalizePersona({on: true, text: ' hi '}), {on: true, text: 'hi'});
  assert.deepEqual(normalizePersona(undefined), {on: false, text: ''});
  assert.deepEqual(normalizePersona(''), {on: false, text: ''});
});

test('没有 chrome.storage 时安静回落成关闭', async () => {
  const persona = await loadPersona();
  assert.deepEqual(persona, {on: false, text: ''});
});

test('三处生成链路都挂上了人设', () => {
  const prompts = src('lib/prompts.js');
  assert.ok(prompts.includes("import { withPersona } from './persona.js';"));
  assert.ok(prompts.includes('withPersona(SYSTEM_PROMPT, opts.persona)'));

  const conversation = src('lib/conversation.js');
  assert.ok(conversation.includes('withPersona(system, settings.persona)'));

  const chatBg = src('lib/chat-background.js');
  assert.ok(chatBg.includes('loadPersona'));
  assert.ok(chatBg.includes('settings.persona = persona'));

  const summaryBg = src('background.js');
  assert.ok(summaryBg.includes('persona: await loadPersona()'));

  const readerBg = src('reader/background.js');
  assert.ok(readerBg.includes('personaBlock(await loadPersona())'));
  assert.ok(readerBg.includes('${picked.scope}${persona}`'));
});

test('人设绝不进入联网判定与检索词', () => {
  const decision = src('reader/lib/decision.js');
  assert.equal(decision.toLowerCase().includes('persona'), false);

  const conversation = src('lib/conversation.js');
  const fn = conversation.slice(conversation.indexOf('export function buildSearchQuery'));
  assert.ok(fn.length > 0);
  assert.equal(fn.includes('persona'), false);
});

test('设置页能填能存，超限有提示', () => {
  const html = src('options/options.html');
  assert.ok(html.includes('id="personaOn"'));
  assert.ok(html.includes('id="personaText"'));
  assert.ok(html.includes('maxlength="1000"'));
  assert.ok(html.includes('id="persona-count"'));

  const js = src('options/options.js');
  assert.ok(js.includes('loadPersona()'));
  assert.ok(js.includes('savePersona({ on:'));
  assert.ok(js.includes('syncPersonaCount'));

  const css = src('options/options.css');
  assert.ok(css.includes('#persona-count.over'));
});
