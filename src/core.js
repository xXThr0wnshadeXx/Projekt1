export const SCHEMA = 1;
export function profileURL(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || !['linkedin.com','www.linkedin.com'].includes(u.hostname) || u.username || u.password || u.port) return null;
    const match = u.pathname.match(/^\/in\/([^/]+)\/?$/);
    if (!match || !/^[\w%.-]+$/.test(match[1])) return null;
    return `https://www.linkedin.com/in/${match[1]}/`;
  } catch { return null; }
}
export function listURL(value) {
  try {
    const u = new URL(value);
    if (u.origin !== 'https://www.linkedin.com' || u.username || u.password) return null;
    const path=u.pathname.replace(/\/?$/,'/');
    if (path === '/mynetwork/invite-connect/connections/' || (path === '/search/results/people/' && u.searchParams.has('connectionOf'))) return u.href;
  } catch { /* Invalid input. */ }
  return null;
}
function filterValues(url,key){
  const values=url.searchParams.getAll(key);if(values.length!==1)return null;
  const value=values[0];if(!value)return null;
  try{const parsed=JSON.parse(value);if(Array.isArray(parsed)&&parsed.length&&parsed.every(v=>typeof v==='string'&&v.length))return JSON.stringify([...new Set(parsed)].sort());if(typeof parsed==='string'&&parsed.length)return JSON.stringify([parsed]);}catch{ /* Some URLs use a single unwrapped ID. */ }
  return JSON.stringify([value]);
}
export function sameConnectionOwner(a,b){
  if(!listURL(a)||!listURL(b))return false;
  const x=new URL(a),y=new URL(b),path=u=>u.pathname.replace(/\/?$/,'/');
  if(path(x)!==path(y))return false;
  if(path(x)==='/mynetwork/invite-connect/connections/')return true;
  const owner=filterValues(x,'connectionOf');return owner!==null&&owner===filterValues(y,'connectionOf');
}
export function sameList(a,b){
  if(!sameConnectionOwner(a,b))return false;
  return filterValues(new URL(a),'network')===filterValues(new URL(b),'network');
}
export function options(input={}) {
  const maxNodes=Number(input.maxNodes ?? 1000),depth=Number(input.depth ?? 2),delay=Number(input.delay ?? 120);
  if (!Number.isInteger(maxNodes)||maxNodes<10||maxNodes>10000) throw Error('Choose a whole-number limit from 10 to 10,000 people.');
  if (!Number.isInteger(depth)||depth<1||depth>3) throw Error('Choose a depth from 1 to 3.');
  if (!Number.isInteger(delay)||delay<0||delay>3600) throw Error('Choose a page interval from 0 to 3,600 seconds.');
  return {maxNodes,depth,delay};
}
export function newState(url,input={}) {
  const root=profileURL(url);
  if (!root) throw Error('Enter a full LinkedIn profile URL, such as https://www.linkedin.com/in/your-name/.');
  const config=options(input),now=new Date().toISOString();
  return {schemaVersion:SCHEMA,id:crypto.randomUUID(),root,config,status:'running',reason:'Opening the starting profile',createdAt:now,updatedAt:now,nodes:{[root]:{id:root,url:root,name:decodeURIComponent(new URL(root).pathname.split('/')[2]),headline:'',depth:0}},edges:{},branches:{},queue:[{kind:'profile',owner:root,depth:0}],current:null,tabId:null,pages:0,log:[]};
}
export function log(state,message) {state.updatedAt=new Date().toISOString();state.log=[{at:state.updatedAt,message},...(state.log||[])].slice(0,100);state.reason=message;}
export function addPerson(state,person,depth) {
  const id=profileURL(person.url); if(!id)return null;
  const old=state.nodes[id];
  state.nodeCount??=Object.keys(state.nodes).length;
  if(!old && state.nodeCount>=state.config.maxNodes)return null;
  const detail=(key,max)=>String(person[key]||old?.[key]||'').slice(0,max);
  state.nodes[id]={id,url:id,name:String(person.name||old?.name||new URL(id).pathname.split('/')[2]).slice(0,200),headline:detail('headline',1000),location:detail('location',300),about:detail('about',4000),experience:detail('experience',6000),education:detail('education',4000),skills:detail('skills',3000),depth:Math.min(depth,old?.depth??depth)};
  state.graphRevision=(state.graphRevision||0)+1;
  if(!old)state.nodeCount++;
  if((!old||depth<old.depth)&&depth<state.config.depth&&!state.queue.some(j=>j.kind==='profile'&&j.owner===id&&j.depth<=depth))state.queue.push({kind:'profile',owner:id,depth});
  return id;
}
export function addEdge(state,a,b,source) {
  if(a===b||!state.nodes[a]||!state.nodes[b])return;
  const [from,to]=[a,b].sort(),id=`${from}|${to}`;
  const evidence={url:source,observedAt:new Date().toISOString(),type:'visible_connection_list'};
  if(!state.edges[id]){state.edges[id]={id,source:from,target:to,evidence:[evidence]};state.graphRevision=(state.graphRevision||0)+1;}
  else if(!state.edges[id].evidence.some(e=>e.url===source))state.edges[id].evidence.push(evidence);
}
export function ingestPage(state,job,snapshot) {
  if(!sameList(job.url,snapshot.url)) throw Error('The connection filter changed. Collection paused to prevent incorrect relationships.');
  let added=0;
  for(const person of snapshot.people||[]) {
    const before=Boolean(state.nodes[profileURL(person.url)]),id=addPerson(state,person,job.depth+1);
    if(id)addEdge(state,job.owner,id,snapshot.url);
    if(id&&!before)added++;
  }
  const branch=state.branches[job.owner] ||= {status:'collecting',pages:0,profiles:[],url:job.url};
  branch.pages++;branch.profiles=[...new Set([...branch.profiles,...snapshot.people.map(p=>profileURL(p.url)).filter(Boolean)])];
  state.pages++;
  return added;
}
export function route(state,target) {
  if(!state?.nodes[target])return [];
  const adj=new Map();for(const e of Object.values(state.edges)){for(const [a,b] of [[e.source,e.target],[e.target,e.source]]){if(!adj.has(a))adj.set(a,[]);adj.get(a).push(b);}}
  const q=[state.root],prev=new Map([[state.root,null]]);
  for(let i=0;i<q.length;i++){const a=q[i];if(a===target)break;for(const b of adj.get(a)||[]){if(!prev.has(b)){prev.set(b,a);q.push(b);}}}
  if(!prev.has(target))return [];
  const out=[];for(let n=target;n;n=prev.get(n))out.unshift(n);return out;
}
export function exportGraph(state) {
  return {schemaVersion:SCHEMA,root:state.root,createdAt:state.createdAt,exportedAt:new Date().toISOString(),config:state.config,status:state.status,nodes:Object.values(state.nodes),edges:Object.values(state.edges),branches:state.branches,pages:state.pages};
}
export function importGraph(data) {
  if(data.schemaVersion!==SCHEMA||!Array.isArray(data.nodes)||!Array.isArray(data.edges)||data.nodes.length>10000||data.edges.length>200000)throw Error('This is not a supported Orbit network JSON file.');
  const root=profileURL(data.root);if(!root)throw Error('The network is missing a valid starting profile.');
  const state=newState(root,{maxNodes:Math.max(1000,data.nodes.length),depth:2});state.queue=[];state.nodes={};
  for(const p of data.nodes){const id=profileURL(p.url||p.id);if(!id||p.id!==id)throw Error('A profile has an invalid URL.');state.nodes[id]={id,url:id,name:String(p.name||'').slice(0,200),headline:String(p.headline||'').slice(0,1000),location:String(p.location||'').slice(0,300),about:String(p.about||'').slice(0,4000),experience:String(p.experience||'').slice(0,6000),education:String(p.education||'').slice(0,4000),skills:String(p.skills||'').slice(0,3000),depth:3};}
  if(!state.nodes[root])throw Error('The starting person is missing.');
  for(const e of data.edges){if(!state.nodes[e.source]||!state.nodes[e.target]||e.source===e.target)throw Error('A connection references a missing person.');const id=[e.source,e.target].sort().join('|');const evidence=(e.evidence||[]).filter(v=>listURL(v.url)).map(v=>({url:v.url,type:'visible_connection_list',observedAt:String(v.observedAt||'').slice(0,40)}));if(!evidence.length)throw Error('Every connection needs a LinkedIn connection-list source.');state.edges[id]={id,source:e.source,target:e.target,evidence};}
  const adj={};for(const e of Object.values(state.edges)){(adj[e.source]||=[]).push(e.target);(adj[e.target]||=[]).push(e.source);}const q=[root];state.nodes[root].depth=0;const seen=new Set(q);for(let i=0;i<q.length;i++)for(const id of adj[q[i]]||[])if(!seen.has(id)){seen.add(id);state.nodes[id].depth=state.nodes[q[i]].depth+1;q.push(id);}
  state.status='imported';state.reason='Imported network • collection history is read-only';state.createdAt=String(data.createdAt||state.createdAt);state.pages=Number(data.pages)||0;return state;
}
export function csv(rows) {
  return rows.map(row=>row.map(v=>{let s=String(v??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}).join(',')).join('\r\n');
}
