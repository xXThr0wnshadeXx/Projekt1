import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {inspectLinkedIn,advanceLinkedIn} from '../src/collector.js';
function page(html,url){const {document}=parseHTML(`<html><body>${html}</body></html>`);globalThis.document=document;globalThis.location=new URL(url);return inspectLinkedIn();}
const profile='https://www.linkedin.com/in/test-root/';
const list='https://www.linkedin.com/search/results/people/?connectionOf=%5B%22owner%22%5D&network=%5B%22F%22%2C%22S%22%5D';
test('profile chooses full connection list over mutual-only list',()=>{const s=page(`<main><h2>Test Person</h2><a href="${list}">229 connections</a><a href="${list}&mutual=1">Nicolas is a mutual connection</a></main>`,profile);assert.equal(s.kind,'profile');assert.equal(s.scope,'connections');assert.equal(s.listUrl,list);assert.equal(s.person.name,'Test Person');});
test('mutual-only and hidden profiles are distinguished',()=>{assert.equal(page(`<main><h1>Test</h1><a href="${list}">3 mutual connections</a></main>`,profile).scope,'mutuals_only');assert.equal(page('<main><h1>Test</h1></main>',profile).scope,'hidden');});
test('modern result cards exclude ads and nested mutual links',()=>{const s=page(`<main><section role="region" aria-label="Primary content"><a href="https://www.linkedin.com/in/one/"><p>One Person • 2nd</p><p>Engineer</p><p>London</p><p>Test is a mutual connection</p></a><a href="https://www.linkedin.com/in/test/">Test</a><a href="https://www.linkedin.com/in/one/">One Person</a><button aria-label="Next">Next</button></section><aside><a href="https://www.linkedin.com/in/ad/"><p>Ad • 2nd</p></a></aside></main>`,list);assert.equal(s.people.length,1);assert.equal(s.people[0].name,'One Person');assert.equal(s.people[0].headline,'Engineer');assert.equal(s.hasNext,true);});
test('own list supports growing scroll results and expected count',()=>{const s=page('<main><p>27 connections</p><a href="https://www.linkedin.com/in/one/"><p>One Person</p><p>Engineer</p></a></main>','https://www.linkedin.com/mynetwork/invite-connect/connections/');assert.equal(s.isOwn,true);assert.equal(s.expectedCount,27);assert.equal(s.people.length,1);});
test('legacy cards parse and disabled next is terminal',()=>{const s=page('<main><li class="reusable-search__result-container"><span class="entity-result__title-text"><a href="https://www.linkedin.com/in/legacy/"><span aria-hidden="true">Legacy Person</span></a></span><div class="entity-result__primary-subtitle">Engineer</div></li><button aria-label="Next" disabled>Next</button></main>',list);assert.equal(s.people[0].name,'Legacy Person');assert.equal(s.hasNext,false);});
test('empty loaded results differ from an unfinished render',()=>{assert.equal(page('<main>No results found</main>',list).kind,'list');assert.equal(page('<main></main>',list).kind,'loading');});
test('login and platform restrictions stop collection',()=>{assert.equal(page('<main>Sign in</main>','https://www.linkedin.com/login').kind,'blocked');assert.equal(page('<main>You have reached your commercial use limit</main>',list).kind,'blocked');assert.equal(page('<main>Verify your identity</main>',profile).kind,'blocked');});
test('partially loading results are not treated as the last page',()=>{assert.equal(page('<main><div aria-busy="true"><a href="https://www.linkedin.com/in/one/"><p>One • 2nd</p></a></div></main>',list).kind,'loading');});

test('unrelated profile content does not trigger a global account restriction',()=>{
  const s=page('<main><h1>Security researcher</h1><p>'+('Research on web interfaces. '.repeat(100))+'A post about unusual activity and search limits.</p></main>',profile);assert.equal(s.kind,'profile');
  assert.equal(page('<main><h1>Example</h1><div role="dialog">You have reached your commercial use limit</div></main>',profile).kind,'blocked');
});

test('pagination outside the primary region supports normal next-page anchors',async()=>{
  const s=page('<main><section role="region" aria-label="Primary content"><a href="https://www.linkedin.com/in/one/"><p>One • 2nd</p></a></section><nav><a aria-label="Go to next page" href="'+list+'&page=2">Next</a></nav></main>',list);
  assert.equal(s.hasNext,true);assert.equal(s.paginationState,'next');
  let clicked=false;document.querySelector('nav a').click=()=>{clicked=true;};await advanceLinkedIn(list,false);assert.equal(clicked,true);
});
test('result ordering does not change page identity',()=>{
  const a='<a href="https://www.linkedin.com/in/a/"><p>A • 2nd</p></a>',b='<a href="https://www.linkedin.com/in/b/"><p>B • 2nd</p></a>';
  const first=page('<main>'+a+b+'</main>',list).signature;assert.equal(page('<main>'+b+a+'</main>',list).signature,first);
});
test('own-list scrolling uses a nested scroll container when present',async()=>{
  const url='https://www.linkedin.com/mynetwork/invite-connect/connections/';page('<main><div class="scroller"><a href="https://www.linkedin.com/in/one/"><p>One</p></a></div></main>',url);
  const scroller=document.querySelector('.scroller');Object.defineProperties(scroller,{scrollHeight:{value:1000},clientHeight:{value:300}});let scrolled=false;scroller.scrollTo=()=>{scrolled=true;};globalThis.getComputedStyle=()=>({overflowY:'auto'});globalThis.window={scrollTo(){throw Error('Should scroll the inner list');}};
  assert.equal(await advanceLinkedIn(url,true),'scrolled');assert.equal(scrolled,true);
});
test('scrolling chooses the connection list when a header profile link comes first',async()=>{
  const url='https://www.linkedin.com/mynetwork/invite-connect/connections/';page('<main><header><a href="/in/me/">Me</a></header><div class="scroller"><a href="/in/a/"><p>A</p></a><a href="/in/b/"><p>B</p></a></div></main>',url);
  const scroller=document.querySelector('.scroller'),moves=[];Object.defineProperties(scroller,{scrollHeight:{value:1200},clientHeight:{value:400},scrollTop:{value:800}});scroller.scrollTo=options=>moves.push(options.top);globalThis.getComputedStyle=e=>({overflowY:e===scroller?'auto':'visible'});globalThis.window={scrollTo(){throw Error('Must use the connection list');}};
  assert.equal(await advanceLinkedIn(url,true),'scrolled');assert.deepEqual(moves,[600,800]);
});
test('profiles retain visible professional sections without controls or headings',()=>{
  const s=page('<main><h1>Ada Lovelace</h1><div class="text-body-medium">Engineer at Analytical Engines</div><div class="text-body-small inline t-black--light break-words">London</div><section><h2>About</h2><p>Computing pioneer</p><button>See more</button></section><section><h2>Experience</h2><p>Engine designer</p></section><section><h2>Education</h2><p>Private study</p></section><section><h2>Skills</h2><p>Mathematics</p></section></main>','https://www.linkedin.com/in/ada/');
  assert.deepEqual([s.person.location,s.person.about,s.person.experience,s.person.education,s.person.skills],['London','Computing pioneer','Engine designer','Private study','Mathematics']);
});
