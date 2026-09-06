import {newState,options,profileURL,listURL,activityURL,postURL,sameList,sameConnectionOwner,addPerson,ingestPage,ingestComments,log} from './core.js';
import {inspectLinkedIn,advanceLinkedIn,advanceComments} from './collector.js';
import {SITE_ORIGIN,COMPANION_VERSION} from './companion.js';
import {normalizePolicy,nextAction,reserveAction,backoffPolicy,blockPolicy,retryAfter,beginRun} from './collection-policy.js';

const KEY='orbitNetwork',ALARM='orbit-collect',VERSION=COMPANION_VERSION;
const POLL=1000,SETTLE=200,LOAD_TIMEOUT=60000,UNCHANGED_TIMEOUT=15000,WORKSPACE_LEASE=24*60*60*1000;
const QUICK_POSTS=3,QUICK_COMMENT_ACTIONS=6;
const REFRESH_AFTER=24*60*60*1000,REFRESH_BATCH=24;
const PROFILE_REFRESH_AFTER=7*24*60*60*1000,SHARED_KINDS=new Set(['profile','connections','comments']);
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
  s.config.comments=Boolean(s.config.comments);
  if(!s.config.comments){
    s.deferredJobs||=[];
    const defer=job=>{if(job&&!s.deferredJobs.some(item=>item.kind==='posts'&&item.owner===job.owner))s.deferredJobs.push(job);};
    for(const job of s.queue.filter(item=>item.kind==='posts'))defer(job);
    s.queue=s.queue.filter(item=>item.kind!=='posts');
    for(const worker of s.workers)if(worker.current?.job.kind==='posts'){defer({...worker.current.job,replayURL:worker.current.resumeURL});worker.current=null;}
  }else if(s.deferredJobs?.some(job=>job.kind==='posts')){
    const active=new Set([...s.queue,...s.workers.map(worker=>worker.current?.job).filter(Boolean)].filter(job=>job.kind==='posts').map(job=>job.owner));
    const restored=s.deferredJobs.filter(job=>job.kind==='posts'&&!active.has(job.owner));
    s.queue.push(...restored);s.deferredJobs=s.deferredJobs.filter(job=>job.kind!=='posts');
  }
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
function finishBranch(s,w,status,reason){const b=w.current.job.detailsOnly?((s.profileChecks||={})[w.current.job.owner]||={}):w.current.job.kind==='posts'?s.commentCoverage?.[w.current.job.owner]:s.branches[w.current.job.owner];if(b){b.status=status;b.reason=reason;b.checkedAt=new Date().toISOString();}log(s,reason);w.current=null;}
function limit(s){s.status='limit';log(s,'Person limit reached. Increase the limit and resume to expand further.');}
function applySharedGraph(s,payload){
  if(!payload||profileURL(payload.root)!==s.root)return false;
  const coverage={},hints={};
  for(const item of Array.isArray(payload.coverage)?payload.coverage.slice(0,9000):[]){
    const personId=profileURL(item.personId),kind=String(item.kind||''),checked=Date.parse(item.checkedAt||'');
    if(!personId||!SHARED_KINDS.has(kind)||!Number.isFinite(checked)||checked>Date.now()+300000)continue;
    if(kind==='profile'&&item.status!=='checked'||kind!=='profile'&&item.status!=='exhausted')continue;
    const key=`${kind}|${personId}`,previous=coverage[key];if(previous&&Date.parse(previous.checkedAt)>=checked)continue;
    coverage[key]={personId,kind,status:String(item.status||''),scope:String(item.scope||''),checkedAt:new Date(checked).toISOString(),contributor:String(item.contributor||'a teammate').slice(0,200),details:item.details&&typeof item.details==='object'?item.details:{}};
  }
  for(const item of Array.isArray(payload.nodes)?payload.nodes.slice(0,3000):[]){const id=profileURL(item.id||item.url),depth=Number(item.depth);if(!id||id===s.root||!Number.isInteger(depth)||depth<1||depth>6)continue;hints[id]={id,url:id,name:String(item.name||'').slice(0,200),headline:String(item.headline||'').slice(0,1000),location:String(item.location||'').slice(0,300),depth};}
  s.sharedCoverage=coverage;s.sharedHints=hints;return true;
}
function freshShared(s,personId,kind,now=Date.now()){
  if(kind==='connections'&&personId===s.root)return null;
  const value=s.sharedCoverage?.[`${kind}|${personId}`],checked=Date.parse(value?.checkedAt||''),maxAge=kind==='profile'?PROFILE_REFRESH_AFTER:REFRESH_AFTER;
  return Number.isFinite(checked)&&now-checked<maxAge?value:null;
}
function reuseSharedMarkers(s,person,now=Date.now()){
  const profile=freshShared(s,person.id,'profile',now),connections=freshShared(s,person.id,'connections',now),comments=freshShared(s,person.id,'comments',now),marker=value=>({status:'shared',sourceStatus:value.status,shared:true,checkedAt:value.checkedAt,contributor:value.contributor,details:value.details,reason:`Fresh coverage reused from ${value.contributor}.`});
  if(profile&&!(s.profileChecks||={})[person.id])s.profileChecks[person.id]=marker(profile);
  if(connections&&!s.branches[person.id])s.branches[person.id]=marker(connections);
  if(comments&&!(s.commentCoverage||={})[person.id])s.commentCoverage[person.id]={...marker(comments),discoveryVersion:1,posts:[],profiles:[],comments:0};
}
function pruneSharedJobs(s,now=Date.now()){
  const keep=[];for(const job of s.queue||[]){
    if(job.owner===s.root){keep.push(job);continue;}
    if(job.kind==='list'&&freshShared(s,job.owner,'connections',now))continue;
    if(job.kind==='posts'&&freshShared(s,job.owner,'comments',now))continue;
    if(job.kind==='profile'&&job.detailsOnly&&freshShared(s,job.owner,'profile',now))continue;
    if(job.kind==='profile'&&!job.refresh&&!job.detailsOnly&&freshShared(s,job.owner,'connections',now)){if(!freshShared(s,job.owner,'profile',now))keep.push({...job,detailsOnly:true});continue;}
    keep.push(job);
  }s.queue=keep;
}
function queueSharedCandidates(s,minDepth=1){
  if(!Number.isInteger(s.nodeCount))s.nodeCount=Object.keys(s.nodes||{}).length;
  let added=0;for(const person of Object.values(s.sharedHints||{}).sort((a,b)=>a.depth-b.depth||a.id.localeCompare(b.id))){
    if(person.depth<minDepth||person.depth>=s.config.depth||s.nodes[person.id])continue;
    const covered=Boolean(freshShared(s,person.id,'profile')&&freshShared(s,person.id,'connections')&&(!s.config.comments||freshShared(s,person.id,'comments')));if(covered)continue;
    if(s.nodeCount>=s.config.maxNodes){limit(s);break;}s.nodes[person.id]={...person,sharedOnly:true};s.nodeCount++;added++;
  }return added;
}
// Seed post jobs from saved direct connections, avoiding a profile visit per
// author. Do this only after the starter's list finishes (or an explicit skip).
function queueDirectPosts(s,force=false){
  if(!s.config.comments||s.config.depth<2)return;
  if(!force&&workers(s).some(w=>w.current?.job.owner===s.root&&w.current.job.kind!=='posts'))return;
  if(!force&&!['exhausted','hidden','mutuals_only','incomplete','shared'].includes(s.branches[s.root]?.status))return;
  const direct=new Set(s.branches[s.root]?.profiles||[]);
  for(const edge of Object.values(s.edges))if((edge.source===s.root||edge.target===s.root)&&edge.evidence?.some(e=>(e.type||'visible_connection_list')==='visible_connection_list'))direct.add(edge.source===s.root?edge.target:edge.source);
  const people=[...direct].map(id=>s.nodes[id]).filter(p=>p?.depth===1&&!p.sharedOnly);
  const key=JSON.stringify([s.config.depth,people.map(p=>p.id)]);if(s.directPostSeedKey===key)return;
  const occupied=new Set([...s.queue,...(s.deferredJobs||[]),...workers(s).map(w=>w.current?.job).filter(Boolean)].filter(job=>job.kind==='posts').map(job=>job.owner));
  for(const person of people){
    reuseSharedMarkers(s,person);
    queueComments(s,{owner:person.id,depth:1},{activityUrl:activityURL(person.id+'recent-activity/posts/',person.id)},occupied);
  }
  s.directPostSeedKey=key;
}
function sortJobs(s){
  const rank=job=>job.owner===s.root&&job.kind!=='posts'?0:job.kind==='posts'&&job.depth===1&&!job.deepComments?1:job.kind==='posts'?2:3;
  s.queue.sort((a,b)=>rank(a)-rank(b)||(a.depth??0)-(b.depth??0));
}
function finishQuickPosts(s,w,reason){
  const job=w.current.job,coverage=s.commentCoverage[job.owner],{postPass,...next}=job;
  coverage.quickPass={posts:postPass.posts.length,actions:postPass.actions,checkedAt:new Date().toISOString()};
  finishBranch(s,w,'incomplete',reason+' Deeper comment collection is queued after the other direct connections.');
  s.queue.push({...next,deepComments:true});
}
function queueUnexplored(s,minDepth=0){
   pruneSharedJobs(s);
   s.queue=s.queue.filter(job=>job.kind!=='profile'||job.refresh||job.detailsOnly||!['exhausted','hidden','mutuals_only','incomplete','shared'].includes(s.branches[job.owner]?.status));
   const jobs=[...s.queue,...(s.deferredJobs||[]),...workers(s).map(w=>w.current?.job).filter(Boolean)],busyProfiles=new Set(jobs.filter(job=>job.kind==='profile').map(job=>job.owner)),busyAny=new Set(jobs.map(job=>job.owner));
   let added=0,repairs=0;
  for(const person of Object.values(s.nodes).sort((a,b)=>a.depth-b.depth||a.id.localeCompare(b.id))){
    if(person.depth<minDepth||person.depth>=s.config.depth)continue;
     reuseSharedMarkers(s,person);
     if(!s.branches[person.id]&&!busyProfiles.has(person.id)){
       s.queue.push({kind:'profile',owner:person.id,depth:person.depth});busyProfiles.add(person.id);busyAny.add(person.id);added++;continue;
    }
    // Connection-list completion says nothing about profile fields or post coverage.
    // Repair a bounded batch once; preserve completed lists and active/deferred jobs.
     if(repairs>=24||busyAny.has(person.id))continue;
    const checked=s.profileChecks?.[person.id];
    if(!person.location&&!checked){
       s.queue.push({kind:'profile',owner:person.id,depth:person.depth,detailsOnly:true});busyProfiles.add(person.id);busyAny.add(person.id);repairs++;added++;continue;
    }
    const comments=s.commentCoverage?.[person.id];
    if(!comments||!comments.discoveryVersion&&['hidden','incomplete'].includes(comments.status)||comments.status==='queued'){
      const before=s.queue.length;
      queueComments(s,{owner:person.id,depth:person.depth},{activityUrl:activityURL(person.id+'recent-activity/all/',person.id)});
       if(s.queue.length>before){busyAny.add(person.id);repairs++;added++;}
    }
  }
  return added;
}
async function continueSavedFrontier(s){
  queueUnexplored(s);
  if(!s.queue.length&&!workers(s).some(w=>w.current))return false;
  if(!s.runId)await startRun(s);
  s.status='running';s.refreshing=false;s.pauseKind=null;s.attentionTabId=null;
  if(s.workspaceManaged)s.workspaceLeaseUntil=Date.now()+WORKSPACE_LEASE;
  log(s,'Continuing unexplored connections from saved progress');await save(s);await schedule(s);await tick();return true;
}
function prepareIncrementalRefresh(s,now=Date.now()){
  const lastBatch=Date.parse(s.lastRefreshBatchAt||'');
  if(Number.isFinite(lastBatch)&&now-lastBatch<REFRESH_AFTER)return [];
  const legacyCheckedAt=s.lastCompletedAt||s.updatedAt||s.createdAt||new Date(now).toISOString();
  for(const coverage of [...Object.values(s.branches||{}),...Object.values(s.commentCoverage||{})])if(coverage&&!coverage.checkedAt&&coverage.status!=='collecting'&&coverage.status!=='queued')coverage.checkedAt=legacyCheckedAt;
  const candidates=Object.values(s.nodes).filter(person=>person.depth<s.config.depth).map(person=>{
    const branch=s.branches?.[person.id],checked=Date.parse(branch?.checkedAt||'');
    return {person,branch,checked:Number.isFinite(checked)?checked:-Infinity};
  }).filter(item=>!freshShared(s,item.person.id,'connections',now)&&(!item.branch||now-item.checked>=REFRESH_AFTER)).sort((a,b)=>{
    if(a.person.id===s.root)return -1;if(b.person.id===s.root)return 1;
    if(Boolean(a.branch)!==Boolean(b.branch))return a.branch?1:-1;
    return a.checked-b.checked||a.person.depth-b.person.depth||a.person.id.localeCompare(b.person.id);
  });
  return candidates.slice(0,REFRESH_BATCH).map(({person})=>({kind:'profile',owner:person.id,depth:person.depth,refresh:true}));
}
async function beginIncrementalRefresh(s,jobs,automatic=false){
  s.queue=jobs;for(const w of workers(s))w.current=null;
  for(const job of jobs)if(s.branches[job.owner]){s.branches[job.owner].status='queued';s.branches[job.owner].reason='Scheduled for an incremental freshness check.';}
  await startRun(s);s.status='running';s.refreshing=true;s.lastRefreshBatchAt=new Date().toISOString();s.attentionTabId=null;s.engineVersion=5;
  log(s,`${automatic?'Daily incremental refresh':'Incremental refresh'} started · ${jobs.length} stale ${jobs.length===1?'branch':'branches'} · completed checkpoints kept`);
  await save(s);await schedule(s);await tick();
}
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
function queueComments(s,job,snap,occupied){
  if(!s.config.comments)return;
  s.commentCoverage||={};
  const previous=s.commentCoverage[job.owner]||{};
  const repair=!previous.discoveryVersion&&['hidden','incomplete'].includes(previous.status);
  if(previous.status&&!job.refresh&&!repair&&previous.status!=='queued')return;
  if(occupied?occupied.has(job.owner):[...s.queue,...(s.deferredJobs||[])].some(item=>item.kind==='posts'&&item.owner===job.owner)||workers(s).some(w=>w.current?.job.kind==='posts'&&w.current.job.owner===job.owner))return;
  const url=activityURL(snap.activityUrl,job.owner);
  s.commentCoverage[job.owner]={...previous,discoveryVersion:1,status:url?'queued':'hidden',posts:previous.posts||[],comments:previous.comments||0,profiles:previous.profiles||[],url,reason:url?'Queued visible post comments.':'No visible post activity link.'};
  if(url){s.queue.push({kind:'posts',owner:job.owner,depth:job.depth,url,refresh:Boolean(job.refresh)});occupied?.add(job.owner);}
  else s.commentCoverage[job.owner].checkedAt=new Date().toISOString();
}
async function collectComments(s,w,snap){
  const c=w.current,job=c.job,now=Date.now();
  if(snap.kind!=='posts'||!activityURL(snap.url,job.owner)||snap.owner!==job.owner){if(now-c.since<4000)return;await recover(s,w,'The activity page changed owner. No comment links were recorded.');return;}
  const coverage=s.commentCoverage[job.owner];coverage.status='collecting';
  const quick=job.depth===1&&!job.deepComments;
  const pass=quick?(job.postPass||={posts:[],actions:0,perPost:{}}):null;
  const allCards=snap.cards.filter(card=>card.author===job.owner);
  if(pass)for(const card of allCards)if(pass.posts.length<QUICK_POSTS&&!pass.posts.includes(card.urn))pass.posts.push(card.urn);
  const cards=pass?allCards.filter(card=>pass.posts.includes(card.urn)):allCards;
  const signature=JSON.stringify(cards.map(card=>[card.urn,card.control,card.comments.map(c=>c.commentId).sort()]));
  if(c.candidate!==signature){c.candidate=signature;c.stableSince=now;return;}
  if(now-c.stableSince<SETTLE)return;
  const before=Object.keys(s.edges).length,seenPosts=new Set(coverage.posts||[]);
  const postCount=seenPosts.size;for(const card of cards){const post=postURL(card.post);if(post)seenPosts.add(post);}
  coverage.posts=[...seenPosts];if(seenPosts.size>postCount)await save(s);
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
    if(pass&&(c.stalls||0)>=1){finishQuickPosts(s,w,'Saved visible commenters; moving to the next direct connection.');await save(s);return;}
    if((c.stalls||0)>=3){finishBranch(s,w,'incomplete','Post comments stopped changing after three paced actions. Visible evidence is saved.');await save(s);return;}
  }
  if(pass&&(pass.actions>=QUICK_COMMENT_ACTIONS||pass.posts.length>=QUICK_POSTS&&!cards.some(card=>card.control&&(pass.perPost[card.urn]||0)<2))){
    finishQuickPosts(s,w,`Saved a first pass through ${pass.posts.length} recent posts.`);await save(s);return;
  }
  // Bound each author's work so one long post cannot consume the entire run.
  if((c.commentActions||0)>=20){finishBranch(s,w,'incomplete','Saved visible post comments; this profile reached its 20-action collection budget.');await save(s);return;}
  const available=cards.filter(card=>card.control&&(!pass||(pass.perPost[card.urn]||0)<2));
  const card=pass?available.sort((a,b)=>(pass.perPost[a.urn]||0)-(pass.perPost[b.urn]||0))[0]:available[0];
  const request=card?{action:card.control,urn:card.urn}:{action:'scroll'};
  if(now<(s.nextRequestAt||0))return;
  if(!await permit(s)){await save(s);return;}
  if(pass){pass.actions++;if(card)pass.perPost[card.urn]=(pass.perPost[card.urn]||0)+1;}
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
  if(!w.current){if(!assign)return;queueDirectPosts(s);sortJobs(s);const job=s.queue.shift();if(job)await navigate(s,w,job);return;}
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
    const signature=JSON.stringify([snap.person,snap.listUrl,snap.activityUrl]);
    if(c.candidate!==signature){c.candidate=signature;c.stableSince=now;return;}
    if(now-c.stableSince<(snap.listUrl?SETTLE:2000))return;
    addPerson(s,snap.person,job.depth);
    (s.profileChecks||={})[job.owner]={checkedAt:new Date().toISOString()};
    queueComments(s,job,snap);
    if(job.detailsOnly){w.current=null;log(s,`Updated ${s.nodes[job.owner].name}’s profile details; saved lists kept`);await save(s);return;}
    if(!snap.listUrl){const previous=s.branches[job.owner]||{};s.branches[job.owner]={...previous,status:'hidden',pages:previous.pages||0,profiles:previous.profiles||[],reason:'No visible connection-list link on this profile.',checkedAt:new Date().toISOString()};log(s,`${s.nodes[job.owner].name}: connection list not visible`);w.current=null;await save(s);}
    else {
      const url=listURL(snap.listUrl);if(!url)throw Error('LinkedIn provided an unsupported connection-list link.');
      const previous=s.branches[job.owner]||{};
      s.branches[job.owner]={...previous,status:'collecting',scope:snap.scope,totalLabel:snap.totalLabel,pages:previous.pages||0,profiles:previous.profiles||[],url,seenPages:[]};
      delete s.branches[job.owner].partialSignature;delete s.branches[job.owner].resumeURL;delete s.branches[job.owner].checkedAt;
      const listJob={kind:'list',owner:job.owner,depth:job.depth,url,refresh:Boolean(job.refresh)};
      const postIndex=s.queue.findIndex(item=>item.kind==='posts'&&item.owner===job.owner);
      // Inspect this person's posts before a long connection list can starve them.
      if(job.owner!==s.root&&postIndex>=0){const [posts]=s.queue.splice(postIndex,1);s.queue.unshift(listJob);await navigate(s,w,posts);}
      else await navigate(s,w,listJob);
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
  if(c.paginationWaiting){
    if(snap.paginationState!=='missing'||snap.signature!==c.lastSignature){
      c.paginationWaiting=false;c.lastSignature=null;c.replaying=true;c.since=now;
    }else if(!c.paginationRevealedAt){
      if(now<(s.nextRequestAt||0))return;
      if(!await permit(s)){await save(s);return;}
      c.paginationRevealedAt=now;c.since=now;await save(s);
      await chrome.scripting.executeScript({target:{tabId:w.tabId},func:advanceLinkedIn,args:[job.url,false,true]});
      return;
    }else {
      if(now-c.paginationRevealedAt<1500)return;
      c.paginationWaiting=false;c.lastSignature=null;c.replaying=true;c.since=now;
    }
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
  // Save stable visible evidence before waiting for a paced pagination probe.
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
  // Merge changed profile fields and new pair evidence even when every URL
  // is already known. The URL/edge indexes make this idempotent.
  const capture={...snap,countPage:!seen&&branch.partialSignature!==snap.signature};
  const added=ingestPage(s,job,capture),links=Object.keys(s.edges).length-beforeEdges;
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
    if(!c.paginationRevealedAt){c.paginationWaiting=true;await save(s);return;}
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
    // Expand observed paths even if the source list was only partially visible.
    // Coverage remains partial; it does not invalidate the edges already seen.
    for(const [i,w] of workers(s).entries()){
      if(s.status!=='running')break;
      const assign=s.config.delay===0||i===0;
      try{
        await step(s,w,assign);
      }catch(error){
        // A navigation/injection failure affects this lane, not the whole network.
        if(storageFailed)throw error;
        if(w.current)await recover(s,w,error.message||'The page could not be read.');
        else throw error;
      }
    }
    if(s.status==='running'&&s.workers.every(w=>!w.current))queueDirectPosts(s);
    if(s.status==='running'&&!s.queue.length&&s.workers.every(w=>!w.current)){
      s.status='complete';s.lastCompletedAt=new Date().toISOString();log(s,s.refreshing?'Incremental refresh finished. Saved checkpoints remain ready for the next daily check.':'Available collection queue finished. Check Coverage for hidden or incomplete lists.');s.refreshing=false;await save(s);
    }
  }catch(error){await pause(s,error.message||'Collection paused after an unexpected error.');}
  finally{await schedule(s);}
}
async function command(message){
  if(message.type==='PING')return {ok:true,name:'Orbit',version:VERSION,capabilities:['exploreNext','sharedCoverage','quickPosts']};
  if(message.type==='WORKSPACE_ACTIVE'){
    const s=await read();if(!s)return {ok:true};s.workspaceManaged=true;
    if(message.active===false){s.workspaceLeaseUntil=0;if(s.status==='running'){s.pauseKind='workspace_closed';await pause(s,'Orbit paused because the Site was closed. Reopen it to continue from this exact checkpoint.');}else await save(s);return {ok:true};}
    // Background tabs and sleeping computers can delay Site timers for hours.
    // A normal close still pauses immediately through pagehide; this lease is
    // only a crash fallback and must not interrupt an intentionally open run.
    s.workspaceLeaseUntil=Date.now()+WORKSPACE_LEASE;
    if(s.status==='paused'&&s.pauseKind==='workspace_closed'){s.status='running';s.pauseKind=null;s.attentionTabId=null;log(s,'Site reopened · continuing from the saved checkpoint');await save(s);await schedule(s);wake(0);}
    else if(s.status==='complete'&&!(await readPolicy(s)).blocked){if(await continueSavedFrontier(s))return {ok:true};const jobs=prepareIncrementalRefresh(s);if(jobs.length)await beginIncrementalRefresh(s,jobs,true);else await save(s);}
    else await save(s);
    return {ok:true};
  }
  if(message.type==='GET_STATE'){const s=await read(),revision=s?`${s.id}:${s.revision||0}:${s.updatedAt}`:'empty';return message.revision===revision?{ok:true,unchanged:true,revision}:{ok:true,state:s,revision};}
  if(message.type==='SHARED_GRAPH'){
    const s=await read();if(!s)return {ok:true,accepted:false};if(!applySharedGraph(s,message.shared))throw Error('The shared graph does not match the active account network.');
    for(const person of Object.values(s.nodes))reuseSharedMarkers(s,person);pruneSharedJobs(s);await save(s);return {ok:true,accepted:true};
  }
  if(message.type==='LIST_MAPS'){
    const s=await read();return {ok:true,maps:s?[{id:s.id,name:s.nodes[s.root]?.name||'Account map',status:s.status,count:Object.keys(s.nodes).length}]:[]};
  }
  if(message.type==='NEW_MAP'||message.type==='SWITCH_MAP'){
    throw Error('Each account has one persistent map. Change its depth or person limit to expand it.');
  }
  if(message.type==='CANCEL'){
    const s=await read();if(s&&['running','paused','limit'].includes(s.status)){
      s.status='cancelled';s.queue=[];for(const w of workers(s))w.current=null;
      log(s,'Build cancelled. Discovered people are kept in this map.');await save(s);await schedule(s);
    }return {ok:true};
  }
  if(message.type==='START'){
    const root=profileURL(message.url),current=await read(),config=options(message.config||current?.config);
    if(!root)throw Error('Enter a valid LinkedIn profile URL.');
    if(current&&root===current.root&&current.status==='running'){
      if(Object.keys(current.nodes).length>config.maxNodes)throw Error('Increase the person limit above the number already saved.');
      const expanded=config.depth>current.config.depth;current.config={...config,delay:Math.max(120,config.delay||120),depth:Math.max(current.config.depth,config.depth)};
      const gate=nextAction(await readPolicy(current),current.config.delay,Date.now(),current.runId);current.nextRequestAt=gate.at;current.pacing={...gate,actionsToday:policy.actions.length};
      for(const w of workers(current))if(w.current?.nextActionAt&&!w.current.retryAt)w.current.nextActionAt=gate.at;
      queueUnexplored(current);if(expanded)log(current,`Expanded this account map to ${current.config.depth} degrees using its saved network`);await save(current);await schedule(current);wake(0);return {ok:true,status:current.status,reason:current.reason};
    }
    if(current&&root===current.root&&['paused','limit'].includes(current.status))return command({type:'RESUME',config});
    if(current&&root!==current.root)throw Error('This account already has one persistent map. Reset it explicitly before changing the starting profile.');
    await acknowledgeRestriction(current);
    if(current&&root===current.root){
      if(Object.keys(current.nodes).length>config.maxNodes)throw Error('Increase the person limit above the number already saved.');
      current.config={...config,delay:Math.max(120,config.delay||120),depth:Math.max(current.config.depth,config.depth)};
      if(await continueSavedFrontier(current))return {ok:true,status:current.status,reason:current.reason};
      const jobs=prepareIncrementalRefresh(current);
      if(!jobs.length){current.status='complete';current.refreshing=false;current.engineVersion=5;log(current,'Network is current. Orbit will keep this checkpoint and check stale branches on the next daily refresh.');await save(current);await schedule(current);return {ok:true,status:current.status,reason:current.reason};}
      await beginIncrementalRefresh(current,jobs);return {ok:true,status:current.status,reason:current.reason};
    }
    const s=newState(message.url,config);s.nextRequestAt=Math.max(current?.nextRequestAt||0,(await chrome.storage.local.get('orbitNextRequestAt')).orbitNextRequestAt||0);s.engineVersion=5;await startRun(s);await save(s);await schedule(s);await tick();return {ok:true};
  }
  if(message.type==='EXPLORE_NEXT'||message.type==='EXPLORE_POSTS'){
    const postsFirst=message.type==='EXPLORE_POSTS';
    const s=await read();if(!s)throw Error('Collect your connections first.');
    if(message.root&&profileURL(message.root)!==s.root)throw Error('Open your active account network before exploring further.');
    if(!Object.values(s.nodes).some(p=>p.depth===1))throw Error('No first-degree people are saved yet. Continue collecting your connections first.');
    if(['restriction','login','errors'].includes(s.pauseKind))throw Error(s.reason||'Resolve the collection pause, then press Resume.');
    if((await readPolicy(s)).blocked)throw Error(policy.blocked.reason);
    const config=options(message.config||s.config);if(Object.keys(s.nodes).length>=config.maxNodes)throw Error('Increase the people limit in Map settings before exploring further.');
    s.config={...config,comments:postsFirst||config.comments,delay:Math.max(120,config.delay),depth:Math.max(2,s.config.depth,config.depth)};
    if(message.shared&&!applySharedGraph(s,message.shared))throw Error('The shared graph does not match the active account network.');
    // Keep the direct-list checkpoint available for a future refresh. Do not
    // replay it when the user explicitly chooses to explore known connections.
    s.deferredJobs||=[];
    for(const w of workers(s))if(w.current?.job.owner===s.root){s.deferredJobs.push({...w.current.job,replayURL:w.current.resumeURL});w.current=null;}
    s.deferredJobs.push(...s.queue.filter(job=>job.owner===s.root));s.queue=s.queue.filter(job=>job.owner!==s.root);
    if(postsFirst)for(const w of workers(s))if(w.current&&!(w.current.job.kind==='posts'&&w.current.job.depth===1&&!w.current.job.deepComments)){
      s.queue.unshift({...w.current.job,replayURL:w.current.resumeURL});w.current=null;
    }
    queueSharedCandidates(s,1);queueDirectPosts(s,true);queueUnexplored(s,1);
    if(!s.queue.length&&!workers(s).some(w=>w.current)){
      s.status='complete';log(s,'All saved people within this depth have been explored. Increase to 3rd degree in Map settings, or wait for a daily refresh.');await save(s);await schedule(s);return {ok:true,status:s.status,reason:s.reason};
    }
    if(!s.runId)await startRun(s);s.status='running';s.refreshing=false;s.pauseKind=null;s.attentionTabId=null;if(s.workspaceManaged)s.workspaceLeaseUntil=Date.now()+WORKSPACE_LEASE;
    log(s,postsFirst?'Checking direct connections’ recent posts first · saved checkpoints kept':'Exploring connections of saved people · direct-list checkpoint kept');await save(s);await schedule(s);await tick();return {ok:true,status:s.status,reason:s.reason};
  }
  if(message.type==='PAUSE'){const s=await read();if(s?.status==='running'){s.pauseKind='user';await pause(s,'Paused by you. Your progress and queue are saved.');}return {ok:true};}
  if(message.type==='RESUME'){
    const s=await read();if(!s||!['paused','limit'].includes(s.status))throw Error('There is no paused collection to resume.');
    const config=options(message.config||s.config);config.delay=Math.max(120,config.delay||120);config.depth=Math.max(s.config.depth,config.depth);
    if(Object.keys(s.nodes).length>=config.maxNodes)throw Error('Increase the person limit above the current number of people.');
    await acknowledgeRestriction(s);
    const expanded=config.depth>s.config.depth;s.config=config;s.engineVersion=5;s.status='running';s.pauseKind=null;s.attentionTabId=null;if(s.workspaceManaged)s.workspaceLeaseUntil=Date.now()+WORKSPACE_LEASE;
     for(const w of workers(s)){
       const c=w.current;if(!c)continue;
       const person=s.nodes[c.job.owner],comments=s.commentCoverage?.[c.job.owner];
       const missingDetails=person&&!person.location&&!s.profileChecks?.[person.id];
       const missingPosts=s.config.comments&&(!comments||comments.status==='queued'||!comments.discoveryVersion&&['hidden','incomplete'].includes(comments.status));
      if(c.job.kind==='list'&&(missingDetails||missingPosts)){
        // Resume post/details checks ahead of an old, long-running list without
        // discarding its exact URL, captured-page signatures, or pacing history.
        w.current=null;s.queue.unshift({...c.job,replayURL:c.resumeURL||c.job.url});
        if(missingDetails&&!s.queue.some(job=>job.kind==='profile'&&job.owner===person.id))s.queue.push({kind:'profile',owner:person.id,depth:person.depth,detailsOnly:true});
        if(missingPosts)queueComments(s,{owner:c.job.owner,depth:c.job.depth},{activityUrl:activityURL(c.job.owner+'recent-activity/all/',c.job.owner)});
       }else {c.since=Date.now();c.candidate=null;c.nextActionAt=0;}
     }
    queueUnexplored(s);
    log(s,expanded?`Expanded this account map to ${config.depth} degrees and resumed from saved data`:'Resumed from the saved page and remaining queue');await save(s);await schedule(s);await tick();return {ok:true,status:s.status,reason:s.reason};
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
