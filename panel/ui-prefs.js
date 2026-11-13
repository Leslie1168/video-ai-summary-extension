/* 知页 · 排版偏好
   把设置页里的字号 / 行高 / 粗细写进 :root 的 CSS 变量，typography.css 用 calc 跟着缩放。
   两个侧栏面板都引入这一份；storage.sync 变化时即时生效，不用重开侧栏。 */
(function () {
  var DEFAULTS = {
    uiFontSize: 14,
    uiLineHeight: 1.75,
    uiFontWeight: 400,
    uiHeadingWeight: 650,
  };

  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? n : fallback;
  }

  function apply(prefs) {
    var root = document.documentElement;
    if (!root) return;
    var s = root.style;
    s.setProperty('--fs-base', num(prefs.uiFontSize, DEFAULTS.uiFontSize) + 'px');
    s.setProperty('--lh-base', String(num(prefs.uiLineHeight, DEFAULTS.uiLineHeight)));
    s.setProperty('--fw-body', String(num(prefs.uiFontWeight, DEFAULTS.uiFontWeight)));
    s.setProperty('--fw-head', String(num(prefs.uiHeadingWeight, DEFAULTS.uiHeadingWeight)));
  }

  function load() {
    apply(DEFAULTS);
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) return;
    try {
      chrome.storage.sync.get(DEFAULTS, function (prefs) {
        apply(prefs || DEFAULTS);
      });
    } catch (err) {
      /* 存储不可用时保持默认刻度 */
    }
  }

  load();

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'sync') return;
        for (var key in DEFAULTS) {
          if (Object.prototype.hasOwnProperty.call(changes, key)) {
            load();
            return;
          }
        }
      });
    } catch (err) {
      /* 忽略：没有监听权限时不影响渲染 */
    }
  }
})();
