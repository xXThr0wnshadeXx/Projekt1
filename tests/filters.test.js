import test from 'node:test';
import assert from 'node:assert/strict';
import {fieldOf,fieldsOf,locationOf,locationMatches,fieldMatches,matchesFilters,groupTargets,springProgress,keywordTerms,keywordMatches,keywordGroupOf} from '../src/filters.js';
test('filters combine location and estimated field without losing unknown profiles',()=>{
 const person={location:'  New   York ',headline:'Software developer'};
 assert.equal(locationOf(person),'new york');assert.equal(fieldOf(person),'Technology');
 assert.ok(matchesFilters(person,{location:'new york',field:'Technology'}));
 assert.equal(matchesFilters(person,{location:'new york',field:'Finance'}),false);
 assert.equal(fieldOf({}),'Not specified');assert.equal(fieldOf({headline:'Making things happen'}),'Other / unclassified');
 assert.equal(fieldOf({...person,industry:'Education'}),'Education');
 assert.equal(fieldOf({headline:'Biology student at SJSU'}),'Healthcare & life sciences');
 assert.equal(fieldOf({education:'Pre-medical studies',skills:'Genomics'}),'Healthcare & life sciences');
 assert.equal(fieldOf({headline:'Biomedical engineering researcher'}),'Healthcare & life sciences');
});
test('facet search is fuzzy and one person can belong to several useful sectors',()=>{
 const person={depth:2,location:'San Francisco Bay Area',headline:'Biomedical software engineer',education:'San Jose State University',skills:['genomics','machine learning']};
 assert.deepEqual(fieldsOf(person),['Healthcare & life sciences','Technology','Education & research']);
 assert.equal(locationMatches(person,'san fransisco'),true);assert.equal(fieldMatches(person,'health'),true);assert.equal(fieldMatches(person,'tech'),true);
 assert.equal(matchesFilters(person,{location:'bay area',field:'biotech',keywords:['SJSU'],second:true}),true);
 assert.equal(matchesFilters(person,{location:'new york',field:'technology',second:true}),false);
});
test('grouping is deterministic and spring motion overshoots then settles exactly',()=>{
 const points=Array.from({length:1000},(_,i)=>({id:String(i),location:i%2?'Boston':'Paris'}));
 const a=groupTargets(points,'location'),b=groupTargets([...points].reverse(),'location');
 assert.deepEqual(a,b);assert.equal(a.targets.size,1000);assert.equal(a.labels.length,2);
 assert.equal(springProgress(0),0);assert.ok(springProgress(.3)>1);assert.equal(springProgress(1),1);
 for(const p of a.targets.values())assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));
});
test('degree and alias-aware keyword filters combine without losing the root',()=>{
 const sjsu={id:'s',depth:2,headline:'Student at San Jose State University',location:'San Jose'};
 assert.deepEqual(keywordTerms(' SJSU, machine learning, sjsu '),['SJSU','machine learning']);assert.deepEqual(keywordMatches(sjsu,['SJSU']),['SJSU']);assert.deepEqual(keywordMatches(sjsu,['San Jose State Universty']),['San Jose State Universty']);assert.equal(keywordGroupOf(sjsu,['SJSU']),'Matches: SJSU');
 assert.equal(matchesFilters(sjsu,{first:true,second:true,extended:false,keywords:['SJSU'],keywordOnly:true}),true);assert.equal(matchesFilters({...sjsu,depth:3},{extended:false}),false);assert.equal(matchesFilters({...sjsu,depth:0},{first:false,second:false,extended:false}),true);
 const grouped=groupTargets([sjsu,{id:'x',depth:2,headline:'Designer'}],'keyword',['SJSU']);assert.deepEqual(grouped.labels.map(label=>label.name),['Matches: SJSU','No keyword match']);
});
