import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../lib/llm.js';
import { getConfig, saveConfig, ready, CLOUD_DEFAULTS } from '../lib/cloudsync.js';
import { loadPersona, savePersona, PERSONA_LIMIT } from '../lib/persona.js';

const $ = (id) => document.getElementById(id);

const fields = {
  webMode: $('webMode'), reasoningEffort: $('reasoningEffort'), contextChars: $('contextChars'), historyTurns: $('historyTurns'), maxTokens: $('maxTokens'),
  apiKey: $('apiKey'),
  baseUrl: $('baseUrl'),
  model: $('model'),
  style: $('style'),
  temperature: $('temperature'),
  customPrompt: $('customPrompt'),
  searchProvider: $('searchProvider'),
  themeMode: $('themeMode'),
  uiFontSize: $('uiFontSize'),
  uiLineHeight: $('uiLineHeight'),
  uiFontWeight: $('uiFontWeight'),
  uiHeadingWeight: $('uiHeadingWeight'),
};

const UI_DEFAULTS = { themeMode: 'auto', uiFontSize: 14, uiLineHeight: 1.75, uiFontWeight: 400, uiHeadingWeight: 650 };

const tempOut = $('temperature-out');
const testResult = $('test-result');
const saveResult = $('save-result');

const flash = (node, text, cls) => {
  node.textContent = text;
  node.className = cls;
};

function syncPersonaCount() {
  const box = $('personaText');
  const out = $('persona-count');
  if (!box || !out) return;
  out.textContent = String(box.value.length);
  out.classList.toggle('over', box.value.length >= PERSONA_LIMIT);
}

$('personaText').addEventListener('input', syncPersonaCount);

async function load() {
  const [s, local, ui, persona] = await Promise.all([
    getSettings(),
    chrome.storage.local.get('tavilyKey'),
    chrome.storage.sync.get(UI_DEFAULTS),
    loadPersona(),
  ]);
  for (const k of ['webMode','reasoningEffort','contextChars','historyTurns','maxTokens']) fields[k].value=String(s[k] ?? DEFAULT_SETTINGS[k]);
  fields.apiKey.value = s.apiKey || '';
  fields.baseUrl.value = s.baseUrl || DEFAULT_SETTINGS.baseUrl;
  fields.model.value = s.model || DEFAULT_SETTINGS.model;
  fields.style.value = s.style || 'standard';
  fields.temperature.value = String(s.temperature ?? 0.3);
  tempOut.textContent = Number(fields.temperature.value).toFixed(1);
  fields.customPrompt.value = s.customPrompt || '';
  fields.searchProvider.value = s.searchProvider || 'auto';
  for (const k of ['themeMode', 'uiFontSize', 'uiLineHeight', 'uiFontWeight', 'uiHeadingWeight']) {
    fields[k].value = String(ui[k] ?? UI_DEFAULTS[k]);
  }
  $('tavilyKey').value = local.tavilyKey || '';
  $('personaOn').checked = !!persona.on;
  $('personaText').value = persona.text || '';
  syncPersonaCount();
  const cloud = await getConfig();
  $('davUrl').value = cloud.davUrl || CLOUD_DEFAULTS.davUrl;
  $('davUser').value = cloud.davUser || '';
  $('davPass').value = cloud.davPass || '';
  $('davDir').value = cloud.davDir || CLOUD_DEFAULTS.davDir;
  $('davDevice').value = cloud.davDevice || '';
  $('davLimitMB').value = String(cloud.davLimitMB || CLOUD_DEFAULTS.davLimitMB);
  $('davAuto').checked = cloud.davAuto !== false;
  $('dav-device-id').textContent = cloud.davDeviceId
    ? `云端子目录：${cloud.davDir}/${cloud.davDeviceId}`
    : '第一次保存或测试时自动生成，只在本机生效。';
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
    webMode:fields.webMode.value,reasoningEffort:fields.reasoningEffort.value,contextChars:Number(fields.contextChars.value),historyTurns:Number(fields.historyTurns.value),maxTokens:Number(fields.maxTokens.value),
    apiKey: fields.apiKey.value.trim(),
    baseUrl: fields.baseUrl.value.trim() || DEFAULT_SETTINGS.baseUrl,
    model: fields.model.value.trim() || DEFAULT_SETTINGS.model,
    style: fields.style.value,
    temperature: Number(fields.temperature.value),
    customPrompt: fields.customPrompt.value.trim(),
    searchProvider: fields.searchProvider.value,
    themeMode: fields.themeMode.value,
    uiFontSize: Number(fields.uiFontSize.value),
    uiLineHeight: Number(fields.uiLineHeight.value),
    uiFontWeight: Number(fields.uiFontWeight.value),
    uiHeadingWeight: Number(fields.uiHeadingWeight.value),
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
  await savePersona({ on: $('personaOn').checked, text: $('personaText').value });
  await chrome.storage.local.set({tavilyKey:$('tavilyKey').value.trim()});
  const cloudPatch = cloudFields();
  if (cloudPatch.davUser || cloudPatch.davPass) {
    await saveConfig(cloudPatch);
  } else {
    await saveConfig({ davUrl: cloudPatch.davUrl, davDir: cloudPatch.davDir, davDevice: cloudPatch.davDevice, davLimitMB: cloudPatch.davLimitMB, davAuto: cloudPatch.davAuto });
  }
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

/** 坚果云那一栏的当前值 */
function cloudFields() {
  return {
    davUrl: $('davUrl').value.trim() || CLOUD_DEFAULTS.davUrl,
    davUser: $('davUser').value.trim(),
    davPass: $('davPass').value,
    davDir: $('davDir').value.trim() || CLOUD_DEFAULTS.davDir,
    davDevice: $('davDevice').value.trim(),
    davLimitMB: Number($('davLimitMB').value) || CLOUD_DEFAULTS.davLimitMB,
    davAuto: $('davAuto').checked,
  };
}

$('toggle-dav-pass').addEventListener('click', (event) => {
  const input = $('davPass');
  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';
  event.target.textContent = isPassword ? '隐藏' : '显示';
});

/** 坚果云不给 CORS 头，必须让后台拿这个域名的持久权限 */
async function ensureDavPermission(url) {
  try {
    const origin = new URL(url).origin;
    const pattern = `${origin}/*`;
    const has = await chrome.permissions.contains({ origins: [pattern] });
    if (has) return true;
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

$('btn-dav-test').addEventListener('click', async () => {
  const patch = cloudFields();
  const result = $('dav-result');
  if (!patch.davUser || !patch.davPass) {
    flash(result, '先填账号和应用密码', 'save-result err');
    return;
  }
  const allowed = await ensureDavPermission(patch.davUrl);
  if (!allowed) {
    flash(result, '没给坚果云域名的访问权限，连不上', 'save-result err');
    return;
  }
  flash(result, '连接中…', 'save-result');
  $('btn-dav-test').disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'CLOUD_TEST', config: patch });
    if (res?.ok) {
      await saveConfig(patch);
      $('dav-device-id').textContent = `云端子目录：${res.folder}/${res.device}`;
      const mb = (res.bytes / 1048576).toFixed(2);
      flash(result, `连接正常 ✓ 云端 ${res.files} 条 · ${mb} MB`, 'save-result ok');
    } else {
      flash(result, `失败：${res?.error || '未知错误'}`, 'save-result err');
    }
  } catch (err) {
    flash(result, `失败：${err?.message || err}`, 'save-result err');
  } finally {
    $('btn-dav-test').disabled = false;
  }
});

$('btn-dav-sync').addEventListener('click', async () => {
  const patch = cloudFields();
  const result = $('dav-result');
  if (!ready(patch)) {
    flash(result, '先填账号和应用密码', 'save-result err');
    return;
  }
  const allowed = await ensureDavPermission(patch.davUrl);
  if (!allowed) {
    flash(result, '没给坚果云域名的访问权限，连不上', 'save-result err');
    return;
  }
  flash(result, '同步中…', 'save-result');
  $('btn-dav-sync').disabled = true;
  try {
    await saveConfig(patch);
    const res = await chrome.runtime.sendMessage({ type: 'CLOUD_SYNC', config: patch });
    if (res?.ok) {
      const mb = (res.bytes / 1048576).toFixed(2);
      flash(
        result,
        `同步完成 ✓ 上传 ${res.uploaded} · 下载 ${res.downloaded} · 删除 ${res.removed} · 云端 ${res.files} 条 ${mb} MB`,
        'save-result ok'
      );
    } else {
      flash(result, `失败：${res?.error || '未知错误'}`, 'save-result err');
    }
  } catch (err) {
    flash(result, `失败：${err?.message || err}`, 'save-result err');
  } finally {
    $('btn-dav-sync').disabled = false;
  }
});

load();
