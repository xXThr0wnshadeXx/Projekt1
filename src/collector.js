// These functions run only inside the dedicated LinkedIn collection tab.
// Keep each function self-contained: chrome.scripting serializes the function.
export function inspectLinkedIn() {
  const clean=s=>(s||'').replace(/\s+/g,' ').trim();
  const canonical=value=>{try{const u=new URL(value,location.href);return u.hostname==='www.linkedin.com'&&/^\/in\/[^/]+\/?$/.test(u.pathname)?`https://www.linkedin.com${u.pathname.replace(/\/?$/,'/')}`:null;}catch{return null;}};
  const main=document.querySelector('[role="region"][aria-label="Primary content"]')||document.querySelector('main')||document.body;
  const text=clean(main.innerText||main.textContent),body=clean(document.body.innerText||document.body.textContent);
  const url=location.href;
  const notices=Array.from(document.querySelectorAll('[role="alert"],[role="dialog"],h1,h2,h3')).map(e=>clean(e.innerText||e.textContent)).join(' ');
  const restriction=/security verification|verify your identity|unusual activity|temporarily restricted|commercial use limit|(?:you(?:'ve| have) reached|you reached)[^.!?]{0,100}(?:search|limit)|(?:reached|exceeded)[^.!?]{0,60}search limit/i;
  if(/\/checkpoint\//.test(location.pathname)||restriction.test(notices)||(body.length<1500&&restriction.test(body)))return {kind:'blocked',url,reason:'LinkedIn is showing a verification, restriction, or search limit. Resolve it in the collection tab before resuming.'};
  if(/\/(login|uas\/login|authwall)/.test(location.pathname)||document.querySelector('input[name="session_password"]'))return {kind:'blocked',url,reason:'Sign in to LinkedIn in the collection tab, then resume.'};
  if(main.querySelector('[aria-busy="true"],.artdeco-loader,.search-results__loader'))return {kind:'loading',url};
  const links=Array.from(main.querySelectorAll('a[href], [role="link"][href]'));
  if(/^\/in\/[^/]+\/?$/.test(location.pathname)) {
    const title=main.querySelector('h1,h2');
    if(!title)return {kind:'loading',url};
    const candidate=links.find(a=>/^[\d,.+]+\s+connections$/i.test(clean(a.textContent)) && /connectionOf=|\/mynetwork\/invite-connect\/connections/.test(a.getAttribute('href')||''));
    const mutual=links.find(a=>/mutual connections?|mutual connection$/i.test(clean(a.textContent)) && (a.getAttribute('href')||'').includes('connectionOf='));
    const selected=candidate||mutual;
    const subtitle=main.querySelector('.text-body-medium');
    return {kind:'profile',url,person:{url:canonical(url),name:clean(title.textContent),headline:clean(subtitle?.textContent)},listUrl:selected?new URL(selected.getAttribute('href'),url).href:null,scope:candidate?'connections':mutual?'mutuals_only':'hidden',totalLabel:clean(candidate?.textContent)};
  }
  const path=location.pathname.replace(/\/?$/,'/');
  const isOwn=path==='/mynetwork/invite-connect/connections/';
  if(!isOwn && path!=='/search/results/people/')return {kind:'unexpected',url,reason:'LinkedIn opened an unexpected page.'};
  const people=[];
  // New LinkedIn layout: each result is a link wrapping paragraphs.
  for(const a of links){const id=canonical(a.getAttribute('href'));if(!id)continue;const p=Array.from(a.querySelectorAll('p')).map(e=>clean(e.textContent)).filter(Boolean);if(p.length<1)continue;if(!isOwn&&!/•\s*(1st|2nd|3rd)/.test(p[0]))continue;people.push({url:id,name:p[0].replace(/\s*•\s*(1st|2nd|3rd\+?).*$/,'').trim(),headline:p[1]||'',location:isOwn?'':p[2]||''});}
  // Legacy layout: result cards expose a dedicated title and subtitle.
  if(!people.length)for(const card of main.querySelectorAll('li.reusable-search__result-container,li.mn-connection-card')){
    const a=card.querySelector('.entity-result__title-text a[href*="/in/"],a.mn-connection-card__link');if(!a)continue;
    const id=canonical(a.getAttribute('href'));if(!id)continue;
    const label=a.querySelector('[aria-hidden="true"],.mn-connection-card__name')||a;
    people.push({url:id,name:clean(label.textContent).replace(/\s*•.*$/,''),headline:clean(card.querySelector('.entity-result__primary-subtitle,.mn-connection-card__occupation')?.textContent),location:clean(card.querySelector('.entity-result__secondary-subtitle')?.textContent)});
  }
  const unique=Array.from(new Map(people.map(p=>[p.url,p])).values());
  const pageRoot=main.closest('main')||main;
  const controls=Array.from(pageRoot.querySelectorAll('button,a[href],[role="button"]'));
  const next=controls.find(e=>e.classList.contains('artdeco-pagination__button--next'))||controls.find(e=>/^(?:go to (?:the )?)?next(?: page)?$/i.test(clean(e.getAttribute('aria-label')||e.textContent))||e.getAttribute('rel')==='next');
  const hasNext=Boolean(next&&!next.disabled&&next.getAttribute('aria-disabled')!=='true');
  const paginationState=hasNext?'next':next?'end':'missing';
  const empty=/no results found|no results|no connections yet|no connections to show/i.test(text);
  const count=isOwn?Number((text.match(/([\d,]+)\s+connections/i)?.[1]||'').replaceAll(',','')):null;
  return {kind:unique.length||empty?'list':'loading',url,people:unique,hasNext,paginationState,isOwn,empty,expectedCount:count||null,signature:unique.map(p=>p.url).sort().join('|'),pageLabel:clean(main.querySelector('[aria-current="page"],[aria-current="true"]')?.textContent),scrollHeight:document.documentElement.scrollHeight};
}

export async function advanceLinkedIn(expectedURL,own,scrollOnly=false) {
  const current=new URL(location.href),expected=new URL(expectedURL);
  const path=u=>u.pathname.replace(/\/?$/,'/');
  const owner=u=>{const values=u.searchParams.getAll('connectionOf');if(values.length!==1||!values[0])return null;try{const parsed=JSON.parse(values[0]);if(Array.isArray(parsed)&&parsed.length&&parsed.every(v=>typeof v==='string'&&v.length))return JSON.stringify([...new Set(parsed)].sort());if(typeof parsed==='string'&&parsed.length)return JSON.stringify([parsed]);}catch{}return JSON.stringify([values[0]]);};
  if(current.origin!=='https://www.linkedin.com'||current.origin!==expected.origin||path(current)!==path(expected)||(path(current)==='/search/results/people/'&&(!owner(expected)||owner(current)!==owner(expected))))throw Error('The collection tab changed.');
  const main=document.querySelector('[role="region"][aria-label="Primary content"]')||document.querySelector('main')||document.body;
  const pageRoot=main.closest('main')||main;
  if(own||scrollOnly){
    // A header/avatar may be the first profile link. Find the scrollable
    // ancestor shared by actual list links instead of trusting that first link.
    const candidates=new Map();
    for(const link of main.querySelectorAll('a[href*="/in/"]')){
      for(let container=link.parentElement;container&&container!==document.body;container=container.parentElement){
        if(container.scrollHeight>container.clientHeight+20&&/auto|scroll/.test(getComputedStyle(container).overflowY)){
          candidates.set(container,(candidates.get(container)||0)+1);break;
        }
      }
    }
    const container=[...candidates].sort((a,b)=>b[1]-a[1])[0]?.[0]||document.scrollingElement||document.documentElement;
    const bottom=Math.max(0,container.scrollHeight-container.clientHeight);
    const scroll=top=>container.scrollTo?container.scrollTo({top,behavior:'instant'}):window.scrollTo({top,behavior:'instant'});
    // Re-enter the loading boundary even if the previous pass ended at bottom.
    // Allow the browser to observe the upward move before returning to bottom.
    if(bottom>0&&(container.scrollTop||0)>=bottom-2){
      scroll(Math.max(0,bottom-Math.min(200,container.clientHeight/2)));
      await new Promise(resolve=>setTimeout(resolve,150));
      if(location.href!==current.href)throw Error('The collection tab changed.');
    }
    scroll(bottom);
    const more=Array.from(pageRoot.querySelectorAll('button')).find(e=>/^(show more|load more)$/i.test(e.textContent.trim()));if(more&&!more.disabled&&more.getAttribute('aria-disabled')!=='true')more.click();return 'scrolled';
  }
  const controls=Array.from(pageRoot.querySelectorAll('button,a[href],[role="button"]'));
  const next=controls.find(e=>e.classList.contains('artdeco-pagination__button--next'))||controls.find(e=>/^(?:go to (?:the )?)?next(?: page)?$/i.test((e.getAttribute('aria-label')||e.textContent||'').trim())||e.getAttribute('rel')==='next');
  if(!next||next.disabled||next.getAttribute('aria-disabled')==='true')return 'end';next.click();return 'next';
}
