import test from 'node:test';
import assert from 'node:assert/strict';
import {DiscoveryError} from '../dist/packages/server/discovery/contracts.js';
import {PublicHttpClient} from '../dist/packages/server/discovery/providers/http.js';
import {TavilySearchProvider} from '../dist/packages/server/discovery/providers/search.js';
import {createDiscoverySources} from '../dist/packages/server/discovery/providers/service.js';

const signal=()=>new AbortController().signal;
const response=(value,status=200,headers={})=>({status,headers:{'content-type':'application/json',...headers},body:new TextEncoder().encode(JSON.stringify(value))});
const fail=(promise,code)=>assert.rejects(promise,e=>e instanceof DiscoveryError&&e.code===code&&!e.message.includes('fixture-key'));
function fixture(handler,resolve=async()=>[{address:'93.184.216.34',family:4}]) {
  const calls=[];
  return {calls,http:new PublicHttpClient('WarmPath/0.1 (https://example.org/project)',{resolve,request:async input=>{calls.push(input);return handler(input);}})};
}
test('Tavily pins its fixed POST endpoint and explicitly requests basic hints only',async()=>{
  const f=fixture(input=>{
    assert.equal(input.url.href,'https://api.tavily.com/search');assert.equal(input.method,'POST');
    assert.deepEqual(input.address,{address:'93.184.216.34',family:4});
    assert.equal(input.headers.authorization,'Bearer fixture-key');assert.equal(input.headers['content-type'],'application/json');
    assert.equal(input.headers['content-length'],String(Buffer.byteLength(input.body)));assert.equal(input.headers.cookie,undefined);
    assert.equal(input.maxBytes,512*1024);assert.ok(!input.body.includes('fixture-key'));
    assert.deepEqual(JSON.parse(input.body),{query:'neutral café',search_depth:'basic',topic:'general',max_results:5,include_answer:false,include_raw_content:false,include_images:false,auto_parameters:false});
    return response({results:[{url:'https://example.org/article',title:'Source',content:'<b>Discovery</b> hint',score:0.99,raw_content:'Never evidence'}],answer:'Never a claim',images:['ignored']});
  });
  assert.deepEqual(await new TavilySearchProvider(f.http,'fixture-key').search('neutral café',signal()),[{url:'https://example.org/article',title:'Source',snippet:'Discovery hint',provider:'TAVILY',evidenceStatus:'DISCOVERY_HINT'}]);
  assert.equal(f.calls.length,1);
});
test('missing/invalid Tavily key and invalid query do not make network requests',async()=>{
  const f=fixture(()=>response({results:[]})),missing=new TavilySearchProvider(f.http);
  assert.equal(missing.configured,false);await fail(missing.search('q',signal()),'NOT_CONFIGURED');
  for(const key of ['', 'a b', 'a\nb', 'x'.repeat(4097)])assert.throws(()=>new TavilySearchProvider(f.http,key),e=>e.code==='INVALID_INPUT');
  for(const query of ['', 'x'.repeat(601), 'q\nsecret'])await fail(new TavilySearchProvider(f.http,'fixture-key').search(query,signal()),'INVALID_INPUT');
  assert.equal(f.calls.length,0);
});
test('Tavily result count and hint text are bounded and unsafe URLs are skipped',async()=>{
  const rows=Array.from({length:8},(_,i)=>({url:`https://example.org/${i}`,title:'t',content:'h'.repeat(2000)}));
  const hits=await new TavilySearchProvider(fixture(()=>response({results:rows})).http,'fixture-key').search('q',signal());
  assert.equal(hits.length,5);assert.ok(hits.every(h=>h.snippet.length===1200));
  const f=fixture(()=>response({results:[{url:'http://example.org',title:'bad'},{url:'https://example.org/?api_key=private',title:'bad'},{url:'https://example.org/good',title:'good'}]}));
  assert.deepEqual((await new TavilySearchProvider(f.http,'fixture-key').search('q',signal())).map(h=>h.url),['https://example.org/good']);
  assert.deepEqual(await new TavilySearchProvider(fixture(()=>response({results:[]})).http,'fixture-key').search('q',signal()),[]);
});
test('Tavily malformed responses and oversized payloads fail closed',async()=>{
  for(const value of [{results:{}},{results:Array(21).fill({})},{error:'fixture-key',results:[]},{results:[{url:'https://example.org',title:42}]},{results:[{url:'https://example.org',title:'t',content:'x'.repeat(10001)}]}])await fail(new TavilySearchProvider(fixture(()=>response(value)).http,'fixture-key').search('q',signal()),'SOURCE_UNAVAILABLE');
  await fail(new TavilySearchProvider(fixture(()=>response({padding:'x'.repeat(512*1024)})).http,'fixture-key').search('q',signal()),'LIMIT_EXCEEDED');
  const f=fixture(()=>response({results:[]}));await fail(f.http.postTavilySearch({query:'x'.repeat(8193)},'fixture-key',signal()),'LIMIT_EXCEEDED');assert.equal(f.calls.length,0);
});
test('Tavily sanitizes auth/quota errors and never forwards Bearer tokens through redirects',async()=>{
  for(const [status,code] of [[401,'ACCESS_DENIED'],[429,'ACCESS_DENIED'],[432,'LIMIT_EXCEEDED'],[433,'LIMIT_EXCEEDED'],[302,'SOURCE_UNAVAILABLE'],[307,'SOURCE_UNAVAILABLE']]){
    const f=fixture(()=>response({error:'fixture-key'},status,{location:'https://other.org/steal'}));
    await fail(new TavilySearchProvider(f.http,'fixture-key').search('q',signal()),code);assert.equal(f.calls.length,1);
  }
});
test('Tavily uses shared DNS, cancellation, encoding, and credential header restrictions',async()=>{
  const blocked=fixture(()=>response({results:[]}),async()=>[{address:'127.0.0.1',family:4}]);
  await fail(new TavilySearchProvider(blocked.http,'fixture-key').search('q',signal()),'ACCESS_DENIED');assert.equal(blocked.calls.length,0);
  const stalled=fixture(()=>new Promise(()=>{})),controller=new AbortController();
  const work=new TavilySearchProvider(stalled.http,'fixture-key').search('q',controller.signal);controller.abort();await fail(work,'CANCELLED');
  await fail(new TavilySearchProvider(fixture(()=>response({},200,{'content-encoding':'gzip'})).http,'fixture-key').search('q',signal()),'UNSUPPORTED_CONTENT');
  const f=fixture(()=>response({}));
  await fail(f.http.get('https://api.tavily.com/search',{signal:signal(),maxBytes:100,headers:{authorization:'Bearer fixture-key'}}),'ACCESS_DENIED');assert.equal(f.calls.length,0);
});
test('Tavily discovery reports capability truthfully and never creates proposals from hints',async()=>{
  const request={scopeId:'s0',expectedGraphVersion:'0',idempotencyKey:'k0',anchors:{linkedinUrl:'https://linkedin.com/in/u0',instagramUrl:'https://instagram.com/u0'},target:{organizationName:'o0'}};
  for(const configured of [true,false]){
    const f=fixture(()=>response({results:[]}));
    const service=createDiscoverySources({provider:new TavilySearchProvider(f.http,configured?'fixture-key':undefined),documents:{fetch:async()=>assert.fail('No documents expected')},authorize:async()=>({scopeId:'s0',graphVersion:'0',selectedContexts:[]})});
    const out=await service.discover('credential',request);
    assert.deepEqual(out.result.capabilities,{wikimedia:'UNAVAILABLE',generalWeb:configured?'AVAILABLE':'NOT_CONFIGURED',coverage:'GENERAL_PUBLIC_WEB'});
    assert.equal(out.result.status,configured?'INSUFFICIENT_PUBLIC_EVIDENCE':'SOURCE_UNAVAILABLE');assert.deepEqual(out.result.proposalRefs,[]);
    assert.equal(out.extraction,'NOT_IMPLEMENTED');assert.equal(out.persistence,'NOT_IMPLEMENTED');
    assert.equal(f.calls.length,configured?3:0);
  }
});
