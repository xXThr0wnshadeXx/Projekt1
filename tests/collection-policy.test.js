import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePolicy,nextAction,reserveAction,retryAfter,blockPolicy,backoffPolicy,HOUR,DAY,HOURLY_ACTIONS,DAILY_ACTIONS} from '../src/collection-policy.js';

test('reservations enforce the minimum interval even with a zero requested delay',()=>{
  const p=reserveAction({},0,1000);
  assert.equal(p.nextAt,121000);
  assert.throws(()=>reserveAction(p,0,120999));
  assert.equal(reserveAction(p,0,121000).actions.length,2);
  assert.equal(reserveAction({},600,1000).nextAt,601000);
  assert.equal(nextAction(p,600,121000).at,601000); // Slowing down applies to the next action too.
  const oldFiveMinute=reserveAction({},300,1000);assert.equal(nextAction(oldFiveMinute,120,1001).at,121000); // A newly selected two-minute interval replaces an ordinary five-minute reservation.
});
test('rolling budgets release only when an action ages out, not at a clock boundary',()=>{
  const now=2*DAY,actions=Array.from({length:HOURLY_ACTIONS},(_,i)=>now-1000*(HOURLY_ACTIONS-i));
  const gate=nextAction({actions},120,now);
  assert.equal(gate.at,actions[0]+HOUR);assert.match(gate.reason,/Hourly/);
  assert.equal(nextAction({actions},120,gate.at).at,gate.at);
  const daily=Array.from({length:DAILY_ACTIONS},(_,i)=>now-2*HOUR-i*1000).sort((a,b)=>a-b);
  assert.equal(nextAction({actions:daily},120,now).at,daily[0]+DAY);
  assert.equal(normalizePolicy({actions:[now-DAY,...daily]},now).actions.length,DAILY_ACTIONS);
});
test('Retry-After accepts seconds and HTTP dates and never shortens a cooldown',()=>{
  const now=Date.parse('2026-09-06T12:00:00Z');
  assert.equal(retryAfter('7200',now),now+2*HOUR);
  assert.equal(retryAfter('Sun, 06 Sep 2026 14:00:00 GMT',now),now+2*HOUR);
  assert.equal(retryAfter('nonsense',now),0);assert.equal(retryAfter('',now),0);
  const blocked=blockPolicy({nextAt:now+DAY},'restricted',now+HOUR,now);
  assert.equal(blocked.nextAt,now+DAY);
  assert.throws(()=>reserveAction(blocked,120,now+2*DAY)); // Time alone never clears the latch.
});
test('transient failures progressively back off without resetting a server deadline',()=>{
  const first=backoffPolicy({},120,1000),second=backoffPolicy(first,120,first.nextAt);
  assert.equal(first.nextAt,121000);assert.equal(second.nextAt,361000);
  assert.equal(backoffPolicy({nextAt:DAY},120,1000).nextAt,DAY);
});

test('a fresh run may issue two startup actions, with every later action paced',async()=>{
  const {beginRun}=await import('../src/collection-policy.js');
  let p=beginRun({},'run',1000);
  p=reserveAction(p,120,1000,'run');
  assert.equal(nextAction(p,120,1001,'run').at,1001);
  p=reserveAction(p,120,1001,'run');
  assert.equal(nextAction(p,120,1002,'run').at,121001);
  assert.throws(()=>reserveAction(p,120,1002,'run'));
  p=reserveAction(p,120,121001,'run');assert.equal(p.nextAt,241001);
});

test('startup allowance cannot override another run, rolling budgets or a retry cooldown',async()=>{
  const {beginRun}=await import('../src/collection-policy.js');
  let p=reserveAction(beginRun({},'one',1000),120,1000,'one');
  assert.equal(nextAction(p,120,1001,'different').at,121000);
  assert.equal(nextAction(beginRun(p,'two',1001),120,1001,'two').at,121000);
  const saved=JSON.parse(JSON.stringify(p));assert.equal(nextAction(saved,120,1001,'one').at,1001);
  const backed=backoffPolicy(p,120,1001);assert.equal(nextAction(backed,120,1002,'one').at,121001);
  const capped={...p,actions:Array.from({length:HOURLY_ACTIONS},()=>1000)};
  assert.equal(nextAction(capped,120,1001,'one').at,1000+HOUR);
});
