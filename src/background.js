import {newState,options,profileURL,listURL,activityURL,sameList,sameConnectionOwner,addPerson,ingestPage,ingestComments,log} from './core.js';
import {inspectLinkedIn,advanceLinkedIn,advanceComments} from './collector.js';
import {SITE_ORIGIN,COMPANION_VERSION} from './companion.js';
import {normalizePolicy,nextAction,reserveAction,backoffPolicy,blockPolicy,retryAfter,beginRun} from './collection-policy.js';

const KEY='orbitNetwork',ALARM='orbit-collect',VERSION=COMPANION_VERSION;
const POLL=1000,SETTLE=200,LOAD_TIMEOUT=60000,UNCHANGED_TIMEOUT=15000;
const POLICY_KEY='orbitCollectionPolicy';
let policy,storageFailed=false;
let chain=Promise.resolve(),cached,timer=null,timerAt=Infinity,workspaceTabs=new Map();
const serialize=fn=>{const p=chain.then(fn);chain=p.catch(()=>{});return p;};
const read=async()=>{if(cached===undefined)cached=(await chrome.storage.local.get(KEY))[KEY]||null;return cached;};
async function readPolicy(s){
  if(!policy){
    policy=normalizePolicy((await chrome.storage.local.get(POLICY_KEY))[POLICY_KEY]);
    // Migrate the previous map-only throttle without resetting its deadline.
    policy.nextAt=Math.max(policy.nextAt,s?.nextRequestAt||0,(await chrome.storage.local.get('orbitNextRequestAt')).orbitNextRequestAt||0);
  }
  return policy;
}
async function savePolicy(value){
  // Commit a reservation before touching LinkedIn. A failed write stops this worker.
  try{await chrome.storage.local.set({[POLICY_KEY]:value});policy=value;}
  catch(error){storageFailed=true;throw error;}
}
async function permit(s){
  if(storageFailed)throw Error('Checkpoint storage failed. Reload the companion before collecting again.');
  const p=await readPolicy(s),gate=nextAction(p,s.config.delay,Date.now(),s.runId);
  s.nextRequestAt=gate.at;s.pacing={...gate,actionsToday:p.actions.length};
  if(p.blocked){s.pauseKind='restriction';await pause(s,p.blocked.reason);return false;}
  if(gate.at>Date.now())return false;
  const reserved=reserveAction(p,s.config.delay,Date.now(),s.runId);await savePolicy(reserved);
  s.nextRequestAt=nextAction(reserved,s.config.delay,Date.now(),s.runId).at;return true;
}
async function startRun(s){s.runId=crypto.randomUUID();await savePolicy(beginRun(await readPolicy(s),s.runId));}
async function restriction(s,w,reason,until=0){
  await savePolicy(blockPolicy(await readPolicy(s),reason,until));
  s.nextRequestAt=policy.nextAt;s.pauseKind='restriction';await pause(s,reason,w);
}
async function acknowledgeRestriction(s){
  const p=await readPolicy(s);if(!p.blocked)return;
  if(Date.now()<p.nextAt)throw Error(`${p.blocked.reason} Collection can be resumed after ${new Date(p.nextAt).toLocaleString()}.`);
  // Only an explicit Resume/Start clears the latch; pagehide/heartbeat cannot.
  await savePolicy({...p,blocked:null,failures:0});
}
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
  cached=s;try{await chrome.storage.local.set({[KEY]:s});}catch(error){storageFailed=true;s.status='paused';throw error;}
};
function wake(delay=POLL){
  const at=Date.now()+delay;if(timer!==null&&timerAt<=at)return;
  clearTimeout(timer);timerAt=at;timer=setTimeout(()=>{timer=null;timerAt=Infinity;serialize(tick).catch(()=>{});},delay);timer.unref?.();
}
async function schedule(s){
  if(s?.status==='running'){if(!await chrome.alarms.get(ALARM))await chrome.alarms.create(ALARM,{periodInMinutes:.5});wake();}
  else {clearTimeout(timer);timer=null;await chrome.alarms.clear(ALARM);}
}
const pause=async(s,reason,w)=>{s.attentionTabId=w?.tabId||null;s.status='paused';log(s,reason);try{await save(s);}finally{await schedule(s);}};
function finishBranch(s,w,status,reason){const b=w.current.job.kind==='posts'?s.commentCoverage?.[w.current.job.owner]:s.branches[w.current.job.owner];if(b){b.status=status;b.reason=reason;}log(s,reason);w.current=null;}
function limit(s){s.status='limit';log(s,'Person limit reached. Increase the limit and resume to expand further.');}
async function navigate(s,w,job,replayURL=job.replayURL){
  const url=job.kind==='profile'?profileURL(job.owner):job.kind==='posts'?activityURL(job.url,job.owner):listURL(replayURL&&sameList(job.url,replayURL)?replayURL:job.url);
  if(!url)throw Error('A queued URL is invalid.');
  w.current={job,since:Date.now(),navPending:true,resumeURL:url};
  if(!await permit(s)){await save(s);return;}
  let tab=w.tabId?await chrome.tabs.get(w.tabId).catch(()=>null):null;
  // Save intent before navigation; an interrupted operation can be replayed.
  w.current={job,since:Date.now(),lastSignature:null,advancePending:false,resumeURL:url,replaying:Boolean(replayURL)};await save(s);
  if(!tab)tab=await chrome.tabs.create({url,active:false});else tab=await chrome.tabs.update(tab.id,{url});
  w.tabId=tab.id;log(s,`Exploring ${s.nodes[job.owner]?.name||'profile'}’s ${job.kind==='posts'?'post comments':'connections'}`);await save(s);
}
function queueComments(s,job,snap){
  s.commentCoverage||={};
  if(s.commentCoverage[job.owner])return;
  const url=activityURL(snap.activityUrl,job.owner);
  s.commentCoverage[job.owner]={status:url?'queued':'hidden',posts:[],comments:0,profiles:[],url,reason:url?'Queued visible post comments.':'No visible post activity link.'};
  if(url)s.queue.push({kind:'posts',owner:job.owner,depth:job.depth,url});
}
async function collectComments(s,w,snap){
  const c=w.current,job=c.job,now=Date.now();
  if(snap.kind!=='posts'||!activityURL(snap.url,job.owner)||snap.owner!==job.owner){if(now-c.since<4000)return;await recover(s,w,'The activity page changed owner. No comment links were recorded.');return;}
  const coverage=s.commentCoverage[job.owner];coverage.status='collecting';
  const cards=snap.cards.filter(card=>card.author===job.owner);
  const signature=JSON.stringify(cards.map(card=>[card.urn,card.control,card.comments.map(c=>c.commentId).sort()]));
  if(c.candidate!==signature){c.candidate=signature;c.stableSince=now;return;}
  if(now-c.stableSince<SETTLE)return;
  const before=Object.keys(s.edges).length;
  const result=c.capturedSignature===signature?{added:0,observations:0}:ingestComments(s,job,cards.flatMap(card=>card.comments));
  if(Object.keys(s.nodes).length<s.config.maxNodes)c.capturedSignature=signature;
  if(result.observations){c.stalls=0;s.lastBatch={added:result.added,links:Object.keys(s.edges).length-before,existing:0,rows:result.observations,owner:job.owner,at:new Date().toISOString()};log(s,`${s.nodes[job.owner].name}: ${result.added} new people · ${result.observations} comment observations`);await save(s);}
  if(Object.keys(s.nodes).length>=s.config.maxNodes){limit(s);await save(s);return;}
  if(snap.empty){finishBranch(s,w,'exhausted','No visible posts on this profile.');await save(s);return;}
  if(c.awaitingComments){
    if(signature===c.actionSignature&&now-c.since<UNCHANGED_TIMEOUT)return;
    if(signature===c.actionSignature)c.stalls=(c.stalls||0)+1;
    else c.stalls=0;
    c.awaitingComments=false;
    if((c.stalls||0)>=3){finishBranch(s,w,'incomplete','Post comments stopped changing after three paced actions. Visible evidence is saved.');await save(s);return;}
  }
  // Bound each author's work so one long post cannot consume the entire run.
  if((c.commentActions||0)>=20){finishBranch(s,w,'incomplete','Saved visible post comments; this profile reached its 20-action collection budget.');await save(s);return;}
  const card=cards.find(card=>card.control);
  const request=card?{action:card.control,urn:card.urn}:{action:'scroll'};
  if(now<(s.nextRequestAt||0))return;
  if(!await permit(s)){await save(s);return;}
  c.commentActions=(c.commentActions||0)+1;c.awaitingComments=true;c.actionSignature=signature;c.since=now;
  // Save intent before expansion; a suspended worker consumes new comments on resume.
  await save(s);
  await chrome.scripting.executeScript({target:{tabId:w.tabId},func:advanceComments,args:[job.url,request]});
}
async function advance(s,w,snap){
  const c=w.current;c.advancePending=true;c.nextActionAt=s.nextRequestAt||0;await save(s);
}
async function performAdvance(s,w,snap){
  const c=w.current;if(Date.now()<Math.max(c.nextActionAt||0,s.nextRequestAt||0))return;
  if(!await permit(s)){await save(s);return;}
  // Persist the in-flight action as well as its reservation before injection.
  c.advancePending=false;c.awaitingResults=true;c.since=Date.now();await save(s);
  const [r]=await chrome.scripting.executeScript({target:{tabId:w.tabId},func:advanceLinkedIn,args:[c.job.url,snap.isOwn]});
  c.candidate=null;delete c.paginationRevealedAt;
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
  await savePolicy(backoffPolicy(await readPolicy(s),s.config.delay));
  s.nextRequestAt=policy.nextAt;
  c.job.retryAttempts=attempts+1;c.retryAt=policy.nextAt;c.retryReason=reason;
  if(policy.failures>=5){s.pauseKind='errors';await pause(s,'Repeated collection failures. Check the LinkedIn tab before resuming.',w);return;}
  log(s,`Retrying ${s.nodes[c.job.owner]?.name||'profile'} (${attempts+1}/2): ${reason}`);
  await save(s);
}
async function step(s,w,assign=true){
  if(!w.current){if(!assign)return;s.queue.sort((a,b)=>(a.depth??0)-(b.depth??0));const job=s.queue.shift();if(job)await navigate(s,w,job);return;}
  if(w.current.navPending){if(Date.now()>=(s.nextRequestAt||0))await navigate(s,w,w.current.job,w.current.resumeURL);return;}
  if(w.current.retryAt){if(Date.now()>=w.current.retryAt)await navigate(s,w,w.current.job,w.current.resumeURL);return;}
  const c=w.current,job=c.job,tab=await chrome.tabs.get(w.tabId).catch(()=>null),now=Date.now();
  if(!tab){w.tabId=null;await recover(s,w,'The collection tab closed or was discarded. Reopening its saved page.');return;}
  // Inspect first, even while images load, so restrictions never become reload loops.
  const [result]=await chrome.scripting.executeScript({target:{tabId:w.tabId},func:inspectLinkedIn});
  const snap=result?.result;if(!snap)throw Error('The LinkedIn page could not be read.');
  if(snap.kind==='list'){snap.signature=(snap.people||[]).map(p=>profileURL(p.url)).filter(Boolean).sort().join('|');if(c.lastSignature)c.lastSignature=c.lastSignature.split('|').sort().join('|');}
  if(snap.kind==='blocked'){if(snap.blockType==='login'){s.pauseKind='login';await pause(s,snap.reason,w);}else await restriction(s,w,snap.reason);return;}
  if(snap.kind==='unexpected'){if(now-c.since<4000)return;await recover(s,w,snap.reason);return;}
  if(snap.kind==='loading'){if(now-c.since>LOAD_TIMEOUT)await recover(s,w,'The page did not expose readable results.');return;}
  if(job.kind==='posts'){await collectComments(s,w,snap);return;}
  if(!c.lastSignature&&!c.advancePending&&(snap.paginationState!=='missing'||c.paginationRevealedAt)&&now-c.since>LOAD_TIMEOUT){await recover(s,w,'The rendered content never settled.');return;}
  if(job.kind==='profile'){
    if(snap.kind!=='profile'||profileURL(snap.url)!==job.owner){if(now-c.since<4000)return;await recover(s,w,'The tab left the expected profile. No data from that page was recorded.');return;}
    // Brief stability check avoids mistaking partially mounted content for a hidden list.
    const signature=JSON.stringify([snap.person,snap.listUrl]);
    if(c.candidate!==signature){c.candidate=signature;c.stableSince=now;return;}
    if(now-c.stableSince<(snap.listUrl?SETTLE:2000))return;
    addPerson(s,snap.person,job.depth);
    queueComments(s,job,snap);
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
  c.resumeURL=snap.url;s.branches[job.owner].resumeURL=snap.url;
  if(c.advancePending){
    if(c.lastSignature===snap.signature){await performAdvance(s,w,snap);return;}
    // Navigation succeeded before a worker suspension; consume the new page.
    c.advancePending=false;
  }
  if(c.lastSignature===snap.signature){
    if(c.awaitingResults){
      if(now-c.since<UNCHANGED_TIMEOUT)return;
      c.awaitingResults=false;c.unchangedAdvances=(c.unchangedAdvances||0)+1;
      if(c.unchangedAdvances>=3){finishBranch(s,w,'incomplete',`${s.nodes[job.owner].name}: no new connections after three paced ${snap.isOwn?'scroll':'next-page'} attempts. Saved progress; the visible list may be incomplete.`);await save(s);return;}
      await advance(s,w,snap);return;
    }
    if(now-c.since>=UNCHANGED_TIMEOUT)await recover(s,w,'Results stopped changing while waiting for the next page.');
    return;
  }
  if(!snap.isOwn&&!snap.empty&&snap.paginationState==='missing'){
    if(!c.paginationRevealedAt){
      if(now<(s.nextRequestAt||0))return;
      if(!await permit(s)){await save(s);return;}
      c.paginationRevealedAt=now;c.since=now;await save(s);
      await chrome.scripting.executeScript({target:{tabId:w.tabId},func:advanceLinkedIn,args:[job.url,false,true]});
      c.paginationRevealedAt=now;c.since=now;await save(s);return;
    }
    if(now-c.paginationRevealedAt<1500)return;
  }
  // Require a stable result set and pagination controls before recording a page.
  const candidate=JSON.stringify([snap.signature,snap.hasNext,snap.empty,snap.expectedCount]);
  if(c.candidate!==candidate){c.candidate=candidate;c.stableSince=now;return;}
  if(now-c.stableSince<(!snap.isOwn&&!snap.hasNext?1000:SETTLE))return;
  const branch=s.branches[job.owner];branch.seenPages ||= [];if(snap.expectedCount)branch.expectedCount=Math.max(branch.expectedCount||0,snap.expectedCount);
  const seen=branch.seenPages.includes(snap.signature);
  if(seen&&!c.replaying&&!snap.isOwn){
    finishBranch(s,w,'incomplete',`${s.nodes[job.owner].name}: LinkedIn returned an already captured page. Stopped this page loop; other lists continue.`);await save(s);return;
  }
  const beforeEdges=Object.keys(s.edges).length;
  // Virtualized lists replace the visible rows; count the union across snapshots.
  const known=new Set(branch.profiles),newRows=(snap.people||[]).filter(p=>!known.has(profileURL(p.url)));
  const capture={...snap,people:snap.isOwn?newRows:snap.people,countPage:branch.partialSignature!==snap.signature};
  const added=seen?0:ingestPage(s,job,capture),links=Object.keys(s.edges).length-beforeEdges;
  if(newRows.length){c.unchangedAdvances=0;if(policy?.failures)await savePolicy({...policy,failures:0});}
  else if(snap.isOwn&&c.awaitingResults){c.unchangedAdvances=(c.unchangedAdvances||0)+1;}
  c.awaitingResults=false;c.lastSignature=snap.signature;c.candidate=null;c.replaying=false;
  if(!seen){
    const existing=snap.people.length-added;
    s.lastBatch={added,links,existing,rows:snap.people.length,owner:job.owner,at:new Date().toISOString()};
    if(added)s.lastDiscoveryAt=s.lastBatch.at;
    log(s,`${s.nodes[job.owner].name}: ${added} new people · ${links} new links · ${existing} already mapped${branch.scope==='mutuals_only'?' · mutual-only list':''}`);
  }
  if(Object.keys(s.nodes).length>=s.config.maxNodes){branch.partialSignature=snap.signature;c.lastSignature=null;limit(s);await save(s);return;}
  delete branch.partialSignature;
  if(!seen)branch.seenPages.push(snap.signature);
  if(snap.isOwn&&(c.unchangedAdvances||0)>=3){finishBranch(s,w,'incomplete',`${s.nodes[job.owner].name}: no new connections after three paced scroll attempts. Saved progress; the visible list may be incomplete.`);await save(s);return;}
  if(!snap.isOwn&&!snap.empty&&snap.paginationState==='missing'){
    finishBranch(s,w,'incomplete',`${s.nodes[job.owner].name}: captured visible people, but could not locate a next-page control. This list may be incomplete.`);await save(s);
  }else if(snap.empty||(!snap.isOwn&&!snap.hasNext)||(snap.isOwn&&branch.expectedCount&&branch.profiles.length>=branch.expectedCount)){
    finishBranch(s,w,branch.scope==='mutuals_only'?'mutuals_only':'exhausted',`${s.nodes[job.owner].name}: end of visible results`);await save(s);
  }else await advance(s,w,snap);

}
async function tick(){
  const s=await read();if(!s||s.status!=='running')return;
  try{
    if(storageFailed)throw Error('Checkpoint storage failed. Reload the companion before collecting again.');
    if(s.workspaceManaged&&Date.now()>(s.workspaceLeaseUntil||0)){s.pauseKind='workspace_closed';await pause(s,'Orbit paused because the Site was closed. Reopen it to continue from this exact checkpoint.');return;}
    if(Object.keys(s.nodes).length>=s.config.maxNodes){limit(s);await save(s);return;}
    const rootBranch=s.branches[s.root],hasExpansion=s.queue.some(job=>(job.depth??0)>0);
    const rootCommentsPending=s.queue.some(job=>job.kind==='posts'&&job.owner===s.root)||s.workers?.some(w=>w.current?.job.kind==='posts'&&w.current.job.owner===s.root);
    if(hasExpansion&&!rootCommentsPending&&!s.commentCoverage?.[s.root]?.profiles.length&&rootBranch&&['incomplete','hidden','mutuals_only'].includes(rootBranch.status)){
      await pause(s,`Direct-layer check needed: Orbit found ${rootBranch.profiles?.length||0}${rootBranch.expectedCount?` of ${rootBranch.expectedCount}`:''} visible direct connections. Resolve this in the collection tab before connections-of-connections are expanded.`);return;
    }
    // Always finish shallower jobs first so every displayed distance has a verified chain.
    s.queue.sort((a,b)=>(a.depth??0)-(b.depth??0));
    for(const [i,w] of workers(s).entries()){
      if(s.status!=='running')break;
      const assign=s.config.delay===0||i===0;
      try{
        await step(s,w,assign);
        // Let the next tick check direct-layer coverage before assigning more work.
      }catch(error){
        // A navigation/injection failure affects this lane, not the whole network.
        if(storageFailed)throw error;
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
async function archiveCurrent(){
 const s=await read();if(!s)return;
 if(s.status==='running')await pause(s,'Paused while switching maps. Resume when ready.');
 const maps=(await chrome.storage.local.get('orbitMaps')).orbitMaps||{};
 maps[s.id]=s;await chrome.storage.local.set({orbitMaps:maps,orbitNextRequestAt:Math.max(s.nextRequestAt||0,(await chrome.storage.local.get('orbitNextRequestAt')).orbitNextRequestAt||0)});
}
async function command(message){
  if(message.type==='PING')return {ok:true,name:'Orbit',version:VERSION};
  if(message.type==='WORKSPACE_ACTIVE'){
    const s=await read();if(!s)return {ok:true};s.workspaceManaged=true;
    if(message.active===false){s.workspaceLeaseUntil=0;if(s.status==='running'){s.pauseKind='workspace_closed';await pause(s,'Orbit paused because the Site was closed. Reopen it to continue from this exact checkpoint.');}else await save(s);return {ok:true};}
    // Three minutes tolerates aggressive background-tab timer throttling while
    // pagehide still pauses immediately on a normal close or navigation.
    s.workspaceLeaseUntil=Date.now()+180000;
    if(s.status==='paused'&&s.pauseKind==='workspace_closed'){s.status='running';s.pauseKind=null;s.attentionTabId=null;log(s,'Site reopened · continuing from the saved checkpoint');await save(s);await schedule(s);wake(0);}else await save(s);
    return {ok:true};
  }
  if(message.type==='GET_STATE'){const s=await read(),revision=s?`${s.id}:${s.revision||0}:${s.updatedAt}`:'empty';return message.revision===revision?{ok:true,unchanged:true,revision}:{ok:true,state:s,revision};}
  if(message.type==='LIST_MAPS'){
    const maps=(await chrome.storage.local.get('orbitMaps')).orbitMaps||{},s=await read();if(s)maps[s.id]=s;
    return {ok:true,maps:Object.values(maps).map(s=>({id:s.id,name:s.nodes[s.root]?.name||'Untitled map',status:s.status,count:Object.keys(s.nodes).length}))};
  }
  if(message.type==='NEW_MAP'||message.type==='SWITCH_MAP'){
    const maps=(await chrome.storage.local.get('orbitMaps')).orbitMaps||{};
    if(message.type==='SWITCH_MAP'&&!maps[message.id]&&(await read())?.id!==message.id)throw Error('Map not found.');
    if(message.type==='SWITCH_MAP'&&(await read())?.id===message.id)return {ok:true};
    await archiveCurrent();await schedule(null);
    if(message.type==='NEW_MAP'){cached=null;await chrome.storage.local.remove(KEY);}
    else {maps[message.id].nextRequestAt=Math.max(maps[message.id].nextRequestAt||0,(await chrome.storage.local.get('orbitNextRequestAt')).orbitNextRequestAt||0);await save(maps[message.id]);await schedule(maps[message.id]);}
    return {ok:true};
  }
  if(message.type==='CANCEL'){
    const s=await read();if(s&&['running','paused','limit'].includes(s.status)){
      s.status='cancelled';s.queue=[];for(const w of workers(s))w.current=null;
      log(s,'Build cancelled. Discovered people are kept in this map.');await save(s);await schedule(s);
    }return {ok:true};
  }
  if(message.type==='START'){
    const root=profileURL(message.url),current=await read(),config=options(message.config);
    if(!root)throw Error('Enter a valid LinkedIn profile URL.');
    if(current&&root===current.root&&current.status==='running')return {ok:true};
    if(current&&root===current.root&&['paused','limit'].includes(current.status))return command({type:'RESUME',config});
    await acknowledgeRestriction(current);
    if(current&&root===current.root){if(Object.keys(current.nodes).length>config.maxNodes)throw Error('Increase the person limit above the number already saved.');current.config={...config,delay:Math.max(120,config.delay||120),depth:Math.max(current.config.depth,config.depth)};current.queue=[];current.commentCoverage={};await startRun(current);for(const person of Object.values(current.nodes).sort((a,b)=>a.depth-b.depth))if(person.depth<current.config.depth)current.queue.push({kind:'profile',owner:person.id,depth:person.depth});for(const w of workers(current))w.current=null;if(current.branches[root])current.branches[root].status='queued';current.status='running';current.attentionTabId=null;current.engineVersion=3;log(current,'Refreshing your single account network from the direct layer outward');await save(current);await schedule(current);await tick();return {ok:true};}
    const s=newState(message.url,config);s.nextRequestAt=Math.max(current?.nextRequestAt||0,(await chrome.storage.local.get('orbitNextRequestAt')).orbitNextRequestAt||0);s.engineVersion=4;await startRun(s);await save(s);await schedule(s);await tick();return {ok:true};
  }
  if(message.type==='PAUSE'){const s=await read();if(s?.status==='running'){s.pauseKind='user';await pause(s,'Paused by you. Your progress and queue are saved.');}return {ok:true};}
  if(message.type==='RESUME'){
    const s=await read();if(!s||!['paused','limit'].includes(s.status))throw Error('There is no paused collection to resume.');
    const config=options(message.config||s.config);config.delay=Math.max(120,config.delay||120);if(config.depth!==s.config.depth)throw Error('Exploration depth is fixed for an existing collection. Start a new map to change it.');
    if(Object.keys(s.nodes).length>=config.maxNodes)throw Error('Increase the person limit above the current number of people.');
    await acknowledgeRestriction(s);
    s.config=config;s.engineVersion=3;s.status='running';s.pauseKind=null;s.attentionTabId=null;if(s.workspaceManaged)s.workspaceLeaseUntil=Date.now()+180000;
    const rootBranch=s.branches[s.root],repair=['incomplete','hidden','mutuals_only'].includes(rootBranch?.status)&&!s.commentCoverage?.[s.root]?.profiles.length&&!workers(s).some(w=>w.current?.job.kind==='posts'&&w.current.job.owner===s.root);
    if(repair){const interrupted=[];for(const w of workers(s)){if(w.current)interrupted.push(w.current.job);w.current=null;}const direct=rootBranch.scope==='connections'&&listURL(rootBranch.url)?{kind:'list',owner:s.root,depth:0,url:rootBranch.url,replayURL:rootBranch.resumeURL||rootBranch.url}:{kind:'profile',owner:s.root,depth:0};const jobs=[direct,...interrupted,...s.queue],seen=new Set();s.queue=jobs.filter(job=>{const key=`${job.kind}|${job.owner}|${job.depth??0}`;if(seen.has(key)||job.owner===s.root&&job!==direct)return false;seen.add(key);return true;});rootBranch.status='queued';rootBranch.reason='Rechecking the complete direct layer before continuing.';log(s,'Resuming by rechecking your direct connections, then continuing the saved queue');}
    else for(const w of workers(s)){if(w.current){w.current.since=Date.now();w.current.candidate=null;w.current.nextActionAt=0;}}
    // Slower mode drains existing lanes before assigning new work to its single lane.
    if(!repair)log(s,'Resumed collection');await save(s);await schedule(s);await tick();return {ok:true,status:s.status,reason:s.reason};
  }
  if(message.type==='CLEAR'){const s=await read();if(s?.status==='running')throw Error('Pause collection before clearing it.');clearTimeout(timer);timer=null;await chrome.alarms.clear(ALARM);const maps=(await chrome.storage.local.get('orbitMaps')).orbitMaps||{};if(s)delete maps[s.id];await chrome.storage.local.set({orbitMaps:maps});cached=null;await chrome.storage.local.remove(KEY);return {ok:true};}
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
  if(sender.tab?.id)workspaceTabs.set(sender.tab.id,{id:sender.tab.id,windowId:sender.tab.windowId,lastSeen:Date.now()});
  serialize(()=>command(message)).then(reply,e=>reply({ok:false,error:e.message}));return true;
});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===ALARM)serialize(tick);});
chrome.tabs.onUpdated?.addListener((id,change)=>{if(change.status==='complete'&&cached?.status==='running'&&cached.workers?.some(w=>w.tabId===id))wake(0);});
// Observe response status only in the collector's tab. Never intercept requests,
// read cookies/bodies, or retry a platform restriction automatically.
chrome.webRequest?.onHeadersReceived.addListener(details=>{
  const status=details.statusCode;
  if(![429,999].includes(status)&&!(details.type==='main_frame'&&[401,403].includes(status)))return;
  serialize(async()=>{
    const s=await read(),w=s?.workers?.find(w=>w.tabId===details.tabId);
    // A late response still applies after the last rows were saved or a build
    // was cancelled; finishing a job must not discard a server cooldown.
    if(!w)return;
    const header=details.responseHeaders?.find(h=>h.name.toLowerCase()==='retry-after')?.value;
    const reason=`LinkedIn returned HTTP ${status}. Collection stopped. Check the collection tab and resume manually after the cooldown.`;
    await restriction(s,w,reason,retryAfter(header));
  }).catch(()=>{});
},{urls:['https://www.linkedin.com/*'],types:['main_frame','xmlhttprequest']},['responseHeaders']);
// The Site is the only user-facing workspace. The extension stays in the
// background and supplies collection capabilities through external messages.
async function openWorkspace(){
  for(const remembered of [...workspaceTabs.values()].sort((a,b)=>b.lastSeen-a.lastSeen)){try{const existing=await chrome.tabs.get(remembered.id);if(chrome.windows?.update&&existing.windowId)await chrome.windows.update(existing.windowId,{focused:true});await chrome.tabs.update(existing.id,{active:true});remembered.lastSeen=Date.now();return existing;}catch{workspaceTabs.delete(remembered.id);}}
  const created=await chrome.tabs.create({url:`${SITE_ORIGIN}/map.html?source=companion`});workspaceTabs.set(created.id,{id:created.id,windowId:created.windowId,lastSeen:Date.now()});return created;
}
chrome.action.onClicked.addListener(()=>openWorkspace().catch(()=>chrome.tabs.create({url:`${SITE_ORIGIN}/map.html?source=companion`})));
chrome.runtime.onStartup.addListener(()=>serialize(async()=>{
  const s=await read();if(!s)return;
  for(const w of workers(s)){if(w.current)s.queue.unshift({...w.current.job,replayURL:w.current.resumeURL});w.current=null;w.tabId=null;}
  s.current=null;s.tabId=null;if(s.status==='running')await pause(s,'Browser restarted. Resume when you are ready.');else await save(s);
}));
chrome.runtime.onInstalled.addListener(()=>serialize(async()=>{const s=await read();if(s?.status==='running')await pause(s,'Companion updated. Progress is saved. Resume from Orbit to use improved scrolling, persistent pacing, and restriction detection.');}));
serialize(async()=>{const s=await read();if(s?.status==='running'){workers(s);await schedule(s);}});
