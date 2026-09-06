import test from 'node:test';
import assert from 'node:assert/strict';
import {NetworkGraph} from '../src/graph.js';
import {newState,addPerson,addEdge} from '../src/core.js';
const root='https://www.linkedin.com/in/root/',source='https://www.linkedin.com/search/results/people/?connectionOf=root';
function graph(t){
  let callback,scheduled=0;const arcs=[];
  t.mock.method(globalThis,'requestAnimationFrame',fn=>{callback=fn;return ++scheduled;});
  globalThis.ResizeObserver=class {observe(){}};globalThis.window={devicePixelRatio:1};
  const context=new Proxy({arc(x,y,r){arcs.push({x,y,r});}},{get:(o,k)=>o[k]||(()=>{})});
  const canvas={getContext:()=>context,addEventListener(){},parentElement:{getBoundingClientRect:()=>({width:1000,height:700})}};
  const g=new NetworkGraph(canvas,()=>{});g.resize();return {g,arcs,paint(now){const fn=callback;callback=null;fn?.(now);},get scheduled(){return scheduled;}};
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
