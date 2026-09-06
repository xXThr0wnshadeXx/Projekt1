import {newState,options,profileURL,listURL,sameList,sameConnectionOwner,addPerson,ingestPage,log} from './core.js';
import {inspectLinkedIn,advanceLinkedIn} from './collector.js';
import {SITE_ORIGIN} from './companion.js';

const KEY='orbitNetwork',ALARM='orbit-collect',VERSION='2.0.0';
const POLL=1000,SETTLE=200,LOAD_TIMEOUT=60000,UNCHANGED_TIMEOUT=15000;
let chain=Promise.resolve(),cached,timer=null,timerAt=Infinity;
const serialize=fn=>{const p=chain.then(fn);chain=p.catch(()=>{});return p;};
const read=async()=>{if(cached===undefined)cached=(await chrome.storage.local.get(KEY))[KEY]||null;return cached;};
function workers(s){
  // Upgrade existing resumable collections without dropping the current page.
  if(!s.workers)s.workers=[{tabId:s.tabId||null,current:s.current||null}];
  s.config.delay=Math.max(120,s.config.delay||120);
  // Preserve outstanding work when migrating an older three-tab collection.
  if(s.workers.length>1){for(const w of s.workers.slice(1)){if(w.current)s.queue.unshift({...w.current.job,replayURL:w.current.resumeURL});}s.workers=s.workers.slice(0,1);}
  if(!s.workers.length)s.workers.push({tabId:null,current:null});
  return s.workers;
}
const save=async s=>{
  s.updatedAt=new Date().toISOString();s.revision=(s.revision||0)+1;
  const active=workers(s).find(w=>s.attentionTabId&&w.tabId===s.attentionTabId)||workers(s).find(w=>w.current);s.current=active?.current||null;s.tabId=active?.tabId||s.workers.find(w=>w.tabId)?.tabId||null;
  cached=s;await chrome.storage.local.set({[KEY]:s});
};
function wake(delay=POLL){
  const at=Date.now()+delay;if(timer!==null&&timerAt<=at)return;
  clearTimeout(timer);timerAt=at;timer=setTimeout(()=>{timer=null;timerAt=Infinity;serialize(tick).catch(()=>{});},delay);timer.unref?.();
}
async function schedule(s){
  if(s?.status==='running'){if(!await chrome.alarms.get(ALARM))await chrome.alarms.create(ALARM,{periodInMinutes:.5});wake();}
  else {clearTimeout(timer);timer=null;await chrome.alarms.clear(ALARM);}
}
const pause=async(s,reason,w)=>{s.attentionTabId=w?.tabId||null;s.status='paused';log(s,reason);await save(s);await schedule(s);};
function finishBranch(s,w,status,reason){const b=s.branches[w.current.job.owner];if(b){b.status=status;b.reason=reason;}log(s,reason);w.current=null;}
function limit(s){s.status='limit';log(s,'Person limit reached. Increase the limit and resume to expand further.');}
async function navigate(s,w,job,replayURL=job.replayURL){
  const url=job.kind==='profile'?profileURL(job.owner):listURL(replayURL&&sameList(job.url,replayURL)?replayURL:job.url);
  if(!url)throw Error('A queued URL is invalid.');
  if(Date.now()<(s.nextRequestAt||0)){w.current={job,since:Date.now(),navPending:true,resumeURL:url};await save(s);return;}
  s.nextRequestAt=Date.now()+s.config.delay*1000;
  let tab=w.tabId?await chrome.tabs.get(w.tabId).catch(()=>null):null;
  // Save intent before navigation; an interrupted operation can be replayed.
  w.current={job,since:Date.now(),lastSignature:null,advancePending:false,resumeURL:url,replaying:Boolean(replayURL)};await save(s);
  if(!tab)tab=await chrome.tabs.create({url,active:false});else tab=await chrome.tabs.update(tab.id,{url});
  w.tabId=tab.id;log(s,`Exploring ${s.nodes[job.owner]?.name||'profile'}’s connections`);await save(s);
}
async function advance(s,w,snap){
  const c=w.current;c.advancePending=true;c.nextActionAt=Date.now()+s.config.delay*1000;await save(s);
  if(s.config.delay===0)await performAdvance(s,w,snap);
}
async function performAdvance(s,w,snap){
  const c=w.current;if(Date.now()<Math.max(c.nextActionAt||0,s.nextRequestAt||0))return;
  s.nextRequestAt=Date.now()+s.config.delay*1000;
  const [r]=await chrome.scripting.executeScript({target:{tabId:w.tabId},func:advanceLinkedIn,args:[c.job.url,snap.isOwn]});
  c.advancePending=false;c.since=Date.now();c.candidate=null;delete c.paginationRevealedAt;
  if(r?.result==='end')finishBranch(s,w,'incomplete','The next-page control disappeared before it could be followed.');
  await save(s);
}
async function recover(s,w,reason){
  const c=w.current;if(!c)throw Error(reason);
  const attempts=c.job.retryAttempts||0;
  if(attempts>=2){
    const name=s.nodes[c.job.owner]?.name||'This profile';
    s.branches[c.job.owner] ||= {pages:0,profiles:[],url:c.job.url};
    finishBranch(s,w,'incomplete',`${name}: skipped after 2 retries. ${reason}`);
    await save(s);return;
  }
  c.job.retryAttempts=attempts+1;c.retryAt=Date.now()+500*2**attempts;c.retryReason=reason;
  log(s,`Retrying ${s.nodes[c.job.owner]?.name||'profile'} (${attempts+1}/2): ${reason}`);
  await save(s);
}
async function step(s,w,assign=true){
  if(!w.current){if(!assign)return;const job=s.queue.shift();if(job)await navigate(s,w,job);return;}
  if(w.current.navPending){if(Date.now()>=(s.nextRequestAt||0))await navigate(s,w,w.current.job,w.current.resumeURL);return;}
  if(w.current.retryAt){if(Date.now()>=w.current.retryAt)await navigate(s,w,w.current.job,w.current.resumeURL);return;}
  const c=w.current,job=c.job,tab=await chrome.tabs.get(w.tabId).catch(()=>null),now=Date.now();
  if(!tab){w.tabId=null;await recover(s,w,'The collection tab closed or was discarded. Reopening its saved page.');return;}
  // Read the DOM when available; images and other slow resources need not finish.
  if(!c.advancePending&&tab.status!=='complete'&&now-c.since>LOAD_TIMEOUT){await recover(s,w,'LinkedIn took too long to load.');return;}
  const [result]=await chrome.scripting.executeScript({target:{tabId:w.tabId},func:inspectLinkedIn});
  const snap=result?.result;if(!snap)throw Error('The LinkedIn page could not be read.');
  if(snap.kind==='list'){snap.signature=(snap.people||[]).map(p=>profileURL(p.url)).filter(Boolean).sort().join('|');if(c.lastSignature)c.lastSignature=c.lastSignature.split('|').sort().join('|');}
  if(snap.kind==='blocked'){await pause(s,snap.reason,w);return;}
  if(snap.kind==='unexpected'){if(now-c.since<4000)return;await recover(s,w,snap.reason);return;}
  if(snap.kind==='loading'){if(now-c.since>LOAD_TIMEOUT)await recover(s,w,'The page did not expose readable results.');return;}
  if(!c.lastSignature&&!c.advancePending&&(snap.paginationState!=='missing'||c.paginationRevealedAt)&&now-c.since>LOAD_TIMEOUT){await recover(s,w,'The rendered content never settled.');return;}
  if(job.kind==='profile'){
    if(snap.kind!=='profile'||profileURL(snap.url)!==job.owner){if(now-c.since<4000)return;await recover(s,w,'The tab left the expected profile. No data from that page was recorded.');return;}
    // Brief stability check avoids mistaking partially mounted content for a hidden list.
    const signature=JSON.stringify([snap.person,snap.listUrl]);
    if(c.candidate!==signature){c.candidate=signature;c.stableSince=now;return;}
    if(now-c.stableSince<(snap.listUrl?SETTLE:2000))return;
    addPerson(s,snap.person,job.depth);
    if(!snap.listUrl){s.branches[job.owner]={status:'hidden',pages:0,profiles:[],reason:'No visible connection-list link on this profile.'};log(s,`${s.nodes[job.owner].name}: connection list not visible`);w.current=null;await save(s);}
    else {
      const url=listURL(snap.listUrl);if(!url)throw Error('LinkedIn provided an unsupported connection-list link.');
      s.branches[job.owner]={status:'collecting',scope:snap.scope,totalLabel:snap.totalLabel,pages:0,profiles:[],url};
      // Follow this list immediately instead of putting it behind every profile.
      await navigate(s,w,{kind:'list',owner:job.owner,depth:job.depth,url});
    }
    return;
  }
  if(snap.kind!=='list'||!sameConnectionOwner(job.url,snap.url)){
    if(now-c.since<4000)return;
    await recover(s,w,'LinkedIn opened a different connection owner or removed the owner filter. No relationships from that page were recorded.');return;
  }
  // Viewer-degree filters affect coverage, not whether these people connect to this owner.
  // Accept only an unchanged owner and record the actual filter for evidence/coverage.
  if(!sameList(job.url,snap.url)){
    const branch=s.branches[job.owner] ||= {pages:0,profiles:[]};
    branch.requestedURL ||= job.url;branch.filterChanged=true;branch.url=snap.url;
    log(s,`${s.nodes[job.owner].name}: LinkedIn adjusted the result filters; collecting the visible subset.`);
    job.url=snap.url;await save(s);
  }
  c.resumeURL=snap.url;
  if(c.advancePending){
    if(c.lastSignature===snap.signature){await performAdvance(s,w,snap);return;}
    // Navigation succeeded before a worker suspension; consume the new page.
    c.advancePending=false;
  }
  if(c.lastSignature===snap.signature){
    if(now-c.since>=UNCHANGED_TIMEOUT)await recover(s,w,'Results stopped changing while waiting for the next page.');
    return;
  }
  if(!snap.isOwn&&!snap.empty&&snap.paginationState==='missing'){
    if(!c.paginationRevealedAt){
      if(now<(s.nextRequestAt||0))return;
      s.nextRequestAt=now+s.config.delay*1000;
      await chrome.scripting.executeScript({target:{tabId:w.tabId},func:advanceLinkedIn,args:[job.url,false,true]});
      c.paginationRevealedAt=now;c.since=now;await save(s);return;
    }
    if(now-c.paginationRevealedAt<1500)return;
  }
  // Require a stable result set and pagination controls before recording a page.
  const candidate=JSON.stringify([snap.signature,snap.hasNext,snap.empty,snap.expectedCount]);
  if(c.candidate!==candidate){c.candidate=candidate;c.stableSince=now;return;}
  if(now-c.stableSince<(!snap.isOwn&&!snap.hasNext?1000:SETTLE))return;
  const branch=s.branches[job.owner];branch.seenPages ||= [];
  const seen=branch.seenPages.includes(snap.signature);
  if(seen&&!c.replaying){
    finishBranch(s,w,'incomplete',`${s.nodes[job.owner].name}: LinkedIn returned an already captured page. Stopped this page loop; other lists continue.`);await save(s);return;
  }
  const beforeEdges=Object.keys(s.edges).length;
  const added=seen?0:ingestPage(s,job,snap),links=Object.keys(s.edges).length-beforeEdges;
  c.lastSignature=snap.signature;c.candidate=null;c.replaying=false;
  if(!seen){
    const existing=snap.people.length-added;
    s.lastBatch={added,links,existing,rows:snap.people.length,owner:job.owner,at:new Date().toISOString()};
    if(added)s.lastDiscoveryAt=s.lastBatch.at;
    log(s,`${s.nodes[job.owner].name}: ${added} new people · ${links} new links · ${existing} already mapped${branch.scope==='mutuals_only'?' · mutual-only list':''}`);
  }
  if(Object.keys(s.nodes).length>=s.config.maxNodes){c.lastSignature=null;limit(s);await save(s);return;}
  if(!seen)branch.seenPages.push(snap.signature);
  if(!snap.isOwn&&!snap.empty&&snap.paginationState==='missing'){
    finishBranch(s,w,'incomplete',`${s.nodes[job.owner].name}: captured visible people, but could not locate a next-page control. This list may be incomplete.`);await save(s);
  }else if(snap.empty||(!snap.isOwn&&!snap.hasNext)||(snap.isOwn&&snap.expectedCount&&snap.people.length>=snap.expectedCount)){
    finishBranch(s,w,branch.scope==='mutuals_only'?'mutuals_only':'exhausted',`${s.nodes[job.owner].name}: end of visible results`);await save(s);
  }else await advance(s,w,snap);

}
async function tick(){
  const s=await read();if(!s||s.status!=='running')return;
  try{
    if(Object.keys(s.nodes).length>=s.config.maxNodes){limit(s);await save(s);return;}
    // Tabs load concurrently; state mutations stay serialized to protect evidence and caps.
    for(const [i,w] of workers(s).entries()){
      if(s.status!=='running')break;
      const assign=s.config.delay===0||i===0;
      try{
        await step(s,w,assign);
        if(s.status==='running'&&!w.current&&assign&&s.queue.length)await navigate(s,w,s.queue.shift());
      }catch(error){
        // A navigation/injection failure affects this lane, not the whole network.
        if(w.current)await recover(s,w,error.message||'The page could not be read.');
        else throw error;
      }
    }
    if(s.status==='running'&&!s.queue.length&&s.workers.every(w=>!w.current)){
      s.status='complete';log(s,'Available collection queue finished. Check Coverage for hidden or incomplete lists.');await save(s);
    }
  }catch(error){await pause(s,error.message||'Collection paused after an unexpected error.');}
  finally{await schedule(s);}
}
async function command(message){
  if(message.type==='PING')return {ok:true,name:'Orbit',version:VERSION};
  if(message.type==='GET_STATE'){const s=await read(),revision=s?`${s.id}:${s.revision||0}:${s.updatedAt}`:'empty';return message.revision===revision?{ok:true,unchanged:true,revision}:{ok:true,state:s,revision};}
  if(message.type==='START'){
    const old=await read();if(old&&['running','paused','limit'].includes(old.status))throw Error('Export or clear the current collection before starting another.');
    const s=newState(message.url,message.config);s.engineVersion=2;await save(s);await schedule(s);await tick();return {ok:true};
  }
  if(message.type==='PAUSE'){const s=await read();if(s?.status==='running')await pause(s,'Paused by you. Your progress and queue are saved.');return {ok:true};}
  if(message.type==='RESUME'){
    const s=await read();if(!s||!['paused','limit'].includes(s.status))throw Error('There is no paused collection to resume.');
    const config=options(message.config||s.config);config.delay=Math.max(120,config.delay||120);if(config.depth!==s.config.depth)throw Error('Exploration depth is fixed for an existing collection. Start a new map to change it.');
    if(Object.keys(s.nodes).length>=config.maxNodes)throw Error('Increase the person limit above the current number of people.');
    s.config=config;s.engineVersion=2;s.status='running';s.attentionTabId=null;
    for(const w of workers(s)){if(w.current){w.current.since=Date.now();w.current.candidate=null;w.current.nextActionAt=0;}}
    // Slower mode drains existing lanes before assigning new work to its single lane.
    log(s,'Resumed collection');await save(s);await schedule(s);wake(0);return {ok:true};
  }
  if(message.type==='CLEAR'){const s=await read();if(s?.status==='running')throw Error('Pause collection before clearing it.');clearTimeout(timer);timer=null;await chrome.alarms.clear(ALARM);cached=null;await chrome.storage.local.remove(KEY);return {ok:true};}
  if(message.type==='SHOW_TAB'){const s=await read(),w=s&&workers(s).find(w=>w.current&&w.tabId);const id=s?.attentionTabId||w?.tabId||s?.tabId;if(id)await chrome.tabs.update(id,{active:true});else throw Error('No collection tab is open yet.');return {ok:true};}
  throw Error('Unknown command.');
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id||!sender.url?.startsWith(chrome.runtime.getURL('')))return false;
  serialize(()=>command(message)).then(reply,e=>reply({ok:false,error:e.message}));return true;
});
chrome.runtime.onMessageExternal?.addListener((message,sender,reply)=>{
  let origin;try{origin=new URL(sender.url).origin;}catch{return false;}
  if(origin!==SITE_ORIGIN)return false;
  serialize(()=>command(message)).then(reply,e=>reply({ok:false,error:e.message}));return true;
});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===ALARM)serialize(tick);});
chrome.tabs.onUpdated?.addListener((id,change)=>{if(change.status==='complete'&&cached?.status==='running'&&cached.workers?.some(w=>w.tabId===id))wake(0);});
chrome.action.onClicked.addListener(()=>chrome.tabs.create({url:chrome.runtime.getURL('map.html')}));
chrome.runtime.onStartup.addListener(()=>serialize(async()=>{
  const s=await read();if(!s)return;
  for(const w of workers(s)){if(w.current)s.queue.unshift(w.current.job);w.current=null;w.tabId=null;}
  s.current=null;s.tabId=null;if(s.status==='running')await pause(s,'Browser restarted. Resume when you are ready.');else await save(s);
}));
chrome.runtime.onInstalled.addListener(()=>serialize(async()=>{const s=await read();if(s?.status==='running')await pause(s,'Companion updated. Collection now uses one tab with at least two minutes between LinkedIn requests. Resume only after resolving any LinkedIn restriction.');}));
serialize(async()=>{const s=await read();if(s?.status==='running'){workers(s);await schedule(s);}});
