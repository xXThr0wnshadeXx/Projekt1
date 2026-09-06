import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {NetworkGraph} from '../src/graph.js';
import {newState,addPerson,addEdge} from '../src/core.js';

test('typed filters coalesce, polls keep applied results, and directory reuses graph matches',async t=>{
 const {document}=parseHTML(readFileSync(new URL('../map.html',import.meta.url),'utf8')),$=id=>document.getElementById(id);
 const root='https://www.linkedin.com/in/ui-root/',s=newState(root);
 const a=addPerson(s,{url:'https://www.linkedin.com/in/ui-a/',name:'Morgan',location:'Boston',headline:'Software engineer'},1),b=addPerson(s,{url:'https://www.linkedin.com/in/ui-b/',name:'Taylor',location:'Paris',headline:'Designer'},1);
 addEdge(s,root,a,'https://www.linkedin.com/search/results/people/?connectionOf=ui-root');addEdge(s,root,b,'https://www.linkedin.com/search/results/people/?connectionOf=ui-root');s.status='imported';
 Object.assign(globalThis,{document,window:{devicePixelRatio:1},location:new URL('http://localhost/map.html'),localStorage:{getItem:()=>JSON.stringify(s)},ResizeObserver:class {observe(){}},requestAnimationFrame:()=>1,addEventListener:()=>{}});
 for(const select of document.querySelectorAll('select'))Object.defineProperty(select,'value',{value:select.querySelector('[selected]')?.getAttribute('value')||select.firstElementChild?.getAttribute('value'),writable:true});
 for(const input of document.querySelectorAll('input[type=checkbox]'))input.checked=input.hasAttribute('checked');
 const context=new Proxy({},{get:()=>()=>{}}),canvas=$('network-canvas');canvas.getContext=()=>context;canvas.parentElement.getBoundingClientRect=()=>({width:1000,height:700});$('inspector').close=()=>{};
 const timers=new Map();let timerId=0;
 t.mock.method(globalThis,'setTimeout',(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;});t.mock.method(globalThis,'clearTimeout',id=>timers.delete(id));t.mock.method(globalThis,'setInterval',()=>0);
 const flush=()=>{for(const [id,{fn,ms}] of [...timers])if(ms===120||ms===220){timers.delete(id);fn();}};
 const filterCalls=t.mock.method(NetworkGraph.prototype,'evaluateFilter'),searchCalls=t.mock.method(NetworkGraph.prototype,'evaluateSearch');
 await import('../src/app.js');
 const initialCalls=filterCalls.mock.callCount(),suggestion=$('location-options').firstElementChild;
 for(const value of ['B','Bo','Boston']){$('filter-location').value=value;$('filter-location').oninput();}
 assert.equal(filterCalls.mock.callCount(),initialCalls);assert.equal([...timers.values()].filter(t=>t.ms===120).length,1);
 $('back-collection').onclick();assert.match($('filter-count').textContent,/3 of 3/);assert.equal(filterCalls.mock.callCount(),initialCalls);
 flush();assert.equal(filterCalls.mock.callCount(),initialCalls+3);assert.match($('filter-count').textContent,/1 of 3/);assert.equal($('location-options').firstElementChild,suggestion);
 $('tab-directory').onclick();assert.equal($('people-body').children.length,1);assert.match($('people-body').textContent,/Morgan/);
 const beforeSearch=searchCalls.mock.callCount();$('search').value='engineer';$('search').oninput();flush();assert.equal(searchCalls.mock.callCount(),beforeSearch+3);assert.equal(filterCalls.mock.callCount(),initialCalls+3);
 $('back-collection').onclick();assert.equal(searchCalls.mock.callCount(),beforeSearch+3);assert.equal(filterCalls.mock.callCount(),initialCalls+3);
 $('filter-location').value='Paris';$('filter-location').oninput();$('reset-filters').onclick();flush();assert.match($('filter-count').textContent,/3 of 3/);assert.equal($('filter-location').value,'');
 $('search').value='Taylor';$('search').oninput();flush();assert.equal($('people-body').children.length,1);assert.match($('people-body').textContent,/Taylor/);
 const sent=[];let quickPosts=false;
 globalThis.chrome={runtime:{sendMessage:async(_id,message)=>{sent.push(message);return message.type==='PING'?{ok:true,version:'test',capabilities:['exploreNext','sharedCoverage',...(quickPosts?['quickPosts']:[])]}:{ok:true,status:'running'};}}};
 await $('explore-posts').onclick();assert.equal(sent.some(m=>m.type==='EXPLORE_POSTS'),false,'old companions must be updated first');
 quickPosts=true;$('collect-comments').checked=false;$('depth').value='1';await $('explore-posts').onclick();
 const request=sent.find(m=>m.type==='EXPLORE_POSTS');assert.equal(request.root,root);assert.equal(request.config.comments,true);assert.equal(request.config.depth,2);assert.equal($('collect-comments').checked,true);

});
