import {profileURL,normalizeEvidence} from '../src/core.js';
import {buildKeywords,ftsQuery,rankPeople} from '../src/search.js';
const MAX_BATCH=100;
const short=(v,n)=>String(v||'').slice(0,n);
export function validateBatch(data){
  const inputNodes=data.nodes||[],inputEdges=data.edges||[],imports=data.imports||[],records=data.records||[];
  if(![inputNodes,inputEdges,imports,records].every(Array.isArray)||[inputNodes,inputEdges,imports,records].some(values=>values.length>MAX_BATCH))throw Error('Save at most 100 records of each type per batch.');
  const now=new Date().toISOString();
  const nodes=inputNodes.map(p=>{const id=profileURL(p.id||p.url);if(!id)throw Error('Invalid profile URL.');const name=short(p.name,200),node={id,name,search_name:name.toLowerCase(),headline:short(p.headline,1000),location:short(p.location,300),about:short(p.about,4000),experience:short(p.experience,6000),education:short(p.education,4000),skills:short(p.skills,3000),at:now};return {...node,keywords:buildKeywords(node)};});
  const edges=inputEdges.map(e=>{
    const a=profileURL(e.source),b=profileURL(e.target);if(!a||!b||a===b)throw Error('Invalid connection.');
    if(!Array.isArray(e.evidence)||!e.evidence.length||e.evidence.length>20)throw Error('Each link needs 1–20 source observations.');
    const [from,to]=[a,b].sort();const observations=e.evidence.map(v=>{const evidence=normalizeEvidence(v,a,b);if(!evidence)throw Error('Invalid connection evidence.');return {source:evidence.url,at:evidence.observedAt,details:JSON.stringify(evidence)};});
    return {a:from,b:to,observations,at:now};
  });
  const cleanImports=imports.map(item=>{if(!/^[a-f0-9]{64}$/.test(item.id))throw Error('Invalid import identifier.');const metadata=JSON.stringify(item.metadata??{});if(metadata.length>200000)throw Error('Import metadata is too large.');return {id:item.id,fileName:short(item.fileName,255),format:short(item.format,100),schemaVersion:short(item.schemaVersion,40),exportedAt:Number.isFinite(Date.parse(item.exportedAt))?new Date(item.exportedAt).toISOString():now,metadata,at:now};});
  const cleanRecords=records.map(item=>{if(!/^[a-f0-9]{64}$/.test(item.importId)||!Number.isInteger(item.index)||item.index<0)throw Error('Invalid preserved source record.');const section=short(item.section,100),value=JSON.stringify(item.data);if(!section||value===undefined||value.length>400000)throw Error('Invalid preserved source record.');return {importId:item.importId,section,index:item.index,value};});
  return {nodes,edges,imports:cleanImports,records:cleanRecords};
}
export async function ingest(db,owner,data,contributor=owner){
  const {nodes,edges,imports,records}=validateBatch(data),nodeJSON=JSON.stringify(nodes),edgeJSON=JSON.stringify(edges),observations=JSON.stringify(edges.flatMap(e=>e.observations.map(o=>({a:e.a,b:e.b,...o})))),importJSON=JSON.stringify(imports),recordJSON=JSON.stringify(records);
  contributor=short(contributor,200);if(!contributor)throw Error('Invalid contributor.');
  const endpointIds=[...new Set(edges.flatMap(e=>[e.a,e.b]))],incoming=new Set(nodes.map(p=>p.id));
  if(endpointIds.length){const existing=(await db.prepare('SELECT id FROM people WHERE owner=? AND id IN (SELECT value FROM json_each(?))').bind(owner,JSON.stringify(endpointIds)).all()).results;for(const p of existing)incoming.add(p.id);if(endpointIds.some(id=>!incoming.has(id)))throw Error('Invalid connection: save its people first.');}
  // JSON batches keep parameter counts bounded and all writes atomic and idempotent.
  await db.batch([
    db.prepare(`INSERT INTO people(owner,id,name,search_name,headline,location,about,experience,education,skills,keywords,first_seen,last_seen)
      SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.search_name'),json_extract(value,'$.headline'),json_extract(value,'$.location'),json_extract(value,'$.about'),json_extract(value,'$.experience'),json_extract(value,'$.education'),json_extract(value,'$.skills'),json_extract(value,'$.keywords'),json_extract(value,'$.at'),json_extract(value,'$.at') FROM json_each(?) WHERE 1
      ON CONFLICT(owner,id) DO UPDATE SET name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE people.name END,search_name=CASE WHEN excluded.name<>'' THEN excluded.search_name ELSE people.search_name END,headline=CASE WHEN excluded.headline<>'' THEN excluded.headline ELSE people.headline END,location=CASE WHEN excluded.location<>'' THEN excluded.location ELSE people.location END,about=CASE WHEN excluded.about<>'' THEN excluded.about ELSE people.about END,experience=CASE WHEN excluded.experience<>'' THEN excluded.experience ELSE people.experience END,education=CASE WHEN excluded.education<>'' THEN excluded.education ELSE people.education END,skills=CASE WHEN excluded.skills<>'' THEN excluded.skills ELSE people.skills END,keywords=substr(trim(people.keywords||' '||excluded.keywords),1,6000),last_seen=excluded.last_seen`).bind(owner,nodeJSON),
    db.prepare(`INSERT INTO connections(owner,a,b,first_seen,last_seen)
      SELECT ?,json_extract(j.value,'$.a'),json_extract(j.value,'$.b'),json_extract(j.value,'$.at'),json_extract(j.value,'$.at') FROM json_each(?) j
      CROSS JOIN people p ON p.owner=? AND p.id=json_extract(j.value,'$.a') CROSS JOIN people q ON q.owner=? AND q.id=json_extract(j.value,'$.b') WHERE 1
      ON CONFLICT(owner,a,b) DO UPDATE SET last_seen=excluded.last_seen`).bind(owner,edgeJSON,owner,owner),
    db.prepare(`INSERT INTO evidence(owner,a,b,source,observed_at,details_json)
      SELECT ?,json_extract(j.value,'$.a'),json_extract(j.value,'$.b'),json_extract(j.value,'$.source'),json_extract(j.value,'$.at'),json_extract(j.value,'$.details') FROM json_each(?) j
      CROSS JOIN connections c ON c.owner=? AND c.a=json_extract(j.value,'$.a') AND c.b=json_extract(j.value,'$.b') WHERE 1
      ON CONFLICT(owner,a,b,source) DO UPDATE SET observed_at=MAX(evidence.observed_at,excluded.observed_at),details_json=excluded.details_json`).bind(owner,observations,owner),
    db.prepare(`INSERT INTO people_contributors(owner,person_id,contributor_id,first_seen,last_seen)
      SELECT ?,json_extract(value,'$.id'),?,json_extract(value,'$.at'),json_extract(value,'$.at') FROM json_each(?) WHERE 1
      ON CONFLICT(owner,person_id,contributor_id) DO UPDATE SET last_seen=excluded.last_seen`).bind(owner,contributor,nodeJSON),
    db.prepare(`INSERT INTO connection_contributors(owner,a,b,contributor_id,first_seen,last_seen)
      SELECT ?,json_extract(value,'$.a'),json_extract(value,'$.b'),?,json_extract(value,'$.at'),json_extract(value,'$.at') FROM json_each(?) WHERE 1
      ON CONFLICT(owner,a,b,contributor_id) DO UPDATE SET last_seen=excluded.last_seen`).bind(owner,contributor,edgeJSON),
    db.prepare(`INSERT INTO evidence_contributors(owner,a,b,source,contributor_id,first_seen,last_seen)
      SELECT ?,json_extract(value,'$.a'),json_extract(value,'$.b'),json_extract(value,'$.source'),?,json_extract(value,'$.at'),json_extract(value,'$.at') FROM json_each(?) WHERE 1
      ON CONFLICT(owner,a,b,source,contributor_id) DO UPDATE SET last_seen=excluded.last_seen`).bind(owner,contributor,observations),
    db.prepare(`INSERT INTO imports(owner,id,file_name,format,schema_version,exported_at,metadata_json,first_seen,last_seen)
      SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.fileName'),json_extract(value,'$.format'),json_extract(value,'$.schemaVersion'),json_extract(value,'$.exportedAt'),json_extract(value,'$.metadata'),json_extract(value,'$.at'),json_extract(value,'$.at') FROM json_each(?) WHERE 1
      ON CONFLICT(owner,id) DO UPDATE SET last_seen=excluded.last_seen`).bind(owner,importJSON),
    db.prepare(`INSERT INTO import_records(owner,import_id,section,record_index,data_json)
      SELECT ?,json_extract(value,'$.importId'),json_extract(value,'$.section'),json_extract(value,'$.index'),json_extract(value,'$.value') FROM json_each(?) WHERE 1
      ON CONFLICT(owner,import_id,section,record_index) DO UPDATE SET data_json=excluded.data_json`).bind(owner,recordJSON),
    db.prepare(`DELETE FROM people_search WHERE owner=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`).bind(owner,nodeJSON),
    db.prepare(`INSERT INTO people_search(owner,id,name,headline,location,keywords)
      SELECT owner,id,name,headline,location,keywords FROM people WHERE owner=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`).bind(owner,nodeJSON)
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
  const url=profileURL(query);if(url)return (await db.prepare('SELECT id,name,headline,location,about,experience,education,skills,keywords,last_seen FROM people WHERE owner=? AND id=?').bind(owner,url).all()).results;
  const q=short(query.trim().toLowerCase(),100);if(!q)return [];
  const match=ftsQuery(q);let candidates=[];
  if(match)candidates=(await db.prepare(`SELECT p.id,p.name,p.headline,p.location,p.about,p.experience,p.education,p.skills,p.keywords,p.last_seen lastSeen
    FROM people_search JOIN people p ON p.owner=people_search.owner AND p.id=people_search.id
    WHERE people_search.owner=? AND people_search MATCH ? ORDER BY bm25(people_search) LIMIT 300`).bind(owner,match).all()).results;
  if(!candidates.length)candidates=(await db.prepare('SELECT id,name,headline,location,about,experience,education,skills,keywords,last_seen lastSeen FROM people WHERE owner=? AND search_name>=? AND search_name<? ORDER BY search_name,id LIMIT 120').bind(owner,q,q+'\uffff').all()).results;
  return rankPeople(candidates,q,30);
}
export async function activity(db,owner){
  const summary=await stats(db,owner);
  const recentPeople=(await db.prepare('SELECT id,name,headline,location,last_seen lastSeen FROM people WHERE owner=? ORDER BY last_seen DESC LIMIT 12').bind(owner).all()).results;
  const recentConnections=(await db.prepare(`SELECT c.a,c.b,pa.name aName,pb.name bName,c.last_seen lastSeen,
    (SELECT group_concat(COALESCE(u.display_name,u.email,cc.contributor_id),', ') FROM connection_contributors cc LEFT JOIN users u ON u.id=cc.contributor_id WHERE cc.owner=c.owner AND cc.a=c.a AND cc.b=c.b) contributorNames
    FROM connections c LEFT JOIN people pa ON pa.owner=c.owner AND pa.id=c.a LEFT JOIN people pb ON pb.owner=c.owner AND pb.id=c.b
    WHERE c.owner=? ORDER BY c.last_seen DESC LIMIT 12`).bind(owner).all()).results;
  return {...summary,recentPeople,recentConnections,recentImports:await listImports(db,owner)};
}
async function edgeSources(db,owner,pairs){
  if(!pairs.length)return new Map();
  const rows=(await db.prepare(`SELECT json_extract(j.value,'$.a') a,json_extract(j.value,'$.b') b,
    (SELECT json_group_array(json_object('url',source,'observedAt',observed_at,'details',details_json)) FROM
      (SELECT source,observed_at,details_json FROM evidence WHERE owner=? AND a=json_extract(j.value,'$.a') AND b=json_extract(j.value,'$.b') ORDER BY observed_at DESC LIMIT 20)) observations
    FROM json_each(?) j`).bind(owner,JSON.stringify(pairs)).all()).results;
  return new Map(rows.map(row=>[`${row.a}|${row.b}`,JSON.parse(row.observations||'[]').map(e=>({type:'visible_connection_list',...JSON.parse(e.details||'{}'),url:e.url,observedAt:e.observedAt}))]));
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
  const sources=await edgeSources(db,owner,pairs);
  for(const edge of edges.values())edge.evidence=sources.get(`${edge.source}|${edge.target}`)||[];
  return {found:true,root,nodes:[...nodes.values()],edges:[...edges.values()],truncated,depth,limit};
}
export async function shortestPath(db,owner,from,to,maxDepth=6,limit=10000){
  from=profileURL(from);to=profileURL(to);if(!from||!to)throw Error('Choose two valid LinkedIn profiles.');
  if(!Number.isInteger(maxDepth)||maxDepth<1||maxDepth>6)throw Error('Choose a path depth from 1 to 6.');
  const start=await db.prepare('SELECT id FROM people WHERE owner=? AND id=?').bind(owner,from).first(),target=await db.prepare('SELECT id FROM people WHERE owner=? AND id=?').bind(owner,to).first();
  if(!start||!target)return {found:false,from,to,nodes:[],edges:[],reason:'Both people must already exist in the shared graph.'};
  const previous=new Map([[from,null]]),via=new Map();let frontier=[from],found=from===to,truncated=false;
  for(let depth=0;depth<maxDepth&&!found&&frontier.length;depth++){
    const rows=(await db.prepare(`SELECT a,b FROM connections WHERE owner=? AND (a IN (SELECT value FROM json_each(?)) OR b IN (SELECT value FROM json_each(?))) LIMIT 20000`).bind(owner,JSON.stringify(frontier),JSON.stringify(frontier)).all()).results,next=[];
    if(rows.length>=20000)truncated=true;
    const active=new Set(frontier);for(const edge of rows){const a=active.has(edge.a)?edge.a:edge.b,b=a===edge.a?edge.b:edge.a;if(previous.has(b))continue;previous.set(b,a);via.set(b,[edge.a,edge.b].sort());next.push(b);if(b===to){found=true;break;}if(previous.size>=limit){truncated=true;break;}}
    frontier=next;if(previous.size>=limit)break;
  }
  if(!found)return {found:false,from,to,nodes:[],edges:[],truncated,reason:truncated?'No route was found inside the bounded search. Try a nearer person.':`No observed route within ${maxDepth} introductions.`};
  const ids=[];for(let id=to;id;id=previous.get(id))ids.unshift(id);const pairs=ids.slice(1).map(id=>{const [a,b]=via.get(id);return {a,b};});
  const people=(await db.prepare('SELECT id,name,headline,location,about,experience,education,skills,keywords FROM people WHERE owner=? AND id IN (SELECT value FROM json_each(?))').bind(owner,JSON.stringify(ids)).all()).results,byId=new Map(people.map(person=>[person.id,person]));
  const contributions=pairs.length?(await db.prepare(`SELECT c.a,c.b,COALESCE(u.display_name,u.email,c.contributor_id) contributor
    FROM connection_contributors c LEFT JOIN users u ON u.id=c.contributor_id
    WHERE c.owner=? AND EXISTS (SELECT 1 FROM json_each(?) j WHERE c.a=json_extract(j.value,'$.a') AND c.b=json_extract(j.value,'$.b')) ORDER BY c.last_seen DESC`).bind(owner,JSON.stringify(pairs)).all()).results:[];
  const contributors=new Map();for(const row of contributions){const key=`${row.a}|${row.b}`;if(!contributors.has(key))contributors.set(key,[]);const values=contributors.get(key);if(!values.includes(row.contributor)&&values.length<5)values.push(row.contributor);}
  const sources=await edgeSources(db,owner,pairs);
  return {found:true,from,to,hops:Math.max(0,ids.length-1),nodes:ids.map(id=>byId.get(id)||{id,name:id}),edges:pairs.map(pair=>({...pair,evidence:sources.get(`${pair.a}|${pair.b}`)||[],contributors:contributors.get(`${pair.a}|${pair.b}`)||[]})),truncated};
}
export async function resetContribution(db,owner,contributor){
  contributor=short(contributor,200);if(!contributor)throw Error('Invalid contributor.');
  const people=(await db.prepare('SELECT person_id id FROM people_contributors WHERE owner=? AND contributor_id=?').bind(owner,contributor).all()).results;
  const connections=(await db.prepare('SELECT a,b FROM connection_contributors WHERE owner=? AND contributor_id=?').bind(owner,contributor).all()).results;
  const observations=(await db.prepare('SELECT a,b,source FROM evidence_contributors WHERE owner=? AND contributor_id=?').bind(owner,contributor).all()).results;
  const ids=JSON.stringify(people.map(row=>row.id)),pairs=JSON.stringify(connections),sources=JSON.stringify(observations);
  await db.batch([
    db.prepare('DELETE FROM evidence_contributors WHERE owner=? AND contributor_id=?').bind(owner,contributor),
    db.prepare(`DELETE FROM evidence WHERE owner=? AND EXISTS (SELECT 1 FROM json_each(?) j WHERE evidence.a=json_extract(j.value,'$.a') AND evidence.b=json_extract(j.value,'$.b') AND evidence.source=json_extract(j.value,'$.source')) AND NOT EXISTS (SELECT 1 FROM evidence_contributors ec WHERE ec.owner=evidence.owner AND ec.a=evidence.a AND ec.b=evidence.b AND ec.source=evidence.source)`).bind(owner,sources),
    db.prepare('DELETE FROM connection_contributors WHERE owner=? AND contributor_id=?').bind(owner,contributor),
    db.prepare(`DELETE FROM evidence WHERE owner=? AND EXISTS (SELECT 1 FROM json_each(?) j WHERE evidence.a=json_extract(j.value,'$.a') AND evidence.b=json_extract(j.value,'$.b')) AND NOT EXISTS (SELECT 1 FROM connection_contributors c WHERE c.owner=evidence.owner AND c.a=evidence.a AND c.b=evidence.b)`).bind(owner,pairs),
    db.prepare(`DELETE FROM connections WHERE owner=? AND EXISTS (SELECT 1 FROM json_each(?) j WHERE connections.a=json_extract(j.value,'$.a') AND connections.b=json_extract(j.value,'$.b')) AND NOT EXISTS (SELECT 1 FROM connection_contributors c WHERE c.owner=connections.owner AND c.a=connections.a AND c.b=connections.b)`).bind(owner,pairs),
    db.prepare('DELETE FROM people_contributors WHERE owner=? AND contributor_id=?').bind(owner,contributor)
  ]);
  const removable=people.length?(await db.prepare(`SELECT p.id FROM people p WHERE p.owner=? AND p.id IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM people_contributors pc WHERE pc.owner=p.owner AND pc.person_id=p.id) AND NOT EXISTS (SELECT 1 FROM connections c WHERE c.owner=p.owner AND (c.a=p.id OR c.b=p.id))`).bind(owner,ids).all()).results:[];
  const removeIds=JSON.stringify(removable.map(row=>row.id));if(removable.length)await db.batch([db.prepare('DELETE FROM people_search WHERE owner=? AND id IN (SELECT value FROM json_each(?))').bind(owner,removeIds),db.prepare('DELETE FROM people WHERE owner=? AND id IN (SELECT value FROM json_each(?))').bind(owner,removeIds)]);
  return {reset:true,peopleContributions:people.length,connectionContributions:connections.length,evidenceContributions:observations.length,peopleRemoved:removable.length};
}
