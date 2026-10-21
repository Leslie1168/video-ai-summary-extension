/**
 * 总结提示词引擎：把 VideoData 组装成高质量的中文总结任务。
 */

export const STYLE_PRESETS = {
  brief: { label: '速览', hint: '只要结论，控制在 200 字以内，要点不超过 3 条。' },
  standard: { label: '标准', hint: '要点 4-7 条，兼顾信息量与可读性。' },
  detailed: { label: '精读', hint: '要点 8-15 条，尽量保留细节、数据、案例与论证链条。' },
};

const SYSTEM_PROMPT = `你是一位资深的内容分析师，擅长把长视频压缩成可信、可直接阅读的笔记。

## 硬性要求
1. 只依据【素材】说话。素材里没有的人名、数据、结论一律不许编造；无法判断的地方直接写"素材未提及"。
2. 【素材】里如果混有弹幕、评论等观众发言，它们属于"观众反应"，不能当成视频作者的观点。必须把两者分开。
3. 语言用简体中文，口语但要精炼，不要写"本视频主要讲述了……"这类废话开场。
4. 当素材带时间戳（形如 [03:12]）时，在要点后面附上对应时间戳，方便回看。宁缺毋滥，不要硬凑。
5. 输出严格使用下面的 Markdown 结构，不要增删一级标题。`;

function styleHint(style) {
  return (STYLE_PRESETS[style] || STYLE_PRESETS.standard).hint;
}

/** 把时间戳秒数格式化为 mm:ss */
export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/**
 * 组装发给模型的消息
 * @param {object} video 内容脚本采集到的 VideoData
 * @param {object} opts  { style, customPrompt }
 */
export function buildMessages(video, opts = {}) {
  const style = opts.style || 'standard';
  const parts = [];

  parts.push('## 视频基本信息');
  parts.push(`- 平台：${video.platform === 'bilibili' ? '哔哩哔哩' : '抖音'}`);
  parts.push(`- 标题：${video.title || '（无标题）'}`);
  if (video.author) parts.push(`- 作者：${video.author}`);
  if (video.publishTime) parts.push(`- 发布时间：${video.publishTime}`);
  if (video.duration) parts.push(`- 时长：${fmtTime(video.duration)}`);
  if (video.hashtags?.length) parts.push(`- 话题标签：${video.hashtags.join('、')}`);
  if (video.stats) {
    const s = Object.entries(video.stats)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${k} ${v}`)
      .join(' / ');
    if (s) parts.push(`- 数据：${s}`);
  }
  if (video.desc) {
    parts.push('');
    parts.push('### 视频文案 / 简介');
    parts.push(video.desc.slice(0, 2000));
  }

  // 主体素材
  if (video.subtitleLines?.length) {
    const via = video.subtitleChannel ? `，来源：${video.subtitleChannel}` : '';
    const warn = (video.subtitleChannel || '').includes('未签名')
      ? '（该来源未经 WBI 签名，可能被风控降级返回其它视频的字幕，若内容与标题明显无关请一律标注"素材存疑"）'
      : '';
    parts.push('');
    parts.push(`### 视频字幕全文（含时间戳，共 ${video.subtitleLines.length} 句${via}）${warn}`);
    parts.push(
      video.subtitleLines
        .map((l) => `[${fmtTime(l.from)}] ${l.text}`)
        .join('\n')
        .slice(0, 22000)
    );
  } else if (video.transcript) {
    parts.push('');
    parts.push('### 视频转录文本');
    parts.push(String(video.transcript).slice(0, 22000));
  }

  if (video.danmaku?.length) {
    parts.push('');
    parts.push(`### 弹幕采样（观众实时反应，共 ${video.danmaku.length} 条）`);
    parts.push(video.danmaku.join(' / ').slice(0, 2500));
  }
  if (video.comments?.length) {
    parts.push('');
    parts.push(`### 热门评论（观众观点，共 ${video.comments.length} 条）`);
    parts.push(video.comments.map((c, i) => `${i + 1}. ${c}`).join('\n').slice(0, 2500));
  }

  if (!video.subtitleLines?.length && !video.transcript) {
    parts.push('');
    parts.push('> 注意：本条视频没有可用字幕。请基于标题、文案、弹幕与评论做**谨慎推断**，并在摘要开头用一句话注明"无字幕，以下基于文案与观众反馈推断"。');
  }

  const user = [
    ...parts,
    '',
    `## 任务`,
    `请阅读以上素材，输出一份结构化中文总结。篇幅要求：${styleHint(style)}`,
    opts.customPrompt ? `\n## 额外要求（优先级最高）\n${opts.customPrompt}` : '',
    '',
    '## 输出格式（严格遵守）',
    '### 🎯 一句话总结',
    '<一句话，40 字以内>',
    '',
    '### 📌 核心要点',
    '- [时间戳] 要点',
    '（按视频推进顺序排列）',
    '',
    '### 🔍 关键信息',
    '- 涉及的人名 / 产品 / 数据 / 结论',
    '（没有就写"素材未提及"）',
    '',
    '### 🗣️ 观众视角',
    '- 弹幕与评论区的主要反应、争议点、补充信息',
    '（没有相关素材就写"无"）',
    '',
    '### 👤 适合谁看',
    '<一两句话>',
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** 粗略估算 token（中文约 1 字 ≈ 0.7 token） */
export function estimateTokens(video) {
  const text =
    (video.subtitleLines?.map((l) => l.text).join('') || '') +
    (video.transcript || '') +
    (video.desc || '') +
    (video.danmaku?.join('') || '') +
    (video.comments?.join('') || '');
  return Math.round(text.length * 0.7);
}
