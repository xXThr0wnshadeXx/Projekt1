import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {consumeRateLimit,rateLimitConfig} from '../server/rate-limit.js';

function database(){
  const raw=new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE api_rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,reset_at INTEGER NOT NULL)');
  return {prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this;},async first(){return raw.prepare(this.sql).get(...this.args)||null;}};}};
}

test('shared database rate limits are atomic per contributor and reset by window',async()=>{
  const db=database();
  assert.equal((await consumeRateLimit(db,'actor:write',2,1000,1000)).allowed,true);
  assert.equal((await consumeRateLimit(db,'actor:write',2,1000,1001)).allowed,true);
  const blocked=await consumeRateLimit(db,'actor:write',2,1000,1002);
  assert.equal(blocked.allowed,false);assert.equal(blocked.remaining,0);
  assert.equal((await consumeRateLimit(db,'other:write',2,1000,1002)).allowed,true);
  assert.equal((await consumeRateLimit(db,'actor:write',2,1000,2000)).allowed,true);
});

test('rate limit configuration is bounded to positive integers',()=>{
  assert.equal(rateLimitConfig({},'write'),20);
  assert.equal(rateLimitConfig({},'read'),120);
  assert.equal(rateLimitConfig({ORBIT_WRITE_LIMIT_PER_MINUTE:'7'},'write'),7);
  assert.equal(rateLimitConfig({ORBIT_READ_LIMIT_PER_MINUTE:'0'},'read'),120);
});
