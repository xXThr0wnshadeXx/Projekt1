import test from 'node:test';import assert from 'node:assert/strict';
import {publicDiscoveryContext} from '../dist/packages/server/discovery/receipts.js';
import {discoveryServiceError} from '../dist/packages/server/discovery/composition.js';
import {DiscoveryError} from '../dist/packages/server/discovery/contracts.js';import {graph} from './fixtures.mjs';
test('only selected source-backed public identity terms enter discovery queries',()=>{
 const g=graph(),request={selectedContextPersonIds:['p1']};g.people[1].displayName='PRIVATE_CONTACT';
 const source={id:'public',policy_version:'public-citation-review-v1',summary:{provider:'PUBLIC_ARTICLE',origin:'PUBLIC_SOURCE'}};
 g.identities.push({personId:'p1',assignmentState:'CONFIRMED',sourceId:'public',displayName:'Public Mention',evidenceIds:['public-evidence']});
 g.evidence.push({id:'public-evidence',sourceId:'public',claimKind:'IDENTITY'});
 assert.deepEqual(publicDiscoveryContext(g,request,[source]).selectedContexts,[{personId:'p1',publicTerms:['Public Mention']}]);
 assert.throws(()=>publicDiscoveryContext(g,request,[{...source,policy_version:'private-v1'}]));
 assert.deepEqual(publicDiscoveryContext(g,{},[]).selectedContexts,[]);
});
test('discovery error mapping uses fixed safe statuses without raw exception details',()=>{
 for(const [code,status] of [['INVALID_INPUT',400],['FORBIDDEN',403],['VERSION_CONFLICT',409],['NOT_CONFIGURED',502],['ACCESS_DENIED',502],['CANCELLED',502]])assert.equal(discoveryServiceError(new DiscoveryError(code)).status,status);
 const error=discoveryServiceError(new Error('private key content'));assert.equal(error.code,'INTERNAL');assert.ok(!error.message.includes('private key'));
});
