import test from 'node:test';
import assert from 'node:assert/strict';
import {fieldOf,locationOf,matchesFilters,groupTargets,springProgress} from '../src/filters.js';
test('filters combine location and estimated field without losing unknown profiles',()=>{
 const person={location:'  New   York ',headline:'Software developer'};
 assert.equal(locationOf(person),'new york');assert.equal(fieldOf(person),'Technology');
 assert.ok(matchesFilters(person,{location:'new york',field:'Technology'}));
 assert.equal(matchesFilters(person,{location:'new york',field:'Finance'}),false);
 assert.equal(fieldOf({}),'Not specified');assert.equal(fieldOf({headline:'Making things happen'}),'Other / unclassified');
 assert.equal(fieldOf({...person,industry:'Education'}),'Education');
});
test('grouping is deterministic and spring motion overshoots then settles exactly',()=>{
 const points=Array.from({length:1000},(_,i)=>({id:String(i),location:i%2?'Boston':'Paris'}));
 const a=groupTargets(points,'location'),b=groupTargets([...points].reverse(),'location');
 assert.deepEqual(a,b);assert.equal(a.targets.size,1000);assert.equal(a.labels.length,2);
 assert.equal(springProgress(0),0);assert.ok(springProgress(.3)>1);assert.equal(springProgress(1),1);
 for(const p of a.targets.values())assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));
});


test('name search ignores casing and outside whitespace, and clearing restores everyone',async()=>{
 const {matchesName}=await import('../src/filters.js');
 const people=[{name:'Alex Rivera'},{name:'Sam Chen',headline:'Alex'}];
 assert.deepEqual(people.filter(p=>matchesName(p,'  RIVERA ')),[people[0]]);
 assert.equal(people.filter(p=>matchesName(p,'Alex')).length,1);
 assert.equal(people.filter(p=>matchesName(p,'   ')).length,2);
 assert.equal(people.filter(p=>matchesName(p,'Nobody')).length,0);
});
