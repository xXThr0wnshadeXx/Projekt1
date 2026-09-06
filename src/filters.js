import {normalizeSearch,queryExpansions,scorePerson} from './search.js';
// Categories are display estimates, never asserted profile facts.
const fields=[['Healthcare & life sciences',/\b(healthcare|health care|health sciences?|medicine|medical|med school|pre[- ]?med(?:ical)?|physician|doctor|nurs(?:e|ing)|clinical|hospital|pharma(?:cy|ceutical)?|dent(?:al|istry|ist)|public health|life sciences?|bio|biology|biological|biochemistry|biotech(?:nology)?|biomedical|neuroscience|genetics?|genomics?|epidemiology|immunology|microbiology|physiology|anatomy)\b/i],['Technology',/\b(software|developer|programmer|data scientist|engineering|engineer|technology|cybersecurity|IT|machine learning|artificial intelligence)\b/i],['Finance',/\b(finance|financial|banking|investor|investment|accountant|accounting)\b/i],['Education & research',/\b(student|professor|teacher|education|research|university|academic)\b/i],['Design & creative',/\b(design|designer|creative|artist|writer|ux|ui)\b/i],['Marketing & sales',/\b(marketing|sales|brand|advertising|communications)\b/i],['Operations & people',/\b(operations|recruiter|recruiting|human resources|logistics|supply chain)\b/i],['Legal',/\b(lawyer|legal|attorney|law)\b/i]];
const locationRules=[
 ['sacramento area','Sacramento Area',/\b(greater sacramento|sacramento(?: metropolitan)? area|sacramento|folsom|el dorado hills|roseville|rocklin|uc davis|university of california davis|sacramento state|sac state)\b/],
 ['san francisco bay area','San Francisco Bay Area',/\b(sfba|san francisco bay area|bay area|san francisco|san mateo|oakland|berkeley|uc berkeley|university of california berkeley|cal berkeley|san jose|sjsu|san jose state(?: university)?|santa clara|palo alto|fremont|cupertino|mountain view)\b/],
 ['los angeles area','Los Angeles Area',/\b(greater los angeles|los angeles(?: metropolitan)? area|los angeles|ucla|uc los angeles|university of california los angeles|usc|university of southern california|pasadena|long beach|santa monica|westwood)\b/],
 ['san diego area','San Diego Area',/\b(san diego|ucsd|uc san diego|university of california san diego|la jolla)\b/]
];
const genericLocations=/^(united states(?: of america)?|usa|us|california|ca)$/;
function cleanLocation(value){return String(value||'').trim().replace(/\s+/g,' ');}
function ruleFor(value){const normalized=normalizeSearch(value);return locationRules.find(([, ,pattern])=>pattern.test(normalized));}
function locationInfo(p){
 const explicit=cleanLocation(p.location),explicitNormalized=normalizeSearch(explicit),explicitRule=ruleFor(explicit);
 if(explicitRule)return {key:explicitRule[0],label:explicitRule[1],search:[explicit,explicitRule[1]].join(' '),inferred:false};
 if(explicitNormalized&&!genericLocations.test(explicitNormalized))return {key:explicitNormalized,label:explicit,search:explicit,inferred:false};
 // Only infer a place when LinkedIn did not provide a useful location. Known
 // schools and city clues are evidence; arbitrary biography words are not.
 const clues=[p.headline,p.education,p.experience,p.about,p.keywords].flat().filter(Boolean).join(' '),inferredRule=ruleFor(clues);
 if(inferredRule)return {key:inferredRule[0],label:inferredRule[1],search:[explicit,clues,inferredRule[1]].join(' '),inferred:true};
 return {key:'Not specified',label:'Not specified',search:explicit||clues,inferred:false};
}
export function locationOf(p){return locationInfo(p).key;}
export function locationLabelOf(p){return locationInfo(p).label;}
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
function compactLocationLabel(value){return String(value||'Not specified').replace(/,\s*United States$/i,'').replace(/,\s*USA$/i,'').trim();}
function fuzzyTextMatch(value,query,threshold=62){
 if(!query)return true;const text=normalizeSearch(value),needle=normalizeSearch(query);if(!needle)return true;
 if(queryExpansions(query).some(term=>text.includes(term)||term.includes(text)))return true;
 return scorePerson({name:value,headline:value,location:value,education:value,experience:value,skills:value},query).score>=threshold;
}
export function locationMatches(p,query=''){const info=locationInfo(p);return fuzzyTextMatch([info.key,info.label,info.search].join(' '),query,58);}
export function fieldMatches(p,query=''){
 if(!query)return true;const categories=fieldsOf(p),source=[...categories,p.industry,p.field,p.headline,p.about,p.education,p.experience,p.skills].flat().filter(Boolean).join(' ');
 return categories.some(value=>fuzzyTextMatch(value,query,58))||fuzzyTextMatch(source,query,68);
}
export function matchesFilters(p,{location='',field='',keywords=[],keywordOnly=false,first=true,second=true,extended=true,maxDepth=6}={}){
 const terms=keywordTerms(keywords),within=p.depth===undefined||p.depth===0||p.depth<=Number(maxDepth||6),depth=p.depth===1?first:p.depth===2?second:p.depth>2?extended:true;
 return within&&depth&&(!location||locationMatches(p,location))&&(!field||fieldMatches(p,field))&&(!terms.length||keywordMatches(p,terms).length>0);
}
export function springProgress(t){if(t>=1)return 1;if(t<=0)return 0;return 1-Math.exp(-7*t)*Math.cos(10*t);}
export function groupTargets(points,by,keywords=[]){
 const groups=new Map();
 for(const p of points){
  const key=by==='location'?locationOf(p):by==='keyword'?keywordGroupOf(p,keywords):fieldOf(p);
  if(!groups.has(key))groups.set(key,{name:by==='location'?compactLocationLabel(locationLabelOf(p)):key,members:[]});
  groups.get(key).members.push(p);
 }
 let ordered=[...groups.values()].sort((a,b)=>b.members.length-a.members.length||a.name.localeCompare(b.name));
 // A long tail of one-person locations makes the map unreadable. Keep the
 // strongest clusters and place every remaining person in one honest catch-all.
 if(by==='location'&&ordered.length>12){const kept=ordered.slice(0,11),rest=ordered.slice(11).flatMap(group=>group.members);ordered=[...kept,{name:'Other locations',members:rest}];}
 const naturalColumns=Math.max(1,Math.ceil(Math.sqrt(ordered.length*1.55))),columns=by==='location'?Math.min(3,naturalColumns):naturalColumns,rows=Math.ceil(ordered.length/columns),targets=new Map(),labels=[];
 const metrics=ordered.map(group=>{const radius=Math.max(32,18*Math.sqrt(Math.max(0,group.members.length-1))+22);return {radius,width:Math.max(radius*2+54,Math.min(370,group.name.length*8+90)),height:radius*2+90};});
 const columnWidths=Array.from({length:columns},(_,column)=>Math.max(220,...metrics.filter((_,i)=>i%columns===column).map(item=>item.width))),rowHeights=Array.from({length:rows},(_,row)=>Math.max(190,...metrics.slice(row*columns,(row+1)*columns).map(item=>item.height))),totalWidth=columnWidths.reduce((a,b)=>a+b,0)+(columns-1)*55,totalHeight=rowHeights.reduce((a,b)=>a+b,0)+(rows-1)*55;
 ordered.forEach(({name,members},i)=>{const column=i%columns,row=Math.floor(i/columns),cx=-totalWidth/2+columnWidths.slice(0,column).reduce((a,b)=>a+b,0)+column*55+columnWidths[column]/2,cy=-totalHeight/2+rowHeights.slice(0,row).reduce((a,b)=>a+b,0)+row*55+rowHeights[row]/2,sorted=[...members].sort((a,b)=>a.id.localeCompare(b.id));sorted.forEach((p,j)=>{const r=18*Math.sqrt(j),angle=j*2.3999632297;targets.set(p.id,{x:cx+Math.cos(angle)*r,y:cy+Math.sin(angle)*r});});labels.push({name,count:sorted.length,x:cx,y:cy-metrics[i].radius-31});});
 return {targets,labels,totalGroups:groups.size};
}
