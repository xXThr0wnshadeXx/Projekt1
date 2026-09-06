import test from 'node:test';
import assert from 'node:assert/strict';
import {NetworkGraph} from '../src/graph.js';
import {newState,addPerson,addEdge} from '../src/core.js';
const root='https://www.linkedin.com/in/root/',source='https://www.linkedin.com/search/results/people/?connectionOf=root';
function graph(t){
  let callback,scheduled=0;const arcs=[],handlers={};
  t.mock.method(globalThis,'requestAnimationFrame',fn=>{callback=fn;return ++scheduled;});
  globalThis.ResizeObserver=class {observe(){}};globalThis.window={devicePixelRatio:1};
  const context=new Proxy({arc(x,y,r){arcs.push({x,y,r});}},{get:(o,k)=>o[k]||(()=>{})});
  const canvas={getContext:()=>context,addEventListener(name,fn){handlers[name]=fn;},parentElement:{getBoundingClientRect:()=>({width:1000,height:700})}};
  const g=new NetworkGraph(canvas,()=>{});g.resize();return {g,arcs,handlers,paint(now){const fn=callback;callback=null;fn?.(now);},get scheduled(){return scheduled;}};
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

test('second-degree arrivals expand other branches smoothly without changing the camera',t=>{
 const {g}=graph(t),s=newState(root),parents=[];
 for(let i=0;i<6;i++){const id=addPerson(s,{url:`https://www.linkedin.com/in/parent-${i}/`},1);addEdge(s,root,id,source);parents.push(id);}
 g.setData(s);g.advanceMotion(performance.now()+2000);
 const sibling=g.positions.get(parents[1]),before={x:sibling.x,y:sibling.y},scale=g.scale,offset={...g.offset};
 for(let i=0;i<30;i++){const id=addPerson(s,{url:`https://www.linkedin.com/in/child-${i}/`},2);addEdge(s,parents[0],id,source);}
 g.setData(s);
 assert.deepEqual({x:sibling.x,y:sibling.y},before,'existing nodes start from their displayed positions');
 assert.ok(Math.hypot(sibling.tx,sibling.ty)>Math.hypot(before.x,before.y),'other branches make room');
 assert.equal(g.scale,scale);assert.deepEqual(g.offset,offset);
 const start=g.motion;g.advanceMotion(start+300);
 assert.notEqual(sibling.x,before.x);assert.notEqual(sibling.x,sibling.tx);
 // Another batch arriving mid-animation must not create invalid coordinates.
 const extra=addPerson(s,{url:'https://www.linkedin.com/in/extra-child/'},2);addEdge(s,parents[0],extra,source);g.setData(s);
 g.advanceMotion(g.motion+1000);
 for(const p of g.points){assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));assert.equal(p.x,p.homeX);assert.equal(p.y,p.homeY);}
 for(let i=0;i<g.points.length;i++)for(let j=i+1;j<g.points.length;j++){
   const a=g.points[i],b=g.points[j];assert.ok(Math.hypot(a.x-b.x,a.y-b.y)>a.r+b.r+10,'nodes retain breathing room');
 }
});
test('growth respects grouping and reduced motion, and ungrouping uses the expanded layout',t=>{
 const {g}=graph(t),s=newState(root);g.reducedMotion=true;
 const a=addPerson(s,{url:'https://www.linkedin.com/in/group-parent/',location:'Paris'},1);addEdge(s,root,a,source);
 g.setData(s);g.setFilters({},'location');
 const b=addPerson(s,{url:'https://www.linkedin.com/in/group-child/',location:'London'},2);addEdge(s,a,b,source);g.setData(s);
 assert.equal(g.motion,null);assert.equal(g.groupLabels.length,3);
 g.setFilters({},'none');
 for(const p of g.points){assert.equal(p.x,p.homeX);assert.equal(p.y,p.homeY);}
 assert.ok(Math.hypot(g.positions.get(a).x,g.positions.get(a).y)>60);
});
