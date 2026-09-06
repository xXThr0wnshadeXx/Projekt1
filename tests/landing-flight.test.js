import test from 'node:test';
import assert from 'node:assert/strict';
import {flightPose} from '../src/landing-flight.js';

test('rocket progresses from launchpad through ignition and space into a complete orbit',()=>{
 const ready=flightPose(0),launch=flightPose(.3),space=flightPose(.55),orbit=flightPose(.93),end=flightPose(1);
 assert.equal(ready.stage,0);assert.equal(ready.flame,0);assert.equal(ready.ground,1);
 assert.equal(launch.stage,1);assert.ok(launch.flame>.9);assert.ok(launch.y<ready.y);
 assert.equal(space.stage,2);assert.ok(space.space>0);assert.equal(space.ground,0);
 assert.equal(orbit.stage,3);assert.ok(orbit.y>70);assert.equal(orbit.space,1);
 assert.ok(Math.abs(end.x-18)<1e-9);assert.ok(Math.abs(end.y-50)<1e-9);assert.ok(Math.abs(end.rotation-360)<1e-9);
});
test('scroll reversal exactly retraces every pose and timeline boundaries stay continuous',()=>{
 const forward=Array.from({length:101},(_,i)=>flightPose(i/100));
 for(let i=100;i>=0;i--)assert.deepEqual(flightPose(i/100),forward[i]);
 for(const boundary of [.08,.12,.4,.6,.7,.85]){
  const before=flightPose(boundary-1e-7),after=flightPose(boundary+1e-7);
  for(const key of ['x','y','rotation','flame','space','ground','scale','farShift','nearShift','heading','orbit'])assert.ok(Math.abs(before[key]-after[key])<.001,`${key} jumps at ${boundary}`);
 }
 assert.deepEqual(flightPose(-10),flightPose(0));assert.deepEqual(flightPose(10),flightPose(1));
});

test('flight sweeps across layered scenery, changes scale, and points along its path',()=>{
 const poses=Array.from({length:201},(_,i)=>flightPose(i/200));
 assert.ok(Math.max(...poses.map(p=>p.x))-Math.min(...poses.map(p=>p.x))>50);
 assert.ok(Math.max(...poses.map(p=>p.scale))-Math.min(...poses.map(p=>p.scale))>.5);
 assert.ok(Math.abs(flightPose(.6).nearShift)>Math.abs(flightPose(.6).farShift));
 for(const aspect of [.7,2,4])for(const p of [.2,.3,.5,.6,.78,.91]){
  const a=flightPose(p-1e-5,aspect),b=flightPose(p+1e-5,aspect),pose=flightPose(p,aspect);
  const dx=(b.x-a.x)*aspect,dy=b.y-a.y,angle=pose.rotation*Math.PI/180;
  assert.ok((dx*Math.sin(angle)-dy*Math.cos(angle))/Math.hypot(dx,dy)>.999);
 }
});
