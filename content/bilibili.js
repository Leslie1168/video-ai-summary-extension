/**
 * B站 内容脚本：采集视频元信息 + 字幕 + 弹幕 + 热门评论
 */
(() => {
  const VB = window.__VB;
  if (!VB) return;
  VB.PLATFORM = 'bilibili';

  const DM_SAMPLE = 60; // 弹幕采样条数
  const CMT_LIMIT = 30; // 评论条数

  function parseTarget() {
    const href = location.href;
    let bvid = (href.match(/\/(BV[0-9A-Za-z]+)/) || [])[1] || '';
    let aid = (href.match(/\/(?:video\/)?av(\d+)/i) || [])[1] || '';
    const ep = (href.match(/\/bangumi\/play\/ep(\d+)/) || [])[1] || '';
    const p = Number((href.match(/[?&]p=(\d+)/) || [])[1] || 1);
    return { bvid, aid, ep, p };
  }

  async function fetchView({ bvid, aid }) {
    const q = bvid ? `bvid=${bvid}` : `aid=${aid}`;
    const json = await VB.fetchJson(`https://api.bilibili.com/x/web-interface/view?${q}`);
    if (json.code !== 0) {
      const hint =
        json.code === -404
          ? '视频不存在或已被删除'
          : json.code === -403
            ? '无权访问该视频（可能是会员/地区限制）'
            : `B站接口返回 ${json.code}：${json.message}`;
      throw new Error(hint);
    }
    return json.data;
  }

  // --------------------------------------------------------------- 字幕
  // B站 AI 字幕需要登录态。扩展运行在已登录的浏览器里，天然带 cookie，
  // 所以这里**不需要**任何额外登录步骤（这正是扩展相对 Skill 的优势）。
  //
  // 渠道顺序（2026-10-15 实测结论）：
  //   ① x/player/wbi/v2（WBI 签名）—— 官方播放器在用，最稳
  //   ② x/web-interface/view/conclusion/get —— B站 官方 AI 文稿，含摘要/提纲
  //   ③ x/player/v2（无签名）—— 最后兜底；被风控降级时会返回**别的视频**的字幕
  //
  // 注：新版 Protobuf 接口 x/v2/subtitle/web/view 不在此列 ——
  //     实测登录后其 subtitle_url 仍是加密占位，前端拿不到明文。

  /** 未登录时 B站 下发的加密占位地址（URL 里含 %00~%1F 的控制字符转义） */
  const isEncryptedUrl = (u) => /%0[0-9A-Fa-f]|%1[0-9A-Fa-f]/.test(u || '');

  async function fetchTracksSigned(bvid, cid, aid) {
    const json = await VB.wbiGet('x/player/wbi/v2', { bvid, cid, aid });
    return json?.data?.subtitle?.subtitles || [];
  }

  async function fetchTracksAnonymous(bvid, cid) {
    const json = await VB.fetchJson(
      `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`
    );
    return json?.data?.subtitle?.subtitles || [];
  }

  /** B站 官方 AI 文稿：不返回轨道，直接给 AI 识别全文 + 摘要 + 提纲 */
  async function fetchConclusion(bvid, cid, aid, upMid) {
    const json = await VB.wbiGet('x/web-interface/view/conclusion/get', {
      bvid,
      cid,
      aid,
      up_mid: upMid || 0,
    });
    const data = json?.data || {};
    const mr = data.model_result || {};
    const lines = [];
    for (const grp of mr.subtitle || []) {
      for (const seg of grp.part_subtitle || []) {
        const text = VB.cleanText(seg.content);
        if (text) lines.push({ from: seg.start_timestamp, to: seg.end_timestamp, text });
      }
    }
    return {
      code: json?.code,
      dataCode: data.code,
      lines,
      summary: mr.summary || '',
      outline: mr.outline || [],
    };
  }

  /** 下载一条字幕轨；返回 null 表示拿不到内容 */
  async function downloadTrack(track) {
    const url = VB.absUrl(track?.subtitle_url || '');
    if (!url || isEncryptedUrl(url)) return null;
    try {
      const raw = await VB.fetchJson(url);
      if (raw?.body) return VB.parseBiliSubtitle(raw);
    } catch {
      /* 少数轨道是 vtt，落到下面的文本分支 */
    }
    try {
      return VB.parseVtt(await VB.fetchText(url));
    } catch {
      return null;
    }
  }

  /** 多渠道取字幕，按可靠性依次降级 */
  async function fetchSubtitle(bvid, cid, aid, upMid) {
    const attempts = [];
    let tracks = [];
    let channel = '';

    // ① 签名接口（最稳）
    try {
      tracks = await fetchTracksSigned(bvid, cid, aid);
      attempts.push(`player/wbi/v2(签名): ${tracks.length} 轨`);
      if (tracks.length) channel = 'player/wbi/v2(签名)';
    } catch (e) {
      attempts.push(`player/wbi/v2(签名): 失败 ${e?.message || e}`);
    }

    if (tracks.length) {
      const picked = VB.pickSubtitle(tracks);
      const lines = await downloadTrack(picked);
      if (lines?.length) {
        return {
          lines,
          lang: picked.lan_doc || picked.lan,
          available: tracks.length,
          channel,
          attempts,
        };
      }
      attempts.push('轨道地址不可用（可能已过期，或未登录时拿到的是加密占位地址）');
    }

    // ② 官方 AI 文稿（可靠，故排在无签名接口之前）
    try {
      const c = await fetchConclusion(bvid, cid, aid, upMid);
      attempts.push(`conclusion/get: code=${c.code} dataCode=${c.dataCode} 文稿 ${c.lines.length} 段`);
      if (c.lines.length) {
        return {
          lines: c.lines,
          lang: 'B站官方 AI 文稿',
          available: Math.max(tracks.length, 1),
          channel: 'view/conclusion/get',
          officialSummary: c.summary,
          officialOutline: c.outline,
          attempts,
        };
      }
    } catch (e) {
      attempts.push(`conclusion/get: 失败 ${e?.message || e}`);
    }

    // ③ 无签名接口 —— 最后兜底，结果标「低置信」
    try {
      tracks = await fetchTracksAnonymous(bvid, cid);
      attempts.push(`player/v2(未签名·低置信): ${tracks.length} 轨`);
      if (tracks.length) {
        const picked = VB.pickSubtitle(tracks);
        const lines = await downloadTrack(picked);
        if (lines?.length) {
          return {
            lines,
            lang: picked.lan_doc || picked.lan,
            available: tracks.length,
            channel: 'player/v2(未签名·低置信)',
            attempts,
          };
        }
      }
    } catch (e) {
      attempts.push(`player/v2(未签名·低置信): 失败 ${e?.message || e}`);
    }

    return { lines: [], lang: '', available: tracks.length, channel: '', attempts };
  }

  async function fetchDanmaku(cid) {
    const xml = await VB.fetchText(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`);
    const all = VB.filterNoise(VB.parseDanmakuXml(xml));
    return { total: all.length, sample: VB.sampleEven(all, DM_SAMPLE) };
  }

  async function fetchComments(aid) {
    try {
      // 必须走 WBI 签名，否则接口返回 -352 风控码
      const json = await VB.wbiGet('x/v2/reply/wbi/main', {
        type: 1,
        oid: aid,
        mode: 3,
        next: 0,
        ps: 20,
      });
      const replies = json?.data?.replies || [];
      return replies
        .slice(0, CMT_LIMIT)
        .map((r) => VB.cleanText(r?.content?.message))
        .filter((t) => t.length >= 4);
    } catch {
      return [];
    }
  }

  async function collect() {
    const target = parseTarget();
    if (!target.bvid && !target.aid) {
      throw new Error('当前页面不是视频页，请打开一个 B站视频后再试。');
    }

    const info = await fetchView(target);

    // 分P
    const pages = info.pages || [];
    const page = pages.find((x) => x.page === target.p) || pages[0] || {};
    const cid = page.cid || info.cid;
    const title =
      pages.length > 1 && page.part
        ? `${info.title} · P${page.page} ${page.part}`
        : info.title;

    const sources = { subtitle: false, danmaku: false, comments: false };

    // 字幕（最佳素材）—— 多渠道降级
    let subtitleLines = [];
    let subtitleLang = '';
    let subtitleAvailable = 0;
    let subtitleChannel = '';
    let officialSummary = '';
    let subtitleAttempts = [];
    try {
      const sub = await fetchSubtitle(info.bvid, cid, info.aid, info.owner?.mid);
      subtitleLines = sub.lines;
      subtitleLang = sub.lang;
      subtitleAvailable = sub.available;
      subtitleChannel = sub.channel;
      officialSummary = sub.officialSummary || '';
      subtitleAttempts = sub.attempts || [];
      sources.subtitle = subtitleLines.length > 0;
    } catch {
      /* 字幕失败不阻塞 */
    }

    // 弹幕（无字幕时的主要素材）
    let danmaku = [];
    let danmakuTotal = 0;
    if (!sources.subtitle) {
      try {
        const dm = await fetchDanmaku(cid);
        danmaku = dm.sample;
        danmakuTotal = dm.total;
        sources.danmaku = danmaku.length > 0;
      } catch {
        /* ignore */
      }
    }

    // 热门评论
    let comments = [];
    try {
      comments = await fetchComments(info.aid);
      sources.comments = comments.length > 0;
    } catch {
      /* ignore */
    }

    const descText = (info.desc_v2?.[0]?.raw_text || info.desc || '').trim();
    const cleanDesc = descText === '-' ? '' : descText;

    const notes = [];
    if (sources.subtitle) {
      notes.push(`字幕来源：${subtitleChannel} · ${subtitleLang}（${subtitleLines.length} 句）`);
      if (subtitleChannel.includes('未签名')) {
        notes.push(
          '⚠️ 字幕来自无 WBI 签名的接口，可能被风控降级返回别的视频的字幕，请核对内容能否对上本视频。'
        );
      } else {
        const dur = Number(info.duration) || 0;
        const per = dur && subtitleLines.length >= 20 ? dur / subtitleLines.length : 0;
        if (per > 8) {
          notes.push(
            `⚠️ 字幕密度异常：${subtitleLines.length} 句 / ${dur} 秒，平均每句 ${per.toFixed(1)} 秒，疑似碎片，请核对。`
          );
        }
      }
    } else {
      subtitleAttempts.forEach((a) => notes.push(`字幕渠道尝试 · ${a}`));
      if (subtitleAvailable) {
        notes.push('检测到字幕轨但拿不到内容：B站 AI 字幕需要登录后才下发，请确认当前浏览器已登录 B站账号。');
      } else {
        notes.push('没有取到任何字幕轨。B站 AI 字幕需要登录态；若已登录仍无轨道，说明该视频确实没有 AI 字幕。');
      }
    }

    return {
      platform: 'bilibili',
      url: location.href,
      id: info.bvid,
      aid: info.aid,
      cid,
      title,
      author: VB.cleanText(info.owner?.name),
      authorUrl: info.owner?.mid ? `https://space.bilibili.com/${info.owner.mid}` : '',
      cover: VB.absUrl(info.pic),
      desc: cleanDesc,
      duration: info.duration || 0,
      publishTime: info.pubdate ? new Date(info.pubdate * 1000).toLocaleDateString('zh-CN') : '',
      hashtags: [info.tname].filter(Boolean),
      stats: {
        播放: info.stat?.view,
        点赞: info.stat?.like,
        弹幕: info.stat?.danmaku,
        收藏: info.stat?.favorite,
        评论: info.stat?.reply,
      },
      subtitleLang,
      subtitleChannel,
      subtitleLines,
      biliOfficialSummary: officialSummary,
      danmaku,
      danmakuTotal,
      comments,
      sources,
      notes,
      qualityScore: (sources.subtitle ? 100 : 0) + (sources.danmaku ? 30 : 0) + (sources.comments ? 20 : 0),
    };
  }

  VB.respond(collect);
})();
