import {profileURL} from './core.js';
const stopWords=new Set(['a','an','and','at','for','in','of','on','the','to','with']);
const aliasGroups=[
  ['sjsu','san jose state','san jose state university'],
  ['cal poly','calpoly','cpslo','california polytechnic state university','california polytechnic state university san luis obispo'],
  ['ucb','uc berkeley','university of california berkeley','cal berkeley'],
  ['la','los angeles','greater los angeles','los angeles metropolitan area','ucla','uc los angeles','university of california los angeles'],['ucsd','uc san diego','university of california san diego'],
  ['ucsb','uc santa barbara','university of california santa barbara'],['ucd','uc davis','university of california davis'],
  ['uci','uc irvine','university of california irvine'],['ucr','uc riverside','university of california riverside'],
  ['ucsc','uc santa cruz','university of california santa cruz'],['usc','university of southern california'],
  ['cs','computer science'],['ce','computer engineering'],['ee','electrical engineering'],
  ['swe','software engineer','software engineering'],['ml','machine learning'],['ai','artificial intelligence'],
  ['bio','biology','biological sciences'],['premed','pre med','pre medical'],['biotech','biotechnology'],['med school','medical school'],
  ['bme','biomedical engineering'],['biochem','biochemistry'],['neuro','neuroscience'],['ph','public health'],
  ['fintech','financial technology'],['vc','venture capital'],['pm','product manager','product management'],
  ['sf','san francisco'],['sfba','bay area','san francisco bay area'],['sac','sacramento','greater sacramento','sacramento metropolitan area'],['nyc','new york city']
];
const searchableFields=['name','headline','location','about','experience','education','skills','keywords'];

export function normalizeSearch(value){return String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();}
function words(value){return normalizeSearch(value).split(' ').filter(Boolean);}
function acronym(value){const keep=words(value).filter(word=>!stopWords.has(word));return keep.length>=2&&keep.length<=8?keep.map(word=>word[0]).join(''):'';}
export function queryExpansions(query){
  const q=normalizeSearch(query),out=new Set(q?[q]:[]);if(!q)return [];
  // Short aliases such as LA, SF and AI must be whole tokens. Substring matching
  // made searches such as "Clara" accidentally expand to Los Angeles.
  const padded=` ${q} `;
  for(const group of aliasGroups)if(group.some(alias=>q===alias||(alias.length>3&&padded.includes(` ${alias} `))))for(const alias of group)out.add(alias);
  return [...out].slice(0,20);
}
export function buildKeywords(person){
  const values=searchableFields.filter(key=>key!=='keywords').map(key=>normalizeSearch(person?.[key])).filter(Boolean),out=new Set();
  for(const value of values){out.add(value);for(const token of words(value))if(token.length>1)out.add(token);
    for(const segment of value.split(/\b(?:at|from|with|and)\b|[|,;/@()\u2022\u00b7]/).map(normalizeSearch).filter(Boolean)){const short=acronym(segment);if(short.length>=2)out.add(short);}
    const tokens=words(value);for(let end=0;end<tokens.length;end++)if(/^(university|college|institute|school|polytechnic)$/.test(tokens[end]))for(let size=2;size<=6&&end-size+1>=0;size++){const short=acronym(tokens.slice(end-size+1,end+1).join(' '));if(short.length>=2)out.add(short);}
  }
  const joined=values.join(' ');for(const group of aliasGroups)if(group.some(alias=>joined.includes(alias)))for(const alias of group)out.add(alias);
  return [...out].join(' ').slice(0,6000);
}
export function searchDocument(person){return normalizeSearch(searchableFields.map(key=>person?.[key]).filter(Boolean).join(' '));}
function editDistance(a,b){
  if(a===b)return 0;if(!a.length)return b.length;if(!b.length)return a.length;let before=null,previous=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){const current=[i];for(let j=1;j<=b.length;j++){current[j]=Math.min(current[j-1]+1,previous[j]+1,previous[j-1]+(a[i-1]===b[j-1]?0:1));if(before&&i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])current[j]=Math.min(current[j],before[j-2]+1);}before=previous;previous=current;}return previous[b.length];
}
function tokenSimilarity(a,b){if(a===b)return 1;if(a.length>=3&&b.length>=3&&(a.startsWith(b)||b.startsWith(a)))return .9-Math.abs(a.length-b.length)*.025;const max=Math.max(a.length,b.length),allowed=max>=10?3:max>=6?2:1,distance=Math.abs(a.length-b.length)>allowed?allowed+1:editDistance(a,b);return distance<=allowed?1-distance/max:0;}
export function scorePerson(person,query){
  const profile=profileURL(query);if(profile)return {score:profileURL(person?.url||person?.id)===profile?100:0,reason:'Exact profile URL'};
  const q=normalizeSearch(query);if(!q)return {score:1,reason:''};const doc=searchDocument(person),name=normalizeSearch(person?.name),tokens=[...new Set(doc.split(' '))],expansions=queryExpansions(q);let score=0,reason='Related profile information';
  for(const term of expansions){const escaped=term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),whole=new RegExp(`(?:^| )${escaped}(?: |$)`);if(name===term){score=Math.max(score,100);reason='Exact name';}else if(name.startsWith(term)){score=Math.max(score,92);reason='Name starts with this';}else if(whole.test(name)){score=Math.max(score,88);reason='Name match';}else if(name.includes(term)){score=Math.max(score,82);reason='Name contains this';}else if(whole.test(doc)){score=Math.max(score,72);reason='Profile detail match';}}
  const queryTokens=words(q).filter(token=>token.length>=3&&!stopWords.has(token));if(queryTokens.length){let matched=0,total=0,exact=0;const minimum=queryTokens.length===1?.8:.74;for(const queryToken of queryTokens){let best=0;for(const token of tokens){best=Math.max(best,tokenSimilarity(queryToken,token));if(best===1)break;}if(best>=minimum){matched++;total+=best;if(best===1)exact++;}}const coverage=matched/queryTokens.length;if(matched&&(queryTokens.length===1||coverage>=.6)){const fuzzy=Math.round(42+coverage*24+(total/matched)*18);if(fuzzy>score){score=fuzzy;reason=exact===queryTokens.length?'Related keyword match':coverage===1?'Close spelling or term match':'Related profile terms';}}}
  return {score,reason};
}
export function rankPeople(people,query,limit=30){return people.map(person=>({...person,...scorePerson(person,query)})).filter(person=>person.score>0).sort((a,b)=>b.score-a.score||String(a.name).localeCompare(String(b.name))).slice(0,limit);}
export function ftsQuery(query){
  const terms=new Set();for(const value of queryExpansions(query)){if(value.length>=3)terms.add(value);for(const token of words(value))if(token.length>=4)for(let i=0;i<=token.length-3;i++)terms.add(token.slice(i,i+3));}
  return [...terms].slice(0,40).map(term=>`"${term.replaceAll('"','""')}"`).join(' OR ');
}
