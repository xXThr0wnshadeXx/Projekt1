import {locationOf,fieldOf,matchesFilters,matchesName} from './filters.js';
import {profileURL,options,route} from './core.js';
import {createLibrary} from './library.js';
import {NetworkGraph} from './graph.js';
import {COMPANION_ID} from './companion.js';
const $=id=>document.getElementById(id),EXTENSION=Boolean(globalThis.chrome?.runtime?.id&&globalThis.chrome?.storage?.local),KEY='orbitNetwork';
let state=null,selected=null,view='graph',toastTimer=null,bridgeConnected=false,refreshing=false,remoteRevision=null,companionVersion=null;
let runSample=null,lastReveal=null,collectionState=null,libraryMode=false;
const library=createLibrary({getCollection:()=>collectionState,showGraph:s=>{libraryMode=true;state=s;selected=null;render();graph.fit();},showCollection:()=>{libraryMode=false;state=collectionState;selected=null;render();}});
const hasCollector=()=>EXTENSION||bridgeConnected;
const graph=new NetworkGraph($('network-canvas'),id=>selectPerson(id));
graph.onReveal=(person,visible,total)=>{lastReveal={person,visible,total,at:Date.now()};renderLive();};
const set=(id,text)=>$(id).textContent=text;
const show=(id,visible)=>$(id).hidden=!visible;
const statuses={running:'Collecting',paused:'Paused',limit:'Person limit reached',cancelled:'Build cancelled',complete:'Queue finished',imported:'Saved map'};
const branchNames={queued:'Queued',collecting:'Collecting',hidden:'List not visible',incomplete:'Incomplete',exhausted:'End of visible results',mutuals_only:'Mutual connections only'};
function toast(message){set('toast',message);show('toast',true);clearTimeout(toastTimer);toastTimer=setTimeout(()=>show('toast',false),8000);}
function config(){return options({maxNodes:$('max-nodes').value,depth:$('depth').value,delay:$('delay').value});}
async function send(message){const response=EXTENSION?await chrome.runtime.sendMessage(message):await chrome.runtime.sendMessage(COMPANION_ID,message);if(!response?.ok)throw Error(response?.error||'The companion did not respond. Reload it in chrome://extensions, then reconnect here.');return response;}
function el(tag,text,className){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;}
function link(text,url,className){const a=el('a',text,className);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;}
function filteredPeople(){const q=$('people-search').value;return Object.values(state?.nodes||{}).filter(p=>matchesFilters(p,activeFilters())&&matchesName(p,q)).sort((a,b)=>a.depth-b.depth||a.name.localeCompare(b.name));}
function degreeMap(){const out={};for(const e of Object.values(state?.edges||{})){out[e.source]=(out[e.source]||0)+1;out[e.target]=(out[e.target]||0)+1;}return out;}
function renderPeople(){const people=filteredPeople(),degrees=degreeMap(),body=$('people-body');body.replaceChildren();set('directory-summary',`${people.length.toLocaleString()} people${$('people-search').value.trim()?' match your search':''}`);if(!people.length){const tr=el('tr'),td=el('td',state?'No people match this search.':'Build a network or open a saved graph to see people.','table-note');td.colSpan=4;tr.append(td);body.append(tr);return;}
  // Render a bounded slice so a 10,000-person map stays responsive. Search spans all nodes.
  for(const p of people.slice(0,500)){const tr=el('tr'),td=el('td'),button=el('button',p.name,'person-button');button.onclick=()=>selectPerson(p.id);td.append(button);tr.append(td,el('td',p.headline||'—'),el('td',p.depth===0?'Starting person':`${p.depth} step${p.depth===1?'':'s'}`),el('td',degrees[p.id]||0));body.append(tr);}if(people.length>500){const tr=el('tr'),td=el('td','Showing the first 500 results. Refine your search to find more people.','table-note');td.colSpan=4;tr.append(td);body.append(tr);}}
function renderCoverage(){const body=$('coverage-body');body.replaceChildren();const query=$('coverage-search').value,all=Object.entries(state?.branches||{}),branches=all.filter(([id])=>matchesName(state.nodes[id]||{name:id},query));set('coverage-summary',`${branches.length.toLocaleString()} of ${all.length.toLocaleString()} people`);for(const [id,b] of branches.slice(0,500)){const tr=el('tr'),td=el('td'),button=el('button',state.nodes[id]?.name||id,'person-button');button.onclick=()=>selectPerson(id);td.append(button);const status=el('td',branchNames[b.status]||b.status);if(b.scope==='mutuals_only'&&b.status!=='mutuals_only')status.append(el('small',' · mutuals only'));if(b.filterChanged)status.append(el('small',' · filters adjusted'));status.title=(b.reason||'')+(b.filterChanged?' LinkedIn changed the viewer-degree filter; this branch covers the visible subset.':'');tr.append(td,status,el('td',(b.profiles||[]).length),el('td',b.pages||0));body.append(tr);}if(branches.length>500){const tr=el('tr'),td=el('td','Showing the first 500 results. Search by name to find more people.','table-note');td.colSpan=4;tr.append(td);body.append(tr);}if(!branches.length){const tr=el('tr'),td=el('td',query.trim()?'No people match this search.':state?.status==='imported'?'This saved map has no resumable collection history.':'Coverage appears as the collector opens connection lists.','table-note');td.colSpan=4;tr.append(td);body.append(tr);}const activity=$('activity-log');activity.replaceChildren();for(const entry of state?.log||[]){const row=el('div',undefined,'log-line');row.append(el('time',new Date(entry.at).toLocaleTimeString()),el('span',entry.message));activity.append(row);}}
function selectPerson(id){selected=id;renderInspector();if(!id)return;if(!$('inspector').open)$('inspector').showModal();}
function renderInspector(){const p=state?.nodes[selected];if(!p){graph.focus(null);return;}const target=$('inspector-content');target.replaceChildren();target.append(el('div',p.name.split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase(),'person-avatar'),el('h3',p.name));if(p.headline)target.append(el('p',p.headline));if(p.location)target.append(el('p',p.location));target.append(link('View LinkedIn profile ↗',p.url,'profile-link'));const path=route(state,p.id);graph.focus(p.id,path);const section=el('div',undefined,'detail-section');section.append(el('h4','SHORTEST RECORDED PATH'));if(path.length)for(const id of path)section.append(el('div',state.nodes[id].name,'path-person'));else section.append(el('p','No recorded path to the starting profile.'));target.append(section);
  const edges=Object.values(state.edges).filter(e=>e.source===p.id||e.target===p.id);if(edges.length){const neighbors=el('div',undefined,'detail-section');neighbors.style.marginTop='24px';neighbors.append(el('h4',`${edges.length} CONNECTIONS IN THIS MAP`));for(const edge of edges.slice(0,20)){const other=edge.source===p.id?edge.target:edge.source,b=el('button',state.nodes[other].name,'neighbor');b.onclick=()=>selectPerson(other);neighbors.append(b);}if(edges.length>20)neighbors.append(el('p',`${edges.length-20} more connections appear in the graph.`));target.append(neighbors);const sources=el('div',undefined,'detail-section');sources.style.marginTop='24px';sources.append(el('h4','RELATIONSHIP EVIDENCE'));for(const edge of edges.slice(0,5)){const other=edge.source===p.id?edge.target:edge.source,e=edge.evidence[0];if(e)sources.append(link(`${state.nodes[other].name} · source list ↗`,e.url,'evidence-link'));}target.append(sources);}}
function renderLive(){
  const active=state?.status==='running';show('live-progress',active);
  if(!active){runSample=null;return;}
  const count=Object.keys(state.nodes).length;
  if(!runSample||runSample.id!==state.id)runSample={id:state.id,at:Date.now(),count};
  const lanes=(state.workers||[{current:state.current}]).filter(w=>w.current),names=lanes.map(w=>state.nodes[w.current.job.owner]?.name||'profile');
  const waiting=lanes.some(w=>w.current.navPending||w.current.advancePending),waitSeconds=Math.max(0,Math.ceil((Math.max(state.nextRequestAt||0,...lanes.map(w=>w.current.nextActionAt||0))-Date.now())/1000));
  const retrying=lanes.find(w=>w.current.retryAt),recent=lastReveal&&Date.now()-lastReveal.at<2500;
  set('live-title',waiting&&waitSeconds?`Next LinkedIn request in ${waitSeconds}s`:retrying?`Retrying ${state.nodes[retrying.current.job.owner]?.name||'a page'} · other tabs continue`:recent?`Added ${lastReveal.person.name}`:names.length?`Exploring ${names[0]}’s connections${names.length>1?` + ${names.length-1} more`:''}`:'Preparing the next connection list');
  const batch=state.lastBatch;
  const summary=batch?`Last page: ${batch.added} new people · ${batch.links??0} new links · ${batch.existing??0} already mapped`:`${count.toLocaleString()} people recorded`;
  set('live-detail',`${summary} · ${state.queue.length} profiles/lists queued`);
  const seconds=(Date.now()-runSample.at)/1000,added=count-runSample.count;
  set('live-rate',seconds>=5?`${Math.round(added/seconds*60)} people/min`:'Measuring speed…');
}
function render(){
  renderLive();show('cancel-build',['running','paused','limit'].includes(state?.status));
  const nodes=Object.values(state?.nodes||{}),edges=Object.values(state?.edges||{}),branches=Object.values(state?.branches||{});set('people-count',state?nodes.length.toLocaleString():'—');set('edge-count',state?edges.length.toLocaleString():'—');set('branch-count',state?branches.filter(b=>b.pages>0).length.toLocaleString():'—');set('page-count',state?(state.pages||0).toLocaleString():'—');set('network-title',state?`${state.nodes[state.root]?.name||'Starting profile'}’s network`:'Your connection map');set('run-badge',statuses[state?.status]||'Not started');$('run-badge').className=`badge ${state?.status||''}`;set('status-label',statuses[state?.status]||'Ready to explore');$('status-dot').className=state?.status||'';set('status-reason',state?.reason||'Collected discoveries save to the shared team library while this page is open.');show('empty-graph',!state);show('collector-controls',hasCollector()&&Boolean(state)&&state.status!=='imported');show('pause',state?.status==='running');show('resume',['paused','limit'].includes(state?.status));show('show-tab',Boolean(state?.tabId));show('clear-button',!libraryMode&&Boolean(state)&&state.status!=='running');$('workspace-build').disabled=libraryMode||Boolean(state)&&['running','paused','limit'].includes(state.status);$('start').disabled=libraryMode||Boolean(state)&&['running','paused','limit'].includes(state.status);$('profile-url').disabled=Boolean(state)&&['running','paused','limit'].includes(state.status);set('updated-label',state?`${state.cloudView?'Shared team library':'Collection checkpoint'} · ${new Date(state.updatedAt).toLocaleString()}`:'Shared team library');set('visible-label',state?`${nodes.filter(p=>p.depth>1).length.toLocaleString()} people beyond the first layer`:'Up to 10,000 people per map');graph.setData(state);refreshFilterOptions();graph.search($('search').value);if(view==='directory')renderPeople();if(view==='coverage')renderCoverage();renderInspector();
}
function switchView(name){view=name;show('search',name==='graph');for(const key of ['graph','directory','coverage']){show(`view-${key}`,key===name);$(`tab-${key}`).setAttribute('aria-selected',String(key===name));}if(name==='directory')renderPeople();if(name==='coverage')renderCoverage();if(name==='graph')graph.resize();}
async function refresh(){
  if(refreshing)return;refreshing=true;
  try{
    let next;
    if(EXTENSION)next=(await chrome.storage.local.get(KEY))[KEY]||null;
    else if(bridgeConnected){const response=await send({type:'GET_STATE',revision:remoteRevision});remoteRevision=response.revision;if(response.unchanged)return;next=response.state;}
    else next=JSON.parse(localStorage.getItem(KEY)||'null');
    if(state&&next&&state.id===next.id&&state.updatedAt===next.updatedAt&&state.revision===next.revision)return;
    if(state?.id!==next?.id)lastReveal=null;
    collectionState=next;refreshMaps().catch(()=>{});library.queue(next);if(libraryMode)return;state=next;if(selected&&!state?.nodes[selected])selected=null;render();
  }finally{refreshing=false;}
}
$('setup-form').onsubmit=async e=>{e.preventDefault();try{if(!profileURL($('profile-url').value))throw Error('Paste a LinkedIn person profile URL beginning with https://www.linkedin.com/in/.');const settings=config();if(!hasCollector())throw Error('Connect the Orbit companion once, then build from this same Site.');await send({type:'START',url:$('profile-url').value,config:settings});await refresh();openWorkspaceSettings(false);}catch(error){toast(error.message);}};
$('pause').onclick=async()=>{try{await send({type:'PAUSE'});await refresh();}catch(e){toast(e.message);}};
$('resume').onclick=async()=>{try{await send({type:'RESUME',config:config()});await refresh();}catch(e){toast(e.message);}};
$('show-tab').onclick=async()=>{try{await send({type:'SHOW_TAB'});}catch(e){toast(e.message);}};
$('clear-button').onclick=async()=>{if(!confirm('Clear this browser’s collection checkpoint? Unsaved discoveries will be lost. People already saved to the database will remain.'))return;try{if(hasCollector())await send({type:'CLEAR'});else localStorage.removeItem(KEY);selected=null;$('inspector-content').replaceChildren(el('h3','Every person has a path.'),el('p','Select someone in your map to explore their connections.'));await refresh();}catch(e){toast(e.message);}};
for(const name of ['graph','directory','coverage'])$(`tab-${name}`).onclick=()=>switchView(name);
$('people-search').oninput=renderPeople;$('coverage-search').oninput=renderCoverage;$('search').oninput=()=>graph.search($('search').value);$('fit').onclick=()=>graph.fit();$('zoom-in').onclick=()=>{graph.zoomTarget=null;graph.zoom(1.08);};$('zoom-out').onclick=()=>{graph.zoomTarget=null;graph.zoom(1/1.08);};
if(EXTENSION){set('connection-mode','CHROME COLLECTOR CONNECTED');chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes[KEY])refresh().catch(e=>toast(e.message));});}else{set('connection-mode','COMPANION NOT CONNECTED');show('install-note',true);}
await refresh();await refreshMaps().catch(()=>{});if(state){$('profile-url').value=state.root;$('max-nodes').value=state.config.maxNodes;$('depth').value=state.config.depth;$('delay').value=Math.max(120,state.config.delay||120);}

async function connectCompanion(quiet=false){try{set('connection-mode','CONNECTING COMPANION…');if(!globalThis.chrome?.runtime?.sendMessage)throw Error('Install the companion in Chrome, then reload this Site.');const ping=await send({type:'PING'});companionVersion=ping.version;remoteRevision=null;bridgeConnected=true;show('update-note',companionVersion!=='2.2.0');set('connection-mode','COMPANION READY');show('install-note',false);await refresh();await refreshMaps().catch(()=>{});if(state){$('profile-url').value=state.root;$('max-nodes').value=state.config.maxNodes;$('depth').value=state.config.depth;$('delay').value=Math.max(120,state.config.delay||120);}if(!quiet)toast('Companion connected. Keep working here—LinkedIn collection opens only when needed.');}catch(e){set('connection-mode','COMPANION NOT CONNECTED');show('install-note',true);if(!quiet)toast(e.message);}}
$('connect-companion').onclick=()=>connectCompanion();
if(!EXTENSION)connectCompanion(true);
setInterval(()=>{if((EXTENSION||bridgeConnected)&&document.visibilityState==='visible')refresh().catch(()=>{bridgeConnected=false;set('connection-mode','COMPANION DISCONNECTED');show('install-note',true);render();});},500);
setInterval(()=>{if(document.visibilityState==='visible')renderLive();},1000);

if($('scroll-zoom'))$('scroll-zoom').onchange=e=>{graph.scrollZoom=e.target.checked;if(!e.target.checked)graph.zoomTarget=null;};
graph.onZoom=scale=>{if($('zoom-level'))set('zoom-level',`${Math.round(scale*100)}%`);};
graph.onZoom(graph.scale);

function activeFilters(){return {location:$('filter-location').value,field:$('filter-field').value};}
function refreshFilterOptions(){
  const people=Object.values(state?.nodes||{});
  for(const [id,key,label] of [['filter-location',locationOf,'All locations'],['filter-field',fieldOf,'All fields']]){
    const select=$(id),value=select.value,counts=new Map();for(const p of people){const k=key(p);counts.set(k,(counts.get(k)||0)+1);}
    const values=[...counts.keys()].sort((a,b)=>a.localeCompare(b));if(value&&!counts.has(value))values.push(value);
    const signature=JSON.stringify([...counts]);if(select.dataset.signature===signature)continue;select.dataset.signature=signature;
    select.replaceChildren(Object.assign(el('option',label),{value:''}));
    for(const v of values)select.append(Object.assign(el('option',`${v} (${counts.get(v)||0})`),{value:v}));select.value=value;
  }
  set('filter-count',`${people.filter(p=>matchesFilters(p,activeFilters())).length.toLocaleString()} of ${people.length.toLocaleString()} people match · use Fit to frame the groups`);
}
function applyFilters(){graph.setFilters(activeFilters(),$('group-by').value);refreshFilterOptions();if(selected&&state?.nodes[selected]&&!matchesFilters(state.nodes[selected],activeFilters())){selected=null;graph.focus(null);$('inspector-content').replaceChildren(el('h3','Select a visible person'),el('p','Your filters changed which people are shown.'));}if(view==='directory')renderPeople();}
$('filter-toggle').onclick=()=>{const open=$('map-filters').hidden;show('map-filters',open);$('filter-toggle').setAttribute('aria-expanded',String(open));};
for(const id of ['filter-location','filter-field','group-by'])$(id).onchange=applyFilters;
$('reset-filters').onclick=()=>{$('filter-location').value='';$('filter-field').value='';$('group-by').value='none';applyFilters();};

async function refreshMaps(){
  if(!hasCollector()){$('new-map').disabled=true;return;}
  const response=await send({type:'LIST_MAPS'}),select=$('map-switcher');$('new-map').disabled=false;
  select.replaceChildren(Object.assign(el('option','New map'),{value:''}));
  for(const m of response.maps)select.append(Object.assign(el('option',`${m.name} · ${m.count} people · ${statuses[m.status]||m.status}`),{value:m.id}));
  select.value=collectionState?.id||'';
}
async function changeMap(type,id){try{
 await send({type,id});libraryMode=false;state=null;selected=null;remoteRevision=null;
 $('inspector-content').replaceChildren(el('h3','Every person has a path.'),el('p','Select someone in your map to explore their connections.'));
 $('profile-url').value='';$('filter-location').value='';$('filter-field').value='';$('group-by').value='none';graph.setFilters({},'none');
 await refresh();if(state){$('profile-url').value=state.root;$('max-nodes').value=state.config.maxNodes;$('depth').value=state.config.depth;$('delay').value=state.config.delay;}
 await refreshMaps();
}catch(e){toast(e.message);}}
$('new-map').onclick=()=>changeMap('NEW_MAP');
$('map-switcher').onchange=e=>changeMap(e.target.value?'SWITCH_MAP':'NEW_MAP',e.target.value);
$('cancel-build').onclick=async()=>{try{await send({type:'CANCEL'});await refresh();await refreshMaps();toast('Build cancelled. Your discovered people are kept.');}catch(e){toast(e.message);}};
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
