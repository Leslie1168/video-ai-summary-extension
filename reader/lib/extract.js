// This function is serialized into the active tab by chrome.scripting.executeScript.
export function extractPage() {
  const host=location.hostname.toLowerCase();
  const site=host.includes('github.com')?'github':host.includes('zhihu.com')?'zhihu':host.includes('csdn.net')?'csdn':host.includes('tieba.baidu.com')?'tieba':'generic';
  const selectors={
    github:['article.markdown-body','.js-comment-body','.comment-body','.timeline-comment .comment-body','.js-discussion','.markdown-body'],
    zhihu:['.Post-RichText','.RichContent-inner','.AnswerItem .RichContent','.CommentItem-content','.ArticleItem-content'],
    csdn:['#content_views','article.blog-content-box','.comment-list .comment-item'],
    tieba:['.d_post_content','.l_post .d_post_content','.p_content'],
    generic:['article','main','[role="main"]']
  };
  const junk='script,style,noscript,svg,nav,aside,footer,header,form,button,input,textarea,select,[hidden],[aria-hidden="true"],.advertisement,.adsbygoogle,.recommend,.related-articles,.sidebar,.toolbar,.share-box,.login-mask';
  const maxBlocks=120, maxChars=85000;
  let candidates=[...document.querySelectorAll(selectors[site].join(','))].filter(e=>e.getClientRects().length>0);
  if(!candidates.length) candidates=[document.querySelector('main, article, [role="main"]') || document.body];
  const parentSet=new Set(candidates);
  candidates=candidates.filter(e=>!Array.from(parentSet).some(other=>other!==e && other.contains(e)));
  const title=(document.querySelector('h1')?.innerText || document.title || '').trim().slice(0,240);
  const blocks=[];let used=0, truncated=false;
  const clean=s=>String(s||'').replace(/\u00a0/g,' ').replace(/[\t ]+/g,' ').replace(/\n[\s\n]{2,}/g,'\n\n').trim();
  // ---- 页面主体信息：站点规则优先，通用 meta 兜底 ----
  const metaOf=(...names)=>{
    for(const name of names){
      const el=document.querySelector(`meta[property="${name}"],meta[name="${name}"],meta[itemprop="${name}"]`);
      const value=el?.getAttribute('content')?.trim();
      if(value)return value.slice(0,120);
    }
    return '';
  };
  const textOf=sel=>{const el=document.querySelector(sel);return el?clean(el.textContent).slice(0,60):'';};
  const attrOf=(sel,attr='content')=>document.querySelector(sel)?.getAttribute(attr)?.trim().slice(0,120)||'';
  const normalDate=raw=>{
    const value=String(raw||'').trim();
    if(!value)return '';
    const direct=/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/.exec(value);
    if(direct)return direct[0].replace(/[年月]/g,'-').replace(/日/,'').replace(/\//g,'-');
    const parsed=new Date(value);
    return Number.isNaN(parsed.getTime())?'':parsed.toISOString().slice(0,10);
  };
  const siteFacts={
    github:{author:attrOf('.author a','href').replace(/^.*github\.com\//,'')||textOf('.author a'),date:normalDate(attrOf('relative-time','datetime')||textOf('relative-time'))},
    zhihu:{author:textOf('.AuthorInfo-name')||textOf('.AuthorInfo'),date:normalDate(textOf('.ContentItem-time')||attrOf('time','datetime'))},
    csdn:{author:textOf('.profile-intro-name')||textOf('#uid'),date:normalDate(textOf('.time')||attrOf('time','datetime'))},
    tieba:{author:textOf('.p_author_name'),date:normalDate(textOf('.post-tail-wrap')||attrOf('time','datetime'))},
    generic:{author:'',date:''}
  }[site];
  const author=(siteFacts.author || metaOf('author','article:author','og:article:author') || textOf('[rel="author"]')).slice(0,60);
  const published=siteFacts.date || normalDate(attrOf('time[datetime]','datetime') || metaOf('article:published_time','datePublished','og:article:published_time'));
  const siteStats={
    github:textOf('.social-count')|| '',
    zhihu:textOf('.VoteButton--up')||'',
    csdn:textOf('#read-count')||textOf('.read-count')||'',
    tieba:textOf('.l_reply_num')||'',
    generic:''
  }[site];

  for(const candidate of candidates) {
    if(blocks.length>=maxBlocks || used>=maxChars){truncated=true;break;}
    const copy=candidate.cloneNode(true);
    copy.querySelectorAll(junk).forEach(e=>e.remove());
    copy.querySelectorAll('pre').forEach(e=>{e.textContent='\n```\n'+e.textContent+'\n```\n';});
    // innerText on a detached clone is empty in Chromium. Preserve block boundaries explicitly.
    copy.querySelectorAll('p,div,h1,h2,h3,h4,li,pre,blockquote,br').forEach(e=>e.append(document.createTextNode('\n')));
    const text=clean(copy.textContent);
    if(text.length<35) continue;
    const id='ai-reader-'+blocks.length+'-'+Math.random().toString(36).slice(2,7);
    candidate.setAttribute('data-ai-reader-anchor',id);
    const label=site==='tieba'?'楼层':site==='github'?'仓库/讨论':site==='zhihu'?'回答/评论':site==='csdn'?'文章':'正文';
    const heading=clean(candidate.querySelector('h1,h2,h3')?.textContent).slice(0,100);
    for(let offset=0;offset<text.length;offset+=4000){
      if(blocks.length>=maxBlocks||used>=maxChars){truncated=true;break;}
      const snippet=text.slice(offset,offset+Math.min(4000,maxChars-used));
      if(!snippet.trim())break;
      blocks.push({id:'P'+(blocks.length+1),anchor:id,label:heading||label,text:snippet});
      used+=snippet.length;
      if(used>=maxChars && offset+snippet.length<text.length)truncated=true;
    }
  }
  return {site,host:location.hostname,url:location.href,title,author,published,siteStats,blocks,truncated,visibleOnly:true,extractedChars:used};
}
export function focusBlock(anchor) {
  const node=[...document.querySelectorAll('[data-ai-reader-anchor]')].find(el=>el.getAttribute('data-ai-reader-anchor')===anchor);
  if(!node) return false;
  node.scrollIntoView({behavior:'smooth',block:'center'});
  const old=node.style.outline;
  node.style.outline='3px solid #10b981';
  setTimeout(()=>{node.style.outline=old;},1800);
  return true;
}