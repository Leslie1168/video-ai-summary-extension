import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../lib/llm.js';

const $ = (id) => document.getElementById(id);

const fields = {
  apiKey: $('apiKey'),
  baseUrl: $('baseUrl'),
  model: $('model'),
  style: $('style'),
  temperature: $('temperature'),
  customPrompt: $('customPrompt'),
  searchProvider: $('searchProvider'),
};

const tempOut = $('temperature-out');
const testResult = $('test-result');
const saveResult = $('save-result');

const flash = (node, text, cls) => {
  node.textContent = text;
  node.className = cls;
};

async function load() {
  const [s, local] = await Promise.all([getSettings(), chrome.storage.local.get('tavilyKey')]);
  fields.apiKey.value = s.apiKey || '';
  fields.baseUrl.value = s.baseUrl || DEFAULT_SETTINGS.baseUrl;
  fields.model.value = s.model || DEFAULT_SETTINGS.model;
  fields.style.value = s.style || 'standard';
  fields.temperature.value = String(s.temperature ?? 0.3);
  tempOut.textContent = Number(fields.temperature.value).toFixed(1);
  fields.customPrompt.value = s.customPrompt || '';
  fields.searchProvider.value = s.searchProvider || 'auto';
  $('tavilyKey').value = local.tavilyKey || '';
}

fields.temperature.addEventListener('input', () => {
  tempOut.textContent = Number(fields.temperature.value).toFixed(1);
});

$('toggle-key').addEventListener('click', (e) => {
  const isPwd = fields.apiKey.type === 'password';
  fields.apiKey.type = isPwd ? 'text' : 'password';
  e.target.textContent = isPwd ? '隐藏' : '显示';
});

function collect() {
  return {
    apiKey: fields.apiKey.value.trim(),
    baseUrl: fields.baseUrl.value.trim() || DEFAULT_SETTINGS.baseUrl,
    model: fields.model.value.trim() || DEFAULT_SETTINGS.model,
    style: fields.style.value,
    temperature: Number(fields.temperature.value),
    customPrompt: fields.customPrompt.value.trim(),
    searchProvider: fields.searchProvider.value,
  };
}

/** 自定义 Base URL 时申请对应主机权限 */
async function ensurePermission(baseUrl) {
  const def = DEFAULT_SETTINGS.baseUrl;
  try {
    if (new URL(baseUrl).origin === new URL(def).origin) return true;
  } catch {
    return false;
  }
  const res = await chrome.runtime.sendMessage({
    type: 'ENSURE_ORIGIN_PERMISSION',
    baseUrl,
  });
  return !!res?.ok;
}

$('btn-save').addEventListener('click', async () => {
  const patch = collect();

  if (!patch.apiKey) {
    flash(saveResult, '请先填写 API Key', 'save-result err');
    return;
  }

  const allowed = await ensurePermission(patch.baseUrl);
  if (!allowed) {
    flash(
      saveResult,
      '已保存其它设置，但未授权访问该接口地址，调用时会失败。请重试并允许权限。',
      'save-result err'
    );
  }

  await saveSettings(patch);
  await chrome.storage.local.set({tavilyKey:$('tavilyKey').value.trim()});
  flash(saveResult, '已保存 ✓', 'save-result ok');
  setTimeout(() => (saveResult.textContent = ''), 2500);
});

$('btn-test').addEventListener('click', async () => {
  const patch = collect();
  if (!patch.apiKey) {
    flash(testResult, '请先填写 API Key', 'test-result err');
    return;
  }

  const allowed = await ensurePermission(patch.baseUrl);
  if (!allowed) {
    flash(testResult, '未获得该接口地址的访问权限', 'test-result err');
    return;
  }

  flash(testResult, '测试中…', 'test-result');
  $('btn-test').disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', settings: patch });
    if (res?.ok) {
      flash(testResult, `连接正常 ✓ 模型回复：${String(res.reply).slice(0, 30)}`, 'test-result ok');
    } else {
      flash(testResult, `失败：${res?.error || '未知错误'}`, 'test-result err');
    }
  } catch (err) {
    flash(testResult, `失败：${err?.message || err}`, 'test-result err');
  } finally {
    $('btn-test').disabled = false;
  }
});

load();
