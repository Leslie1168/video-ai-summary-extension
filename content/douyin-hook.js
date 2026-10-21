/**
 * 抖音 主世界（MAIN world）注入钩子，document_start 执行。
 * 目的：捕获抖音自身发出的「视频详情」接口响应与「字幕文件」内容，
 *       通过 window.postMessage 交给隔离世界的内容脚本。
 * 原则：绝不改变原请求行为，任何异常都必须静默吞掉。
 */
(() => {
  if (window.__VB_HOOKED__) return;
  window.__VB_HOOKED__ = true;

  const CHANNEL = '__VB_CAPTURE__';
  const DETAIL_RE = /aweme\/v1\/web\/aweme\/(detail|post|related|recommend)/;
  const CAPTION_RE = /(\.webvtt|\.srt)(\?|$)|caption|subtitle/i;

  const emit = (kind, payload) => {
    try {
      window.postMessage({ channel: CHANNEL, kind, payload }, '*');
    } catch {
      /* ignore */
    }
  };

  const safeJson = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const handleResponse = (url, getText) => {
    try {
      if (!url || typeof url !== 'string') return;

      if (DETAIL_RE.test(url)) {
        getText().then((text) => {
          const json = safeJson(text);
          if (json) emit('aweme', json);
        });
        return;
      }

      if (CAPTION_RE.test(url)) {
        getText().then((text) => {
          if (text && /-->/.test(text)) emit('caption', { url, text });
        });
      }
    } catch {
      /* ignore */
    }
  };

  // ---- fetch 钩子 ----
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const input = args[0];
        const url = typeof input === 'string' ? input : input?.url;
        if (url && (DETAIL_RE.test(url) || CAPTION_RE.test(url))) {
          p.then((res) => {
            try {
              const clone = res.clone();
              handleResponse(url, () => clone.text());
            } catch {
              /* ignore */
            }
          }).catch(() => {});
        }
      } catch {
        /* ignore */
      }
      return p;
    };
  }

  // ---- XMLHttpRequest 钩子 ----
  const XHR = window.XMLHttpRequest;
  if (XHR?.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url, ...rest) {
      try {
        this.__vbUrl = typeof url === 'string' ? url : url?.toString?.();
      } catch {
        /* ignore */
      }
      return origOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.send = function (...args) {
      try {
        const url = this.__vbUrl;
        if (url && (DETAIL_RE.test(url) || CAPTION_RE.test(url))) {
          this.addEventListener('load', () => {
            try {
              const rt = this.responseType;
              if (rt === '' || rt === 'text') {
                handleResponse(url, () => Promise.resolve(this.responseText));
              } else if (rt === 'json') {
                handleResponse(url, () => Promise.resolve(JSON.stringify(this.response)));
              }
            } catch {
              /* ignore */
            }
          });
        }
      } catch {
        /* ignore */
      }
      return origSend.apply(this, args);
    };
  }

  // ---- SSR 内嵌数据兜底 ----
  const scanGlobals = () => {
    try {
      const candidates = [window._ROUTER_DATA, window.__INITIAL_STATE__, window.RENDER_DATA];
      for (const c of candidates) {
        if (c && typeof c === 'object') emit('aweme', c);
      }
    } catch {
      /* ignore */
    }
  };
  scanGlobals();
  setTimeout(scanGlobals, 1500);
})();
