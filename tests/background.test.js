import test from 'node:test';
import assert from 'node:assert/strict';
import {route,newState} from '../src/core.js';
const root='https://www.linkedin.com/in/root/',a='https://www.linkedin.com/in/a/',b='https://www.linkedin.com/in/b/';
const list=id=>`https://www.linkedin.com/search/results/people/?connectionOf=${id}`;
const person=id=>({url:`https://www.linkedin.com/in/${id}/`,name:id.toUpperCase()});
const profile=(p,url)=>({kind:'profile',url:p.url,person:p,listUrl:url,scope:'connections'});
const page=(url,people,extra={})=>({kind:'list',url,people,signature:people.map(p=>p.url).join('|'),hasNext:false,...extra});
let serial=0;
async function harness(t,initial,saved={}){
  const data={...structuredClone(saved),...(initial?{orbitNetwork:structuredClone(initial)}:{})},listeners={},alarms=new Map(),tabs=new Map();let now=1000000,nextTab=0,advances=0,snapshots={},onAdvance,onComments;const requests=[];
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));t.mock.method(globalThis,'clearTimeout',()=>{});
  const event=name=>({addListener(fn){listeners[name]=fn;}});
  globalThis.chrome={runtime:{id:'test-extension',getURL:p=>`chrome-extension://test-extension/${p}`,onMessage:event('message'),onMessageExternal:event('external'),onStartup:event('startup'),onInstalled:event('installed')},storage:{local:{async get(k){return structuredClone({[k]:data[k]});},async set(v){Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}}},alarms:{async create(k,v){alarms.set(k,v);},async clear(k){alarms.delete(k);},async get(k){return alarms.get(k);},onAlarm:event('alarm')},tabs:{onUpdated:event('updated'),async create(v){requests.push(now);const tab={id:++nextTab,status:'complete',lastAccessed:now,windowId:1,...v};tabs.set(tab.id,tab);return tab;},async get(id){if(!tabs.has(id))throw Error('No tab');return tabs.get(id);},async update(id,v){if(v.url)requests.push(now);Object.assign(tabs.get(id),v);return tabs.get(id);}},windows:{async update(id,v){return {id,...v};}},scripting:{async executeScript({target,func}){if(func.name==='advanceComments'){requests.push(now);onComments?.(tabs.get(target.tabId));return [{result:'expanded'}];}if(func.name==='advanceLinkedIn'){requests.push(now);advances++;onAdvance?.(tabs.get(target.tabId));return [{result:'next'}];}const value=snapshots[tabs.get(target.tabId).url];if(value instanceof Error)throw value;return [{result:structuredClone(value)}];}},action:{onClicked:event('action')},webRequest:{onHeadersReceived:event('headers')}};
  await import(`../src/background.js?test=${serial++}`);
  const command=msg=>new Promise(resolve=>listeners.message(msg,{id:'test-extension',url:'chrome-extension://test-extension/index.html'},resolve));
  const flush=async()=>{for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));};
  const tick=async(ms=500)=>{now+=ms;const s=data.orbitNetwork,c=s?.current;if(c&&!c.lastSignature&&!c.paginationRevealedAt&&c.job.kind==='list'&&snapshots[tabs.get(s.tabId)?.url]?.paginationState==='missing')now=Math.max(now,s.nextRequestAt||0);if(c?.navPending||c?.advancePending||c?.retryAt||(c?.paginationWaiting))now=Math.max(now,s.nextRequestAt||0,c.nextActionAt||0,c.retryAt||0);listeners.alarm({name:'orbit-collect'});await flush();};
  const elapse=async ms=>{now+=ms;listeners.alarm({name:'orbit-collect'});await flush();};
  return {data,listeners,alarms,tabs,requests,command,tick,elapse,flush,set snapshots(v){snapshots=v;},set onAdvance(v){onAdvance=v;},set onComments(v){onComments=v;},get advances(){return advances;}};
}
test('first two actions start promptly, later actions obey two-minute spacing; restrictions pause collection',async t=>{
  const h=await harness(t);h.snapshots={[root]:profile(person('root'),list('root')),[list('root')]:page(list('root'),[person('a')]),[a]:profile(person('a'),list('a')),[list('a')]:page(list('a'),[person('b')])};
  assert.equal((await h.command({type:'START',url:root})).ok,true);
  for(let i=0;i<30;i++)await h.tick();
  const s=h.data.orbitNetwork;assert.equal(s.status,'complete');assert.deepEqual(route(s,b),[root,a,b]);assert.equal(s.pages,2);assert.equal(h.advances,0);for(let i=2;i<h.requests.length;i++)assert.ok(h.requests[i]-h.requests[i-1]>=120000);assert.equal(h.alarms.size,0);
  await h.elapse(Date.parse(s.branches[root].checkedAt)-Date.now()+24*60*60*1000+1);
  h.snapshots={[root]:{kind:'blocked',url:root,reason:'LinkedIn verification required'}};
  const refresh=await h.command({type:'START',url:root});assert.equal(refresh.status,'running');await h.tick();await h.tick();assert.equal(h.data.orbitNetwork.status,'paused');assert.equal(h.alarms.size,0);
  assert.equal((await h.command({type:'RESUME',config:{maxNodes:1000,depth:3,delay:0}})).ok,false);
  assert.equal(h.listeners.external({type:'GET_STATE'},{url:'https://evil.example/'},()=>{}),false);
  assert.equal(h.listeners.message({type:'CLEAR'},{id:'test-extension',url:'https://www.linkedin.com/'},()=>{}),false);
  const result=await h.command({type:'GET_STATE'});assert.ok(result.state);assert.equal((await h.command({type:'GET_STATE',revision:result.revision})).unchanged,true);
  h.listeners.action();await h.flush();assert.equal([...h.tabs.values()].at(-1).url,'https://orbit-shreev2703-graph-test.shreev2703.chatgpt.site/map.html?source=companion');const tabCount=h.tabs.size;h.listeners.action();await h.flush();assert.equal(h.tabs.size,tabCount);assert.equal([...h.tabs.values()].at(-1).active,true);
});
test('closing and reopening the Site pauses and resumes the same checkpoint',async t=>{
  const h=await harness(t);h.snapshots={[root]:profile(person('root'),list('root')),[list('root')]:page(list('root'),[person('a')])};await h.command({type:'START',url:root,config:{depth:1,delay:0}});const id=h.data.orbitNetwork.id;
  await h.command({type:'WORKSPACE_ACTIVE',active:false});assert.equal(h.data.orbitNetwork.status,'paused');assert.equal(h.data.orbitNetwork.pauseKind,'workspace_closed');assert.equal(h.data.orbitNetwork.id,id);assert.ok(h.data.orbitNetwork.current||h.data.orbitNetwork.queue.length);
  await h.command({type:'WORKSPACE_ACTIVE',active:true});assert.equal(h.data.orbitNetwork.status,'running');assert.equal(h.data.orbitNetwork.pauseKind,null);for(let i=0;i<15;i++){await h.command({type:'WORKSPACE_ACTIVE',active:true});await h.tick();}assert.equal(h.data.orbitNetwork.status,'complete');assert.ok(h.data.orbitNetwork.nodes[a]);
});
test('one paced tab follows lists and respects the shared cap on resume',async t=>{
  const h=await harness(t),first=['a','b','c'].map(person),snapshots={[root]:profile(person('root'),list('root')),[list('root')]:page(list('root'),first)};
  for(const p of first){const id=p.name.toLowerCase();snapshots[p.url]=profile(p,list(id));snapshots[list(id)]=page(list(id),Array.from({length:10},(_,i)=>person(`${id}-${i}`)));}
  h.snapshots=snapshots;await h.command({type:'START',url:root,config:{maxNodes:10,depth:2,delay:0}});
  for(let i=0;i<7;i++)await h.tick();
  assert.equal(h.tabs.size,1);assert.equal(h.data.orbitNetwork.workers.filter(w=>w.current).length,1);
  for(let i=0;i<12;i++)await h.tick();
  assert.equal(h.data.orbitNetwork.status,'limit');assert.equal(Object.keys(h.data.orbitNetwork.nodes).length,10);
  assert.equal((await h.command({type:'RESUME',config:{maxNodes:100,depth:2,delay:0}})).ok,true);
  for(let i=0;i<60;i++)await h.tick();
  const s=h.data.orbitNetwork;assert.equal(s.status,'complete');assert.equal(Object.keys(s.nodes).length,34);assert.equal(Object.keys(s.edges).length,33);
  for(const id of ['a','b','c'])assert.deepEqual(route(s,person(`${id}-9`).url),[root,person(id).url,person(`${id}-9`).url]);
});
test('unchanged pagination waits for results instead of rapidly clicking Next or declaring completion',async t=>{
  const h=await harness(t),url=list('root'),snapshots={[root]:profile(person('root'),url),[url]:page(url,[person('a')],{hasNext:true})};h.snapshots=snapshots;
  await h.command({type:'START',url:root,config:{depth:1}});for(let i=0;i<7;i++)await h.tick();
  assert.equal(h.advances,1);assert.equal(h.data.orbitNetwork.pages,1);assert.equal(h.data.orbitNetwork.status,'running');
  for(let i=0;i<6;i++)await h.tick();assert.equal(h.advances,1);assert.equal(h.data.orbitNetwork.status,'running');
  snapshots[url]=page(url,[person('b')]);for(let i=0;i<3;i++)await h.tick();
  assert.equal(h.data.orbitNetwork.status,'complete');assert.equal(h.data.orbitNetwork.pages,2);assert.equal(Object.keys(h.data.orbitNetwork.nodes).length,3);
});
test('legacy saved page resumes, browser restart requeues every lane once',async t=>{
  const s=newState(root);s.status='paused';s.config.delay=30;s.current={job:{kind:'profile',owner:root,depth:0},since:0};s.queue=[];s.tabId=1;
  const h=await harness(t,s);h.tabs.set(1,{id:1,url:root,status:'complete'});h.snapshots={[root]:profile(person('root'),list('root')),[list('root')]:page(list('root'),[])};
  await h.command({type:'RESUME',config:{maxNodes:1000,depth:2,delay:0}});
  assert.equal(h.data.orbitNetwork.workers.length,1);assert.equal(h.data.orbitNetwork.current.job.owner,root);
  h.listeners.startup();await h.flush();const saved=h.data.orbitNetwork;assert.equal(saved.status,'paused');assert.equal(saved.current,null);assert.equal(saved.queue.length,1);assert.ok(saved.workers.every(w=>!w.current&&!w.tabId));
});
test('resume renews the Site lease and expands saved people despite incomplete direct coverage',async t=>{
  const s=newState(root,{depth:2,delay:0});s.status='paused';s.pauseKind='coverage';s.workspaceManaged=true;s.workspaceLeaseUntil=0;s.branches[root]={status:'incomplete',pages:1,profiles:[a],url:list('root')};s.nodes[a]={...person('a'),id:a,depth:1};s.queue=[{kind:'profile',owner:a,depth:1}];s.workers=[{tabId:null,current:null}];
  const h=await harness(t,s);h.snapshots={[root]:profile(person('root'),list('root'))};const response=await h.command({type:'RESUME',config:{maxNodes:1000,depth:2,delay:0}});
  assert.equal(response.ok,true);assert.equal(response.status,'running');assert.ok(h.data.orbitNetwork.workspaceLeaseUntil>1000000);assert.equal(h.data.orbitNetwork.current.job.owner,a);assert.equal(h.data.orbitNetwork.branches[root].status,'incomplete');assert.equal(h.data.orbitNetwork.queue.some(job=>job.owner===root),false);
});

test('a changed viewer-degree filter keeps the same owner and records adjusted coverage',async t=>{
  const h=await harness(t),requested=list('root')+'&network=%5B%22F%22%2C%22S%22%5D',actual=list('root')+'&page=1';
  h.snapshots={[root]:profile(person('root'),requested),[requested]:page(actual,[person('a')])};
  await h.command({type:'START',url:root,config:{depth:1}});for(let i=0;i<12;i++)await h.tick();
  const s=h.data.orbitNetwork;assert.equal(s.status,'complete');assert.equal(Object.keys(s.nodes).length,2);assert.equal(s.branches[root].filterChanged,true);assert.equal(Object.values(s.edges)[0].evidence[0].url,actual);
});
test('a different connection owner is never ingested and recovery has a finite retry limit',async t=>{
  const h=await harness(t),requested=list('root');h.snapshots={[root]:profile(person('root'),requested),[requested]:page(list('wrong-person'),[person('unrelated')])};
  await h.command({type:'START',url:root,config:{depth:1}});for(let i=0;i<30;i++)await h.tick(1000);
  const s=h.data.orbitNetwork;assert.equal(s.status,'complete');assert.equal(s.branches[root].status,'incomplete');assert.equal(s.nodes[person('unrelated').url],undefined);assert.equal(Object.keys(s.edges).length,0);assert.match(s.branches[root].reason,/2 retries/);
});
test('transient injection errors and a closed tab recover without a global pause',async t=>{
  const h=await harness(t),snapshots={[root]:new Error('Frame was removed')};h.snapshots=snapshots;
  await h.command({type:'START',url:root,config:{depth:1}});await h.tick();assert.equal(h.data.orbitNetwork.status,'running');assert.equal(h.data.orbitNetwork.current.job.retryAttempts,1);
  snapshots[root]=profile(person('root'),list('root'));snapshots[list('root')]=page(list('root'),[person('a')]);
  h.tabs.clear();for(let i=0;i<18;i++)await h.tick();
  assert.equal(h.data.orbitNetwork.status,'complete');assert.ok(h.data.orbitNetwork.nodes[a]);
});
test('readable pages can advance while background images are still loading',async t=>{
  const h=await harness(t);h.snapshots={[root]:profile(person('root'),list('root')),[list('root')]:page(list('root'),[person('a')])};
  await h.command({type:'START',url:root,config:{depth:1}});h.tabs.get(1).status='loading';
  for(let i=0;i<12;i++)await h.tick();assert.equal(h.data.orbitNetwork.status,'complete');assert.ok(h.data.orbitNetwork.nodes[a]);
});
test('View tab opens the actual lane requiring verification',async t=>{
  const h=await harness(t),snapshots={[root]:profile(person('root'),list('root')),[list('root')]:page(list('root'),[person('a'),person('b')]),[a]:profile(person('a'),null),[b]:{kind:'blocked',url:b,reason:'Sign in to LinkedIn'}};h.snapshots=snapshots;
  await h.command({type:'START',url:root});for(let i=0;i<30;i++)await h.tick();
  const s=h.data.orbitNetwork;assert.equal(s.status,'paused');assert.equal(h.tabs.get(s.attentionTabId).url,b);
  await h.command({type:'SHOW_TAB'});assert.equal(h.tabs.get(s.attentionTabId).active,true);
});
test('alternating repeated pages stop a branch without inflating captured-page counts',async t=>{
  const h=await harness(t),url=list('root'),one=page(url,[person('a')],{hasNext:true}),two=page(url,[person('b')],{hasNext:true}),snapshots={[root]:profile(person('root'),url),[url]:one};h.snapshots=snapshots;
  h.onAdvance=()=>{snapshots[url]=snapshots[url]===one?two:one;};
  await h.command({type:'START',url:root,config:{depth:1}});for(let i=0;i<60;i++)await h.tick();
  const s=h.data.orbitNetwork;assert.equal(s.status,'complete');assert.equal(s.pages,2);assert.equal(s.branches[root].status,'incomplete');assert.match(s.branches[root].reason,/page loop/);assert.equal(Object.keys(s.nodes).length,3);
});
test('overlapping connection lists add edges even when they add zero people',async t=>{
  const h=await harness(t),snapshots={[root]:profile(person('root'),list('root')),[list('root')]:page(list('root'),[person('a'),person('b')]),[a]:profile(person('a'),list('a')),[list('a')]:page(list('a'),[person('b')]),[b]:profile(person('b'),list('b')),[list('b')]:page(list('b'),[person('a')])};h.snapshots=snapshots;
  await h.command({type:'START',url:root});for(let i=0;i<60;i++)await h.tick();
  const s=h.data.orbitNetwork;assert.equal(s.status,'complete');assert.equal(Object.keys(s.nodes).length,3);assert.equal(Object.keys(s.edges).length,3);assert.ok(s.log.some(e=>/0 new people · 1 new links/.test(e.message)));assert.equal(s.lastBatch.added,0);assert.equal(s.lastBatch.existing,1);
});
test('missing pagination gets a scroll attempt and is marked incomplete, not exhausted',async t=>{
  const h=await harness(t),url=list('root');h.snapshots={[root]:profile(person('root'),url),[url]:page(url,[person('a')],{paginationState:'missing'})};
  await h.command({type:'START',url:root,config:{depth:1}});for(let i=0;i<30;i++)await h.tick();
  const s=h.data.orbitNetwork;assert.equal(s.status,'complete');assert.equal(s.pages,1);assert.equal(s.branches[root].status,'incomplete');assert.equal(h.advances,1);
});
test('a stalled Next retries the control without reloading or recounting the page',async t=>{
  const h=await harness(t),url=list('root');h.snapshots={[root]:profile(person('root'),url),[url]:page(url,[person('a')],{hasNext:true})};
  await h.command({type:'START',url:root,config:{depth:1}});for(let i=0;i<40;i++)await h.tick(2000);
  assert.equal(h.data.orbitNetwork.pages,1);assert.equal(h.advances,3);assert.equal(h.requests.length,5);assert.equal(h.data.orbitNetwork.status,'complete');assert.equal(h.data.orbitNetwork.branches[root].status,'incomplete');
});
test('maps keep independent checkpoints, cancellation stops work, and switching preserves pacing',async t=>{
 const h=await harness(t);await h.command({type:'START',url:root});const first=h.data.orbitNetwork.id,next=h.data.orbitNetwork.nextRequestAt;
 assert.equal((await h.command({type:'NEW_MAP'})).ok,true);assert.equal(h.data.orbitNetwork,undefined);assert.equal(h.data.orbitMaps[first].status,'paused');assert.equal(h.alarms.size,0);
 await h.command({type:'START',url:a});const second=h.data.orbitNetwork.id;assert.notEqual(first,second);assert.ok(h.data.orbitNetwork.nextRequestAt>=next);
 await h.command({type:'CANCEL'});assert.equal(h.data.orbitNetwork.status,'cancelled');assert.ok(h.data.orbitNetwork.nodes[a]);assert.equal(h.data.orbitNetwork.queue.length,0);assert.equal(h.alarms.size,0);
 const calls=h.requests.length;await h.tick();assert.equal(h.requests.length,calls);
 await h.command({type:'SWITCH_MAP',id:first});assert.equal(h.data.orbitNetwork.id,first);assert.equal(h.data.orbitNetwork.status,'paused');assert.equal(h.data.orbitMaps[second].status,'cancelled');
 assert.equal((await h.command({type:'LIST_MAPS'})).maps.length,2);
 assert.equal((await h.command({type:'SWITCH_MAP',id:'missing'})).ok,false);assert.equal(h.data.orbitNetwork.id,first);
});

test('own list counts actual paced scrolls, never idle polls, and avoids reloads at a stall',async t=>{
  const own='https://www.linkedin.com/mynetwork/invite-connect/connections/';
  const h=await harness(t);h.snapshots={[root]:profile(person('root'),own),[own]:page(own,[person('a')],{isOwn:true,expectedCount:10})};
  await h.command({type:'START',url:root,config:{depth:1}});
  for(let i=0;i<4;i++)await h.tick();
  assert.equal(h.advances,0);
  for(let i=0;i<20;i++)await h.elapse(1000);
  assert.equal(h.data.orbitNetwork.status,'running');assert.equal(h.advances,0);
  for(let attempt=1;attempt<=3;attempt++){
    await h.tick();assert.equal(h.advances,attempt);
    await h.elapse(15000);
  }
  const s=h.data.orbitNetwork;
  assert.equal(s.status,'complete');assert.equal(s.branches[root].status,'incomplete');
  assert.equal(h.requests.length,5); // Profile, list, three scrolls; zero reloads.
  assert.equal(s.pages,1);
  for(let i=2;i<h.requests.length;i++)assert.ok(h.requests[i]-h.requests[i-1]>=120000);
});

test('virtualized own lists complete from the union of unique captured profiles',async t=>{
  const own='https://www.linkedin.com/mynetwork/invite-connect/connections/';
  const snapshots={[root]:profile(person('root'),own),[own]:page(own,[person('a'),person('b')],{isOwn:true,expectedCount:4})};
  const h=await harness(t);h.snapshots=snapshots;
  h.onAdvance=()=>{snapshots[own]=page(own,[person('c'),person('d')],{isOwn:true,expectedCount:4});};
  await h.command({type:'START',url:root,config:{depth:1}});
  for(let i=0;i<16;i++)await h.tick();
  assert.equal(h.data.orbitNetwork.status,'complete');assert.equal(h.advances,1);
  assert.equal(h.data.orbitNetwork.branches[root].profiles.length,4);
  assert.equal(Object.keys(h.data.orbitNetwork.edges).length,4);
});

test('a person cap midway through an own-list snapshot resumes without losing rows or double counting pages',async t=>{
  const own='https://www.linkedin.com/mynetwork/invite-connect/connections/';
  const people=Array.from({length:14},(_,i)=>person(`p-${i}`));
  const h=await harness(t);h.snapshots={[root]:profile(person('root'),own),[own]:page(own,people,{isOwn:true,expectedCount:14}),[root+'recent-activity/all/']:{kind:'posts',url:root+'recent-activity/all/',owner:root,cards:[],empty:true}};
  await h.command({type:'START',url:root,config:{depth:1,maxNodes:10}});
  for(let i=0;i<12;i++)await h.tick();
  assert.equal(h.data.orbitNetwork.status,'limit');assert.equal(h.data.orbitNetwork.branches[root].profiles.length,9);
  assert.equal((await h.command({type:'RESUME',config:{depth:1,maxNodes:20}})).ok,true);
  for(let i=0;i<6;i++)await h.tick();
  const s=h.data.orbitNetwork;assert.equal(s.status,'complete');assert.equal(s.pages,1);
  assert.equal(s.branches[root].profiles.length,14);assert.equal(Object.keys(s.nodes).length,15);assert.equal(h.advances,0);
});

test('clearing the map cannot clear the persisted request reservation',async t=>{
  const h=await harness(t);await h.command({type:'START',url:root});
  const deadline=h.data.orbitCollectionPolicy.nextAt;
  await h.command({type:'PAUSE'});await h.command({type:'CLEAR'});await h.command({type:'START',url:a});
  assert.equal(h.requests.length,1);assert.equal(h.data.orbitCollectionPolicy.nextAt,deadline);
  await h.elapse(119999);assert.equal(h.requests.length,1);
  await h.elapse(1);assert.equal(h.requests.length,2);
});

test('HTTP 429 honors Retry-After across clear, start, heartbeat and explicit resume',async t=>{
  const h=await harness(t);await h.command({type:'START',url:root});
  h.listeners.headers({tabId:1,statusCode:429,type:'xmlhttprequest',responseHeaders:[{name:'Retry-After',value:'3600'}]});await h.flush();
  assert.equal(h.data.orbitNetwork.status,'paused');assert.equal(h.alarms.size,0);
  assert.equal(h.data.orbitCollectionPolicy.nextAt,4600000);
  assert.equal((await h.command({type:'RESUME'})).ok,false);
  await h.command({type:'WORKSPACE_ACTIVE',active:true});assert.equal(h.data.orbitNetwork.status,'paused');
  await h.command({type:'CLEAR'});
  assert.equal((await h.command({type:'START',url:a})).ok,false);assert.equal(h.requests.length,1);
  await h.elapse(3600000);assert.equal(h.requests.length,1);
  assert.equal((await h.command({type:'START',url:a})).ok,true);assert.equal(h.requests.length,2);
});

test('a saved policy survives a new service worker even without an active map',async t=>{
  const h=await harness(t,null,{orbitCollectionPolicy:{actions:[999000],nextAt:1120000,blocked:{reason:'LinkedIn restriction',at:999000}}});
  assert.equal((await h.command({type:'START',url:root})).ok,false);assert.equal(h.requests.length,0);
  await h.elapse(120000);
  assert.equal((await h.command({type:'START',url:root})).ok,true);assert.equal(h.requests.length,1);
});

test('unrelated tabs and forbidden subresources do not pause a collector; document restrictions do',async t=>{
  const h=await harness(t);await h.command({type:'START',url:root});
  h.listeners.headers({tabId:999,statusCode:429,type:'xmlhttprequest'});
  h.listeners.headers({tabId:1,statusCode:403,type:'xmlhttprequest'});await h.flush();
  assert.equal(h.data.orbitNetwork.status,'running');
  h.listeners.headers({tabId:1,statusCode:403,type:'main_frame'});await h.flush();
  assert.equal(h.data.orbitNetwork.status,'paused');assert.ok(h.data.orbitCollectionPolicy.blocked);
});

test('restrictions are detected on a slow-loading page before any retry navigation',async t=>{
  const h=await harness(t);h.snapshots={[root]:{kind:'blocked',url:root,reason:'Too many requests'}};
  await h.command({type:'START',url:root});h.tabs.get(1).status='loading';
  await h.elapse(61000);assert.equal(h.requests.length,1);assert.equal(h.data.orbitNetwork.status,'paused');
  assert.ok(h.data.orbitCollectionPolicy.blocked);
});

test('an action is never issued if its throttle reservation cannot be saved',async t=>{
  const h=await harness(t),original=chrome.storage.local.set;
  chrome.storage.local.set=async value=>{if(value.orbitCollectionPolicy?.actions.length)throw Error('Storage unavailable');return original(value);};
  await h.command({type:'START',url:root});
  assert.equal(h.requests.length,0);assert.equal(h.data.orbitNetwork.status,'paused');
  chrome.storage.local.set=original;
  await h.command({type:'RESUME'});await h.elapse(600000);
  assert.equal(h.requests.length,0); // Fail closed until the worker is reloaded.
});

test('duplicate Start keeps the current checkpoint instead of refreshing every known profile',async t=>{
  const h=await harness(t);await h.command({type:'START',url:root});
  const before=structuredClone(h.data.orbitNetwork.current);
  await h.command({type:'START',url:root});
  assert.deepEqual(h.data.orbitNetwork.current,before);assert.equal(h.requests.length,1);
});

test('a completed map stays put until its daily freshness window',async t=>{
  const s=newState(root,{depth:2,delay:0});s.status='complete';s.queue=[];s.branches[root]={status:'exhausted',pages:1,profiles:[a],url:list('root'),checkedAt:new Date(1000000).toISOString()};s.nodes[a]={...person('a'),id:a,depth:1};s.branches[a]={status:'hidden',pages:0,profiles:[],checkedAt:new Date(1000000).toISOString()};
  const h=await harness(t,s);const response=await h.command({type:'START',url:root,config:{depth:2,delay:0}});
  assert.equal(response.ok,true);assert.equal(h.data.orbitNetwork.status,'complete');assert.equal(h.requests.length,0);assert.equal(h.data.orbitNetwork.queue.length,0);assert.match(h.data.orbitNetwork.reason,/current/i);
});

test('incremental refresh rotates through a bounded stale batch without erasing coverage',async t=>{
  const s=newState(root,{depth:2,delay:0});s.status='complete';s.queue=[];s.commentCoverage={};const old=new Date(-100000000).toISOString();
  s.branches[root]={status:'exhausted',pages:4,profiles:[],url:list('root'),checkedAt:old};
  for(let i=0;i<40;i++){const p=person(`known-${i}`),id=p.url;s.nodes[id]={...p,id,depth:1};s.branches[id]={status:'hidden',pages:0,profiles:[],checkedAt:old};s.commentCoverage[id]={status:'exhausted',posts:[],profiles:[],comments:0,checkedAt:old};}
  const h=await harness(t,s);h.snapshots={[root]:profile(person('root'),list('root'))};await h.command({type:'START',url:root,config:{depth:2,delay:0}});
  const active=[...h.data.orbitNetwork.queue,...h.data.orbitNetwork.workers.map(w=>w.current?.job).filter(Boolean)];
  assert.equal(active.length,24);assert.ok(active.every(job=>job.refresh));assert.equal(h.data.orbitNetwork.refreshing,true);assert.equal(h.data.orbitNetwork.branches[root].pages,4);assert.equal(Object.keys(h.data.orbitNetwork.commentCoverage).length,40);assert.equal(Object.keys(h.data.orbitNetwork.nodes).length,41);
});

test('reopening the Site starts a due daily refresh without rebuilding the map',async t=>{
  const s=newState(root,{depth:1,delay:0});s.status='complete';s.queue=[];s.branches[root]={status:'exhausted',pages:2,profiles:[a],url:list('root'),checkedAt:'stale'};s.nodes[a]={...person('a'),id:a,depth:1};
  const h=await harness(t,s);h.snapshots={[root]:profile(person('root'),list('root'))};await h.command({type:'WORKSPACE_ACTIVE',active:true});
  assert.equal(h.data.orbitNetwork.status,'running');assert.equal(h.data.orbitNetwork.refreshing,true);assert.equal(h.data.orbitNetwork.current.job.owner,root);assert.equal(h.data.orbitNetwork.branches[root].pages,2);assert.ok(h.data.orbitNetwork.log.some(entry=>/Daily incremental refresh/.test(entry.message)));
});

test('an incomplete direct list still expands observed connections without inventing completeness',async t=>{
  const h=await harness(t),url=list('root');h.snapshots={[root]:profile(person('root'),url),[url]:page(url,[person('a')],{paginationState:'missing'}),[a]:profile(person('a'),list('a')),[list('a')]:page(list('a'),[person('b')])};
  await h.command({type:'START',url:root});for(let i=0;i<30;i++)await h.tick();
  assert.equal(h.data.orbitNetwork.status,'complete');assert.equal(h.data.orbitNetwork.branches[root].status,'incomplete');assert.deepEqual(route(h.data.orbitNetwork,b),[root,a,b]);
});

test('Explore next layer defers a repeating root page, preserves progress, and visits only unexpanded people',async t=>{
  const s=newState(root,{depth:2});s.queue=[{kind:'profile',owner:a,depth:1},{kind:'profile',owner:b,depth:1}];s.status='paused';
  for(const id of [a,b])s.nodes[id]={id,url:id,name:id,depth:1};
  s.branches[root]={status:'incomplete',pages:8,profiles:[a,b],url:list('root')};s.branches[b]={status:'exhausted',pages:2,profiles:[]};
  s.workers=[{tabId:1,current:{job:{kind:'list',owner:root,depth:0,url:list('root')},resumeURL:list('root')+'&page=8',lastSignature:'saved',since:0}}];
  const h=await harness(t,s);h.tabs.set(1,{id:1,url:list('root'),status:'complete'});h.snapshots={[a]:profile(person('a'),list('a'))};
  const response=await h.command({type:'EXPLORE_NEXT',root});assert.equal(response.ok,true);
  const after=h.data.orbitNetwork;assert.equal(after.current.job.owner,a);assert.equal(after.queue.some(job=>job.owner===b||job.owner===root),false);assert.equal(after.branches[root].pages,8);assert.equal(after.branches[root].status,'incomplete');assert.equal(after.deferredJobs[0].replayURL,list('root')+'&page=8');
  const current=structuredClone(after.current);await h.command({type:'EXPLORE_NEXT',root});assert.equal(h.data.orbitNetwork.current.job.owner,current.job.owner);assert.equal(h.requests.length,1);
});

test('unexplored people take priority over a daily refresh and survive a previously completed run',async t=>{
  const s=newState(root,{depth:2});s.status='complete';s.queue=[];s.lastRefreshBatchAt=new Date().toISOString();s.nodes[a]={id:a,url:a,name:'A',depth:1};s.branches[root]={status:'exhausted',pages:4,profiles:[a],checkedAt:'stale'};
  const h=await harness(t,s);await h.command({type:'START',url:root});assert.equal(h.data.orbitNetwork.current.job.owner,a);assert.equal(h.data.orbitNetwork.refreshing,false);assert.equal(h.data.orbitNetwork.branches[root].pages,4);
});

test('replayed known own-list rows enrich profiles and add missing links without duplicate people',async t=>{
  const own='https://www.linkedin.com/mynetwork/invite-connect/connections/',s=newState(root,{depth:1});s.status='paused';s.queue=[];s.nodes[a]={id:a,url:a,name:'A',depth:1,headline:'Old role'};
  s.pages=1;s.branches[root]={status:'collecting',pages:1,profiles:[a],seenPages:[a],url:own,expectedCount:1};s.workers=[{tabId:1,current:{job:{kind:'list',owner:root,depth:0,url:own},replaying:true,resumeURL:own,since:0}}];
  const h=await harness(t,s);h.tabs.set(1,{id:1,url:own,status:'complete'});h.snapshots={[own]:page(own,[{...person('a'),headline:'New role'}],{isOwn:true,expectedCount:1})};
  await h.command({type:'RESUME'});for(let i=0;i<5;i++)await h.tick();const saved=h.data.orbitNetwork;
  assert.equal(saved.nodes[a].headline,'New role');assert.equal(Object.keys(saved.nodes).length,2);assert.equal(Object.keys(saved.edges).length,1);assert.equal(saved.pages,1);
});

test('a late restriction response persists even after the active job is cancelled',async t=>{
  const h=await harness(t);await h.command({type:'START',url:root});
  await h.command({type:'CANCEL'});
  h.listeners.headers({tabId:1,statusCode:429,type:'xmlhttprequest',responseHeaders:[{name:'Retry-After',value:'7200'}]});await h.flush();
  assert.equal(h.data.orbitCollectionPolicy.nextAt,8200000);
  assert.equal((await h.command({type:'START',url:a})).ok,false);assert.equal(h.requests.length,1);
});

test('a profile with hidden connections still discovers commenters and expands their paths',async t=>{
  const url=root+'recent-activity/all/',h=await harness(t);
  const comments=[{commenter:person('a'),author:root,post:'https://www.linkedin.com/feed/update/urn:li:activity:123/',commentId:'urn:li:comment:(activity:123,456)',observedAt:'2026-09-06T00:00:00Z'}];
  const snapshots={[root]:{...profile(person('root'),null),activityUrl:url},[url]:{kind:'posts',url,owner:root,cards:[{urn:'urn:li:activity:123',author:root,post:comments[0].post,comments:[],control:'open'}]},[a]:profile(person('a'),list('a')),[list('a')]:page(list('a'),[person('b')])};
  h.snapshots=snapshots;h.onComments=()=>{snapshots[url].cards[0].comments=comments;snapshots[url].cards[0].control=null;};
  await h.command({type:'START',url:root});
  for(let i=0;i<65;i++)await h.elapse(10000);
  const s=h.data.orbitNetwork;
  assert.ok(s.nodes[a]);assert.deepEqual(route(s,a),[root,a]);assert.equal(s.branches[root].status,'hidden');
  assert.equal(s.commentCoverage[root].profiles.length,1);assert.equal(Object.values(s.edges)[0].evidence[0].type,'comment_interaction');
  for(let i=0;i<30;i++)await h.tick();
  assert.deepEqual(route(h.data.orbitNetwork,b),[root,a,b]);
  assert.ok(h.requests[1]-h.requests[0]<120000);
  for(let i=2;i<h.requests.length;i++)assert.ok(h.requests[i]-h.requests[i-1]>=120000);
});

test('comment collection pauses on restrictions and never consumes a startup exemption to bypass them',async t=>{
  const h=await harness(t),url=root+'recent-activity/all/';
  h.snapshots={[root]:{...profile(person('root'),null),activityUrl:url},[url]:{kind:'blocked',reason:'LinkedIn rate limit',url}};
  await h.command({type:'START',url:root});for(let i=0;i<10;i++)await h.tick();
  assert.equal(h.requests.length,2);assert.equal(h.data.orbitNetwork.status,'paused');assert.ok(h.data.orbitCollectionPolicy.blocked);
  assert.equal((await h.command({type:'RESUME'})).ok,false);assert.equal(h.requests.length,2);
});


test('missing pagination never delays recording already visible relationships',async t=>{
  const h=await harness(t),url=list('root');h.snapshots={[root]:profile(person('root'),url),[url]:page(url,[person('a')],{paginationState:'missing'})};
  await h.command({type:'START',url:root,config:{depth:1}});
  // Real wall-clock ticks, without the harness jumping to the next permitted action.
  for(let i=0;i<7;i++)await h.elapse(500);
  assert.deepEqual(route(h.data.orbitNetwork,a),[root,a]);assert.equal(h.data.orbitNetwork.pages,1);assert.equal(h.requests.length,2);assert.equal(h.advances,0);
  for(let i=0;i<12;i++)await h.tick();assert.equal(h.data.orbitNetwork.pages,1);assert.equal(h.advances,1);assert.equal(h.data.orbitNetwork.status,'complete');
});
test('resume repairs skipped posts once without replaying mutual lists or dropping queued people',async t=>{
  const s=newState(root,{depth:2});s.status='paused';s.queue=[{kind:'profile',owner:a,depth:1}];s.workers=[{tabId:null,current:null}];
  s.branches[root]={status:'incomplete',scope:'mutuals_only',pages:1,profiles:[a],url:list('root')};s.nodes[a]={...person('a'),id:a,depth:1};
  s.commentCoverage={[root]:{status:'hidden',url:null,profiles:[],comments:0,posts:[]}};
  const h=await harness(t,s),url=root+'recent-activity/all/';
  h.snapshots={[url]:{kind:'posts',url,owner:root,cards:[],empty:true},[a]:profile(person('a'),null)};
  await h.command({type:'RESUME'});assert.equal(h.data.orbitNetwork.current.job.kind,'posts');assert.equal(h.data.orbitNetwork.current.job.owner,root);assert.ok(h.data.orbitNetwork.queue.some(job=>job.owner===a));
  await h.command({type:'PAUSE'});await h.command({type:'RESUME'});
  assert.equal(h.data.orbitNetwork.queue.filter(job=>job.kind==='posts').length,0);
  for(let i=0;i<20;i++)await h.tick();
  assert.equal(h.data.orbitNetwork.status,'complete');assert.equal(h.data.orbitNetwork.commentCoverage[root].status,'exhausted');assert.equal(h.data.orbitNetwork.branches[root].pages,1);assert.equal(h.requests.length,2);
});

test('partial mutual-only results continue to verified deeper relationships',async t=>{
  const h=await harness(t),url=list('root');h.snapshots={[root]:{...profile(person('root'),url),scope:'mutuals_only'},[url]:page(url,[person('a')],{paginationState:'missing'}),[a]:profile(person('a'),list('a')),[list('a')]:page(list('a'),[person('b')]),[b]:profile(person('b'),null)};
  await h.command({type:'START',url:root});for(let i=0;i<45;i++)await h.tick();
  const s=h.data.orbitNetwork;assert.equal(s.status,'complete');assert.equal(s.branches[root].status,'incomplete');assert.equal(s.branches[root].scope,'mutuals_only');
  assert.deepEqual(route(s,b),[root,a,b]);assert.ok(!s.log.some(entry=>/Direct-layer check/.test(entry.message)));
  for(let i=2;i<h.requests.length;i++)assert.ok(h.requests[i]-h.requests[i-1]>=120000);
});
