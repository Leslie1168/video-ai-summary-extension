/**
 * DeepSeek / OpenAI 兼容 流式客户端
 * 同时被 background service worker 与扩展页面使用。
 */

export const DEFAULT_SETTINGS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  // deepseek-flash 当前由官方映射到 DeepSeek-V4.1-Flash-1017。
  // deepseek-chat 是旧名，仍可用但已不在官方文档列表内。
  model: 'deepseek-flash',
  temperature: 0.3,
  // 思考与正文共享输出额度；默认直接回答，并在达到上限时续写。
  maxTokens: 16384,
  reasoningEffort: 'none',
  contextChars: 64000,
  historyTurns: 8,
  webEnabled: true,
  webMode: 'fast',
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
export async function chatStream({ messages, onDelta, onReasoning, onFinish, signal, settings, thinking, maxContinuations = 2, _continuations = 0 }) {
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
      ...(new URL(cfg.baseUrl || DEFAULT_SETTINGS.baseUrl).hostname === 'api.deepseek.com' ? {stream_options:{include_usage:true}} : {}),
      temperature: Number.isFinite(Number(cfg.temperature)) ? Number(cfg.temperature) : 0.3,
      max_tokens: Math.max(512, Math.min(65536, Number(cfg.maxTokens) || 16384)),
      // Only send this provider-specific option to the official DeepSeek API.
      ...(new URL(cfg.baseUrl || DEFAULT_SETTINGS.baseUrl).hostname === 'api.deepseek.com'
        ? { thinking: { type: thinking === false || !cfg.reasoningEffort || cfg.reasoningEffort === 'none' ? 'disabled' : 'enabled' },
            ...(thinking !== false && ['low','high','max'].includes(cfg.reasoningEffort) ? {reasoning_effort:cfg.reasoningEffort} : {}) } : {}),
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
  let finishReason;
  let sawReasoning = false;
  let sawDone = false;
  let usage;
  const consume = line => {
    line = line.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') { sawDone = true; return; }
    if (!payload) return;
    let json;
    try { json = JSON.parse(payload); } catch { return; }
    if (json.error) throw new Error(`模型接口错误：${json.error.message || '未知错误'}`);
    if (json.usage) usage=json.usage;
    const choice = json?.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const d = choice?.delta || {};
    if (d.reasoning_content) { sawReasoning = true; onReasoning?.(); }
    if (typeof d.content === 'string' && d.content) {
      full += d.content;
      onDelta?.(d.content, full);
    }
  };

  try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      consume(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
  signal?.throwIfAborted();
  if (finishReason === 'content_filter') throw new Error('模型接口拦截了本次回答，已保留收到的文字，请调整问题。');
  if (!full.trim()) {
    if (finishReason === 'length') throw new Error(sawReasoning
      ? '模型的输出额度被思考过程耗尽，未生成正文。请增加输出额度或关闭思考模式。'
      : '模型达到输出长度上限，未生成正文。请增加输出额度。');
    throw new Error(sawReasoning ? '模型只返回了思考内容，未生成正文，请重试。' : '模型未返回回答正文，请检查接口和模型设置。');
  }
  if (!finishReason && !sawDone) throw new Error('响应流意外中断，已保留收到的文字，请重试或要求继续。');
  if (finishReason === 'length' && _continuations < maxContinuations) {
    const prefix = full;
    const rest = await chatStream({messages:[...messages,{role:'assistant',content:prefix},
      {role:'user',content:'上一条回答因长度上限中断。只从中断处继续，补完剩余内容，不要重复已写内容。'}],
      settings:cfg, thinking, signal, onReasoning, maxContinuations, _continuations:_continuations+1,
      onFinish:info=>{
        const items=[usage,info.usage].filter(Boolean);
        const combined=items.length?{partial:items.length<2 || !!info.usage?.partial}:undefined;
        if(combined)for(const key of ['prompt_tokens','completion_tokens','total_tokens'])if(items.every(item=>Number.isFinite(item[key])))combined[key]=items.reduce((total,item)=>total+item[key],0);
        onFinish?.({...info,usage:combined});
      },
      onDelta:(_delta, tail) => onDelta?.(_delta, prefix + tail)});
    return prefix + rest;
  }
  onFinish?.({finishReason, truncated:finishReason === 'length', continuations:_continuations,usage});
  return full;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** 一次性（非流式）调用，用于连通性测试 */
export async function chatOnce({ messages, settings, signal, maxTokens = 512 }) {
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
      max_tokens: maxTokens,
      ...(new URL(cfg.baseUrl || DEFAULT_SETTINGS.baseUrl).hostname === 'api.deepseek.com' ? {thinking:{type:'disabled'}} : {}),
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`接口返回 ${res.status}：${body.slice(0, 300) || res.statusText}`);
  }
  const json = await res.json();
  const msg = json?.choices?.[0]?.message || {};
  return msg.content || (msg.reasoning_content ? '（模型返回了思考内容，未给出正文）' : '');
}
