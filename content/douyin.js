/**
 * 抖音 隔离世界 内容脚本：消费钩子捕获的数据 + DOM 兜底
 */
(() => {
  const VB = window.__VB;
  if (!VB) return;
  VB.PLATFORM = 'douyin';

  const CHANNEL = '__VB_CAPTURE__';
  const CMT_LIMIT = 30;

  /** 捕获缓存 */
  const cache = {
    awemes: [],
    captions: [],
    at: 0,
  };
  let waiters = [];

  window.addEventListener('message', (ev) => {
    // 只接受本窗口的钩子消息（source 为空时放行，避免个别环境下被误丢弃）
    if (ev.source && ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.channel !== CHANNEL) return;

    if (msg.kind === 'aweme') {
      const list = collectAwemes(msg.payload);
      if (list.length) {
        cache.awemes.push(...list);
        cache.at = Date.now();
        flush();
      }
    } else if (msg.kind === 'caption') {
      if (msg.payload?.text && !cache.captions.some((c) => c.url === msg.payload.url)) {
        cache.captions.push(msg.payload);
        flush();
      }
    }
  });

  const flush = () => {
    const list = waiters;
    waiters = [];
    list.forEach((fn) => fn());
  };

  /** 从任意嵌套 JSON 里把所有 aweme 对象挖出来 */
  function collectAwemes(root) {
    const out = [];
    const seen = new WeakSet();
    const stack = [root];
    let guard = 0;
    while (stack.length && guard++ < 20000) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const n of node) stack.push(n);
        continue;
      }
      if (node.aweme_id && (node.desc !== undefined || node.video || node.statistics)) {
        out.push(node);
        continue;
      }
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return out;
  }

  /** 从 aweme 对象里挖字幕轨 */
  function findCaptionTracks(root) {
    const found = [];
    const seen = new WeakSet();
    const stack = [root];
    let guard = 0;
    while (stack.length && guard++ < 20000) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const n of node) stack.push(n);
        continue;
      }
      const keys = Object.keys(node);
      let url = node.url ?? node.Url ?? node.caption_url ?? node.url_list;
      if (Array.isArray(url)) url = url[0];
      if (typeof url === 'string' && url) {
        const looksCaption = /\.(webvtt|vtt|srt)(\?|$)/i.test(url) || /caption|subtitle/i.test(url);
        const hasLang = typeof node.lang === 'string' || typeof node.language === 'string' || typeof node.lan === 'string';
        const looksVideo = /\.(mp4|m3u8|jpe?g|png|webp|heic)(\?|$)/i.test(url);
        if ((looksCaption || (hasLang && !looksVideo)) && !looksVideo) {
          found.push({
            url,
            lang: node.lang || node.language || node.lan || '',
            format: node.caption_format || node.format || '',
          });
        }
      }
      for (const k of keys) {
        const v = node[k];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return found;
  }

  function currentId() {
    const m =
      location.href.match(/\/video\/(\d{6,})/) ||
      location.href.match(/[?&]modal_id=(\d{6,})/) ||
      location.href.match(/\/note\/(\d{6,})/);
    return m ? m[1] : '';
  }

  function pickAweme() {
    const id = currentId();
    if (id) {
      const hit = cache.awemes.find((a) => String(a.aweme_id) === id);
      if (hit) return hit;
    }
    return cache.awemes[0] || null;
  }

  /** 等钩子把数据送过来 */
  function waitForData(timeout = 5000) {
    if (pickAweme()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeout);
      waiters.push(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }

  // ---------------- DOM 兜底 ----------------

  const DESC_SEL = [
    '[data-e2e="video-desc"]',
    '[data-e2e="detail-video-desc"]',
    '[data-e2e="note-desc"]',
    '.video-info-detail h1',
  ];
  const AUTHOR_SEL = [
    '[data-e2e="user-name"]',
    '[data-e2e="detail-video-user-name"]',
    '[data-e2e="video-author-name"]',
    '.account-name',
  ];
  const TITLE_SEL = ['[data-e2e="video-title"]', '.video-title'];

  function domDesc() {
    // 优先整块文案容器，其次标题
    const el =
      DESC_SEL.map((s) => document.querySelector(s)).find(Boolean) ||
      TITLE_SEL.map((s) => document.querySelector(s)).find(Boolean);
    return VB.cleanText(el?.innerText || el?.textContent);
  }

  function domAuthor() {
    const el = AUTHOR_SEL.map((s) => document.querySelector(s)).find(Boolean);
    return VB.cleanText(el?.innerText || el?.textContent);
  }

  function domComments() {
    const nodes = document.querySelectorAll(
      '[data-e2e="comment-item"], [data-e2e="comment-item-content"], .comment-item'
    );
    const out = [];
    for (const n of nodes) {
      const t = VB.cleanText(n.innerText || n.textContent);
      if (t && t.length >= 4 && t.length <= 400) out.push(t);
      if (out.length >= CMT_LIMIT) break;
    }
    return out;
  }

  function domStat() {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      return VB.cleanText(el?.innerText || el?.textContent) || null;
    };
    return {
      点赞: pick('[data-e2e="video-like-count"]'),
      评论: pick('[data-e2e="comment-count"]'),
      收藏: pick('[data-e2e="video-collect-count"]'),
      分享: pick('[data-e2e="video-share-count"]'),
    };
  }

  // ---------------- 主流程 ----------------

  function parseHashTags(desc) {
    const tags = [];
    const re = /#([^\s#]{1,24})/g;
    let m;
    while ((m = re.exec(desc || '')) !== null) tags.push(m[1]);
    return tags;
  }

  async function collect() {
    await waitForData(5000);

    const aweme = pickAweme();
    const notes = [];
    const sources = { subtitle: false, danmaku: false, comments: false };

    let title = '';
    let desc = '';
    let author = '';
    let duration = 0;
    let publishTime = '';
    let hashtags = [];
    let stats = {};
    let cover = '';
    let subtitleLines = [];

    if (aweme) {
      desc = VB.cleanText(aweme.desc || '');
      author = VB.cleanText(aweme.author?.nickname || '');
      title = desc || VB.cleanText(aweme.item_title || '');
      duration = aweme.video?.duration ? Math.round(aweme.video.duration / 1000) : 0;
      publishTime = aweme.create_time ? new Date(aweme.create_time * 1000).toLocaleDateString('zh-CN') : '';
      hashtags = (aweme.text_extra || []).map((t) => t.hashtag_name).filter(Boolean);
      const st = aweme.statistics || {};
      stats = {
        点赞: st.digg_count,
        评论: st.comment_count,
        收藏: st.collect_count,
        分享: st.share_count,
        播放: st.play_count,
      };
      cover = VB.absUrl(aweme.video?.cover?.url_list?.[0] || aweme.video?.origin_cover?.url_list?.[0] || '');

      // 字幕轨
      const tracks = findCaptionTracks(aweme);
      const picked = tracks.find((t) => /^zh|^ai-zh/i.test(t.lang)) || tracks[0];
      if (picked) {
        try {
          let text = '';
          const cached = cache.captions.find((c) => c.url === picked.url);
          if (cached) text = cached.text;
          else text = await VB.fetchText(picked.url);
          subtitleLines = VB.parseVtt(text);
          sources.subtitle = subtitleLines.length > 0;
        } catch {
          notes.push('发现了字幕轨但下载失败，已改用文案与评论。');
        }
      }
    }

    // 直接捕获到的字幕文件（无需依赖 aweme 解析）
    if (!subtitleLines.length && cache.captions.length) {
      const text = cache.captions[cache.captions.length - 1].text;
      const lines = VB.parseVtt(text);
      if (lines.length) {
        subtitleLines = lines;
        sources.subtitle = true;
      }
    }

    // DOM 兜底
    if (!desc) desc = domDesc();
    if (!title) title = desc || VB.cleanText(document.title.replace(/-\s*抖音.*$/, ''));
    if (!author) author = domAuthor();
    if (!hashtags.length) hashtags = parseHashTags(desc);
    if (!Object.values(stats).some(Boolean)) stats = domStat();

    const comments = domComments();
    sources.comments = comments.length > 0;

    // 文案里去掉话题标签，读起来更干净
    const cleanDesc = VB.cleanText(desc.replace(/#[^\s#]{1,24}/g, ' '));

    if (!title && !cleanDesc && !subtitleLines.length) {
      notes.push('未能读到视频信息。请刷新一次页面（F5）后重试——首次安装扩展前已打开的页面不会被注入钩子。');
    } else if (!subtitleLines.length) {
      notes.push('抖音绝大多数视频没有字幕轨。本次总结基于文案、话题与评论区内容推断。');
    }
    if (!aweme) {
      notes.push('未捕获到接口数据，信息来自页面 DOM，字段可能不全。');
    }

    return {
      platform: 'douyin',
      url: location.href,
      id: currentId(),
      title: title || '（未识别到标题）',
      author,
      cover,
      desc: cleanDesc,
      duration,
      publishTime,
      hashtags: [...new Set(hashtags)].slice(0, 12),
      stats,
      subtitleLang: subtitleLines.length ? 'zh' : '',
      subtitleLines,
      danmaku: [],
      comments,
      sources,
      notes,
      qualityScore: (sources.subtitle ? 100 : 0) + (sources.comments ? 20 : 0) + (desc ? 10 : 0),
    };
  }

  VB.respond(collect);
})();
