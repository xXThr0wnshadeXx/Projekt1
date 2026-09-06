import {newState,addPerson,addEdge,exportGraph,importGraph} from '../src/core.js';
document.getElementById('load').onclick=()=>{
const root='https://www.linkedin.com/in/synthetic-test-root/',s=newState(root,{maxNodes:2000});s.nodes[root].name='SYNTHETIC TEST · 1,501 people';
for(let i=0;i<30;i++){
const owner=addPerson(s,{url:`https://www.linkedin.com/in/synthetic-branch-${i}/`,name:`Test connector ${String(i).padStart(2,'0')}`,headline:'Synthetic test fixture'},1),source=`https://www.linkedin.com/search/results/people/?connectionOf=synthetic-${i}`;
addEdge(s,root,owner,source);
for(let j=0;j<49;j++){const p=addPerson(s,{url:`https://www.linkedin.com/in/synthetic-person-${i}-${j}/`,name:`Test person ${i}-${j}`,headline:j%2?'Synthetic engineer':'Synthetic designer'},2);addEdge(s,owner,p,source);}
}
localStorage.setItem('orbitNetwork',JSON.stringify(importGraph(exportGraph(s))));document.getElementById('result').textContent='1,501 synthetic people saved. Open the Orbit preview to test the graph.';
};
