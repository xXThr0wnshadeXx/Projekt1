import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../src/landing-motion.js',import.meta.url),'utf8');
test('scroll entrances replay after either exit and keep one completion listener',()=>{
 const classes=new Set(),listeners={};let intersect,change,disconnected=false;
 const element={classList:{add:c=>classes.add(c),remove:c=>classes.delete(c)},contains:()=>false,dataset:{},style:{setProperty(){}},addEventListener:(name,fn)=>{assert.equal(listeners[name],undefined);listeners[name]=fn;}};
 class Observer{constructor(fn){intersect=fn;}observe(){}disconnect(){disconnected=true;}}
 runInNewContext(source,{matchMedia:()=>({matches:false,addEventListener:(_,fn)=>change=fn}),window:{IntersectionObserver:Observer},IntersectionObserver:Observer,document:{activeElement:null,querySelectorAll:s=>s==='.art-person'?[element]:[],addEventListener(){}}});
 for(let i=0;i<3;i++){
  intersect([{target:element,isIntersecting:true}]);assert.ok(classes.has('scroll-revealed'));
  listeners.animationend({target:element});assert.equal(classes.size,0);
  intersect([{target:element,isIntersecting:false}]);
 }
 intersect([{target:element,isIntersecting:true}]);change({matches:true});
 assert.equal(classes.size,0);assert.equal(disconnected,true);
});
