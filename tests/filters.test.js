import test from 'node:test';
import assert from 'node:assert/strict';
import {fieldOf,locationOf,matchesFilters,groupTargets,springProgress,keywordTerms,keywordMatches,keywordGroupOf} from '../src/filters.js';
test('filters combine location and estimated field without losing unknown profiles',()=>{
 const person={location:'  New   York ',headline:'Software developer'};
 assert.equal(locationOf(person),'new york');assert.equal(fieldOf(person),'Technology');
 assert.ok(matchesFilters(person,{location:'new york',field:'Technology'}));
 assert.equal(matchesFilters(person,{location:'new york',field:'Finance'}),false);
 assert.equal(fieldOf({}),'Not specified');assert.equal(fieldOf({headline:'Making things happen'}),'Other / unclassified');
 assert.equal(fieldOf({...person,industry:'Education'}),'Education');
});
test('keyword groups use only the saved headline and location without asserting affiliations',()=>{
 const person={headline:'Engineer at Acme',location:'Stanford, California'},other={headline:'Designer',location:'Boston'};
 assert.deepEqual(keywordTerms([' Acme ','Stanford','acme','x'.repeat(61)]),['Acme','Stanford']);
 assert.deepEqual(keywordMatches(person,['Acme','Stanford','Boston']),['Acme','Stanford']);
 assert.equal(keywordGroupOf(person,['Acme','Stanford']),'Matches: Acme + Stanford');
 assert.equal(keywordGroupOf(other,['Acme']),'No keyword match');
 assert.ok(matchesFilters(person,{keywords:['Acme'],keywordOnly:true}));
 assert.equal(matchesFilters(other,{keywords:['Acme'],keywordOnly:true}),false);
 const grouped=groupTargets([person,other],'keyword',['Acme']);
 assert.deepEqual(grouped.labels.map(label=>label.name),['Matches: Acme','No keyword match']);
});
test('grouping is deterministic and spring motion overshoots then settles exactly',()=>{
 const points=Array.from({length:1000},(_,i)=>({id:String(i),location:i%2?'Boston':'Paris'}));
 const a=groupTargets(points,'location'),b=groupTargets([...points].reverse(),'location');
 assert.deepEqual(a,b);assert.equal(a.targets.size,1000);assert.equal(a.labels.length,2);
 assert.equal(springProgress(0),0);assert.ok(springProgress(.3)>1);assert.equal(springProgress(1),1);
 for(const p of a.targets.values())assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));
});
