import test from 'node:test';
import assert from 'node:assert/strict';
import {profileURL,listURL,sameList,sameConnectionOwner,newState,addPerson,addEdge,ingestPage,route,exportGraph,importGraph,csv} from '../src/core.js';
const root='https://www.linkedin.com/in/test-root/';
const list='https://www.linkedin.com/search/results/people/?connectionOf=%5B%22owner%22%5D&network=%5B%22F%22%2C%22S%22%5D';
test('only canonical LinkedIn person URLs are accepted',()=>{assert.equal(profileURL('https://linkedin.com/in/some-person/?trk=test'), 'https://www.linkedin.com/in/some-person/');for(const u of ['https://linkedin.com.evil.test/in/a/','https://www.linkedin.com@evil.test/in/a/','javascript:alert(1)','https://user:pass@www.linkedin.com/in/a/','https://www.linkedin.com/company/acme/','http://www.linkedin.com/in/a/'])assert.equal(profileURL(u),null);});
test('list identity requires the same owner and network filter',()=>{assert.ok(listURL(list));assert.ok(sameList(list,list+'&page=2'));assert.ok(!sameList(list,list.replace('owner','another')));assert.ok(!sameList(list,list.replace('network=','other=')));assert.equal(listURL('https://example.com/search/results/people/?connectionOf=x'),null);});
test('deduplicate by URL, preserve multiple sources, and compute a path',()=>{const s=newState(root),a=addPerson(s,{url:'https://www.linkedin.com/in/a/',name:'A'},1),b=addPerson(s,{url:'https://www.linkedin.com/in/b/',name:'B'},2);addPerson(s,{url:a+'?tracking=1',name:'A'},1);addEdge(s,root,a,list);addEdge(s,a,b,list);addEdge(s,b,a,list+'&page=2');assert.equal(Object.keys(s.nodes).length,3);assert.equal(Object.keys(s.edges).length,2);assert.equal(Object.values(s.edges).find(e=>e.evidence.length===2).evidence.length,2);assert.deepEqual(route(s,b),[root,a,b]);assert.deepEqual(s.queue.map(j=>j.owner),[root,a]);});
test('thousands of nodes stay within the cap and interrupted pages can be replayed',()=>{const s=newState(root,{maxNodes:1000}),people=Array.from({length:1500},(_,i)=>({url:`https://www.linkedin.com/in/test-${i}/`,name:`Fixture ${i}`})),job={owner:root,depth:0,url:list};ingestPage(s,job,{url:list,people});assert.equal(Object.keys(s.nodes).length,1000);assert.equal(Object.keys(s.edges).length,999);s.config.maxNodes=2000;ingestPage(s,job,{url:list,people});assert.equal(Object.keys(s.nodes).length,1501);assert.equal(Object.keys(s.edges).length,1500);assert.equal(new Set(s.queue.map(j=>j.owner)).size,s.queue.length);});
test('changed filters cannot create false edges',()=>{const s=newState(root);assert.throws(()=>ingestPage(s,{owner:root,depth:0,url:list},{url:list.replace('owner','wrong'),people:[]}));assert.equal(Object.keys(s.edges).length,0);});
test('export/import preserves graph and rejects broken evidence',()=>{const s=newState(root),a=addPerson(s,{url:'https://www.linkedin.com/in/a/',name:'A'},1);addEdge(s,root,a,list);const data=exportGraph(s),copy=importGraph(data);assert.deepEqual(route(copy,a),[root,a]);assert.equal(copy.status,'imported');data.edges[0].evidence[0].url='javascript:alert(1)';assert.throws(()=>importGraph(data));});
test('spreadsheet exports quote fields and neutralize formulas',()=>{const result=csv([['=HYPERLINK("x")','a,b','line\nbreak']]);assert.ok(result.startsWith('"\'=HYPERLINK'));assert.ok(result.includes('"a,b"'));});
test('a person discovered by a parallel branch is explored when a shorter path appears',()=>{const s=newState(root),id=addPerson(s,{url:'https://www.linkedin.com/in/overlap/',name:'Overlap'},2);assert.equal(s.queue.length,1);addPerson(s,{url:id,name:'Overlap'},1);addPerson(s,{url:id,name:'Overlap'},1);assert.equal(s.queue.filter(j=>j.owner===id).length,1);assert.equal(s.nodes[id].depth,1);});

test('equivalent owner/degree filters tolerate JSON ordering and URL normalization',()=>{
  const base='https://www.linkedin.com/search/results/people/';
  const a=base+'?connectionOf='+encodeURIComponent(JSON.stringify(['owner']))+'&network='+encodeURIComponent(JSON.stringify(['S','F']));
  const b=base.slice(0,-1)+'?network='+encodeURIComponent(JSON.stringify(['F','S']))+'&connectionOf=owner&page=2';
  assert.equal(sameList(a,b),true);
  assert.equal(sameConnectionOwner(a,base+'?connectionOf=owner'),true);
  assert.equal(sameList(a,base+'?connectionOf=owner'),false);
  assert.equal(sameConnectionOwner(a,base+'?connectionOf=other'),false);
  assert.equal(sameConnectionOwner(a,base+'?connectionOf='),false);
  assert.equal(sameConnectionOwner(a,base+'?connectionOf=owner&connectionOf=other'),false);
});
