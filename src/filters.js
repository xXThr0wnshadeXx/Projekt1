// Headline categories are display estimates, never asserted profile facts.
const fields=[['Technology',/\b(software|developer|programmer|data scientist|engineering|engineer|technology|cybersecurity|IT)\b/i],['Finance',/\b(finance|financial|banking|investor|investment|accountant|accounting)\b/i],['Healthcare',/\b(healthcare|medical|physician|doctor|nurse|clinical|health)\b/i],['Education & research',/\b(student|professor|teacher|education|research|university|academic)\b/i],['Design & creative',/\b(design|designer|creative|artist|writer|ux|ui)\b/i],['Marketing & sales',/\b(marketing|sales|brand|advertising|communications)\b/i],['Operations & people',/\b(operations|recruiter|recruiting|human resources|logistics|supply chain)\b/i],['Legal',/\b(lawyer|legal|attorney|law)\b/i]];
export function locationOf(p){return p.location?.trim().replace(/\s+/g,' ').toLowerCase()||'Not specified';}
export function fieldOf(p){return p.industry?.trim()||p.field?.trim()||fields.find(([,pattern])=>pattern.test(p.headline||''))?.[0]||(p.headline?.trim()?'Other / unclassified':'Not specified');}
/** Keywords are a display aid. They never assert an affiliation that the saved profile does not say. */
export function keywordTerms(value){
 const terms=Array.isArray(value)?value:String(value||'').split(/[\n,]/),seen=new Set(),out=[];
 for(const raw of terms){const term=String(raw||'').trim().replace(/\s+/g,' '),key=term.toLocaleLowerCase();if(!term||term.length>60||seen.has(key))continue;seen.add(key);out.push(term);if(out.length===8)break;}
 return out;
}
export function profileText(p){return [p.headline,p.location].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();}
export function keywordMatches(p,terms=[]){const text=profileText(p).toLocaleLowerCase();return keywordTerms(terms).filter(term=>text.includes(term.toLocaleLowerCase()));}
export function keywordGroupOf(p,terms=[]){const matches=keywordMatches(p,terms);return matches.length?`Matches: ${matches.join(' + ')}`:'No keyword match';}
export function matchesFilters(p,{location='',field='',keywords=[],keywordOnly=false}={}){return (!location||locationOf(p)===location)&&(!field||fieldOf(p)===field)&&(!keywordOnly||keywordMatches(p,keywords).length>0);}
export function springProgress(t){if(t>=1)return 1;if(t<=0)return 0;return 1-Math.exp(-7*t)*Math.cos(10*t);}
export function groupTargets(points,by,keywords=[]){
 const groups=new Map();for(const p of points){const key=by==='location'?locationOf(p):by==='keyword'?keywordGroupOf(p,keywords):fieldOf(p);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(p);}
 const ordered=[...groups].sort(([a],[b])=>a.localeCompare(b)),columns=Math.ceil(Math.sqrt(ordered.length)),maxSize=Math.max(1,...ordered.map(([,p])=>p.length)),cell=Math.max(220,Math.sqrt(maxSize)*26+100),rows=Math.ceil(ordered.length/columns),targets=new Map(),labels=[];
 ordered.forEach(([name,members],i)=>{const cx=(i%columns-(columns-1)/2)*cell,cy=(Math.floor(i/columns)-(rows-1)/2)*cell;members.sort((a,b)=>a.id.localeCompare(b.id)).forEach((p,j)=>{const r=12*Math.sqrt(j),angle=j*2.3999632297;targets.set(p.id,{x:cx+Math.cos(angle)*r,y:cy+Math.sin(angle)*r});});labels.push({name,count:members.length,x:cx,y:cy-cell/2+20});});
 return {targets,labels};
}
