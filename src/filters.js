import {normalizeSearch,queryExpansions,scorePerson} from './search.js';
// Categories are display estimates, never asserted profile facts.
const fields=[['Healthcare & life sciences',/\b(healthcare|health care|health sciences?|medicine|medical|med school|pre[- ]?med(?:ical)?|physician|doctor|nurs(?:e|ing)|clinical|hospital|pharma(?:cy|ceutical)?|dent(?:al|istry|ist)|public health|life sciences?|bio|biology|biological|biochemistry|biotech(?:nology)?|biomedical|neuroscience|genetics?|genomics?|epidemiology|immunology|microbiology|physiology|anatomy)\b/i],['Technology',/\b(software|developer|programmer|data scientist|engineering|engineer|technology|cybersecurity|IT|machine learning|artificial intelligence)\b/i],['Finance',/\b(finance|financial|banking|investor|investment|accountant|accounting)\b/i],['Education & research',/\b(student|professor|teacher|education|research|university|academic)\b/i],['Design & creative',/\b(design|designer|creative|artist|writer|ux|ui)\b/i],['Marketing & sales',/\b(marketing|sales|brand|advertising|communications)\b/i],['Operations & people',/\b(operations|recruiter|recruiting|human resources|logistics|supply chain)\b/i],['Legal',/\b(lawyer|legal|attorney|law)\b/i]];
export function locationOf(p){return p.location?.trim().replace(/\s+/g,' ').toLowerCase()||'Not specified';}
export function fieldOf(p){const text=[p.headline,p.about,p.experience,p.education,p.skills].filter(Boolean).join(' ');return p.industry?.trim()||p.field?.trim()||fields.find(([,pattern])=>pattern.test(text))?.[0]||(text.trim()?'Other / unclassified':'Not specified');}
export function keywordTerms(value){
 const terms=Array.isArray(value)?value:String(value||'').split(/[\n,]/),seen=new Set(),out=[];
 for(const raw of terms){const term=String(raw||'').trim().replace(/\s+/g,' '),key=normalizeSearch(term);if(!key||term.length>60||seen.has(key))continue;seen.add(key);out.push(term);if(out.length===8)break;}
 return out;
}
export function keywordMatches(p,terms=[]){const text=normalizeSearch([p.name,p.headline,p.location,p.about,p.experience,p.education,p.skills,p.keywords].filter(Boolean).join(' '));return keywordTerms(terms).filter(term=>queryExpansions(term).some(value=>text.includes(value))||scorePerson(p,term).score>=70);}
export function keywordGroupOf(p,terms=[]){const matches=keywordMatches(p,terms);return matches.length?`Matches: ${matches.join(' + ')}`:'No keyword match';}
export function matchesFilters(p,{location='',field='',keywords=[],keywordOnly=false,first=true,second=true,extended=true}={}){return (p.depth===1?first:p.depth===2?second:p.depth>2?extended:true)&&(!location||locationOf(p)===location)&&(!field||fieldOf(p)===field)&&(!keywordOnly||keywordMatches(p,keywords).length>0);}
export function springProgress(t){if(t>=1)return 1;if(t<=0)return 0;return 1-Math.exp(-7*t)*Math.cos(10*t);}
export function groupTargets(points,by,keywords=[]){
 const groups=new Map();for(const p of points){const key=by==='location'?locationOf(p):by==='keyword'?keywordGroupOf(p,keywords):fieldOf(p);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(p);}
 const ordered=[...groups].sort(([a],[b])=>a.localeCompare(b)),columns=Math.ceil(Math.sqrt(ordered.length)),maxSize=Math.max(1,...ordered.map(([,p])=>p.length)),cell=Math.max(220,Math.sqrt(maxSize)*26+100),rows=Math.ceil(ordered.length/columns),targets=new Map(),labels=[];
 ordered.forEach(([name,members],i)=>{const cx=(i%columns-(columns-1)/2)*cell,cy=(Math.floor(i/columns)-(rows-1)/2)*cell;members.sort((a,b)=>a.id.localeCompare(b.id)).forEach((p,j)=>{const r=12*Math.sqrt(j),angle=j*2.3999632297;targets.set(p.id,{x:cx+Math.cos(angle)*r,y:cy+Math.sin(angle)*r});});labels.push({name,count:members.length,x:cx,y:cy-cell/2+20});});
 return {targets,labels};
}
