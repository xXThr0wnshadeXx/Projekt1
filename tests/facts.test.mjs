import assert from 'node:assert/strict';
import {test} from 'node:test';
import {projectConfirmedRelationships, affiliationKey} from '../dist/packages/server/facts/projection.js';
import {FactReviewService} from '../dist/packages/server/facts/service.js';

test('fact projection requires explicit search inclusion, preserves direction and never traverses observations', () => {
  const relationship = {id:'r1',fromPersonId:'p1',toPersonId:'p2',state:'CONFIRMED',kind:'FRIEND',strength:0.5,confidence:1,recencyFactor:1,evidenceIds:['e2','e1'],observedLinkIds:[]};
  const graph = {relationships:[relationship],sources:[{id:'s1'}],evidence:[{id:'e1',sourceId:'s1',claimKind:'RELATIONSHIP'},{id:'e2',sourceId:'s1',claimKind:'RELATIONSHIP'}],observedLinks:[{fromPersonId:'p2',toPersonId:'p1',kind:'CONTACT_SAVED'}]};
  assert.deepEqual(projectConfirmedRelationships(graph,new Set()),[]);
  const edges=projectConfirmedRelationships(graph,new Set(['r1']));
  assert.equal(edges.length,1); assert.equal(edges[0].fromPersonId,'p1'); assert.equal(edges[0].toPersonId,'p2');
  assert.deepEqual(edges[0].evidenceIds,['e1','e2']);
  assert.deepEqual(projectConfirmedRelationships({...graph,evidence:[...graph.evidence].reverse()},new Set(['r1'])),edges);
  for (const patch of [{state:'PENDING'},{state:'REJECTED'},{kind:'UNKNOWN'},{strength:0},{confidence:0},{recencyFactor:0},{evidenceIds:['foreign']}]) {
    assert.deepEqual(projectConfirmedRelationships({...graph,relationships:[{...relationship,...patch}]},new Set(['r1'])),[]);
  }
  assert.deepEqual(projectConfirmedRelationships({...graph,evidence:[{id:'e1',claimKind:'IDENTITY'},{id:'e2',claimKind:'RELATIONSHIP'}]},new Set(['r1'])),[]);
  assert.deepEqual(projectConfirmedRelationships({...graph,sources:[]},new Set(['r1'])),[]);
});

test('affiliation keys bind exact content and person, independent of object key order', () => {
  const affiliation={organizationId:'o1',current:null,support:{value:true,state:'PENDING',confidence:1,evidenceIds:['e1']}};
  assert.equal(affiliationKey('p1',affiliation),affiliationKey('p1',{support:affiliation.support,current:null,organizationId:'o1'}));
  assert.notEqual(affiliationKey('p1',affiliation),affiliationKey('p2',affiliation));
  assert.notEqual(affiliationKey('p1',affiliation),affiliationKey('p1',{...affiliation,current:true}));
});

test('fact facade resolves actor from session and rejects client authority fields', async () => {
  let calls=0;
  const credential='s'.repeat(43);
  const service=new FactReviewService({auth:{resolveSession:async value=>value===credential?{userId:'u1'}:null},facts:{review:async (actor,request)=>{calls++;assert.equal(actor.userId,'u1');assert.match(actor.sessionHash,/^[a-f0-9]{64}$/);assert.deepEqual(request,{scopeId:'s1'});return {};}}});
  await assert.rejects(()=>service.review(null,{scopeId:'s1'}),{code:'UNAUTHENTICATED'});
  await assert.rejects(()=>service.review(credential,{scopeId:'s1',actorUserId:'u2'}));
  assert.equal(calls,0); await service.review(credential,{scopeId:'s1'}); assert.equal(calls,1);
});
