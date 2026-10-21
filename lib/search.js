// Search result excerpts only; never run scripts returned by a search site.
export const SEARCH_ORIGINS = ['https://www.so.com/*', 'https://www.sogou.com/*', 'https://www.bing.com/*', 'https://cn.bing.com/*'];

function decodeXml(value) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
      const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&(lt|gt|quot|apos|amp);/g, (_, n) => ({lt:'<',gt:'>',quot:'"',apos:"'",amp:'&'})[n]).trim();
}

export function safeSource(result) {
  try {
    const url = new URL(result.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return { title: String(result.title || url.hostname).slice(0, 240), url: url.href,
      content: String(result.content || '').slice(0, 2400) };
  } catch { return null; }
}

export function parseBingRss(xml) {
  if (!/<rss\b/i.test(xml)) throw new Error('搜索服务返回了验证页，请稍后重试或切换 Tavily。');
  const results = [];
  const seen = new Set();
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const tag = name => decodeXml(match[1].match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1]);
    const item = safeSource({title:tag('title'),url:tag('link'),content:tag('description')});
    if (item && !seen.has(item.url)) { seen.add(item.url); results.push(item); }
  }
  return results.slice(0, 6);
}

export function parseSogouHtml(html) {
  const clean = String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const headings = [...clean.matchAll(/<h3\b[^>]*class=["'][^"']*vr-title[^"']*["'][^>]*>([\s\S]*?)<\/h3>/gi)];
  const results = [], seen = new Set();
  for (let i=0; i<headings.length; i++) {
    const heading = headings[i];
    const tail = clean.slice(heading.index + heading[0].length, headings[i+1]?.index ?? clean.length);
    // Sogou exposes original article URLs in the result's data-url attribute.
    const direct = tail.match(/\bdata-url=["'](https?:[^"']+)["']/i)?.[1];
    const excerpt = tail.match(/<(p|div)\b[^>]*class=["'][^"']*(?:fz-mid|star-wiki|str_info)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i)?.[2];
    const item = safeSource({url:decodeXml(direct),title:decodeXml(heading[1]),content:decodeXml(excerpt).replace(/\s+/g, ' ')});
    if (item && item.content && !seen.has(item.url)) { seen.add(item.url); results.push(item); }
  }
  if (!results.length) throw new Error('搜狗未返回可用结果，可能需要验证或更换搜索词。');
  return results.slice(0, 6);
}

export function parseSoHtml(html) {
  const clean = String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const headings = [...clean.matchAll(/<h3\b[^>]*class=["'][^"']*res-title[^"']*["'][^>]*>([\s\S]*?)<\/h3>/gi)];
  const results = [], seen = new Set();
  for (let i=0; i<headings.length; i++) {
    const heading = headings[i];
    const tail = clean.slice(heading.index + heading[0].length, headings[i+1]?.index ?? clean.length);
    const direct = heading[1].match(/\bdata-mdurl=["'](https?:[^"']+)["']/i)?.[1]
      || heading[1].match(/\bhref=["'](https?:[^"']+)["']/i)?.[1];
    const excerpt = tail.match(/<span\b[^>]*\bdata-result-summary[^>]*>([\s\S]*?)<\/span>/i)?.[1]
      || tail.match(/<p\b[^>]*class=["'][^"']*res-desc[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1];
    const item = safeSource({url:decodeXml(direct),title:decodeXml(heading[1]),content:decodeXml(excerpt).replace(/\s+/g, ' ')});
    if (item && item.content && !seen.has(item.url)) { seen.add(item.url); results.push(item); }
  }
  if (!results.length) throw new Error('360 搜索未返回可用结果，可能需要验证或更换搜索词。');
  return results.slice(0, 6);
}

async function timedFetch(url, options, parentSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  parentSignal?.addEventListener('abort', abort, {once:true});
  const timer = setTimeout(abort, 18000);
  try { return await fetch(url, {...options, signal:controller.signal, credentials:'omit', referrerPolicy:'no-referrer'}).then(async res => {
    if (!res.ok) throw new Error(`搜索服务返回 ${res.status}`);
    return await res.text();
  }); } finally { clearTimeout(timer); parentSignal?.removeEventListener('abort', abort); }
}

export async function searchWeb(query, settings, signal) {
  const q = String(query || '').trim().slice(0, 350);
  if (!q) throw new Error('请输入搜索问题');
  if (settings.searchProvider === 'tavily') {
    const {tavilyKey = ''} = await chrome.storage.local.get('tavilyKey');
    if (!tavilyKey) throw new Error('请先在设置页填写 Tavily 搜索 Key，或切换为 Bing。');
    const text = await timedFetch('https://api.tavily.com/search', {
      method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${tavilyKey}`},
      body:JSON.stringify({query:q, search_depth:'basic', max_results:6, include_answer:false, include_raw_content:false}),
    }, signal);
    const results = (JSON.parse(text).results || []).map(safeSource).filter(Boolean);
    if (!results.length) throw new Error('未检索到可用网页，请换个关键词重试。');
    return results;
  }
  let lastError;
  if (settings.searchProvider !== 'bing') {
    try {
      const html = await timedFetch(`https://www.so.com/s?q=${encodeURIComponent(q)}`, {}, signal);
      return parseSoHtml(html);
    } catch (err) { if (signal?.aborted) throw err; lastError = err; }
    try {
      const html = await timedFetch(`https://www.sogou.com/web?query=${encodeURIComponent(q)}`, {}, signal);
      return parseSogouHtml(html);
    } catch (err) { if (signal?.aborted) throw err; lastError = err; }
  }
  for (const origin of settings.searchProvider === 'bing' ? ['https://cn.bing.com', 'https://www.bing.com'] : []) {
    try {
      const xml = await timedFetch(`${origin}/search?format=rss&q=${encodeURIComponent(q)}`, {}, signal);
      const results = parseBingRss(xml);
      if (!results.length) throw new Error('没有检索到可用网页');
      return results;
    } catch (err) { if (signal?.aborted) throw err; lastError = err; }
  }
  throw new Error(`联网搜索失败：${lastError?.message || '网络不可用'}。请检查网络或在设置中切换 Tavily；本次未生成联网回答。`);
}
