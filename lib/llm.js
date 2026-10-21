/**
 * DeepSeek / OpenAI 兼容 流式客户端
 * 同时被 background service worker 与扩展页面使用。
 */

export const DEFAULT_SETTINGS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  // 官方当前支持的模型名：deepseek-flash（即 V4.1-Flash）/ deepseek-v4-pro。
  // deepseek-chat 是旧名，仍可用但已不在官方文档列表内。
  model: 'deepseek-flash',
  temperature: 0.3,
  // deepseek-flash 默认开启思考模式，推理 token 也算在 max_tokens 里，
  // 所以留出余量，避免长视频的精读模式被截断。
  maxTokens: 4096,
  style: 'standard', // brief | standard | detailed
  customPrompt: '',
  searchProvider: 'auto',
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  merged.baseUrl = (merged.baseUrl || '').trim();
  merged.model = (merged.model || '').trim() || DEFAULT_SETTINGS.model;
  return merged;
}

export async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
}

/** 把 baseUrl 归一化成 chat/completions 的完整地址 */
export function chatCompletionsUrl(baseUrl) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) b = DEFAULT_SETTINGS.baseUrl;
  if (!/\/v\d+$/.test(b)) b += '/v1';
  return b + '/chat/completions';
}

/** 从 baseUrl 取出 origin，用于申请可选主机权限 */
export function originOf(baseUrl) {
  try {
    return new URL(baseUrl).origin + '/*';
  } catch {
    return null;
  }
}

/**
 * 流式对话。onDelta(deltaText, fullText)；onReasoning() 在模型输出思考内容时回调。
 *
 * 注意：deepseek-flash 默认开启思考模式，流里会先出现 `reasoning_content` 再出现 `content`。
 * 我们只把 content 累积进正文，reasoning 仅用于驱动"正在思考"提示。
 * @returns {Promise<string>} 完整文本
 */
export async function chatStream({ messages, onDelta, onReasoning, signal, settings }) {
  const cfg = settings || (await getSettings());
  if (!cfg.apiKey) throw new Error('NO_API_KEY');

  const res = await fetch(chatCompletionsUrl(cfg.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      temperature: Number(cfg.temperature) || 0.3,
      max_tokens: Number(cfg.maxTokens) || 3000,
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`接口返回 ${res.status}：${body.slice(0, 300) || res.statusText}`);
  }
  if (!res.body) throw new Error('响应无数据流');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const d = json?.choices?.[0]?.delta || {};
        if (d.reasoning_content) onReasoning?.();
        const delta = d.content;
        if (delta) {
          full += delta;
          onDelta?.(delta, full);
        }
      } catch {
        /* 忽略无法解析的分片 */
      }
    }
  }
  return full;
}

/** 一次性（非流式）调用，用于连通性测试 */
export async function chatOnce({ messages, settings }) {
  const cfg = settings || (await getSettings());
  if (!cfg.apiKey) throw new Error('NO_API_KEY');
  const res = await fetch(chatCompletionsUrl(cfg.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: false,
      temperature: 0,
      // 必须给足余量：deepseek-flash 默认开思考模式，
      // 32 个 token 会被推理全部吃掉，导致正文为空、看起来像"连接成功但没回应"。
      max_tokens: 512,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`接口返回 ${res.status}：${body.slice(0, 300) || res.statusText}`);
  }
  const json = await res.json();
  const msg = json?.choices?.[0]?.message || {};
  return msg.content || (msg.reasoning_content ? '（模型返回了思考内容，未给出正文）' : '');
}
