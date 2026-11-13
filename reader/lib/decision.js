export function quickWebDecision(question, mode = 'auto') {
  if (mode === 'page') return {web:false, reason:'仅页面模式'};
  if (mode === 'web') return {web:true, reason:'强制联网模式'};
  const q = String(question || '');
  if (/(现在|今天|最新|近期|今年|近日|目前|实时|刚刚|截至|近[一二三四五六七八九十\d]+[天周月年]|current|latest|today|recent|as of|right now|this year)/i.test(q)) return {web:true, reason:'问题涉及时效信息'};
  if (/(其他网站|别的网站|全网|网上|站外|官方文档|官网|搜索|联网|核实|验证|对比.*(?:其他|外部)|web search)/i.test(q)) return {web:true, reason:'问题要求站外资料或核实'};
  if (/(这页|本文|本帖|上面|页面|作者|文中|帖子|楼层|评论|仓库|这段|这里|readme|issue|this page|this article)/i.test(q)) return {web:false, reason:'问题针对当前页面'};
  return null;
}
export function normalizeDecision(raw) {
  try {
    const match = String(raw).match(/\{[\s\S]*\}/);
    const result = JSON.parse(match?.[0] || '');
    return {web:result.needWeb === true, reason:String(result.reason || '模型辅助判断').slice(0,100), query:String(result.query || '').trim().slice(0,120)};
  } catch {return {web:false, reason:'联网判断失败，仅基于页面回答', query:''};}
}