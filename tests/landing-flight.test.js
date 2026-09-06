import test from 'node:test';
import assert from 'node:assert/strict';
import {flightPose} from '../src/landing-flight.js';

test('rocket progresses from launchpad through ignition and space into a complete orbit',()=>{
 const ready=flightPose(0),launch=flightPose(.3),space=flightPose(.55),orbit=flightPose(.825),end=flightPose(1);
 assert.equal(ready.stage,0);assert.equal(ready.flame,0);assert.equal(ready.ground,1);
 assert.equal(launch.stage,1);assert.ok(launch.flame>.9);assert.ok(launch.y<ready.y);
 assert.equal(space.stage,2);assert.ok(space.space>0);assert.equal(space.ground,0);
 assert.equal(orbit.stage,3);assert.ok(orbit.y>70);assert.equal(orbit.space,1);
 assert.ok(Math.abs(end.x-50)<1e-9);assert.equal(end.y,20);assert.equal(end.rotation,450);
});
test('scroll reversal exactly retraces every pose and timeline boundaries stay continuous',()=>{
 const forward=Array.from({length:101},(_,i)=>flightPose(i/100));
 for(let i=100;i>=0;i--)assert.deepEqual(flightPose(i/100),forward[i]);
 for(const boundary of [.12,.43,.52,.65]){
  const before=flightPose(boundary-1e-7),after=flightPose(boundary+1e-7);
  for(const key of ['x','y','rotation','flame','space','ground'])assert.ok(Math.abs(before[key]-after[key])<.001,`${key} jumps at ${boundary}`);
 }
 assert.deepEqual(flightPose(-10),flightPose(0));assert.deepEqual(flightPose(10),flightPose(1));
});
