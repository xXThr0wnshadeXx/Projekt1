import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {ingest,stats,search,neighborhood,listImports,shortestPath,resetContribution,activity} from '../server/database.js';
function database(){
  const raw=new DatabaseSync(':memory:');for(const f of readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')))raw.exec(readFileSync(new URL('../drizzle/'+f,import.meta.url),'utf8'));
  const db={prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this;},async all(){return {results:raw.prepare(sql).all(...this.args)};},async first(){return raw.prepare(sql).get(...this.args)||null;}};},async batch(statements){raw.exec('BEGIN');try{const results=statements.map(s=>({results:raw.prepare(s.sql).all(...s.args)}));raw.exec('COMMIT');return results;}catch(e){raw.exec('ROLLBACK');throw e;}}};return {db,raw};
}
const person=n=>({id:`https://www.linkedin.com/in/${n}/`,name:n,headline:'Example role'});
const edge=(a,b)=>({source:person(a).id,target:person(b).id,evidence:[{url:`https://www.linkedin.com/search/results/people/?connectionOf=${a}`,observedAt:'2026-09-06T00:00:00Z'}]});
test('the durable library merges collections, preserves evidence, and isolates accounts',async()=>{
  const {db}=database();await ingest(db,'one',{nodes:['root','a'].map(person),edges:[edge('root','a')]});
  await ingest(db,'one',{nodes:['a','b'].map(person),edges:[edge('a','b')]});
  await ingest(db,'one',{nodes:['root','a'].map(person),edges:[edge('root','a')]});
  assert.equal((await stats(db,'one')).people,3);assert.equal((await stats(db,'one')).connections,2);
  assert.equal((await search(db,'one','a'))[0].id,person('a').id);assert.equal((await search(db,'one',person('b').id)).length,1);
  assert.equal((await stats(db,'two')).people,0);assert.equal((await search(db,'two','a')).length,0);
  const graph=await neighborhood(db,'one',person('root').id);assert.equal(graph.nodes.length,3);assert.equal(graph.edges.length,2);assert.equal(graph.nodes.find(p=>p.id===person('b').id).depth,2);assert.ok(graph.edges.every(e=>e.evidence.length));
  assert.equal((await neighborhood(db,'two',person('root').id)).found,false);
});
test('repeated and reversed imports update details without duplicating people or links',async()=>{
  const {db,raw}=database();
  await ingest(db,'shared',{nodes:[person('root'),person('a')],edges:[edge('root','a')]});
  await ingest(db,'shared',{nodes:[{...person('a'),name:'Updated A',location:'Seattle'},person('root')],edges:[{...edge('root','a'),source:person('a').id,target:person('root').id}]});
  assert.equal((await stats(db,'shared')).people,2);assert.equal((await stats(db,'shared')).connections,1);
  assert.equal(raw.prepare('SELECT name FROM people WHERE owner=? AND id=?').get('shared',person('a').id).name,'Updated A');
  assert.equal(raw.prepare('SELECT COUNT(*) count FROM evidence WHERE owner=?').get('shared').count,1);
  await ingest(db,'shared',{nodes:[],edges:[{source:person('root').id,target:person('a').id,evidence:[{url:'https://www.linkedin.com/search/results/people/?connectionOf=second-source',observedAt:'2026-09-06T01:00:00Z'}]}]});
  assert.equal((await stats(db,'shared')).connections,1);assert.equal(raw.prepare('SELECT COUNT(*) count FROM evidence WHERE owner=?').get('shared').count,2);
});
test('rich import records are preserved idempotently with their metadata',async()=>{
  const {db,raw}=database(),id='a'.repeat(64),payload={nodes:[],edges:[],imports:[{id,fileName:'archive.json',format:'knowledge-graph',schemaVersion:'2',exportedAt:'2026-09-06T00:00:00Z',metadata:{counts:{profiles:52}}}],records:[{importId:id,section:'profileDetails',index:0,data:{person:person('a').id,key:'skill',value:'SQLite'}}]};
  await ingest(db,'shared',payload);await ingest(db,'shared',payload);
  assert.equal((await stats(db,'shared')).imports,1);assert.equal(raw.prepare('SELECT COUNT(*) count FROM import_records WHERE owner=?').get('shared').count,1);
  assert.equal(JSON.parse(raw.prepare('SELECT metadata_json FROM imports WHERE owner=?').get('shared').metadata_json).counts.profiles,52);
  assert.deepEqual((await listImports(db,'shared')).map(item=>[item.fileName,item.records]),[['archive.json',1]]);
});
test('invalid and orphaned links never become a silently saved graph',async()=>{
  const {db}=database();await assert.rejects(ingest(db,'one',{nodes:[person('a')],edges:[edge('a','b')]}),/save its people first/);assert.equal((await stats(db,'one')).people,0);
  await assert.rejects(ingest(db,'one',{nodes:[person('a')],edges:[{...edge('a','b'),evidence:[]}]}),/source observations/);
});
test('library neighborhoods are bounded even for high-degree profiles',async()=>{
  const {db}=database();await ingest(db,'one',{nodes:[person('root')],edges:[]});
  for(let i=0;i<5;i++){const names=Array.from({length:100},(_,j)=>'p'+(i*100+j));await ingest(db,'one',{nodes:names.map(person),edges:names.map(n=>edge('root',n))});}
  const graph=await neighborhood(db,'one',person('root').id,2,100);assert.equal(graph.nodes.length,100);assert.equal(graph.truncated,true);assert.ok(graph.edges.every(e=>graph.nodes.some(n=>n.id===e.source)&&graph.nodes.some(n=>n.id===e.target)));
});
test('search understands abbreviations, rich fields, and close spellings',async()=>{
  const {db}=database();await ingest(db,'shared',{nodes:[{...person('sam'),name:'Sam Engineer',headline:'Student at San Jose State University',skills:'Machine Learning'},{...person('jasper'),name:'Jasper Chen',headline:'Applied Mathematics and RAG at AutoSitu'},{...person('tina'),name:'Tina Rong',headline:'Emulation Verification Engineer at Apple'}],edges:[]},'sam-user');
  assert.equal((await search(db,'shared','sjsu'))[0].id,person('sam').id);
  assert.equal((await search(db,'shared','machin learnin'))[0].id,person('sam').id);
  assert.equal((await search(db,'shared','enginerr'))[0].id,person('sam').id);
  assert.equal((await search(db,'shared','san jose universty'))[0].id,person('sam').id);
  assert.deepEqual((await search(db,'shared','apple')).map(result=>result.id),[person('tina').id]);
  assert.equal((await search(db,'shared','appel'))[0].id,person('tina').id);
});
test('cross-account paths retain shared evidence and reset only one contributor',async()=>{
  const {db,raw}=database();await ingest(db,'shared',{nodes:['root','a'].map(person),edges:[edge('root','a')]},'shreev');await ingest(db,'shared',{nodes:['a','b'].map(person),edges:[edge('a','b')]},'ben');await ingest(db,'shared',{nodes:['root','a'].map(person),edges:[edge('root','a')]},'nicolas');
  const path=await shortestPath(db,'shared',person('root').id,person('b').id,6);assert.equal(path.hops,2);assert.deepEqual(path.nodes.map(node=>node.id),['root','a','b'].map(name=>person(name).id));assert.deepEqual(new Set(path.edges[0].contributors),new Set(['shreev','nicolas']));
  const before=await activity(db,'shared');assert.equal(before.people,3);assert.equal(before.connections,2);assert.equal(before.recentConnections.length,2);
  await resetContribution(db,'shared','shreev');assert.equal(raw.prepare('SELECT COUNT(*) count FROM connections WHERE owner=?').get('shared').count,2);
  await resetContribution(db,'shared','nicolas');assert.equal(raw.prepare('SELECT COUNT(*) count FROM connections WHERE owner=?').get('shared').count,1);assert.equal((await shortestPath(db,'shared',person('root').id,person('b').id,6)).found,false);
});
