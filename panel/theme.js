/* 知页 · 主题切换
 * 在 <head> 里同步执行：先按 localStorage 缓存定色，避免加载瞬间闪白，
 * 再异步对齐 chrome.storage.sync 里的真值。
 * 最终只往 <html> 上写一个 data-theme="light|dark"，CSS 里
 * html[data-theme="dark"] 那一段就是唯一深色来源。
 */
(function () {
  var CACHE = 'zhye-theme';
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var mode = 'auto';

  function resolve(value) {
    if (value === 'light' || value === 'dark') return value;
    return mq && mq.matches ? 'dark' : 'light';
  }

  function paint() {
    var actual = resolve(mode);
    root.setAttribute('data-theme', actual);
    root.style.colorScheme = actual;
  }

  function remember(value) {
    try { window.localStorage.setItem(CACHE, value); } catch (e) { /* 隐私模式忽略 */ }
  }

  try {
    mode = window.localStorage.getItem(CACHE) || 'auto';
  } catch (e) {
    mode = 'auto';
  }
  paint();

  if (mq && mq.addEventListener) {
    mq.addEventListener('change', function () {
      if (mode === 'auto') paint();
    });
  }

  function sync(value) {
    mode = value === 'light' || value === 'dark' ? value : 'auto';
    remember(mode);
    paint();
  }

  if (!(window.chrome && window.chrome.storage && window.chrome.storage.sync)) return;

  try {
    window.chrome.storage.sync.get({ themeMode: 'auto' }, function (value) {
      sync(value && value.themeMode);
    });
    window.chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'sync' || !changes.themeMode) return;
      sync(changes.themeMode.newValue);
    });
  } catch (e) { /* 扩展上下文失效时保持缓存值 */ }
})();
