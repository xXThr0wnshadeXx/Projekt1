import {prepareImport} from './import.js';
export function splitEvidence(edge){const parts=[];for(let i=0;i<(edge.evidence||[]).length;i+=20)parts.push({...edge,evidence:edge.evidence.slice(i,i+20)});return parts;}
export function coverageRecords(state){
  if(!state)return [];
  const out=[],push=(personId,kind,status,checkedAt,scope='',details={})=>{if(!personId||!Number.isFinite(Date.parse(checkedAt||'')))return;out.push({personId,kind,status,checkedAt,scope,details});};
  for(const [personId,value] of Object.entries(state.profileChecks||{}))if(!value.shared)push(personId,'profile','checked',value.checkedAt,'',{source:'profile'});
  for(const [personId,value] of Object.entries(state.branches||{}))if(!value.shared&&['exhausted','incomplete','hidden','mutuals_only'].includes(value.status))push(personId,'connections',value.status,value.checkedAt,value.scope||'',{pages:Number(value.pages)||0,profiles:Array.isArray(value.profiles)?value.profiles.length:0,filterChanged:Boolean(value.filterChanged)});
  for(const [personId,value] of Object.entries(state.commentCoverage||{}))if(!value.shared&&['exhausted','incomplete','hidden','mutuals_only'].includes(value.status))push(personId,'comments',value.status,value.checkedAt,value.scope||'',{posts:Array.isArray(value.posts)?value.posts.length:0,profiles:Array.isArray(value.profiles)?value.profiles.length:0,comments:Number(value.comments)||0});
  return out;
}
export function mergeAccountGraphs(local,shared,maxDepth=6){
  if(!local)return shared||null;if(!shared||shared.root!==local.root)return local;
  const nodes={...shared.nodes,...local.nodes},edges={...shared.edges};
  for(const edge of Object.values(local.edges||{})){
    const previous=edges[edge.id],seen=new Set((previous?.evidence||[]).map(item=>`${item.type||'visible_connection_list'}|${item.url}|${item.commentId||''}`));
    edges[edge.id]={...(previous||{}),...edge,evidence:[...(previous?.evidence||[]),...(edge.evidence||[]).filter(item=>!seen.has(`${item.type||'visible_connection_list'}|${item.url}|${item.commentId||''}`))]};
  }
  const adjacent=new Map();for(const edge of Object.values(edges)){if(!nodes[edge.source]||!nodes[edge.target])continue;for(const [a,b] of [[edge.source,edge.target],[edge.target,edge.source]]){if(!adjacent.has(a))adjacent.set(a,[]);adjacent.get(a).push(b);}}
  const depths=new Map([[local.root,0]]),queue=[local.root];while(queue.length){const id=queue.shift(),depth=depths.get(id);if(depth>=maxDepth)continue;for(const next of adjacent.get(id)||[])if(!depths.has(next)){depths.set(next,depth+1);queue.push(next);}}
  const connected={};for(const [id,depth] of depths)if(nodes[id])connected[id]={...nodes[id],depth};
  const connectedEdges={};for(const edge of Object.values(edges))if(connected[edge.source]&&connected[edge.target])connectedEdges[edge.id]=edge;
  const coverage=new Map();for(const item of [...(shared.coverage||[]),...(local.coverage||[])])coverage.set(`${item.personId}|${item.kind}`,item);
  return {...local,id:`account:${local.root}`,graphRevision:`${local.revision||0}:${shared.graphRevision||0}:${Object.keys(connectedEdges).length}`,nodes:connected,edges:connectedEdges,branches:{...(shared.branches||{}),...(local.branches||{})},profileChecks:{...(shared.profileChecks||{}),...(local.profileChecks||{})},commentCoverage:{...(shared.commentCoverage||{}),...(local.commentCoverage||{})},coverage:[...coverage.values()],cloudView:false,sharedView:true,updatedAt:[local.updatedAt,shared.updatedAt].filter(Boolean).sort().at(-1)};
}
// The hosted page uses its Sites session; no LinkedIn credentials leave Chrome.
export function createLibrary({getCollection,showGraph,showCollection}){
  const $=id=>document.getElementById(id),enabled=location.protocol==='https:'||location.hostname==='127.0.0.1';
  let pending=null,prepared=null,saving=false,importing=false,timer=null,searchTimer=null,searchSerial=0;
  const accountRevisions=new Map();
  const savedNodes=new Map(),savedEdges=new Map(),savedCoverage=new Map();
  async function api(path,body){const r=await fetch('/api/library/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});const data=await r.json();if(r.status===401){$('library-signin').hidden=false;$('library-signin').href='/?return_to=%2Fmap.html#login';$('library-signin').textContent='Sign in to continue ↗';$('library-counts').textContent='Sign in to view the shared team library';}else if(r.ok)$('library-signin').hidden=true;if(!r.ok){const error=Error(data.error||'Library request failed.');error.status=r.status;error.retryAfter=Number(r.headers.get('Retry-After'))||0;throw error;}return data;}
  const status=text=>{$('library-status').textContent=text;};
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function refreshStats(){const s=await api('stats');$('library-counts').textContent=`${Number(s.people).toLocaleString()} people · ${Number(s.connections).toLocaleString()} links saved${Number(s.reusableCoverage)?` · ${Number(s.reusableCoverage).toLocaleString()} reusable checks`:''}${Number(s.imports)?` · ${Number(s.imports).toLocaleString()} imports`:''}`;}
  async function ingestBatch(body,progress){
    for(;;){
      try{return await api('ingest',body);}
      catch(error){if(error.status!==429)throw error;const seconds=Math.max(1,error.retryAfter||60);progress(`Rate limit reached · continuing automatically in ${seconds} seconds…`);await delay(seconds*1000);}
    }
  }
  async function upload(data,progress){
    const fields=['nodes','edges','imports','records'],total=fields.reduce((sum,key)=>sum+data[key].length,0);let uploaded=0;
    for(const key of fields)for(let i=0;i<data[key].length;i+=100){
      const batch=data[key].slice(i,i+100),values=key==='edges'?batch.flatMap(splitEvidence):batch;for(let j=0;j<values.length;j+=100)await ingestBatch({nodes:[],edges:[],imports:[],records:[],[key]:values.slice(j,j+100)},progress);uploaded+=batch.length;
      progress(`Uploading to D1 · ${uploaded.toLocaleString()} of ${total.toLocaleString()} records`);
    }
  }
  async function sync(){
    if(saving||importing||!pending||!enabled)return;saving=true;
    const snapshot=pending;pending=null;
    try{
      status('Saving discoveries to the shared team library…');
      for(const [field,cache,key] of [['nodes',savedNodes,'nodes'],['edges',savedEdges,'edges']]){
        const entries=Object.values(snapshot[field]||{}).filter(v=>field!=='nodes'||!v.sharedOnly).map(v=>({value:v,signature:JSON.stringify(v)})).filter(v=>cache.get(v.value.id)!==v.signature);
        for(let i=0;i<entries.length;i+=100){const batch=entries.slice(i,i+100),values=field==='edges'?batch.flatMap(v=>splitEvidence(v.value)):batch.map(v=>v.value);for(let j=0;j<values.length;j+=100)await api('ingest',{nodes:[],edges:[],[key]:values.slice(j,j+100)});for(const e of batch)cache.set(e.value.id,e.signature);}
      }
      const entries=coverageRecords(snapshot).map(value=>({value,key:`${value.personId}|${value.kind}`,signature:JSON.stringify(value)})).filter(item=>savedCoverage.get(item.key)!==item.signature);
      for(let i=0;i<entries.length;i+=100){const batch=entries.slice(i,i+100);await api('ingest',{nodes:[],edges:[],coverage:batch.map(item=>item.value)});for(const item of batch)savedCoverage.set(item.key,item.signature);}
      await refreshStats();const rebuilt=!snapshot.root||await lookup(snapshot.root,true,6,true);status(`${rebuilt?'Saved and rebuilt from D1':'Saved to D1 · map refresh will retry'} · ${new Date().toLocaleTimeString()}`);
    }catch(error){pending ||= snapshot;status(error.status===401?'Sign in to save this collection to the shared team library.':`Not yet saved: ${error.message}. Will retry.`);}
    finally{saving=false;if(pending){clearTimeout(timer);timer=setTimeout(sync,30000);}}
  }
  function queue(state){if(!enabled||!state||state.cloudView)return;pending=state;clearTimeout(timer);timer=setTimeout(sync,2000);}
  async function lookup(url,accountView=false,depth=2,quiet=false){
    try{
      if(!quiet)status('Loading saved connections…');depth=Math.max(1,Math.min(6,Number(depth)||2));const since=accountView?accountRevisions.get(url)||'':'';const data=await api('graph?url='+encodeURIComponent(url)+`&depth=${depth}&limit=3000${since?`&since=${encodeURIComponent(since)}`:''}`);
      if(!data.found){status('This person is not in the team library yet. Collect a network containing them.');return;}
      if(data.unchanged)return true;
      const nodes=Object.fromEntries(data.nodes.map(p=>[p.id,p])),edges=Object.fromEntries(data.edges.map(e=>[e.id,e])),branches={},profileChecks={},commentCoverage={};
      for(const item of data.coverage||[]){const value={status:'shared',sourceStatus:item.status,shared:true,checkedAt:item.checkedAt,contributor:item.contributor,scope:item.scope,details:item.details,reason:`Fresh ${item.kind} coverage reused from ${item.contributor||'a teammate'}.`};if(item.kind==='connections')branches[item.personId]=value;else if(item.kind==='profile')profileChecks[item.personId]=value;else if(item.kind==='comments')commentCoverage[item.personId]=value;}
      const bounded=data.truncated||data.edgeTruncated,shared={schemaVersion:1,id:`library-account:${data.root}`,graphRevision:data.updatedAt||`${data.nodes.length}:${data.edges.length}`,root:data.root,nodes,edges,branches,profileChecks,commentCoverage,coverage:data.coverage||[],queue:[],status:'imported',cloudView:true,pages:0,config:{maxNodes:3000,depth,delay:120,comments:false},createdAt:data.updatedAt||new Date().toISOString(),updatedAt:data.updatedAt||new Date().toISOString(),reason:bounded?'Showing a bounded connected view for responsive rendering.':'Loaded every saved person and relationship connected to this account within the selected distance.'};
      if(accountView&&data.updatedAt)accountRevisions.set(url,data.updatedAt);showGraph(shared,accountView);
      $('back-collection').hidden=accountView;if(!quiet)status(bounded?'Account network rebuilt from D1 · bounded for responsive rendering':'Account network rebuilt from D1 · no LinkedIn request needed');return shared;
    }catch(error){status(error.message);return null;}
  }
  $('library-query').addEventListener('input',()=>{
    clearTimeout(searchTimer);const serial=++searchSerial;
    searchTimer=setTimeout(async()=>{try{
      const q=$('library-query').value.trim(),target=$('library-results');target.replaceChildren();if(!q)return;
      const data=await api('search?q='+encodeURIComponent(q));if(serial!==searchSerial)return;
      for(const p of data.people){const b=document.createElement('button'),name=document.createElement('strong'),detail=document.createElement('small');b.className='library-person';name.textContent=p.name||p.id;detail.textContent=[p.reason,p.headline||p.location].filter(Boolean).join(' · ');b.append(name,detail);b.onclick=()=>lookup(p.id);target.append(b);}
      if(!data.people.length)target.textContent='No close suggestion yet. Try an abbreviation, school, company, location, role, or partial spelling.';
    }catch(error){status(error.message);}},250);
  });
  $('library-form').onsubmit=e=>{e.preventDefault();const value=$('library-query').value.trim();if(value.startsWith('https://'))lookup(value);};
  $('save-library').onclick=()=>{queue(getCollection());clearTimeout(timer);sync();};
  $('import-library').onclick=()=>$('library-import-file').click();
  $('library-import-file').onchange=async event=>{
    const file=event.target.files?.[0];event.target.value='';if(!file||importing)return;$('import-library').disabled=true;
    try{
      status(`Reading ${file.name} locally…`);const raw=await file.text();prepared=await prepareImport(JSON.parse(raw),raw,file.name);
      const p=prepared;$('library-import-summary').textContent=`Ready to import ${p.nodes.length.toLocaleString()} people, ${p.edges.length.toLocaleString()} connections, and ${p.records.length.toLocaleString()} preserved source records.${p.skippedPeople||p.skippedConnections?` ${p.skippedPeople.toLocaleString()} invalid people and ${p.skippedConnections.toLocaleString()} unsupported connections will stay preserved in the source records but will not be added to the visual graph.`:''}`;$('library-import-preview').hidden=false;status('Review the totals, then confirm. Nothing has been uploaded yet.');
    }catch(error){prepared=null;$('library-import-preview').hidden=true;status(`Import stopped: ${error.message}`);}
    finally{$('import-library').disabled=false;}
  };
  $('confirm-library-import').onclick=async()=>{if(!prepared||importing)return;importing=true;$('confirm-library-import').disabled=true;$('cancel-library-import').disabled=true;try{await upload(prepared,status);await refreshStats();status(`Import complete · ${prepared.nodes.length.toLocaleString()} people, ${prepared.edges.length.toLocaleString()} links, and ${prepared.records.length.toLocaleString()} source records processed without duplicates`);prepared=null;$('library-import-preview').hidden=true;}catch(error){status(error.status===401?'Sign in with ChatGPT, then confirm again.':`Import stopped: ${error.message}`);}finally{importing=false;$('confirm-library-import').disabled=false;$('cancel-library-import').disabled=false;if(pending){clearTimeout(timer);timer=setTimeout(sync,1000);}}};
  $('cancel-library-import').onclick=()=>{prepared=null;$('library-import-preview').hidden=true;status('Import cancelled · nothing was uploaded.');};
  $('back-collection').onclick=()=>{showCollection();$('back-collection').hidden=true;};
  $('show-imports').onclick=async()=>{const target=$('library-imports'),button=$('show-imports');if(!target.hidden){target.hidden=true;button.setAttribute('aria-expanded','false');button.textContent='View database activity';return;}button.disabled=true;try{const data=await api('activity');target.replaceChildren();const summary=document.createElement('p');summary.className='database-proof';summary.textContent=`LIVE D1 · ${Number(data.people).toLocaleString()} people · ${Number(data.connections).toLocaleString()} links · last save ${data.lastSaved?new Date(data.lastSaved).toLocaleString():'not yet'}`;target.append(summary);
    const section=(title,rows,render)=>{const details=document.createElement('details'),heading=document.createElement('summary'),body=document.createElement('div');details.open=true;heading.textContent=`${title} (${rows.length})`;for(const item of rows){const row=document.createElement('article'),name=document.createElement('strong'),meta=document.createElement('span'),values=render(item);name.textContent=values[0];meta.textContent=values.slice(1).filter(Boolean).join(' · ');row.append(name,meta);body.append(row);}if(!rows.length)body.textContent='Nothing saved yet.';details.append(heading,body);target.append(details);};
    section('Recently saved people',data.recentPeople,item=>[item.name||item.id,item.headline||item.location||'Profile',new Date(item.lastSeen).toLocaleString()]);
    section('Recently saved connections',data.recentConnections,item=>[`${item.aName||item.a} → ${item.bName||item.b}`,item.contributorNames&&`Contributed by ${item.contributorNames}`,new Date(item.lastSeen).toLocaleString()]);
    section('Imported files',data.recentImports,item=>[item.fileName||'Imported collection',item.format||'JSON',`${Number(item.records).toLocaleString()} preserved records`,new Date(item.lastSeen).toLocaleString()]);
    target.hidden=false;button.setAttribute('aria-expanded','true');button.textContent='Hide database activity';}catch(error){status(error.message);}finally{button.disabled=false;}};
  if(enabled)refreshStats().then(()=>status('Database-first sync ready · collection pacing does not pause D1 reads')).catch(error=>{if(error.status===401)status('Sign in to contribute to the shared team library.');else{$('library-counts').textContent='Library unavailable';status('Open the hosted Orbit site to use the shared team library.');}});
  else status('Use the hosted Orbit site for permanent storage.');
  setInterval(()=>{if(pending&&!saving&&!importing)sync();},30000);
  return {queue,loadAccount:(url,depth=6)=>lookup(url,true,depth,true),resetCaches(){pending=null;savedNodes.clear();savedEdges.clear();savedCoverage.clear();accountRevisions.clear();}};
}
