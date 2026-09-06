// The hosted page uses its Sites session; no LinkedIn credentials leave Chrome.
export function createLibrary({getCollection,showGraph,showCollection}){
  const $=id=>document.getElementById(id),enabled=location.protocol==='https:'||location.hostname==='127.0.0.1';
  let pending=null,saving=false,timer=null,searchTimer=null,searchSerial=0;
  const savedNodes=new Map(),savedEdges=new Map();
  async function api(path,body){const r=await fetch('/api/library/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});const data=await r.json();if(r.status===401){$('library-signin').hidden=false;$('library-counts').textContent='Sign in to view the shared team library';}else if(r.ok)$('library-signin').hidden=true;if(!r.ok){const error=Error(data.error||'Library request failed.');error.status=r.status;throw error;}return data;}
  const status=text=>{$('library-status').textContent=text;};
  async function refreshStats(){const s=await api('stats');$('library-counts').textContent=`${Number(s.people).toLocaleString()} people · ${Number(s.connections).toLocaleString()} links saved`;}
  async function sync(){
    if(saving||!pending||!enabled)return;saving=true;
    const snapshot=pending;pending=null;
    try{
      status('Saving discoveries to the shared team library…');
      for(const [field,cache,key] of [['nodes',savedNodes,'nodes'],['edges',savedEdges,'edges']]){
        const entries=Object.values(snapshot[field]||{}).map(v=>({value:v,signature:JSON.stringify(v)})).filter(v=>cache.get(v.value.id)!==v.signature);
        for(let i=0;i<entries.length;i+=100){const batch=entries.slice(i,i+100);await api('ingest',{nodes:[],edges:[],[key]:batch.map(v=>v.value)});for(const e of batch)cache.set(e.value.id,e.signature);}
      }
      status(`Saved to library · ${new Date().toLocaleTimeString()}`);await refreshStats();
    }catch(error){pending ||= snapshot;status(error.status===401?'Sign in with ChatGPT to save this collection to the shared team library.':`Not yet saved: ${error.message}. Will retry.`);}
    finally{saving=false;if(pending){clearTimeout(timer);timer=setTimeout(sync,30000);}}
  }
  function queue(state){if(!enabled||!state||state.cloudView)return;pending=state;clearTimeout(timer);timer=setTimeout(sync,2000);}
  async function lookup(url){
    try{
      status('Loading saved connections…');const data=await api('graph?url='+encodeURIComponent(url)+'&depth=2&limit=1000');
      if(!data.found){status('This person is not in the team library yet. Collect a network containing them.');return;}
      const nodes=Object.fromEntries(data.nodes.map(p=>[p.id,p])),edges=Object.fromEntries(data.edges.map(e=>[e.id,e]));
      showGraph({schemaVersion:1,id:'library:'+data.root+':'+Date.now(),root:data.root,nodes,edges,branches:{},queue:[],status:'imported',cloudView:true,pages:0,config:{maxNodes:1000,depth:2,delay:120},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),reason:data.truncated?'Showing a bounded sample of saved connections. Search another person to explore from there.':'Loaded observed connections from the shared team library.'});
      $('back-collection').hidden=false;status(data.truncated?'Saved neighborhood loaded · sample limited to keep the map responsive':'Saved neighborhood loaded · no LinkedIn requests');
    }catch(error){status(error.message);}
  }
  $('library-query').addEventListener('input',()=>{
    clearTimeout(searchTimer);const serial=++searchSerial;
    searchTimer=setTimeout(async()=>{try{
      const q=$('library-query').value.trim(),target=$('library-results');target.replaceChildren();if(!q)return;
      const data=await api('search?q='+encodeURIComponent(q));if(serial!==searchSerial)return;
      for(const p of data.people){const b=document.createElement('button');b.className='library-person';b.textContent=p.name||p.id;b.title=p.headline;b.onclick=()=>lookup(p.id);target.append(b);}
      if(!data.people.length)target.textContent='No saved match. Try the start of their name or their full LinkedIn URL.';
    }catch(error){status(error.message);}},250);
  });
  $('library-form').onsubmit=e=>{e.preventDefault();const value=$('library-query').value.trim();if(value.startsWith('https://'))lookup(value);};
  $('save-library').onclick=()=>{queue(getCollection());clearTimeout(timer);sync();};
  $('back-collection').onclick=()=>{showCollection();$('back-collection').hidden=true;};
  if(enabled)refreshStats().then(()=>status('Shared team library ready · discoveries save automatically while this page is open')).catch(error=>{if(error.status===401)status('Sign in with ChatGPT to contribute to the shared team library.');else{$('library-counts').textContent='Library unavailable';status('Open the hosted Orbit site to use the shared team library.');}});
  else status('Use the hosted Orbit site for permanent storage.');
  return {queue};
}
