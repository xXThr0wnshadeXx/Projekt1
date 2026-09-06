import test from 'node:test';
import assert from 'node:assert/strict';
import {scrollAngle,easeAngle,project,makeSystem} from '../src/landing-solar.js';
test('Y-axis rotation changes depth, closes one revolution, and reverses with scroll',()=>{
 const p={x:120,y:15,z:40},a=project(p,scrollAngle(0)),b=project(p,scrollAngle(1));
 for(const key of ['x','y','z'])assert.ok(Math.abs(a[key]-b[key])<1e-9);
 assert.notEqual(project(p,0).z,project(p,Math.PI/2).z);
 assert.equal(scrollAngle(-1),scrollAngle(0));assert.equal(scrollAngle(2),scrollAngle(1));
 const forward=Array.from({length:21},(_,i)=>project(p,scrollAngle(i/20)));
 for(let i=20;i>=0;i--)assert.deepEqual(project(p,scrollAngle(i/20)),forward[i]);
});
test('rotation eases without overshoot and settles in either direction',()=>{
 for(const target of [-4,6]){let current=0;for(let i=0;i<200;i++){
  const next=easeAngle(current,target,16);assert.ok(Math.abs(next-target)<=Math.abs(current-target));current=next;
 }assert.equal(current,target);}
 assert.ok(Math.abs(easeAngle(easeAngle(0,2,8),2,8)-easeAngle(0,2,16))<1e-12);
});
test('node system has a central sphere, closed rings, and finite projection at every angle',()=>{
 const {nodes,rings}=makeSystem();assert.equal(nodes.length,26);assert.equal(rings.length,5);
 assert.deepEqual([nodes[0].x,nodes[0].y,nodes[0].z],[0,0,0]);
 for(const ring of rings)assert.ok(Math.hypot(ring[0].x-ring.at(-1).x,ring[0].z-ring.at(-1).z)<1e-9);
 for(let a=0;a<7;a+=.1)for(const p of nodes){const q=project(p,a);assert.ok(Object.values(q).every(Number.isFinite));assert.ok(q.perspective>0);}
});
