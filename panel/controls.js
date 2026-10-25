import {getSettings, saveSettings} from '../lib/llm.js';
export let pendingSettings = Promise.resolve();
export async function initControls() {
  const keys = ['webMode','reasoningEffort','contextChars','historyTurns','maxTokens'];
  const cfg = await getSettings();
  for (const key of keys) {
    const node = document.getElementById(key);
    node.value = String(cfg[key]);
    node.addEventListener('change', () => {
      const value = ['reasoningEffort','webMode'].includes(key) ? node.value : Number(node.value);
      pendingSettings = pendingSettings.catch(() => {}).then(() => saveSettings({[key]:value}));
      pendingSettings.then(() => {document.getElementById('ai-save-status').textContent='已保存';}, () => {document.getElementById('ai-save-status').textContent='保存失败，请重试';});
    });
  }
}
