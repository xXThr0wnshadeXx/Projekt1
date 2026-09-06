import test from 'node:test';
import assert from 'node:assert/strict';
import {NetworkGraph,networkTargets,focusTargets} from '../src/graph.js';
import {newState,addPerson,addEdge} from '../src/core.js';
const root='https://www.linkedin.com/in/root/',source='https://www.linkedin.com/search/results/people/?connectionOf=root';
function graph(t){
  let callback,scheduled=0;const arcs=[],fills=[],handlers={},selections=[];
  t.mock.method(globalThis,'requestAnimationFrame',fn=>{callback=fn;return ++scheduled;});
  globalThis.ResizeObserver=class {observe(){}};globalThis.window={devicePixelRatio:1};
  const context=new Proxy({arc(x,y,r){arcs.push({x,y,r});},fill(){fills.push(context.fillStyle);}},{get:(o,k)=>o[k]||(()=>{})});
  const canvas={style:{},getContext:()=>context,getBoundingClientRect:()=>({left:0,top:0,width:1000,height:700}),addEventListener(name,fn){handlers[name]=fn;},parentElement:{getBoundingClientRect:()=>({width:1000,height:700})}};
  const g=new NetworkGraph(canvas,id=>selections.push(id));g.resize();return {g,arcs,fills,handlers,selections,paint(now){const fn=callback;callback=null;fn?.(now);},get scheduled(){return scheduled;}};
}
// Node has no animation frame API; these tests exercise timing/layout without a browser.
globalThis.requestAnimationFrame=()=>0;
test('nodes reveal individually, positions stay stable, and rendering stops after arrivals',t=>{
  const h=graph(t),s=newState(root);h.g.setData(s);h.paint(performance.now()+1000);
  const initial={...h.g.positions.get(root)};
  for(let i=0;i<10;i++){const id=addPerson(s,{url:`https://www.linkedin.com/in/p-${i}/`,name:`Person ${i}`},1);addEdge(s,root,id,source);}
  h.g.setData(s);assert.equal(h.g.positions.get(root).x,initial.x);assert.equal(h.g.positions.get(root).y,initial.y);
  const newPoints=h.g.points.slice(1);assert.ok(newPoints[1].bornAt>newPoints[0].bornAt);assert.ok(newPoints.at(-1).bornAt-newPoints[0].bornAt<1200);
  let seen;h.g.onReveal=(p,n)=>seen=n;h.paint(newPoints[0].bornAt+1);assert.equal(seen,2);
  h.paint(newPoints.at(-1).bornAt+1000);assert.equal(seen,11);assert.equal(h.g.frame,null);
  const scheduled=h.scheduled;h.g.setData(s);assert.equal(h.scheduled,scheduled);
  h.g.setData(null);h.paint(performance.now()+3000);assert.equal(h.g.points.length,0);
});
test('10,000-node layout has a bounded reveal window and supports reduced motion',t=>{
  const h=graph(t),s=newState(root,{maxNodes:10000});
  const start=performance.now();for(let i=0;i<9999;i++){const id=addPerson(s,{url:`https://www.linkedin.com/in/p-${i}/`,name:`Person ${i}`},2);addEdge(s,root,id,source);}
  h.g.setData(s);const elapsed=performance.now()-start;
  assert.equal(h.g.points.length,10000);assert.ok(h.g.points.at(-1).bornAt-h.g.points[0].bornAt<=1200);assert.ok(elapsed<5000,`10k graph setup took ${elapsed}ms`);
  h.g.reducedMotion=true;const copy={...s,id:'new'};h.g.setData(copy);h.paint(performance.now());assert.equal(h.g.frame,null);
  t.diagnostic(`Synthetic 10,000 people / 9,999 edges: data assembly + layout ${elapsed.toFixed(0)}ms (no browser paint or LinkedIn network time).`);
});

test('scroll is opt-in, zoom is bounded and anchored, arrivals preserve the viewport',t=>{
  const h=graph(t),s=newState(root);h.g.setData(s);
  let prevented=false;
  const wheel={deltaY:1000,deltaMode:0,offsetX:170,offsetY:220,preventDefault(){prevented=true;}};
  const initial=h.g.scale;
  h.handlers.wheel(wheel);assert.equal(h.g.scale,initial);assert.equal(prevented,false);
  h.g.scrollZoom=true;
  const before=(wheel.offsetX-h.g.w/2-h.g.offset.x)/h.g.scale;
  h.handlers.wheel(wheel);assert.equal(prevented,true);assert.ok(h.g.scale/initial>.95);
  assert.ok(Math.abs((wheel.offsetX-h.g.w/2-h.g.offset.x)/h.g.scale-before)<1e-9);
  const scale=h.g.scale,offset={...h.g.offset};
  for(let i=0;i<50;i++)addPerson(s,{url:`https://www.linkedin.com/in/new-${i}/`,name:`New ${i}`},1);
  h.g.setData(s);assert.equal(h.g.scale,scale);assert.deepEqual(h.g.offset,offset);
  h.g.fit();assert.notEqual(h.g.scale,scale);
});
test('group movement survives refreshes, settles and resets without losing people',t=>{
 const h=graph(t),s=newState(root);
 for(let i=0;i<8;i++)addPerson(s,{url:`https://www.linkedin.com/in/group-${i}/`,name:`Person ${i}`,location:i%2?'Paris':'Boston'},1);
 h.g.setData(s);h.g.setFilters({},'location');assert.notEqual(h.g.motion,null);
 const start=h.g.motion;h.g.setData(s);assert.equal(h.g.motion,start);
 h.paint(start+1000);assert.equal(h.g.motion,null);
 for(const p of h.g.points){assert.equal(p.x,p.tx);assert.equal(p.y,p.ty);}
 h.g.reducedMotion=true;h.g.setFilters({location:'boston'},'location');assert.equal(h.g.motion,null);assert.equal(h.g.points.filter(p=>h.g.isVisible(p)).length,4);
 h.g.setFilters({},'none');for(const p of h.g.points){assert.equal(p.x,p.homeX);assert.equal(p.y,p.homeY);}
 h.g.setData({...s,id:'different'});for(const p of h.g.points)assert.ok(Number.isFinite(p.x));
});
test('wheel zoom eases around the pointer, settles, and respects reduced motion',t=>{
 const h=graph(t);h.g.setData(newState(root));h.g.scrollZoom=true;
 const initial=h.g.scale,x=200,y=160,world=(x-h.g.w/2-h.g.offset.x)/initial;
 h.handlers.wheel({deltaY:60,deltaMode:0,offsetX:x,offsetY:y,preventDefault(){}});
 assert.equal(h.g.scale,initial);const target=h.g.zoomTarget.scale,start=h.g.zoomTime;
 h.paint(start+16);assert.ok(h.g.scale<initial&&h.g.scale>target);
 assert.ok(Math.abs((x-h.g.w/2-h.g.offset.x)/h.g.scale-world)<1e-9);
 for(let i=2;i<100;i++)h.paint(start+i*16);
 assert.equal(h.g.zoomTarget,null);assert.equal(h.g.scale,target);
 h.g.reducedMotion=true;h.g.queueZoom(1.08,x,y);assert.equal(h.g.zoomTarget,null);assert.ok(h.g.scale>target);
});
test('continuous wheel input does not restart easing and has a useful zoom range',t=>{
 const h=graph(t);h.g.setData(newState(root));h.g.scrollZoom=true;
 const initial=h.g.scale,event={deltaY:100,deltaMode:0,offsetX:300,offsetY:240,preventDefault(){}};
 h.handlers.wheel(event);const start=h.g.zoomTime;
 assert.ok(h.g.zoomTarget.scale/initial>.8&&h.g.zoomTarget.scale/initial<.85);
 h.handlers.wheel(event);assert.equal(h.g.zoomTime,start);
 h.paint(start+16);assert.ok(h.g.scale<initial);
});
test('fit is always 100% and controls make useful progress on very large maps',t=>{
 const h=graph(t),ratios=[];h.g.onZoom=(_scale,ratio)=>ratios.push(ratio);
 h.g.points=[{id:'far',x:100000,y:50000,depth:1,bornAt:0}];
 h.g.fit();assert.ok(h.g.scale<.01);assert.equal(h.g.zoomRatio(),1);assert.equal(ratios.at(-1),1);
 h.g.stepZoom(1);assert.equal(h.g.zoomTarget.scale/h.g.fitScale,1.5);
 const start=h.g.zoomTime;for(let i=1;i<100;i++)h.paint(start+i*16);
 assert.equal(h.g.zoomTarget,null);assert.ok(Math.abs(h.g.zoomRatio()-1.5)<1e-12);assert.ok(Math.abs(ratios.at(-1)-1.5)<1e-12);
 h.g.stepZoom(-1);assert.ok(Math.abs(h.g.zoomTarget.scale/h.g.fitScale-1)<1e-12);
});
test('adaptive branch targets make room for growing second-degree clusters',()=>{
 const points=[{id:'root',depth:0},{id:'a',depth:1},{id:'b',depth:1},...Array.from({length:30},(_,i)=>({id:`child-${i}`,depth:2}))],edges=[{source:'root',target:'a'},{source:'root',target:'b'},...Array.from({length:30},(_,i)=>({source:'a',target:`child-${i}`}))];
 const targets=networkTargets(points,edges,'root');assert.equal(targets.size,points.length);for(const point of targets.values())assert.ok(Number.isFinite(point.x)&&Number.isFinite(point.y));assert.ok(Math.hypot(targets.get('a').x,targets.get('a').y)<Math.hypot(targets.get('b').x,targets.get('b').y)||Math.hypot(targets.get('a').x,targets.get('a').y)>0);
 const seen=[];for(const p of points){const at=targets.get(p.id);for(const other of seen)assert.ok(Math.hypot(at.x-other.x,at.y-other.y)>0);seen.push(at);}
});

test('selection greys unrelated dots, updates for new edges, and clears back to depth colors',t=>{
 const h=graph(t),s=newState(root);h.g.reducedMotion=true;
 const a=addPerson(s,{url:'https://www.linkedin.com/in/a/'},1),b=addPerson(s,{url:'https://www.linkedin.com/in/b/'},2),c=addPerson(s,{url:'https://www.linkedin.com/in/c/'},1);
 addEdge(s,root,a,source);addEdge(s,a,b,source);addEdge(s,root,c,source);
 h.g.setData(s);h.g.focus(b,[root,a,b]);h.fills.length=0;h.paint(performance.now()+2000);
 assert.deepEqual([...h.g.neighbors].sort(),[a,b].sort());
 assert.deepEqual(h.fills,['#747474','#a8bf83','#747474','#b5a0cb'],'even distant path nodes are grey unless directly connected');
 addEdge(s,c,b,source);h.g.setData(s);assert.ok(h.g.neighbors.has(c));
 h.g.focus(null);h.fills.length=0;h.paint(performance.now()+3000);
 assert.deepEqual(h.fills,['#ead779','#a8bf83','#a8bf83','#b5a0cb']);
});


test('zooming out keeps dots visible without moving the layout',t=>{
 const {g,arcs,paint}=graph(t),s=newState(root);g.reducedMotion=true;
 const child=addPerson(s,{url:'https://www.linkedin.com/in/visible-child/'},2);addEdge(s,root,child,source);g.setData(s);
 const before=g.points.map(p=>({x:p.x,y:p.y}));g.scale=.02;arcs.length=0;paint(performance.now()+2000);
 assert.equal(arcs.length,2);assert.ok(arcs[0].r*g.scale>=8);assert.ok(arcs[1].r*g.scale>=3);
 assert.deepEqual(g.points.map(p=>({x:p.x,y:p.y})),before);
});
test('search spreads matches and makes dimmed people impossible to select',t=>{
 const h=graph(t),s=newState(root);h.g.reducedMotion=true;
 const hit=addPerson(s,{url:'https://www.linkedin.com/in/sjsu-person/',name:'SJSU Person',education:'San Jose State University'},1),miss=addPerson(s,{url:'https://www.linkedin.com/in/other/',name:'Unrelated Person',education:'Stanford University'},1);addEdge(s,root,hit,source);addEdge(s,root,miss,source);h.g.setData(s);h.g.search('sjsu');
 assert.equal(h.g.isSearchHit(h.g.positions.get(hit)),true);assert.equal(h.g.isSearchHit(h.g.positions.get(miss)),false);
 const click=id=>{const p=h.g.positions.get(id),e={clientX:h.g.w/2+h.g.offset.x+p.x*h.g.scale,clientY:h.g.h/2+h.g.offset.y+p.y*h.g.scale,pointerId:1};h.handlers.pointerdown(e);h.handlers.pointerup(e);};
 click(miss);assert.equal(h.selections.at(-1),null);click(hit);assert.equal(h.selections.at(-1),hit);
 const targets=focusTargets([{id:'a'},{id:'b'},{id:'c'}]);assert.ok(Math.hypot(targets.get('b').x-targets.get('c').x,targets.get('b').y-targets.get('c').y)>58);
});
test('filter changes mark removed nodes for a dust transition and fit the survivors',t=>{
 const h=graph(t),s=newState(root);const a=addPerson(s,{url:'https://www.linkedin.com/in/boston/',location:'Boston'},1),b=addPerson(s,{url:'https://www.linkedin.com/in/paris/',location:'Paris'},1);addEdge(s,root,a,source);addEdge(s,root,b,source);h.g.setData(s);h.g.setFilters({location:'boston'});
 assert.ok(Number.isFinite(h.g.positions.get(b).snapAt));assert.equal(h.g.isVisible(h.g.positions.get(a)),true);assert.equal(h.g.isVisible(h.g.positions.get(b)),false);assert.ok(h.g.scale>0);
});

test('unfiltered name search retains the starter and real intermediate route only',t=>{
 const h=graph(t),s=newState(root);h.g.reducedMotion=true;
 const bridge=addPerson(s,{url:'https://www.linkedin.com/in/bridge/',name:'Morgan Rivera'},1);
 const hit=addPerson(s,{url:'https://www.linkedin.com/in/target/',name:'Zelda Quinn',headline:'Astronomy',location:'Boston'},2);
 const other=addPerson(s,{url:'https://www.linkedin.com/in/unrelated/',name:'Oscar Reed'},1);
 addEdge(s,root,bridge,source);addEdge(s,bridge,hit,source);addEdge(s,root,other,source);
 h.g.setData(s);h.g.search('Zelda Quinn');
 assert.deepEqual(h.g.searchContext,new Set([root,hit,bridge]));
 assert.equal(h.g.isSearchHit(h.g.positions.get(root)),false);
 for(const id of [root,bridge,hit]){
  const p=h.g.positions.get(id);assert.equal(h.g.isSearchVisible(p),true);
  assert.equal(h.g.pickPoint(p.x,p.y)?.id,id);
  assert.ok(Math.abs(p.x*h.g.scale)<h.g.w/2);
 }
 assert.equal(h.g.isSearchVisible(h.g.positions.get(other)),false);
 for(const filter of [{location:'Boston'},{field:'Technology'},{keywords:['Astronomy']},{first:false},{second:false},{extended:false}]){
  h.g.setFilters(filter);assert.equal(h.g.searchContext.size,0);
 }
 h.g.setFilters({first:true,second:true,extended:true});assert.ok(h.g.searchContext.has(root));
 h.g.search('Astronomy');assert.equal(h.g.searchContext.size,0);
 h.g.search('Zelda Quinn');assert.ok(h.g.searchContext.has(root));
 h.g.search('');assert.equal(h.g.searchContext.size,0);
 h.g.search('Zelda Quinn');h.g.setData(null);assert.equal(h.g.searchContext.size,0);
});

test('disk stays centered, separates depths and is deterministic across input order',()=>{
 const points=[{id:'root',depth:0},...Array.from({length:800},(_,i)=>({id:`person-${i}`,depth:i<120?1:i<500?2:3}))];
 const targets=networkTargets(points,[],'root'),reverse=networkTargets([...points].reverse(),[],'root');
 assert.deepEqual(targets.get('root'),{x:0,y:0});assert.deepEqual(targets,reverse);
 const bands=[1,2,3].map(depth=>points.filter(p=>p.depth===depth).map(p=>Math.hypot(targets.get(p.id).x,targets.get(p.id).y)));
 assert.ok(Math.max(...bands[0])<Math.min(...bands[1]));assert.ok(Math.max(...bands[1])<Math.min(...bands[2]));
 const positions=[...targets.values()],xs=positions.map(p=>p.x),ys=positions.map(p=>p.y),width=Math.max(...xs)-Math.min(...xs),height=Math.max(...ys)-Math.min(...ys);
 assert.ok(width/height>.95&&width/height<1.05);assert.ok(Math.max(...bands[2])<1100,'disk radius grows with square root of population');
 for(let i=0;i<positions.length;i++)for(let j=0;j<i;j++)assert.ok(Math.hypot(positions[i].x-positions[j].x,positions[i].y-positions[j].y)>55,'nodes have room on and between rings');
 assert.deepEqual(focusTargets(points.slice(0,8),'root').get('root'),{x:0,y:0});
});

test('filtering and fuzzy search run once per change, never during paint, zoom or hover',t=>{
 const h=graph(t),s=newState(root,{maxNodes:10000});h.g.reducedMotion=true;
 for(let i=0;i<9999;i++){const id=addPerson(s,{url:`https://www.linkedin.com/in/cache-${i}/`,name:`Person ${i}`,location:i%2?'Boston':'Paris',headline:'Software engineer'},1);addEdge(s,root,id,source);}
 h.g.setData(s);
 const filters=t.mock.method(h.g,'evaluateFilter'),search=t.mock.method(h.g,'evaluateSearch');
 const start=performance.now();h.g.setFilters({location:'Boston'});const filterMs=performance.now()-start;
 assert.equal(filters.mock.callCount(),10000);assert.equal(search.mock.callCount(),0);
 h.g.search('engineer');assert.equal(search.mock.callCount(),10000);
 const frameStart=performance.now();for(let i=0;i<5;i++){h.g.paint(performance.now()+2000);h.g.pickPoint(0,0);h.g.fit();h.g.zoom(1.05);}
 assert.equal(filters.mock.callCount(),10000);assert.equal(search.mock.callCount(),10000);
 h.g.setFilters({location:'Boston'});h.g.search('engineer');assert.equal(filters.mock.callCount(),10000);assert.equal(search.mock.callCount(),10000);
 h.g.setFilters({location:'Boston'},'location');assert.equal(filters.mock.callCount(),10000);assert.equal(search.mock.callCount(),10000);
 t.diagnostic(`Synthetic 10k map: filter apply ${filterMs.toFixed(0)}ms; 5 mock-canvas paints + hover/fit/zoom ${(performance.now()-frameStart).toFixed(0)}ms. No fuzzy evaluations during rendering.`);
});

test('cached results refresh for metadata changes, new people, graph replacement and tree exit',t=>{
 const {g}=graph(t),s=newState(root);g.reducedMotion=true;
 const a=addPerson(s,{url:'https://www.linkedin.com/in/cache-a/',name:'Morgan',location:'Paris',headline:'Designer'},1);addEdge(s,root,a,source);
 g.setData(s);g.setFilters({location:'Boston'});g.search('engineer');assert.equal(g.isVisible(g.positions.get(a)),false);assert.equal(g.isSearchHit(g.positions.get(a)),false);
 addPerson(s,{url:a,location:'Boston',headline:'Software engineer'},1);g.setData(s);assert.equal(g.isVisible(g.positions.get(a)),true);assert.equal(g.isSearchHit(g.positions.get(a)),true);
 const b=addPerson(s,{url:'https://www.linkedin.com/in/cache-b/',name:'Taylor',location:'Boston',headline:'Engineer'},1);addEdge(s,root,b,source);g.setData(s);assert.equal(g.isVisible(g.positions.get(b)),true);assert.equal(g.isSearchHit(g.positions.get(b)),true);
 g.search('');g.setFilters({});g.showTree(a);assert.deepEqual({x:g.positions.get(a).x,y:g.positions.get(a).y},{x:0,y:0});g.clearTree();assert.deepEqual({x:g.positions.get(root).x,y:g.positions.get(root).y},{x:0,y:0});
 const revision=g.matchRevision;g.setData(null);assert.ok(g.matchRevision>revision);g.setData({...s,id:'replacement'});assert.equal(g.points.length,3);assert.equal(g.isVisible(g.positions.get(a)),true);
});

test('large filter changes bound particle effects instead of animating every removed node',t=>{
 const {g}=graph(t),s=newState(root);for(let i=0;i<1000;i++)addPerson(s,{url:`https://www.linkedin.com/in/dust-${i}/`,location:'Paris'},1);
 g.setData(s);g.setFilters({location:'Boston'});assert.ok(g.points.filter(p=>p.snapAt).length<=180);assert.equal(g.points.filter(p=>g.isVisible(p)).length,0);
});
