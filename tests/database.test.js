import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {ingest,stats,search,neighborhood} from '../server/database.js';
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
test('invalid and orphaned links never become a silently saved graph',async()=>{
  const {db}=database();await assert.rejects(ingest(db,'one',{nodes:[person('a')],edges:[edge('a','b')]}),/save its people first/);assert.equal((await stats(db,'one')).people,0);
  await assert.rejects(ingest(db,'one',{nodes:[person('a')],edges:[{...edge('a','b'),evidence:[]}]}),/source observations/);
});
test('library neighborhoods are bounded even for high-degree profiles',async()=>{
  const {db}=database();await ingest(db,'one',{nodes:[person('root')],edges:[]});
  for(let i=0;i<5;i++){const names=Array.from({length:100},(_,j)=>'p'+(i*100+j));await ingest(db,'one',{nodes:names.map(person),edges:names.map(n=>edge('root',n))});}
  const graph=await neighborhood(db,'one',person('root').id,2,100);assert.equal(graph.nodes.length,100);assert.equal(graph.truncated,true);assert.ok(graph.edges.every(e=>graph.nodes.some(n=>n.id===e.source)&&graph.nodes.some(n=>n.id===e.target)));
});
