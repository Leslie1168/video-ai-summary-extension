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
  const timer = setTimeout(abort, 5000);
  try { return await fetch(url, {...options, signal:controller.signal, credentials:'omit', referrerPolicy:'no-referrer'}).then(async res => {
    if (!res.ok) throw new Error(`搜索服务返回 ${res.status}`);
    return await res.text();
  }); } finally { clearTimeout(timer); parentSignal?.removeEventListener('abort', abort); }
}

export function searchTerms(query) {
  const clean = String(query).toLowerCase().replace(/(?:请问|请帮我|帮我|搜索一下|搜索|查一下|查找|查询|这个视频|视频中|视频里|提到的|提及的|列出来|列出|是什么|有哪些|怎么样|为什么|如何|现在|最新|消息|内容|资料|介绍|一下|一下子|关于|的|了|呢|吗|与|和)/g, ' ');
  const terms = new Set(clean.match(/[a-z0-9][a-z0-9_.+-]{1,}/g) || []);
  for (const run of clean.match(/[\u3400-\u9fff]+/g) || []) {
    for (let i=0; i<run.length-1; i++) terms.add(run.slice(i,i+2));
  }
  return [...terms];
}

export function relevantResults(results, query) {
  const terms = searchTerms(query);
  const ranked = results.map(safeSource).filter(Boolean).map(source => {
    const text = `${source.title} ${source.content}`.toLowerCase();
    const score = terms.filter(term => text.includes(term)).length;
    return {source,score};
  }).sort((a,b)=>b.score-a.score);
  return ranked.slice(0,6).map(item=>item.source);
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
    return relevantResults(results,q);
  }
  const controller=new AbortController();
  const abort=()=>controller.abort();
  if(signal?.aborted)controller.abort();
  signal?.addEventListener('abort',abort,{once:true});
  const providers=settings.searchProvider==='bing'
    ? [{url:'https://cn.bing.com/search?format=rss&q=',parse:parseBingRss},{url:'https://www.bing.com/search?format=rss&q=',parse:parseBingRss}]
    : [{url:'https://www.so.com/s?q=',parse:parseSoHtml},{url:'https://cn.bing.com/search?format=rss&q=',parse:parseBingRss},{url:'https://www.sogou.com/web?query=',parse:parseSogouHtml}];
  try {
    return await Promise.any(providers.map(async provider=>{
      const text=await timedFetch(provider.url+encodeURIComponent(q),{},controller.signal);
      const results=relevantResults(provider.parse(text),q);
      if(!results.length)throw new Error('没有检索到可用网页');
      return results;
    }));
  } catch(error) {
    signal?.throwIfAborted();
    throw new Error('搜索服务暂未返回网页，将继续回答并说明核实状态。');
  } finally {controller.abort();signal?.removeEventListener('abort',abort);}
}
