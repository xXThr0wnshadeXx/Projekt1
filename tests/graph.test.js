import test from 'node:test';
import assert from 'node:assert/strict';
import {NetworkGraph} from '../src/graph.js';
import {newState,addPerson,addEdge} from '../src/core.js';
const root='https://www.linkedin.com/in/root/',source='https://www.linkedin.com/search/results/people/?connectionOf=root';
function graph(t){
  let callback,scheduled=0;const arcs=[],fills=[],handlers={};
  t.mock.method(globalThis,'requestAnimationFrame',fn=>{callback=fn;return ++scheduled;});
  globalThis.ResizeObserver=class {observe(){}};globalThis.window={devicePixelRatio:1};
  const context=new Proxy({arc(x,y,r){arcs.push({x,y,r});},fill(){fills.push(context.fillStyle);}},{get:(o,k)=>o[k]||(()=>{})});
  const canvas={getContext:()=>context,addEventListener(name,fn){handlers[name]=fn;},parentElement:{getBoundingClientRect:()=>({width:1000,height:700})}};
  const g=new NetworkGraph(canvas,()=>{});g.resize();return {g,arcs,fills,handlers,paint(now){const fn=callback;callback=null;fn?.(now);},get scheduled(){return scheduled;}};
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
