import {locationOf,fieldsOf,matchesFilters,keywordTerms} from './filters.js';
import {profileURL,options,route,routes} from './core.js';
import {createLibrary,mergeAccountGraphs} from './library.js';
import {NetworkGraph} from './graph.js';
import {COMPANION_ID,COMPANION_VERSION} from './companion.js';
import {rankPeople} from './search.js';
const $=id=>document.getElementById(id),EXTENSION=Boolean(globalThis.chrome?.runtime?.id&&globalThis.chrome?.storage?.local),KEY='orbitNetwork';
let state=null,selected=null,view='graph',toastTimer=null,bridgeConnected=false,refreshing=false,remoteRevision=null,companionVersion=null,inspectorSerial=0,mapArrangement='none';
let runSample=null,lastReveal=null,collectionState=null,sharedState=null,libraryMode=false,sharedRefreshing=false;
const accountGraph=()=>mergeAccountGraphs(collectionState,sharedState,6);
const library=createLibrary({getCollection:()=>collectionState,showGraph:(s,accountView=false)=>{libraryMode=!accountView;if(accountView)sharedState=s;state=accountView?accountGraph():s;selected=null;render();},showCollection:()=>{libraryMode=false;state=accountGraph();selected=null;render();}});
const hasCollector=()=>EXTENSION||bridgeConnected;
const graph=new NetworkGraph($('network-canvas'),id=>selectPerson(id));
graph.onReveal=(person,visible,total)=>{lastReveal={person,visible,total,at:Date.now()};renderLive();};
const set=(id,text)=>$(id).textContent=text;
const show=(id,visible)=>$(id).hidden=!visible;
const statuses={running:'Collecting',paused:'Paused',limit:'Person limit reached',cancelled:'Build cancelled',complete:'Queue finished',imported:'Saved map'};
const branchNames={queued:'Queued',collecting:'Collecting',hidden:'List not visible',incomplete:'Incomplete',exhausted:'End of visible results',mutuals_only:'Mutual connections only'};
function toast(message){set('toast',message);show('toast',true);clearTimeout(toastTimer);toastTimer=setTimeout(()=>show('toast',false),8000);}
function config(){return options({maxNodes:$('max-nodes').value,depth:$('depth').value,delay:$('delay').value,comments:$('collect-comments').checked});}
async function send(message){const response=EXTENSION?await chrome.runtime.sendMessage(message):await chrome.runtime.sendMessage(COMPANION_ID,message);if(!response?.ok)throw Error(response?.error||'The companion did not respond. Reload it in chrome://extensions, then reconnect here.');return response;}
function el(tag,text,className){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;}
function link(text,url,className){const a=el('a',text,className);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;}
function freshness(value){const at=Date.parse(value||'');if(!Number.isFinite(at))return 'not checked yet';const age=Math.max(0,Date.now()-at),minutes=Math.floor(age/60000);if(minutes<2)return 'checked now';if(minutes<60)return `checked ${minutes}m ago`;const hours=Math.floor(minutes/60);if(hours<24)return `checked ${hours}h ago`;return `checked ${Math.floor(hours/24)}d ago`;}
function filteredPeople(){const q=$('search').value.trim(),people=Object.values(state?.nodes||{}).filter(p=>matchesFilters(p,activeFilters()));return q?rankPeople(people,q,people.length).sort((a,b)=>b.score-a.score||a.depth-b.depth||a.name.localeCompare(b.name)):people.sort((a,b)=>a.depth-b.depth||a.name.localeCompare(b.name));}
function degreeMap(){const out={};for(const e of Object.values(state?.edges||{})){out[e.source]=(out[e.source]||0)+1;out[e.target]=(out[e.target]||0)+1;}return out;}
function renderPeople(){const people=filteredPeople(),degrees=degreeMap(),body=$('people-body');body.replaceChildren();set('directory-summary',`${people.length.toLocaleString()} suggested ${people.length===1?'person':'people'}${$('search').value?' ranked by relevance':''}`);if(!people.length){const tr=el('tr'),td=el('td',state?'No close matches yet. Try a school abbreviation, employer, role, location, or partial spelling.':'Start collecting or open the shared graph to see people.','table-note');td.colSpan=4;tr.append(td);body.append(tr);return;}
  // Render a bounded slice so a 10,000-person map stays responsive. Search spans all nodes.
  for(const p of people.slice(0,500)){const tr=el('tr'),td=el('td'),button=el('button',p.name,'person-button');button.onclick=()=>selectPerson(p.id);td.append(button);if(p.reason)td.append(el('small',p.reason,'match-reason'));tr.append(td,el('td',p.headline||p.education||'—'),el('td',p.depth===0?'Starting person':`${p.depth} step${p.depth===1?'':'s'}`),el('td',degrees[p.id]||0));body.append(tr);}if(people.length>500){const tr=el('tr'),td=el('td','Showing the 500 strongest suggestions. Refine the search to narrow them.','table-note');td.colSpan=4;tr.append(td);body.append(tr);}}
function renderCoverage(){const body=$('coverage-body');body.replaceChildren();const branches=Object.entries(state?.branches||{});for(const [id,b] of branches){const tr=el('tr'),td=el('td'),button=el('button',state.nodes[id]?.name||id,'person-button');button.onclick=()=>selectPerson(id);td.append(button);const status=el('td',branchNames[b.status]||b.status);if(b.scope==='mutuals_only'&&b.status!=='mutuals_only')status.append(el('small',' · mutuals only'));if(b.filterChanged)status.append(el('small',' · filters adjusted'));status.append(el('small',` · ${freshness(b.checkedAt)}`,'coverage-freshness'));status.title=(b.reason||'')+(b.filterChanged?' LinkedIn changed the viewer-degree filter; this branch covers the visible subset.':'');tr.append(td,status,el('td',(b.profiles||[]).length),el('td',b.pages||0));body.append(tr);}if(!branches.length){const tr=el('tr'),td=el('td',state?.status==='imported'?'This saved map has no resumable collection history.':'Coverage appears as the collector opens connection lists.','table-note');td.colSpan=4;tr.append(td);body.append(tr);}for(const [id,c] of Object.entries(state?.commentCoverage||{})){const tr=el('tr');tr.append(el('td',state.nodes[id]?.name||id),el('td',`Post comments · ${branchNames[c.status]||c.status} · ${freshness(c.checkedAt)}`),el('td',c.profiles?.length||0),el('td',`${c.posts?.length||0} posts`));tr.title=c.reason||'Visible commenter-to-author relationships';body.append(tr);}const activity=$('activity-log');activity.replaceChildren();for(const entry of state?.log||[]){const row=el('div',undefined,'log-line');row.append(el('time',new Date(entry.at).toLocaleTimeString()),el('span',entry.message));activity.append(row);}}
function selectPerson(id){selected=id;renderInspector();if(!id)return;if(!$('inspector').open)$('inspector').showModal();}
function disclosure(label,value){if(!value)return null;const details=el('details',undefined,'profile-disclosure');details.append(el('summary',label),el('p',value));return details;}
function compactRoute(ids){const line=el('div',undefined,'shared-route');for(const [index,id] of ids.entries()){if(index)line.append(el('span','→','route-arrow'));const button=el('button',state.nodes[id]?.name||id,'path-person');button.onclick=()=>selectPerson(id);line.append(button);}return line;}
function routeEvidence(ids){const evidence=[];for(let i=1;i<ids.length;i++){const edge=state.edges[[ids[i-1],ids[i]].sort().join('|')];evidence.push(...(edge?.evidence||[]));}const listed=evidence.filter(item=>(item.type||'visible_connection_list')==='visible_connection_list').length,comments=evidence.filter(item=>item.type==='comment_interaction').length,newest=evidence.map(item=>Date.parse(item.observedAt||'')).filter(Number.isFinite).sort((a,b)=>b-a)[0];return {listed,comments,newest};}
async function loadSharedPath(person,slot,serial){
  if(location.protocol!=='https:'||person.id===state?.root){slot.textContent=person.id===state?.root?'This is your starting account profile.':'Shared routes are available on the hosted Site.';return;}
  try{const response=await fetch('/api/library/path?to='+encodeURIComponent(person.id)+'&depth=6'),data=await response.json();if(serial!==inspectorSerial)return;slot.replaceChildren();if(!response.ok)throw Error(data.error||'The shared route could not be loaded.');if(!data.found){slot.append(el('p',data.reason||'No observed route yet. Keep collecting overlapping networks.'));return;}
    slot.append(el('strong',`${data.hops} observed ${data.hops===1?'introduction':'introductions'} away`));const routeLine=el('div',undefined,'shared-route');for(const [index,node] of data.nodes.entries()){if(index)routeLine.append(el('span','→','route-arrow'));const button=el('button',node.name||node.id,'path-person');button.onclick=()=>selectPerson(node.id);routeLine.append(button);}slot.append(routeLine);const contributors=[...new Set(data.edges.flatMap(edge=>edge.contributors||[]))];if(contributors.length)slot.append(el('small',`Route supported by ${contributors.join(', ')}`,'path-contributors'));
  }catch(error){if(serial===inspectorSerial)slot.textContent=error.message;}
}
function renderInspector(){const p=state?.nodes[selected];if(!p){graph.focus(null);return;}const serial=++inspectorSerial,target=$('inspector-content');target.replaceChildren();target.append(el('div',p.name.split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase(),'person-avatar'),el('h3',p.name));if(p.headline)target.append(el('p',p.headline));if(p.location)target.append(el('p',p.location));const actions=el('div',undefined,'inspector-actions'),tree=el('button','View connection tree','primary'),share=el('button','Share person & route','quiet');actions.append(link('View LinkedIn ↗',p.url,'profile-link'),tree,share);tree.onclick=()=>openPersonTree(p);share.onclick=async()=>{const path=route(state,p.id).map(id=>state.nodes[id]?.name).filter(Boolean).join(' → '),text=[p.name,p.headline,p.location,path&&`Observed route: ${path}`,p.url].filter(Boolean).join('\n');try{if(navigator.share)await navigator.share({title:`${p.name} · Orbit`,text});else{await navigator.clipboard.writeText(text);toast('Person and observed route copied.');}}catch(error){if(error.name!=='AbortError')toast('Sharing was not available in this browser.');}};target.append(actions);
  const facts=el('div',undefined,'profile-facts');for(const [label,value] of [['About',p.about],['Experience',p.experience],['Education',p.education],['Skills',p.skills]]){const item=disclosure(label,value);if(item)facts.append(item);}if(facts.childElementCount)target.append(facts);
  const observedRoutes=routes(state,p.id),localPath=observedRoutes[0]||route(state,p.id);graph.focus(p.id,localPath);const section=el('div',undefined,'detail-section');section.append(el('h4','BEST ROUTE IN THIS VIEW'));if(localPath.length){for(const id of localPath)section.append(el('div',state.nodes[id].name,'path-person'));const proof=routeEvidence(localPath),parts=[`${localPath.length-1} ${localPath.length===2?'hop':'hops'}`,proof.listed&&`${proof.listed} connection-list ${proof.listed===1?'source':'sources'}`,proof.comments&&`${proof.comments} interaction ${proof.comments===1?'source':'sources'}`,proof.newest&&freshness(new Date(proof.newest).toISOString())].filter(Boolean);section.append(el('small',parts.join(' · '),'route-proof'));}else section.append(el('p','No route appears in the currently loaded view.'));if(observedRoutes.length>1){const alternatives=el('details',undefined,'alternate-routes profile-disclosure');alternatives.append(el('summary',`${observedRoutes.length-1} other observed ${observedRoutes.length===2?'route':'routes'}`));const body=el('div',undefined,'alternate-route-list');for(const candidate of observedRoutes.slice(1)){const row=el('div',undefined,'alternate-route');row.append(compactRoute(candidate));const proof=routeEvidence(candidate);row.append(el('small',`${candidate.length-1} hops · ${proof.listed?'connection-list evidence':'interaction evidence'}`,'route-proof'));body.append(row);}alternatives.append(body);section.append(alternatives);}target.append(section);
  const shared=el('div',undefined,'detail-section shared-path'),slot=el('div','Finding the strongest observed route across the team graph…','path-loading');shared.append(el('h4','ACROSS EVERY TEAMMATE’S NETWORK'),slot);target.append(shared);loadSharedPath(p,slot,serial);
  const edges=Object.values(state.edges).filter(e=>e.source===p.id||e.target===p.id);if(edges.length){const neighbors=el('details',undefined,'detail-section profile-disclosure'),body=el('div',undefined,'neighbor-list');neighbors.append(el('summary',`${edges.length} connections in this view`),body);for(const edge of edges.slice(0,30)){const other=edge.source===p.id?edge.target:edge.source,b=el('button',state.nodes[other].name,'neighbor');b.onclick=()=>selectPerson(other);body.append(b);}const sources=el('details',undefined,'detail-section profile-disclosure');sources.append(el('summary','Relationship sources'));
    for(const edge of edges.slice(0,30)){const other=edge.source===p.id?edge.target:edge.source;for(const evidence of (edge.evidence||[]).slice(0,3)){const comment=evidence.type==='comment_interaction';const label=comment?`${state.nodes[evidence.commenter]?.name||'Commenter'} commented on ${state.nodes[evidence.author]?.name||'author'}’s post`:`LinkedIn connection with ${state.nodes[other]?.name||'person'}`;sources.append(link(label+' ↗',evidence.url,'profile-link'));}}
    target.append(sources);
    if(edges.length>30)body.append(el('p',`${edges.length-30} more appear in the graph.`));target.append(neighbors);}}
function renderLive(){
  const active=state?.status==='running';show('live-progress',active);
  if(!active){runSample=null;return;}
  const count=Object.keys(state.nodes).length;
  if(!runSample||runSample.id!==state.id)runSample={id:state.id,at:Date.now(),count};
  const lanes=(state.workers||[{current:state.current}]).filter(w=>w.current),names=lanes.map(w=>state.nodes[w.current.job.owner]?.name||'profile');
  const rootBranch=state.branches?.[state.root],directReady=['exhausted'].includes(rootBranch?.status),phase=lanes.some(w=>w.current.job.kind==='posts')?'Collecting visible commenter-to-author links':directReady?'Exploring further relationship paths':'Collecting visible connections and post comments';
  const waiting=lanes.some(w=>w.current.navPending||w.current.advancePending||w.current.retryAt),waitSeconds=Math.max(0,Math.ceil((Math.max(state.nextRequestAt||0,...lanes.map(w=>Math.max(w.current.nextActionAt||0,w.current.retryAt||0)))-Date.now())/1000));
  const retrying=lanes.find(w=>w.current.retryAt),recent=lastReveal&&Date.now()-lastReveal.at<2500;
  set('live-title',waiting&&waitSeconds?`${state.pacing?.reason||'Pacing collection'} · next action in ${waitSeconds}s`:retrying?`Retrying ${state.nodes[retrying.current.job.owner]?.name||'a page'} · waiting before retry`:recent?`Added ${lastReveal.person.name}`:names.length?`Exploring ${names[0]}’s connections${names.length>1?` + ${names.length-1} more`:''}`:'Preparing the next connection list');
  const batch=state.lastBatch;
  const summary=batch?`Last page: ${batch.added} new people · ${batch.links??0} new links · ${batch.existing??0} already mapped`:`${count.toLocaleString()} people recorded`;
  set('live-detail',`${phase} · ${summary} · ${state.queue.length} profiles/lists queued`);
  const seconds=(Date.now()-runSample.at)/1000,added=count-runSample.count;
  set('live-rate',seconds>=5?`${Math.round(added/seconds*60)} people/min`:'Measuring speed…');
}
function render(){
  renderLive();show('cancel-build',['running','paused','limit'].includes(state?.status));
  const directPeople=Object.values(state?.nodes||{}).filter(p=>p.depth===1),unexplored=directPeople.filter(p=>!state.branches?.[p.id]).length;
  show('expansion-controls',!libraryMode&&directPeople.length>0);
  set('expansion-summary',`${directPeople.length} direct connections saved · ${unexplored} connections’ lists not explored yet`);
  $('explore-next').disabled=!hasCollector()||state?.cloudView;
  const nodes=Object.values(state?.nodes||{}),edges=Object.values(state?.edges||{}),branches=Object.values(state?.branches||{}),complete=state?.status==='complete',paused=['paused','limit'].includes(state?.status);set('people-count',state?nodes.length.toLocaleString():'—');set('edge-count',state?edges.length.toLocaleString():'—');set('branch-count',state?branches.filter(b=>b.pages>0).length.toLocaleString():'—');set('page-count',state?(state.pages||0).toLocaleString():'—');set('network-title',state?`${state.nodes[state.root]?.name||'Starting profile'}’s account network`:'Your account network');set('run-badge',statuses[state?.status]||'Not started');$('run-badge').className=`badge ${state?.status||''}`;set('status-label',statuses[state?.status]||'Ready to explore');$('status-dot').className=state?.status||'';set('status-reason',state?.reason||'Discoveries periodically save to your account and merge safely into the team graph.');set('pause-reason',paused?(state.reason||'Collection paused. Open the collection tab, then resume.'):'');show('pause-reason',paused);set('workspace-build',complete?'Check for new connections ↗':'Continue collecting ↗');set('start',complete?'Check for new connections ↗':'Continue collecting ↗');show('empty-graph',!state);show('collector-controls',hasCollector()&&Boolean(state)&&state.status!=='imported');show('pause',state?.status==='running');show('resume',paused);show('show-tab',Boolean(state?.tabId));show('clear-button',!libraryMode&&Boolean(state)&&state.status!=='running');$('workspace-build').disabled=libraryMode||Boolean(state)&&['running','paused','limit'].includes(state.status);$('start').disabled=libraryMode||Boolean(state)&&['running','paused','limit'].includes(state.status);$('profile-url').disabled=Boolean(state)&&['running','paused','limit'].includes(state.status);set('updated-label',state?`${state.sharedView?'Account map synced with shared D1':state.cloudView?'Account network loaded from D1':'Account checkpoint autosaved'} · ${new Date(state.updatedAt).toLocaleString()}`:'Shared team library');set('visible-label',state?`${nodes.filter(p=>p.depth===1).length.toLocaleString()} direct · ${nodes.filter(p=>p.depth>1).length.toLocaleString()} connected through teammates`:'One persistent account network');graph.setData(state);refreshFilterOptions();graph.search($('search').value);if(view==='directory')renderPeople();if(view==='coverage')renderCoverage();
}
function switchView(name){view=name;for(const key of ['graph','directory','coverage']){show(`view-${key}`,key===name);$(`tab-${key}`).setAttribute('aria-selected',String(key===name));}if(name==='directory')renderPeople();if(name==='coverage')renderCoverage();if(name==='graph')graph.resize();}
async function refresh(){
  if(refreshing)return;refreshing=true;
  try{
    let next;
    if(EXTENSION)next=(await chrome.storage.local.get(KEY))[KEY]||null;
    else if(bridgeConnected){const response=await send({type:'GET_STATE',revision:remoteRevision});remoteRevision=response.revision;if(response.unchanged)return;next=response.state;}
    else next=JSON.parse(localStorage.getItem(KEY)||'null');
    if(state&&next&&state.id===next.id&&state.updatedAt===next.updatedAt&&state.revision===next.revision)return;
    if(state?.id!==next?.id)lastReveal=null;
  collectionState=next;library.queue(next);if(libraryMode)return;state=accountGraph();if(selected&&!state?.nodes[selected])selected=null;render();
  }finally{refreshing=false;}
}
$('setup-form').onsubmit=async e=>{e.preventDefault();try{if(!profileURL($('profile-url').value))throw Error('Paste a LinkedIn person profile URL beginning with https://www.linkedin.com/in/.');const settings=config();if(!hasCollector())throw Error('Connect the Orbit companion once, then build from this same Site.');await send({type:'START',url:$('profile-url').value,config:settings});await refresh();openWorkspaceSettings(false);}catch(error){toast(error.message);}};
$('pause').onclick=async()=>{try{await send({type:'PAUSE'});await refresh();}catch(e){toast(e.message);}};
$('resume').onclick=async()=>{const button=$('resume'),original=button.textContent;try{const count=Object.keys(state?.nodes||{}).length,current=Number($('max-nodes').value);if(count>=current&&current<10000)$('max-nodes').value=Math.min(10000,Math.max(count+500,Math.ceil((count+1)/1000)*1000));button.disabled=true;button.setAttribute('aria-busy','true');button.textContent='Resuming…';const response=await send({type:'RESUME',config:config()});remoteRevision=null;await refresh();toast(response.status==='running'?'Collection resumed from the saved checkpoint.':response.reason||'Collection is waiting for attention.');}catch(e){toast(e.message);}finally{button.disabled=false;button.removeAttribute('aria-busy');button.textContent=original;}};
$('show-tab').onclick=async()=>{try{await send({type:'SHOW_TAB'});}catch(e){toast(e.message);}};
$('clear-button').onclick=async()=>{if(!confirm('Reset your account network? Orbit removes this account’s contribution, but keeps people and links that teammates also contributed. This cannot be undone.'))return;try{if(hasCollector())await send({type:'CLEAR'});else localStorage.removeItem(KEY);const response=await fetch('/api/account/network/reset',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}'}),data=await response.json();if(!response.ok)throw Error(data.error||'The account network could not be reset.');library.resetCaches();collectionState=null;state=null;selected=null;render();toast(`Account network reset · ${data.connectionContributions||0} contributed links reviewed.`);}catch(e){toast(e.message);}};
for(const name of ['graph','directory','coverage'])$(`tab-${name}`).onclick=()=>switchView(name);
$('search').oninput=()=>{closeTreeView();graph.search($('search').value);if(selected){const point=graph.positions.get(selected);if(point&&!graph.isSearchHit(point)){selected=null;graph.focus(null);$('inspector').close();}}if(view==='directory')renderPeople();};$('fit').onclick=()=>graph.fit();$('zoom-in').onclick=()=>graph.stepZoom(1);$('zoom-out').onclick=()=>graph.stepZoom(-1);
if(EXTENSION){set('connection-mode','CHROME COLLECTOR CONNECTED');send({type:'WORKSPACE_ACTIVE',active:true}).catch(()=>{});chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes[KEY])refresh().catch(e=>toast(e.message));});}else{set('connection-mode','COMPANION NOT CONNECTED');show('install-note',true);}
async function refreshShared(){const root=collectionState?.root||globalThis.ORBIT_PROFILE;if(sharedRefreshing||libraryMode||!root||document.visibilityState!=='visible')return;sharedRefreshing=true;try{await library.loadAccount(root,6);}finally{sharedRefreshing=false;}}
await refresh();if(state){$('profile-url').value=state.root;$('max-nodes').value=state.config.maxNodes;$('depth').value=state.config.depth;$('delay').value=Math.max(120,state.config.delay||120);$('collect-comments').checked=Boolean(state.config.comments);await refreshShared();}else if(globalThis.ORBIT_PROFILE){$('profile-url').value=globalThis.ORBIT_PROFILE;await library.loadAccount(globalThis.ORBIT_PROFILE,6);}

async function connectCompanion(quiet=false){try{set('connection-mode','CONNECTING COMPANION…');if(!globalThis.chrome?.runtime?.sendMessage)throw Error('Install the companion in Chrome, then reload this Site.');const ping=await send({type:'PING'});companionVersion=ping.version;remoteRevision=null;bridgeConnected=true;await send({type:'WORKSPACE_ACTIVE',active:true});const outdated=companionVersion!==COMPANION_VERSION;show('update-note',outdated);if(outdated)set('update-version',`Update required: companion ${companionVersion||'unknown'} → ${COMPANION_VERSION}.`);set('connection-mode',outdated?`COMPANION ${companionVersion||'UNKNOWN'} · UPDATE REQUIRED`:'COMPANION READY · AUTOSAVE ON');show('install-note',false);await refresh();if(state){$('profile-url').value=state.root;$('max-nodes').value=state.config.maxNodes;$('depth').value=state.config.depth;$('delay').value=Math.max(120,state.config.delay||120);$('collect-comments').checked=Boolean(state.config.comments);}if(!quiet)toast(outdated?`Companion ${companionVersion||'unknown'} is outdated. Install ${COMPANION_VERSION} to receive collection fixes.`:'Companion connected. This account network saves to shared D1 automatically.');}catch(e){set('connection-mode','COMPANION NOT CONNECTED');show('install-note',true);if(!quiet)toast(e.message);}}
$('connect-companion').onclick=()=>connectCompanion();
if(!EXTENSION)connectCompanion(true);
setInterval(()=>{if((EXTENSION||bridgeConnected)&&document.visibilityState==='visible')refresh().catch(()=>{bridgeConnected=false;set('connection-mode','COMPANION DISCONNECTED');show('install-note',true);render();});},500);
setInterval(()=>{if(EXTENSION||bridgeConnected)send({type:'WORKSPACE_ACTIVE',active:true}).catch(()=>{});},30000);
addEventListener('pagehide',()=>{if(EXTENSION||bridgeConnected)send({type:'WORKSPACE_ACTIVE',active:false}).catch(()=>{});});
setInterval(()=>{if(document.visibilityState==='visible')renderLive();},1000);
setInterval(()=>refreshShared().catch(()=>{}),30000);

if($('scroll-zoom'))$('scroll-zoom').onchange=e=>{graph.scrollZoom=e.target.checked;if(!e.target.checked)graph.zoomTarget=null;};
graph.onZoom=(scale,ratio=graph.zoomRatio())=>{if($('zoom-level'))set('zoom-level',`${Math.round(ratio*100)}%`);};
graph.onZoom(graph.scale,graph.zoomRatio());

function activeKeywords(){return keywordTerms($('filter-keywords').value);}
function activeFilters(){return {location:$('filter-location').value.trim(),field:$('filter-field').value.trim(),keywords:activeKeywords(),first:$('degree-first').checked,second:$('degree-second').checked,extended:$('degree-extended').checked,maxDepth:Number($('max-distance').value)};}
function syncArrangementButtons(){for(const [id,value] of [['arrange-network','none'],['arrange-location','location']])$(id).setAttribute('aria-pressed',String(value===mapArrangement&&!graph.treeRoot));}
function closeTreeView(){if(!graph.treeRoot)return;graph.clearTree();show('tree-focus',false);if(selected)graph.focus(selected,route(state,selected));syncArrangementButtons();}
function openPersonTree(person){$('search').value='';graph.search('');mapArrangement='none';syncArrangementButtons();const summary=graph.showTree(person.id);if(!summary){toast('No observed connection tree is available for this person yet.');return;}set('tree-focus-name',person.name);set('tree-focus-count',`${summary.direct.toLocaleString()} nearby · ${summary.extended.toLocaleString()} one more step away`);show('tree-focus',true);graph.focus(person.id,[]);switchView('graph');$('inspector').close();toast(`Centered the map on ${person.name}. Select any visible person to keep exploring.`);}
function refreshFilterOptions(){
  const people=Object.values(state?.nodes||{});
  const locations=new Map(),sectors=new Map();for(const p of people){const location=locationOf(p);locations.set(location,(locations.get(location)||0)+1);for(const field of fieldsOf(p))sectors.set(field,(sectors.get(field)||0)+1);}
  const fillSuggestions=(id,counts,limit)=>{const list=$(id),signature=JSON.stringify([...counts]);if(list.dataset.signature===signature)return;list.dataset.signature=signature;list.replaceChildren();for(const [value,count] of [...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,limit))list.append(Object.assign(el('option'),{value,label:`${value} · ${count}`}));};
  fillSuggestions('location-options',locations,16);fillSuggestions('field-options',sectors,16);
  const filters=activeFilters(),matched=people.filter(p=>matchesFilters(p,filters)).length,active=[filters.location&&`location “${filters.location}”`,filters.field&&`sector “${filters.field}”`,filters.keywords.length&&`profile “${filters.keywords.join(', ')}”`].filter(Boolean);
  const visibleLocations=new Set(people.filter(p=>matchesFilters(p,filters)).map(locationOf)).size,arranged=mapArrangement==='location'?` · grouped across ${visibleLocations.toLocaleString()} recorded ${visibleLocations===1?'location':'locations'}`:'';
  set('filter-count',`${matched.toLocaleString()} of ${people.length.toLocaleString()} people visible${active.length?` · ${active.join(' · ')}`:' · no filters applied'}${arranged}`);
}
function applyFilters(){closeTreeView();const filters=activeFilters();graph.setFilters(filters,mapArrangement,activeKeywords());refreshFilterOptions();if(selected&&state?.nodes[selected]&&!matchesFilters(state.nodes[selected],filters)){selected=null;graph.focus(null);$('inspector-content').replaceChildren(el('h3','Select a visible person'),el('p','Your filters changed which people are shown.'));}if(view==='directory')renderPeople();}
function arrangeMap(by){closeTreeView();selected=null;graph.focus(null);$('inspector').close();mapArrangement=by;syncArrangementButtons();applyFilters();toast(by==='location'?'People are grouped by their best available location, including recognized school and metro clues.':'People returned to their observed connection paths.');}
$('filter-toggle').onclick=()=>{const open=$('map-filters').hidden;show('map-filters',open);$('filter-toggle').setAttribute('aria-expanded',String(open));};
$('arrange-network').onclick=()=>arrangeMap('none');
$('arrange-location').onclick=()=>arrangeMap('location');
$('exit-tree').onclick=()=>closeTreeView();
for(const id of ['filter-location','filter-field','filter-keywords'])$(id).oninput=applyFilters;
for(const id of ['degree-first','degree-second','degree-extended','max-distance'])$(id).onchange=applyFilters;
$('reset-filters').onclick=()=>{for(const id of ['filter-location','filter-field','filter-keywords'])$(id).value='';for(const id of ['degree-first','degree-second','degree-extended'])$(id).checked=true;$('max-distance').value='6';applyFilters();};

$('cancel-build').onclick=async()=>{try{await send({type:'CANCEL'});await refresh();toast('This collection run stopped. Every discovered person already saved remains in your account network.');}catch(e){toast(e.message);}};
$('filter-lines').onchange=e=>{graph.showAllConnections=e.target.checked;graph.draw();};

function openWorkspaceSettings(settings){
 $('map-settings').hidden=!settings;document.querySelector('.main-panel').hidden=settings;if(settings)$('inspector').close();
 $('settings-tab').setAttribute('aria-pressed',String(settings));$('workspace-tab').setAttribute('aria-pressed',String(!settings));
 if(!settings)graph.resize();
}
$('workspace-tab').onclick=()=>openWorkspaceSettings(false);
$('settings-tab').onclick=()=>openWorkspaceSettings(true);

$('close-person').onclick=()=>$('inspector').close();
$('workspace-build').onclick=()=>{
 if(!$('setup-form').checkValidity()){openWorkspaceSettings(true);$('setup-form').reportValidity();return;}
 $('setup-form').requestSubmit();
};
$('explore-next').onclick=async()=>{
  const button=$('explore-next');button.disabled=true;
  try{
    const ping=await send({type:'PING'});
    if(!ping.capabilities?.includes('exploreNext')){show('update-note',true);set('update-version',`Update companion ${ping.version||'unknown'} to ${COMPANION_VERSION} to explore the next layer.`);throw Error('Update the existing unpacked companion folder, click Reload in Chrome Extensions, then reload Orbit. Do not remove the extension: its local checkpoint must be kept.');}
    const settings=config();settings.depth=Math.max(2,settings.depth);$('depth').value=settings.depth;
    const response=await send({type:'EXPLORE_NEXT',root:state.root,config:settings});remoteRevision=null;await refresh();
    toast(response.status==='running'?'Exploring saved people’s connections. Your direct-list checkpoint is kept.':response.reason);
  }catch(error){toast(error.message);}finally{button.disabled=!hasCollector()||Boolean(state?.cloudView);}
};
