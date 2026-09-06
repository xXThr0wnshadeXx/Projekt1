import test from 'node:test';
import assert from 'node:assert/strict';
import {route,newState} from '../src/core.js';
const root='https://www.linkedin.com/in/root/',a='https://www.linkedin.com/in/a/',b='https://www.linkedin.com/in/b/';
const list=id=>`https://www.linkedin.com/search/results/people/?connectionOf=${id}`;
const person=id=>({url:`https://www.linkedin.com/in/${id}/`,name:id.toUpperCase()});
const profile=(p,url)=>({kind:'profile',url:p.url,person:p,listUrl:url,scope:'connections'});
const page=(url,people,extra={})=>({kind:'list',url,people,signature:people.map(p=>p.url).join('|'),hasNext:false,...extra});
let serial=0;
async function harness(t,initial){
  const data=initial?{orbitNetwork:structuredClone(initial)}:{},listeners={},alarms=new Map(),tabs=new Map();let now=1000000,nextTab=0,advances=0,snapshots={},onAdvance;const requests=[];
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));t.mock.method(globalThis,'clearTimeout',()=>{});
  const event=name=>({addListener(fn){listeners[name]=fn;}});
  globalThis.chrome={runtime:{id:'test-extension',getURL:p=>`chrome-extension://test-extension/${p}`,onMessage:event('message'),onMessageExternal:event('external'),onStartup:event('startup'),onInstalled:event('installed')},storage:{local:{async get(k){return structuredClone({[k]:data[k]});},async set(v){Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}}},alarms:{async create(k,v){alarms.set(k,v);},async clear(k){alarms.delete(k);},async get(k){return alarms.get(k);},onAlarm:event('alarm')},tabs:{onUpdated:event('updated'),async create(v){requests.push(now);const tab={id:++nextTab,status:'complete',lastAccessed:now,windowId:1,...v};tabs.set(tab.id,tab);return tab;},async get(id){if(!tabs.has(id))throw Error('No tab');return tabs.get(id);},async update(id,v){if(v.url)requests.push(now);Object.assign(tabs.get(id),v);return tabs.get(id);}},windows:{async update(id,v){return {id,...v};}},scripting:{async executeScript({target,func}){if(func.name==='advanceLinkedIn'){requests.push(now);advances++;onAdvance?.(tabs.get(target.tabId));return [{result:'next'}];}const value=snapshots[tabs.get(target.tabId).url];if(value instanceof Error)throw value;return [{result:structuredClone(value)}];}},action:{onClicked:event('action')}};
  await import(`../src/background.js?test=${serial++}`);
  const command=msg=>new Promise(resolve=>listeners.message(msg,{id:'test-extension',url:'chrome-extension://test-extension/index.html'},resolve));
  const flush=async()=>{for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));};
  const tick=async(ms=500)=>{now+=ms;const s=data.orbitNetwork,c=s?.current;if(c&&!c.lastSignature&&!c.paginationRevealedAt&&c.job.kind==='list'&&snapshots[tabs.get(s.tabId)?.url]?.paginationState==='missing')now=Math.max(now,s.nextRequestAt||0);if(c?.navPending||c?.advancePending||(c?.paginationWaiting))now=Math.max(now,s.nextRequestAt||0,c.nextActionAt||0);listeners.alarm({name:'orbit-collect'});await flush();};
  return {data,listeners,alarms,tabs,requests,command,tick,flush,set snapshots(v){snapshots=v;},set onAdvance(v){onAdvance=v;},get advances(){return advances;}};
}
test('two layers obey two-minute request spacing; restrictions pause collection',async t=>{
  const h=await harness(t);h.snapshots={[root]:profile(person('root'),list('root')),[list('root')]:page(list('root'),[person('a')]),[a]:profile(person('a'),list('a')),[list('a')]:page(list('a'),[person('b')])};
  assert.equal((await h.command({type:'START',url:root})).ok,true);
  for(let i=0;i<30;i++)await h.tick();
  const s=h.data.orbitNetwork;assert.equal(s.status,'complete');assert.deepEqual(route(s,b),[root,a,b]);assert.equal(s.pages,2);assert.equal(h.advances,0);for(let i=1;i<h.requests.length;i++)assert.ok(h.requests[i]-h.requests[i-1]>=120000);assert.equal(h.alarms.size,0);
  h.snapshots={[root]:{kind:'blocked',url:root,reason:'LinkedIn verification required'}};
  await h.command({type:'START',url:root});await h.tick();await h.tick();assert.equal(h.data.orbitNetwork.status,'paused');assert.equal(h.alarms.size,0);
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
  for(let i=0;i<6;i++)await h.tick();
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
test('replaying a captured page after a stalled Next does not recount it',async t=>{
  const h=await harness(t),url=list('root');h.snapshots={[root]:profile(person('root'),url),[url]:page(url,[person('a')],{hasNext:true})};
  await h.command({type:'START',url:root,config:{depth:1}});for(let i=0;i<40;i++)await h.tick(2000);
  assert.equal(h.data.orbitNetwork.pages,1);assert.equal(h.advances,3);assert.equal(h.data.orbitNetwork.status,'complete');assert.equal(h.data.orbitNetwork.branches[root].status,'incomplete');
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
