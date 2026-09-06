import test from 'node:test';
import assert from 'node:assert/strict';
import {profileURL,listURL,sameList,sameConnectionOwner,newState,addPerson,addEdge,ingestPage,route,routes,exportGraph,importGraph,csv} from '../src/core.js';
import {coverageRecords,mergeAccountGraphs} from '../src/library.js';
const root='https://www.linkedin.com/in/test-root/';
const list='https://www.linkedin.com/search/results/people/?connectionOf=%5B%22owner%22%5D&network=%5B%22F%22%2C%22S%22%5D';
test('only canonical LinkedIn person URLs are accepted',()=>{assert.equal(profileURL('https://linkedin.com/in/some-person/?trk=test'), 'https://www.linkedin.com/in/some-person/');for(const u of ['https://linkedin.com.evil.test/in/a/','https://www.linkedin.com@evil.test/in/a/','javascript:alert(1)','https://user:pass@www.linkedin.com/in/a/','https://www.linkedin.com/company/acme/','http://www.linkedin.com/in/a/'])assert.equal(profileURL(u),null);});
test('list identity requires the same owner and network filter',()=>{assert.ok(listURL(list));assert.ok(sameList(list,list+'&page=2'));assert.ok(!sameList(list,list.replace('owner','another')));assert.ok(!sameList(list,list.replace('network=','other=')));assert.equal(listURL('https://example.com/search/results/people/?connectionOf=x'),null);});
test('deduplicate by URL, preserve multiple sources, and compute a path',()=>{const s=newState(root),a=addPerson(s,{url:'https://www.linkedin.com/in/a/',name:'A'},1),b=addPerson(s,{url:'https://www.linkedin.com/in/b/',name:'B'},2);addPerson(s,{url:a+'?tracking=1',name:'A'},1);addEdge(s,root,a,list);addEdge(s,a,b,list);addEdge(s,b,a,list+'&page=2');assert.equal(Object.keys(s.nodes).length,3);assert.equal(Object.keys(s.edges).length,2);assert.equal(Object.values(s.edges).find(e=>e.evidence.length===2).evidence.length,2);assert.deepEqual(route(s,b),[root,a,b]);assert.deepEqual(s.queue.map(j=>j.owner),[root,a]);});
test('shared account maps add only connected people and merge duplicate relationship evidence',()=>{const local=newState(root),a=addPerson(local,{url:'https://www.linkedin.com/in/a/',name:'A'},1);addEdge(local,root,a,list);local.revision=4;const b='https://www.linkedin.com/in/b/',stray='https://www.linkedin.com/in/stray/',sharedCoverage={personId:a,kind:'connections',status:'exhausted',checkedAt:'2026-09-06T00:00:00Z'},shared={root,nodes:{[root]:local.nodes[root],[a]:local.nodes[a],[b]:{id:b,url:b,name:'B'},[stray]:{id:stray,url:stray,name:'Stray'}},edges:{[`${a}|${b}`]:{id:`${a}|${b}`,source:a,target:b,evidence:[{url:list+'&page=2'}]}},branches:{[a]:{status:'shared',shared:true}},coverage:[sharedCoverage],graphRevision:'remote-1',updatedAt:'2026-09-06T00:00:00Z'};const merged=mergeAccountGraphs(local,shared,6);assert.deepEqual(Object.keys(merged.nodes).sort(),[root,a,b].sort());assert.equal(merged.nodes[b].depth,2);assert.equal(Object.keys(merged.edges).length,2);assert.equal(Object.values(merged.edges).find(edge=>edge.source===root||edge.target===root).evidence.length,1);assert.equal(merged.branches[a].status,'shared');assert.deepEqual(merged.coverage,[sharedCoverage]);});
test('coverage uploads completed local work but never attributes shared-only hints',()=>{const checkedAt='2026-09-06T12:00:00Z',s=newState(root);s.profileChecks={[root]:{checkedAt},['https://www.linkedin.com/in/shared-only/']:{checkedAt,shared:true}};s.branches[root]={status:'exhausted',checkedAt,pages:3,profiles:['a','b']};s.branches['https://www.linkedin.com/in/filtered/']={status:'exhausted',checkedAt,filterChanged:true};s.commentCoverage={[root]:{status:'incomplete',checkedAt,posts:['p'],profiles:[],comments:2}};s.nodes['https://www.linkedin.com/in/shared-only/']={id:'https://www.linkedin.com/in/shared-only/',sharedOnly:true};const records=coverageRecords(s);assert.deepEqual(records.map(item=>`${item.kind}:${item.personId}`).sort(),[`comments:${root}`,`connections:${root}`,'connections:https://www.linkedin.com/in/filtered/',`profile:${root}`].sort());assert.equal(records.find(item=>item.personId.includes('filtered')).details.filterChanged,true);});
test('alternate routes expose secondary introductions in shortest-first order',()=>{const s=newState(root),a=addPerson(s,{url:'https://www.linkedin.com/in/a/',name:'A'},1),b=addPerson(s,{url:'https://www.linkedin.com/in/b/',name:'B'},1),target=addPerson(s,{url:'https://www.linkedin.com/in/target/',name:'Target'},2);for(const [from,to] of [[root,a],[root,b],[a,target],[b,target]])addEdge(s,from,to,list);const found=routes(s,target);assert.equal(found.length,2);assert.deepEqual(found[0],[root,a,target]);assert.deepEqual(found[1],[root,b,target]);});
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

test('visible comments create equal-weight undirected paths and keep source direction',async()=>{
  const {ingestComments,relationshipTypes,addEdge}=await import('../src/core.js');
  const root='https://www.linkedin.com/in/author/',other='https://www.linkedin.com/in/commenter/';
  const s=newState(root,{depth:2}),job={kind:'posts',owner:root,depth:0,url:root+'recent-activity/all/'};
  const c={commenter:{url:other,name:'Someone outside my LinkedIn connections'},author:root,post:'https://www.linkedin.com/feed/update/urn:li:activity:123/',commentId:'urn:li:comment:(activity:123,456)',observedAt:'2026-09-06T12:00:00Z'};
  assert.equal(ingestComments(s,job,[c]).added,1);assert.deepEqual(route(s,other),[root,other]);
  assert.equal(ingestComments(s,job,[c]).observations,0);assert.equal(Object.keys(s.edges).length,1);
  const edge=Object.values(s.edges)[0];assert.equal(edge.evidence[0].commenter,other);assert.equal(edge.evidence[0].author,root);
  addEdge(s,root,other,'https://www.linkedin.com/mynetwork/invite-connect/connections/');
  assert.equal(Object.keys(s.edges).length,1);assert.deepEqual(new Set(relationshipTypes(edge)),new Set(['comment_interaction','visible_connection_list']));
  const restored=importGraph(exportGraph(s));assert.deepEqual(route(restored,other),[root,other]);assert.equal(Object.values(restored.edges)[0].evidence[0].commentId,c.commentId);
});

test('comment evidence rejects mismatched endpoints, parent posts and foreign origins',async()=>{
  const {normalizeEvidence}=await import('../src/core.js');
  const a='https://www.linkedin.com/in/a/',b='https://www.linkedin.com/in/b/';
  const e={type:'comment_interaction',commenter:a,author:b,post:'https://www.linkedin.com/feed/update/urn:li:activity:123/',commentId:'urn:li:comment:(activity:123,456)',observedAt:'2026-09-06T12:00:00Z'};
  assert.ok(normalizeEvidence(e,a,b));assert.ok(normalizeEvidence(e,b,a));
  assert.equal(normalizeEvidence({...e,author:a},a,b),null);
  assert.equal(normalizeEvidence({...e,commentId:'urn:li:comment:(activity:999,456)'},a,b),null);
  assert.equal(normalizeEvidence({...e,post:'https://evil.example/feed/update/urn:li:activity:123/'},a,b),null);
});

test('account graph refreshes only for graph changes, not collection pacing updates',()=>{
 const local=newState(root),a=addPerson(local,{url:'https://www.linkedin.com/in/revision-a/',name:'A'},1);addEdge(local,root,a,list);
 const shared={root,nodes:{},edges:{},graphRevision:'shared-1'};
 const initial=mergeAccountGraphs(local,shared).graphRevision;
 local.revision=99;local.reason='Waiting before the next action';assert.equal(mergeAccountGraphs(local,shared).graphRevision,initial);
 addPerson(local,{url:a,location:'Boston'},1);const updated=mergeAccountGraphs(local,shared).graphRevision;assert.notEqual(updated,initial);
 assert.notEqual(mergeAccountGraphs(local,shared,1).graphRevision,updated);
 assert.notEqual(mergeAccountGraphs(local,{...shared,graphRevision:'shared-2'}).graphRevision,updated);
});
