/**
 * Background service worker
 * 职责：侧边栏行为、AI 请求代理（流式）、追问对话（Port）代理、权限申请、连通性测试。
 */
import { chatStream, chatOnce, getSettings, originOf } from './lib/llm.js';
import { buildMessages } from './lib/prompts.js';
import { registerChatPort } from './lib/chat-background.js';

registerChatPort();

// 点击工具栏图标直接打开侧边栏
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn('[视频AI总结] 侧边栏设置失败', err));
});
chrome.sidePanel
  ?.setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

const activeStreams = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'summarize') return;

  const controller = new AbortController();
  activeStreams.set(port, controller);

  port.onDisconnect.addListener(() => {
    controller.abort();
    activeStreams.delete(port);
  });

  port.onMessage.addListener(async (msg) => {
    if (msg?.type === 'abort') {
      controller.abort();
      return;
    }
    if (msg?.type !== 'start') return;

    try {
      const settings = await getSettings();
      if (!settings.apiKey) throw new Error('NO_API_KEY');

      const messages = buildMessages(msg.video, {
        style: msg.style || settings.style,
        customPrompt: msg.customPrompt ?? settings.customPrompt,
        contextChars: settings.contextChars,
      });

      let completion;
      const text = await chatStream({
        messages,
        settings,
        onFinish:info => {completion = info;},
        signal: controller.signal,
        onReasoning: () => {
          try {
            port.postMessage({ type: 'thinking' });
          } catch {
            controller.abort();
          }
        },
        onDelta: (delta, full) => {
          try {
            port.postMessage({ type: 'delta', delta, full });
          } catch {
            controller.abort();
          }
        },
      });

      port.postMessage({ type: 'done', full: text, truncated:completion?.truncated });
    } catch (err) {
      const aborted = err?.name === 'AbortError' || controller.signal.aborted;
      if (!aborted) {
        port.postMessage({ type: 'error', error: err?.message || String(err) });
      } else {
        try {
          port.postMessage({ type: 'aborted' });
        } catch {
          /* port 已关闭 */
        }
      }
    }
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'TEST_CONNECTION') {
        const settings = { ...(await getSettings()), ...(msg.settings || {}) };
        const reply = await chatOnce({
          settings,
          messages: [{ role: 'user', content: '回复两个字：正常' }],
        });
        sendResponse({ ok: true, reply });
        return;
      }

      if (msg?.type === 'ENSURE_ORIGIN_PERMISSION') {
        const origin = originOf(msg.baseUrl);
        if (!origin) {
          sendResponse({ ok: false, error: 'Base URL 格式不正确' });
          return;
        }
        const granted = await chrome.permissions.request({ origins: [origin] });
        sendResponse({ ok: granted, origin });
        return;
      }

      sendResponse({ ok: false, error: '未知消息类型' });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true; // 异步响应
});
