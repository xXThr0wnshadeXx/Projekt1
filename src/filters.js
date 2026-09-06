import {normalizeSearch,queryExpansions,scorePerson} from './search.js';
// Categories are display estimates, never asserted profile facts.
const fields=[['Healthcare & life sciences',/\b(healthcare|health care|health sciences?|medicine|medical|med school|pre[- ]?med(?:ical)?|physician|doctor|nurs(?:e|ing)|clinical|hospital|pharma(?:cy|ceutical)?|dent(?:al|istry|ist)|public health|life sciences?|bio|biology|biological|biochemistry|biotech(?:nology)?|biomedical|neuroscience|genetics?|genomics?|epidemiology|immunology|microbiology|physiology|anatomy)\b/i],['Technology',/\b(software|developer|programmer|data scientist|engineering|engineer|technology|cybersecurity|IT|machine learning|artificial intelligence)\b/i],['Finance',/\b(finance|financial|banking|investor|investment|accountant|accounting)\b/i],['Education & research',/\b(student|professor|teacher|education|research|university|academic)\b/i],['Design & creative',/\b(design|designer|creative|artist|writer|ux|ui)\b/i],['Marketing & sales',/\b(marketing|sales|brand|advertising|communications)\b/i],['Operations & people',/\b(operations|recruiter|recruiting|human resources|logistics|supply chain)\b/i],['Legal',/\b(lawyer|legal|attorney|law)\b/i]];
export function locationOf(p){return p.location?.trim().replace(/\s+/g,' ').toLowerCase()||'Not specified';}
export function fieldsOf(p){
 const text=[p.headline,p.about,p.experience,p.education,p.skills,p.keywords].flat().filter(Boolean).join(' '),out=[];
 for(const value of [p.industry,p.field]){const clean=String(value||'').trim();if(clean&&!out.some(item=>normalizeSearch(item)===normalizeSearch(clean)))out.push(clean);}
 for(const [name,pattern] of fields)if(pattern.test(text)&&!out.includes(name))out.push(name);
 return out.length?out:[text.trim()?'Other / unclassified':'Not specified'];
}
export function fieldOf(p){return fieldsOf(p)[0];}
export function keywordTerms(value){
 const terms=Array.isArray(value)?value:String(value||'').split(/[\n,]/),seen=new Set(),out=[];
 for(const raw of terms){const term=String(raw||'').trim().replace(/\s+/g,' '),key=normalizeSearch(term);if(!key||term.length>60||seen.has(key))continue;seen.add(key);out.push(term);if(out.length===8)break;}
 return out;
}
export function keywordMatches(p,terms=[]){const text=normalizeSearch([p.name,p.headline,p.location,p.about,p.experience,p.education,p.skills,p.keywords].filter(Boolean).join(' '));return keywordTerms(terms).filter(term=>queryExpansions(term).some(value=>text.includes(value))||scorePerson(p,term).score>=70);}
export function keywordGroupOf(p,terms=[]){const matches=keywordMatches(p,terms);return matches.length?`Matches: ${matches.join(' + ')}`:'No keyword match';}
function fuzzyTextMatch(value,query,threshold=62){
 if(!query)return true;const text=normalizeSearch(value),needle=normalizeSearch(query);if(!needle)return true;
 if(queryExpansions(query).some(term=>text.includes(term)||term.includes(text)))return true;
 return scorePerson({name:value,headline:value,location:value,education:value,experience:value,skills:value},query).score>=threshold;
}
export function locationMatches(p,query=''){return fuzzyTextMatch(locationOf(p),query,58);}
export function fieldMatches(p,query=''){
 if(!query)return true;const categories=fieldsOf(p),source=[...categories,p.industry,p.field,p.headline,p.about,p.education,p.experience,p.skills].flat().filter(Boolean).join(' ');
 return categories.some(value=>fuzzyTextMatch(value,query,58))||fuzzyTextMatch(source,query,68);
}
export function matchesFilters(p,{location='',field='',keywords=[],keywordOnly=false,first=true,second=true,extended=true}={}){
 const terms=keywordTerms(keywords),depth=p.depth===1?first:p.depth===2?second:p.depth>2?extended:true;
 return depth&&locationMatches(p,location)&&fieldMatches(p,field)&&(!terms.length||keywordMatches(p,terms).length>0);
}
export function springProgress(t){if(t>=1)return 1;if(t<=0)return 0;return 1-Math.exp(-7*t)*Math.cos(10*t);}
export function groupTargets(points,by,keywords=[]){
 const groups=new Map();for(const p of points){const key=by==='location'?locationOf(p):by==='keyword'?keywordGroupOf(p,keywords):fieldOf(p);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(p);}
 const ordered=[...groups].sort(([a],[b])=>a.localeCompare(b)),columns=Math.ceil(Math.sqrt(ordered.length)),maxSize=Math.max(1,...ordered.map(([,p])=>p.length)),cell=Math.max(220,Math.sqrt(maxSize)*26+100),rows=Math.ceil(ordered.length/columns),targets=new Map(),labels=[];
 ordered.forEach(([name,members],i)=>{const cx=(i%columns-(columns-1)/2)*cell,cy=(Math.floor(i/columns)-(rows-1)/2)*cell;members.sort((a,b)=>a.id.localeCompare(b.id)).forEach((p,j)=>{const r=12*Math.sqrt(j),angle=j*2.3999632297;targets.set(p.id,{x:cx+Math.cos(angle)*r,y:cy+Math.sin(angle)*r});});labels.push({name,count:members.length,x:cx,y:cy-cell/2+20});});
 return {targets,labels};
}
