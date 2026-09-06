import {profileURL,listURL} from '../src/core.js';
const MAX_BATCH=100;
const short=(v,n)=>String(v||'').slice(0,n);
export function validateBatch(data){
  const inputNodes=data.nodes||[],inputEdges=data.edges||[],imports=data.imports||[],records=data.records||[];
  if(![inputNodes,inputEdges,imports,records].every(Array.isArray)||[inputNodes,inputEdges,imports,records].some(values=>values.length>MAX_BATCH))throw Error('Save at most 100 records of each type per batch.');
  const now=new Date().toISOString();
  const nodes=inputNodes.map(p=>{const id=profileURL(p.id||p.url);if(!id)throw Error('Invalid profile URL.');const name=short(p.name,200);return {id,name,search_name:name.toLowerCase(),headline:short(p.headline,1000),location:short(p.location,300),at:now};});
  const edges=inputEdges.map(e=>{
    const a=profileURL(e.source),b=profileURL(e.target);if(!a||!b||a===b)throw Error('Invalid connection.');
    if(!Array.isArray(e.evidence)||!e.evidence.length||e.evidence.length>20)throw Error('Each link needs 1–20 source observations.');
    const [from,to]=[a,b].sort();const observations=e.evidence.map(v=>{if(!listURL(v.url)||!Number.isFinite(Date.parse(v.observedAt)))throw Error('Invalid connection evidence.');return {source:v.url,at:new Date(v.observedAt).toISOString()};});
    return {a:from,b:to,observations,at:now};
  });
  const cleanImports=imports.map(item=>{if(!/^[a-f0-9]{64}$/.test(item.id))throw Error('Invalid import identifier.');const metadata=JSON.stringify(item.metadata??{});if(metadata.length>200000)throw Error('Import metadata is too large.');return {id:item.id,fileName:short(item.fileName,255),format:short(item.format,100),schemaVersion:short(item.schemaVersion,40),exportedAt:Number.isFinite(Date.parse(item.exportedAt))?new Date(item.exportedAt).toISOString():now,metadata,at:now};});
  const cleanRecords=records.map(item=>{if(!/^[a-f0-9]{64}$/.test(item.importId)||!Number.isInteger(item.index)||item.index<0)throw Error('Invalid preserved source record.');const section=short(item.section,100),value=JSON.stringify(item.data);if(!section||value===undefined||value.length>400000)throw Error('Invalid preserved source record.');return {importId:item.importId,section,index:item.index,value};});
  return {nodes,edges,imports:cleanImports,records:cleanRecords};
}
export async function ingest(db,owner,data){
  const {nodes,edges,imports,records}=validateBatch(data),nodeJSON=JSON.stringify(nodes),edgeJSON=JSON.stringify(edges),observations=JSON.stringify(edges.flatMap(e=>e.observations.map(o=>({a:e.a,b:e.b,...o})))),importJSON=JSON.stringify(imports),recordJSON=JSON.stringify(records);
  const endpointIds=[...new Set(edges.flatMap(e=>[e.a,e.b]))],incoming=new Set(nodes.map(p=>p.id));
  if(endpointIds.length){const existing=(await db.prepare('SELECT id FROM people WHERE owner=? AND id IN (SELECT value FROM json_each(?))').bind(owner,JSON.stringify(endpointIds)).all()).results;for(const p of existing)incoming.add(p.id);if(endpointIds.some(id=>!incoming.has(id)))throw Error('Invalid connection: save its people first.');}
  // JSON batches keep parameter counts bounded and all writes atomic and idempotent.
  await db.batch([
    db.prepare(`INSERT INTO people(owner,id,name,search_name,headline,location,first_seen,last_seen)
      SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.search_name'),json_extract(value,'$.headline'),json_extract(value,'$.location'),json_extract(value,'$.at'),json_extract(value,'$.at') FROM json_each(?) WHERE 1
      ON CONFLICT(owner,id) DO UPDATE SET name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE people.name END,search_name=CASE WHEN excluded.name<>'' THEN excluded.search_name ELSE people.search_name END,headline=CASE WHEN excluded.headline<>'' THEN excluded.headline ELSE people.headline END,location=CASE WHEN excluded.location<>'' THEN excluded.location ELSE people.location END,last_seen=excluded.last_seen`).bind(owner,nodeJSON),
    db.prepare(`INSERT INTO connections(owner,a,b,first_seen,last_seen)
      SELECT ?,json_extract(j.value,'$.a'),json_extract(j.value,'$.b'),json_extract(j.value,'$.at'),json_extract(j.value,'$.at') FROM json_each(?) j
      CROSS JOIN people p ON p.owner=? AND p.id=json_extract(j.value,'$.a') CROSS JOIN people q ON q.owner=? AND q.id=json_extract(j.value,'$.b') WHERE 1
      ON CONFLICT(owner,a,b) DO UPDATE SET last_seen=excluded.last_seen`).bind(owner,edgeJSON,owner,owner),
    db.prepare(`INSERT INTO evidence(owner,a,b,source,observed_at)
      SELECT ?,json_extract(j.value,'$.a'),json_extract(j.value,'$.b'),json_extract(j.value,'$.source'),json_extract(j.value,'$.at') FROM json_each(?) j
      CROSS JOIN connections c ON c.owner=? AND c.a=json_extract(j.value,'$.a') AND c.b=json_extract(j.value,'$.b') WHERE 1
      ON CONFLICT(owner,a,b,source) DO UPDATE SET observed_at=MAX(evidence.observed_at,excluded.observed_at)`).bind(owner,observations,owner),
    db.prepare(`INSERT INTO imports(owner,id,file_name,format,schema_version,exported_at,metadata_json,first_seen,last_seen)
      SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.fileName'),json_extract(value,'$.format'),json_extract(value,'$.schemaVersion'),json_extract(value,'$.exportedAt'),json_extract(value,'$.metadata'),json_extract(value,'$.at'),json_extract(value,'$.at') FROM json_each(?) WHERE 1
      ON CONFLICT(owner,id) DO UPDATE SET last_seen=excluded.last_seen`).bind(owner,importJSON),
    db.prepare(`INSERT INTO import_records(owner,import_id,section,record_index,data_json)
      SELECT ?,json_extract(value,'$.importId'),json_extract(value,'$.section'),json_extract(value,'$.index'),json_extract(value,'$.value') FROM json_each(?) WHERE 1
      ON CONFLICT(owner,import_id,section,record_index) DO UPDATE SET data_json=excluded.data_json`).bind(owner,recordJSON)
  ]);
  return {saved:true};
}
export async function stats(db,owner){
  const r=await db.prepare('SELECT (SELECT COUNT(*) FROM people WHERE owner=?) people,(SELECT COUNT(*) FROM connections WHERE owner=?) connections,(SELECT COUNT(*) FROM imports WHERE owner=?) imports,(SELECT MAX(last_seen) FROM people WHERE owner=?) lastSaved').bind(owner,owner,owner,owner).first();return r;
}
export async function listImports(db,owner){
  return (await db.prepare(`SELECT i.id,i.file_name fileName,i.format,i.schema_version schemaVersion,i.exported_at exportedAt,i.last_seen lastSeen,COUNT(r.record_index) records
    FROM imports i LEFT JOIN import_records r ON r.owner=i.owner AND r.import_id=i.id WHERE i.owner=?
    GROUP BY i.owner,i.id ORDER BY i.last_seen DESC LIMIT 25`).bind(owner).all()).results;
}
export async function search(db,owner,query){
  const url=profileURL(query);if(url)return (await db.prepare('SELECT id,name,headline,last_seen FROM people WHERE owner=? AND id=?').bind(owner,url).all()).results;
  const q=short(query.trim().toLowerCase(),100);if(!q)return [];
  return (await db.prepare('SELECT id,name,headline,last_seen FROM people WHERE owner=? AND search_name>=? AND search_name<? ORDER BY search_name,id LIMIT 30').bind(owner,q,q+'\uffff').all()).results;
}
export async function neighborhood(db,owner,root,depth=2,limit=1000){
  root=profileURL(root);if(!root)throw Error('Enter a LinkedIn profile URL.');
  if(!Number.isInteger(depth)||depth<1||depth>2||!Number.isInteger(limit)||limit<10||limit>3000)throw Error('Choose 1–2 layers and 10–3,000 people.');
  const start=await db.prepare('SELECT * FROM people WHERE owner=? AND id=?').bind(owner,root).first();if(!start)return {found:false,nodes:[],edges:[]};
  const nodes=new Map([[root,{...start,url:root,depth:0}]]),edges=new Map();let frontier=[root],truncated=false,queriesUsed=0;
  for(let layer=1;layer<=depth&&frontier.length;layer++){
    const next=[];
    // Each node receives a bounded share so one highly connected person cannot dominate.
    const perNode=Math.max(10,Math.ceil((limit-nodes.size)/frontier.length));
    for(let i=0;i<frontier.length;i+=25){
      if(queriesUsed>=400){truncated=true;break;}
      const batch=frontier.slice(i,i+Math.min(25,400-queriesUsed));queriesUsed+=batch.length;const queries=batch.map(id=>db.prepare(`SELECT a,b FROM connections WHERE owner=? AND a=? UNION SELECT a,b FROM connections WHERE owner=? AND b=? LIMIT ?`).bind(owner,id,owner,id,perNode+1));
      const results=await db.batch(queries);
      for(const result of results){if(result.results.length>perNode)truncated=true;for(const e of result.results.slice(0,perNode)){
        const candidate=nodes.has(e.a)?e.b:e.a;if(!nodes.has(candidate)){if(nodes.size>=limit){truncated=true;continue;}nodes.set(candidate,{id:candidate,url:candidate,depth:layer});next.push(candidate);}
        edges.set(`${e.a}|${e.b}`,{id:`${e.a}|${e.b}`,source:e.a,target:e.b,evidence:[]});
      }}
      if(nodes.size>=limit){truncated=true;break;}
    }
    frontier=next;if(nodes.size>=limit)break;
  }
  const ids=[...nodes.keys()];
  const details=(await db.prepare('SELECT * FROM people WHERE owner=? AND id IN (SELECT value FROM json_each(?))').bind(owner,JSON.stringify(ids)).all()).results;
  for(const p of details)Object.assign(nodes.get(p.id),p);
  // Indexed edge evidence lookup, bounded to the displayed links.
  const pairs=[...edges.values()].map(e=>({a:e.source,b:e.target}));
  const sources=(await db.prepare(`SELECT json_extract(j.value,'$.a') a,json_extract(j.value,'$.b') b,
    (SELECT json_object('url',e.source,'observedAt',e.observed_at) FROM evidence e WHERE e.owner=? AND e.a=json_extract(j.value,'$.a') AND e.b=json_extract(j.value,'$.b') ORDER BY e.observed_at DESC LIMIT 1) observation FROM json_each(?) j`).bind(owner,JSON.stringify(pairs)).all()).results;
  for(const e of sources){const edge=edges.get(`${e.a}|${e.b}`);if(edge&&e.observation)edge.evidence.push({...JSON.parse(e.observation),type:'visible_connection_list'});}
  return {found:true,root,nodes:[...nodes.values()],edges:[...edges.values()],truncated,depth,limit};
}
