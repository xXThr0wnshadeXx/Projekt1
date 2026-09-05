import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DiscoveryError,validateDiscoveryRequest,normalizeProfileUrl,publicUrl} from '../dist/packages/server/discovery/contracts.js';
import {PublicHttpClient,isPublicAddress,abortable} from '../dist/packages/server/discovery/providers/http.js';
import {WikimediaSearchProvider,BraveSearchProvider} from '../dist/packages/server/discovery/providers/search.js';
import {PublicDocumentFetcher,normalizePublicContent,robotsAllowed,selectDocumentExcerpt} from '../dist/packages/server/discovery/document-fetch.js';
import {createDiscoverySources} from '../dist/packages/server/discovery/providers/service.js';

const agent='WarmPath/0.1 (https://example.org/project)',signal=()=>new AbortController().signal;
const encode=value=>new TextEncoder().encode(value);
const response=(body='',status=200,type='text/plain',headers={})=>({status,headers:{'content-type':type,...headers},body:encode(body)});
const json=value=>response(JSON.stringify(value),200,'application/json');
const fail=(promise,code)=>assert.rejects(promise,e=>e instanceof DiscoveryError && e.code===code);
const request={scopeId:'s0',expectedGraphVersion:'0',idempotencyKey:'k0',anchors:{linkedinUrl:'https://www.linkedin.com/in/u0/',instagramUrl:'https://www.instagram.com/u0/'},target:{organizationName:'o0'}};
function fixture(handler,resolve=async()=>[{address:'93.184.216.34',family:4}]) {
  const calls=[];
  const http=new PublicHttpClient(agent,{resolve,request:async input=>{calls.push(input);return handler(input,calls);}});
  return {http,calls};
}
const html='<html><head><title>Source &amp; title</title><meta property="article:published_time" content="2020-01-02"><meta property="og:site_name" content="Publisher"></head><body><p>u0 supervised u1.</p><script>not evidence</script><style>hidden</style><!-- comment --><p>Historical account.</p></body></html>';
function documents(handler) {return fixture(async input=>input.url.pathname==='/robots.txt'?response('User-agent: *\nAllow: /'):handler(input));}

test('strict discovery input normalizes profile anchors without inferring names',()=>{
  const r=validateDiscoveryRequest({...request,anchors:{linkedinUrl:'https://linkedin.com/in/u0?trk=x#ignored',instagramUrl:'https://instagram.com/U0/?igsh=x'}});
  assert.equal(r.anchors.linkedinUrl,request.anchors.linkedinUrl);assert.equal(r.anchors.instagramUrl,request.anchors.instagramUrl);
  assert.equal(r.target.personName,undefined);
  for(const value of [{...request,actorUserId:'other'},{...request,target:{}},{...request,selectedContextPersonIds:['p0','p0']},{...request,selectedContextPersonIds:['a','b','c','d','e']},{...request,target:{personName:'x'.repeat(201)}},{...request,anchors:{...request.anchors,rootPersonId:'other'}}])assert.throws(()=>validateDiscoveryRequest(value),e=>e.code==='INVALID_INPUT');
});
test('profile URL host/path allowlists reject spoofed hosts, traversal, credentials and private account routes',()=>{
  for(const u of ['https://linkedin.com.evil.org/in/u0','https://u:p@linkedin.com/in/u0','https://linkedin.com:444/in/u0','https://linkedin.com/company/o0','https://linkedin.com/in/u%2Fother','https://linkedin.com/in/%2e%2e','http://linkedin.com/in/u0','https://linkedin.com./in/u0','https://www.linkedin.com/in/u0/extra'])assert.throws(()=>normalizeProfileUrl(u,'linkedin'));
  for(const u of ['https://instagram.com/accounts','https://instagram.com/u0/followers','https://instagram.com/p/abc','https://instagram.com/..foo','https://instagram.com/foo..bar','https://evilinstagram.com/u0'])assert.throws(()=>normalizeProfileUrl(u,'instagram'));
  assert.equal(normalizeProfileUrl('https://www.linkedin.com/in/%E6%9D%8E/','linkedin'),'https://www.linkedin.com/in/%E6%9D%8E/');
  assert.throws(()=>publicUrl('https://example.org\\@127.0.0.1'));
});
test('public address classification blocks private, special and transition ranges in both families',()=>{
  for(const ip of ['0.0.0.0','10.1.1.1','100.64.0.1','127.0.0.1','169.254.169.254','172.20.0.1','192.168.1.1','192.0.0.8','192.0.2.1','198.18.1.1','198.51.100.1','203.0.113.1','224.1.1.1','255.255.255.255','::','::1','::ffff:127.0.0.1','fc00::1','fe80::1','ff02::1','64:ff9b::7f00:1','2002:7f00:1::','2001:db8::1','3fff::1','nonsense'])assert.equal(isPublicAddress(ip),false,ip);
  for(const ip of ['93.184.216.34','8.8.8.8','2606:4700:4700::1111','2001:4860:4860::8888'])assert.equal(isPublicAddress(ip),true,ip);
});
test('DNS checks every answer and hands a pinned validated address to request',async()=>{
  const mixed=fixture(()=>response('unexpected'),async()=>[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}]);
  await fail(mixed.http.get('https://example.org/',{signal:signal(),maxBytes:100}), 'ACCESS_DENIED');assert.equal(mixed.calls.length,0);
  let lookups=0;
  const f=fixture(input=>{assert.deepEqual(input.address,{address:'93.184.216.34',family:4});assert.equal(input.url.hostname,'example.org');assert.equal(input.headers.cookie,undefined);assert.equal(input.headers.authorization,undefined);return response('ok');},async()=>{lookups++;return [{address:lookups===1?'93.184.216.34':'127.0.0.1',family:4}];});
  await f.http.get('https://example.org/',{signal:signal(),maxBytes:100});assert.equal(lookups,1);
  await fail(f.http.get('https://example.org/again',{signal:signal(),maxBytes:100}),'ACCESS_DENIED');assert.equal(f.calls.length,1);
});
test('private/literal encoded hosts and extra credential headers cannot reach network',async()=>{
  const f=fixture(()=>response('unexpected'));
  for(const url of ['https://localhost/','https://service.internal/','https://127.1/','https://2130706433/','https://0x7f000001/','https://[::ffff:127.0.0.1]/'])await fail(f.http.get(url,{signal:signal(),maxBytes:100}),'ACCESS_DENIED');
  await fail(f.http.get('https://example.org/',{signal:signal(),maxBytes:100,headers:{cookie:'private'}}),'ACCESS_DENIED');
  await fail(f.http.get('https://example.org/',{signal:signal(),maxBytes:100,headers:{'x-subscription-token':'fixture'}}),'ACCESS_DENIED');
  assert.equal(f.calls.length,0);
});
test('transport byte, compression, abort and generic error boundaries are enforced',async()=>{
  await fail(fixture(()=>response('x'.repeat(101))).http.get('https://example.org/',{signal:signal(),maxBytes:100}),'LIMIT_EXCEEDED');
  await fail(fixture(()=>response('x',200,'text/plain',{'content-encoding':'gzip'})).http.get('https://example.org/',{signal:signal(),maxBytes:100}),'UNSUPPORTED_CONTENT');
  const c=new AbortController(),pending=fixture(()=>new Promise(()=>{}));
  const work=pending.http.get('https://example.org/',{signal:c.signal,maxBytes:100});c.abort();await fail(work,'CANCELLED');
  const leaked=fixture(()=>{throw new Error('secret-query-cookie');});
  await assert.rejects(leaked.http.get('https://example.org/',{signal:signal(),maxBytes:100}),e=>e.code==='SOURCE_UNAVAILABLE'&&!e.message.includes('secret'));
  const dns=new AbortController();const stalled=fixture(()=>response(),()=>new Promise(()=>{}));const resolving=stalled.http.get('https://example.org/',{signal:dns.signal,maxBytes:100});dns.abort();await fail(resolving,'CANCELLED');
});
test('Wikimedia uses fixed endpoint, bounded parameters, caches hints and strips snippet markup',async()=>{
  const f=fixture(input=>{assert.equal(input.url.origin,'https://en.wikipedia.org');assert.equal(input.url.pathname,'/w/api.php');assert.equal(input.url.searchParams.get('srlimit'),'5');assert.equal(input.headers['x-subscription-token'],undefined);return json({query:{search:[{pageid:12,title:'u0',snippet:'<span>candidate</span>'}]}});});
  const p=new WikimediaSearchProvider(f.http),hits=await p.search('neutral0',signal());
  assert.deepEqual(hits,[{url:'https://en.wikipedia.org/?curid=12',title:'u0',snippet:'candidate',provider:'WIKIMEDIA',evidenceStatus:'DISCOVERY_HINT'}]);
  hits[0].title='changed';assert.equal((await p.search('neutral0',signal()))[0].title,'u0');assert.equal(f.calls.length,1);
  await fail(p.search('x'.repeat(601),signal()),'INVALID_INPUT');
});
test('Wikimedia serializes calls even when an intermediate queued caller cancels',async()=>{
  let active=0,max=0,release;const wait=new Promise(done=>{release=done;});
  const f=fixture(async()=>{active++;max=Math.max(max,active);await wait;active--;return json({query:{search:[]}});});
  const p=new WikimediaSearchProvider(f.http),first=p.search('a',signal()),c=new AbortController();
  const second=p.search('b',c.signal),third=p.search('c',signal());c.abort();await fail(second,'CANCELLED');release();await Promise.all([first,third]);assert.equal(max,1);
});
test('providers distinguish missing config, denied access, malformed response and no results',async()=>{
  const f=fixture(()=>json({query:{search:[]}}));assert.deepEqual(await new WikimediaSearchProvider(f.http).search('q',signal()),[]);
  await fail(new BraveSearchProvider(f.http).search('q',signal()),'NOT_CONFIGURED');assert.equal(f.calls.length,1);
  for(const code of [401,403,429,451])await fail(new WikimediaSearchProvider(fixture(()=>response('private',code)).http).search('q',signal()),'ACCESS_DENIED');
  await fail(new WikimediaSearchProvider(fixture(()=>json({query:{search:'bad'}})).http).search('q',signal()),'SOURCE_UNAVAILABLE');
  await fail(new WikimediaSearchProvider(fixture(()=>json({error:{code:'maxlag'}})).http).search('q',signal()),'SOURCE_UNAVAILABLE');
});
test('Brave sends injected key only to fixed provider and never follows provider redirects',async()=>{
  const f=fixture(input=>{assert.equal(input.url.origin,'https://api.search.brave.com');assert.equal(input.url.pathname,'/res/v1/web/search');assert.equal(input.headers['x-subscription-token'],'test-only');assert.equal(input.url.searchParams.get('count'),'5');assert.ok(!input.url.href.includes('test-only'));return json({web:{results:[{url:'https://example.org/article',title:'title',description:'hint'}]}});});
  assert.equal((await new BraveSearchProvider(f.http,'test-only').search('q',signal()))[0].evidenceStatus,'DISCOVERY_HINT');
  const redirect=fixture(()=>response('',302,'text/plain',{location:'https://other.org/steal'}));await fail(new BraveSearchProvider(redirect.http,'test-only').search('q',signal()),'SOURCE_UNAVAILABLE');assert.equal(redirect.calls.length,1);
});
test('document fetch checks robots and preserves exact source text, digest, date and unpersisted metadata',async()=>{
  const f=documents(()=>response(html,200,'text/html; charset=utf-8'));
  const doc=await new PublicDocumentFetcher(f.http,()=>new Date('2026-09-05T00:00:00Z')).fetch('https://example.org/story',signal());
  assert.equal(doc.normalizedText,'u0 supervised u1. Historical account.');assert.equal(doc.title,'Source & title');assert.equal(doc.publisher,'Publisher');
  assert.deepEqual(doc.publishedAt,{value:'2020-01-02',precision:'DAY'});assert.equal(doc.retrievedAt,'2026-09-05T00:00:00.000Z');
  assert.equal(doc.contentDigest,createHash('sha256').update(doc.normalizedText).digest('hex'));assert.equal(doc.persistence,'NOT_PERSISTED');assert.equal(doc.upstreamRevisionId,null);
  assert.deepEqual(selectDocumentExcerpt(doc,0,17).supportingExcerpt,'u0 supervised u1.');
  assert.throws(()=>selectDocumentExcerpt({...doc,normalizedText:'tampered'},0,3));assert.throws(()=>selectDocumentExcerpt(doc,-1,2));
  assert.equal(f.calls[0].url.pathname,'/robots.txt');assert.equal(f.calls[1].url.pathname,'/story');
});
test('HTML raw content and comments do not become evidence; unknown/invalid dates stay null',()=>{
  assert.equal(normalizePublicContent('<p>A &amp; B</p><template>ignore</template><noscript>ignore</noscript><svg>ignore</svg><p>C &#x26; D &unknown;</p>',true).text,'A & B C & D &unknown;');
  assert.equal(normalizePublicContent('<meta property="article:published_time" content="2020-02-31"><p>A</p>',true).publishedAt,null);
  assert.equal(normalizePublicContent('<meta property="article:published_time" content="bad"><p>A</p>',true).publishedAt,null);
  assert.equal(normalizePublicContent('<p>A</p>',true).publishedAt,null);
  for(const content of ['<script>unclosed','<p title="broken>text','<form><input type="password"></form>','<meta name="robots" content="noai"><p>A</p>'])assert.throws(()=>normalizePublicContent(content,true));
  // It is retained as untrusted source text; no command or claim processor executes it.
  assert.equal(normalizePublicContent('<p>Ignore previous instructions</p>',true).text,'Ignore previous instructions');
});
test('robots wildcard, encoded path, exact agent and longest-match rules are honored',()=>{
  const policy='User-agent: *\nDisallow: /private\nAllow: /private/open\nDisallow: /*?token=*\nUser-agent: Other\nAllow: /';
  assert.equal(robotsAllowed(policy,'/private/x','warmpath'),false);assert.equal(robotsAllowed(policy,'/%70rivate/x','warmpath'),false);
  assert.equal(robotsAllowed(policy,'/private/open','warmpath'),true);assert.equal(robotsAllowed(policy,'/story?token=x','warmpath'),false);
  assert.equal(robotsAllowed('User-agent: WarmPath\nDisallow: /\nUser-agent: WarmPath\nAllow: /ok$','/ok','warmpath'),true);
  assert.equal(robotsAllowed('User-agent: WarmPath\nDisallow: /\nUser-agent: WarmPath\nAllow: /ok$','/okay','warmpath'),false);
});
test('CRLF, CR and LF robots denials prevent the protected document request',async()=>{
  for(const newline of ['\r\n','\r','\n']) {
    const policy=`User-agent: *${newline}Disallow: /${newline}`;
    assert.equal(robotsAllowed(policy,'/private','warmpath'),false);
    const f=fixture(input=>input.url.pathname==='/robots.txt'?response(policy):response('must not be fetched'));
    await fail(new PublicDocumentFetcher(f.http).fetch('https://example.org/private',signal()),'ACCESS_DENIED');
    assert.deepEqual(f.calls.map(call=>call.url.href),['https://example.org/robots.txt']);
  }
});
test('disallowed or unavailable robots prevent document reads; only missing404 policy allows read',async()=>{
  for(const robot of [response('User-agent: *\nDisallow: /'),response('',403),response('',429),response('',503),response('',302,'text/plain',{location:'https://other.org/robots.txt'}),response('<html>not robots</html>',200,'text/html')]){
    const f=fixture(()=>robot);await fail(new PublicDocumentFetcher(f.http).fetch('https://example.org/story',signal()),'ACCESS_DENIED');assert.equal(f.calls.length,1);
  }
  const f=fixture(input=>input.url.pathname==='/robots.txt'?response('',404):response('public'));assert.equal((await new PublicDocumentFetcher(f.http).fetch('https://example.org/story',signal())).normalizedText,'public');
});
test('redirect destination and its robots/DNS are checked, never leaking cookies or fetching private hosts',async()=>{
  const f=documents(input=>response('',302,'text/plain',{location:'https://127.0.0.1/private'}));
  await fail(new PublicDocumentFetcher(f.http).fetch('https://example.org/story',signal()),'ACCESS_DENIED');assert.equal(f.calls.length,2);
  const redirected=fixture(input=>input.url.pathname==='/robots.txt'?response('User-agent: *\nAllow: /'):input.url.hostname==='example.org'?response('',302,'text/plain',{location:'https://other.org/story'}):response('new'));
  const doc=await new PublicDocumentFetcher(redirected.http).fetch('https://example.org/story',signal());assert.equal(doc.sourceUrl,'https://example.org/story');assert.equal(doc.fetchedUrl,'https://other.org/story');
  assert.deepEqual(redirected.calls.map(c=>c.url.href),['https://example.org/robots.txt','https://example.org/story','https://other.org/robots.txt','https://other.org/story']);
  assert.ok(redirected.calls.every(c=>!c.headers.cookie&&!c.headers.authorization&&!c.headers['x-subscription-token']));
});
test('document denies login/list endpoints, HTTP downgrade, redirect loops, compressed and unsupported pages',async()=>{
  const empty=fixture(()=>response('unexpected'));for(const p of ['/login','/u0/followers','/u0/following','/accounts/login'])await fail(new PublicDocumentFetcher(empty.http).fetch(`https://example.org${p}`,signal()),'ACCESS_DENIED');assert.equal(empty.calls.length,0);
  await fail(new PublicDocumentFetcher(documents(()=>response('',302,'text/plain',{location:'http://example.org/other'})).http).fetch('https://example.org/story',signal()),'INVALID_INPUT');
  await fail(new PublicDocumentFetcher(documents(()=>response('',302,'text/plain',{location:'/again'})).http).fetch('https://example.org/story',signal()),'ACCESS_DENIED');
  for(const type of ['application/pdf','application/json','text/html; charset=iso-8859-1'])await fail(new PublicDocumentFetcher(documents(()=>response('body',200,type)).http).fetch('https://example.org/story',signal()),'UNSUPPORTED_CONTENT');
  for(const code of [401,403,429,451])await fail(new PublicDocumentFetcher(documents(()=>response('denied',code)).http).fetch('https://example.org/story',signal()),'ACCESS_DENIED');
});
test('document revision changes when source metadata changes even with identical text',async()=>{
  let date='2020-01-02';const f=documents(()=>response(`<meta property="article:published_time" content="${date}"><p>unchanged</p>`,200,'text/html'));
  const fetcher=new PublicDocumentFetcher(f.http),a=await fetcher.fetch('https://example.org/story',signal());date='2021-01-02';const b=await fetcher.fetch('https://example.org/story',signal());assert.equal(a.contentDigest,b.contentDigest);assert.notEqual(a.revision,b.revision);
});
function serviceFixture(overrides={}) {
  const queries=[],pages=[];
  const provider={kind:'WIKIMEDIA',configured:true,search:async q=>{queries.push(q);return [{url:'https://example.org/story',title:'hint',snippet:'not evidence',provider:'WIKIMEDIA',evidenceStatus:'DISCOVERY_HINT'}];}};
  const docs={fetch:async url=>{pages.push(url);return {id:'doc0',normalizedText:'source'};}};
  return {queries,pages,service:createDiscoverySources({provider,documents:docs,authorize:async()=>({scopeId:'s0',graphVersion:'0',selectedContexts:[]}),...overrides})};
}
test('source service authenticates/authorizes before search and blocks foreign context/version',async()=>{
  for(const authority of [{scopeId:'other',graphVersion:'0',selectedContexts:[]},{scopeId:'s0',graphVersion:'0',selectedContexts:[{personId:'foreign',publicTerms:['secret']}]}]){
    const f=serviceFixture({authorize:async()=>authority});await fail(f.service.discover('credential',request),'FORBIDDEN');assert.equal(f.queries.length,0);assert.equal(f.pages.length,0);
  }
  const stale=serviceFixture({authorize:async()=>({scopeId:'s0',graphVersion:'1',selectedContexts:[]})});await fail(stale.service.discover('credential',request),'VERSION_CONFLICT');assert.equal(stale.queries.length,0);
  const denied=serviceFixture({authorize:async()=>{throw new DiscoveryError('FORBIDDEN');}});await fail(denied.service.discover(null,request),'FORBIDDEN');assert.equal(denied.queries.length,0);
});
test('source service retains self-asserted URLs, visible limits and empty proposals without extractor',async()=>{
  const f=serviceFixture(),out=await f.service.discover('credential',request);
  assert.equal(out.anchors.identityState,'OWNER_ASSERTED_ANCHOR');assert.deepEqual(out.result.proposalRefs,[]);assert.equal(out.result.status,'INSUFFICIENT_PUBLIC_EVIDENCE');
  assert.equal(out.extraction,'NOT_IMPLEMENTED');assert.equal(out.persistence,'NOT_IMPLEMENTED');assert.equal(out.result.capabilities.coverage,'WIKIMEDIA_ONLY');assert.equal(out.result.capabilities.generalWeb,'NOT_CONFIGURED');
  assert.ok(f.queries[0].includes(request.anchors.linkedinUrl));assert.ok(!f.queries.includes('u0'));assert.equal(f.pages.length,1);assert.ok(out.result.warnings.some(w=>w.includes('Claim extraction')));
});
test('source budgets bound queries/pages, duplicate hits and selected public context',async()=>{
  let queried=0,fetched=0;const provider={kind:'BRAVE',configured:true,search:async()=>{queried++;return Array.from({length:5},(_,i)=>({url:`https://example.org/${queried}-${i}`,title:'h',snippet:'hint',provider:'BRAVE',evidenceStatus:'DISCOVERY_HINT'}));}};
  const f=serviceFixture({provider,documents:{fetch:async()=>{fetched++;throw new DiscoveryError('ACCESS_DENIED');}},authorize:async()=>({scopeId:'s0',graphVersion:'0',selectedContexts:[{personId:'p0',publicTerms:['public0']},{personId:'p1',publicTerms:['public1']}]})});
  const out=await f.service.discover('credential',{...request,selectedContextPersonIds:['p0','p1']});assert.equal(queried,4);assert.equal(fetched,5);assert.equal(out.hits.length,8);assert.equal(out.result.budget.exhausted,true);assert.equal(out.result.capabilities.coverage,'GENERAL_PUBLIC_WEB');
});
test('no silent fallback on unconfigured/denied general web and no invented unavailable source proof',async()=>{
  const provider={kind:'BRAVE',configured:false,search:async()=>{throw new Error('should not run');}};
  const out=await serviceFixture({provider}).service.discover('credential',request);assert.equal(out.result.status,'SOURCE_UNAVAILABLE');assert.equal(out.result.capabilities.generalWeb,'NOT_CONFIGURED');assert.equal(out.result.budget.queriesUsed,0);assert.deepEqual(out.result.proposalRefs,[]);
  let calls=0;const denied=serviceFixture({provider:{kind:'BRAVE',configured:true,search:async()=>{calls++;throw new DiscoveryError('ACCESS_DENIED');}}});const result=await denied.service.discover('credential',request);assert.equal(calls,1);assert.equal(result.result.capabilities.generalWeb,'UNAVAILABLE');
});
test('source service respects caller cancellation even when injected authorization ignores signal',async()=>{
  const c=new AbortController(),f=serviceFixture({authorize:()=>new Promise(()=>{})});const work=f.service.discover('credential',request,c.signal);c.abort();await fail(work,'CANCELLED');assert.equal(f.queries.length,0);
});
test('decoded private-list paths and credential-bearing URLs fail before retrieval',async()=>{
  const f=fixture(()=>response('unexpected'));
  await fail(new PublicDocumentFetcher(f.http).fetch('https://example.org/u0/%66ollowers',signal()),'ACCESS_DENIED');
  for(const url of ['https://www.instagram.com/api/v1/friendships/','https://www.linkedin.com/voyager/api/','https://example.org/story?access_token=not-public'])await fail(new PublicDocumentFetcher(f.http).fetch(url,signal()),'INVALID_INPUT');
  assert.equal(f.calls.length,0);
  assert.equal(normalizeProfileUrl('https://uk.linkedin.com/in/u0/','linkedin'),request.anchors.linkedinUrl);
});
test('invalid calendar timestamps are not promoted into publication dates',()=>{
  for(const date of ['2020-02-31T12:00:00Z','2020-01-01T24:00:00Z','2020-13-01','2020-01-01T12:61:00Z'])assert.equal(normalizePublicContent(`<meta property="article:published_time" content="${date}"><p>A</p>`,true).publishedAt,null);
  assert.deepEqual(normalizePublicContent('<meta property="article:published_time" content="2020-01-01T12:00:00+02:00"><p>A</p>',true).publishedAt,{value:'2020-01-01T10:00:00.000Z',precision:'SECOND'});
});
test('source service rechecks session and graph authority after collection',async()=>{
  let calls=0;const revoked=serviceFixture({authorize:async()=>{if(++calls>1)throw new DiscoveryError('FORBIDDEN');return {scopeId:'s0',graphVersion:'0',selectedContexts:[]};}});
  await fail(revoked.service.discover('credential',request),'FORBIDDEN');assert.ok(revoked.queries.length>0);
  calls=0;const changed=serviceFixture({authorize:async()=>({scopeId:'s0',graphVersion:String(calls++),selectedContexts:[]})});await fail(changed.service.discover('credential',request),'VERSION_CONFLICT');
});
