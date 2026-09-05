import test from 'node:test';import assert from 'node:assert/strict';
import {source} from '../dist/contracts/schema.js';import {validateGraphSnapshot} from '../dist/contracts/validation.js';
import {graph,authority,time} from './fixtures.mjs';
test('PUBLIC_ARTICLE remains distinct from PUBLIC_PROFILE in source and graph validation',()=>{
 for(const provider of ['PUBLIC_ARTICLE','PUBLIC_PROFILE']){
  const summary={id:'s1',provider,label:'Source',origin:'PUBLIC_SOURCE',importedAt:time};
  assert.doesNotThrow(()=>source(summary,'$'));const snapshot=graph();snapshot.sources=[summary];
  assert.equal(validateGraphSnapshot(snapshot,authority).sources[0].provider,provider);
 }
});
test('source validation continues to reject unknown providers and invalid source fields',()=>{
 const summary={id:'s1',provider:'PUBLIC_ARTICLE',label:'Source',origin:'PUBLIC_SOURCE',importedAt:time};
 for(const change of [{provider:'ARTICLE'},{provider:'public_article'},{provider:'UNKNOWN'},{origin:'SCRAPED'},{importedAt:'not-a-date'},{accessToken:'forbidden'}])assert.throws(()=>source({...summary,...change},'$'));
});
