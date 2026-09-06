import {profileURL,listURL,normalizeEvidence} from './core.js';

const values=value=>Array.isArray(value)?value:value&&typeof value==='object'?Object.values(value):[];
const text=(value,max=1000)=>String(value??'').slice(0,max);
const validDate=(value,fallback)=>Number.isFinite(Date.parse(value))?new Date(value).toISOString():fallback;
const personId=value=>profileURL(value?.id||value?.url||value?.profileUrl||value?.linkedinUrl||value?.linkedin_url||value);
const hex=buffer=>[...new Uint8Array(buffer)].map(byte=>byte.toString(16).padStart(2,'0')).join('');

async function sha256(value){return hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));}

export async function prepareImport(data,rawText,fileName='network.json'){
  if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Choose a JSON object containing people or connection data.');
  const now=new Date().toISOString(),people=values(data.nodes??data.profiles??data.people),links=values(data.edges??data.connections??data.relationships??data.links);
  if(!people.length&&!links.length&&!values(data.commentObservations).length)throw Error('No people or connections were recognized. Supported fields include profiles/connections, nodes/edges, people/relationships, and people/links.');
  const nodes=new Map(),addPerson=value=>{const id=personId(value);if(!id)return false;const old=nodes.get(id)||{};nodes.set(id,{id,url:id,name:text(value?.name||value?.fullName||value?.displayName||old.name,200),headline:text(value?.headline||value?.title||old.headline,1000),location:text(value?.location||old.location,300),firstSeen:validDate(value?.firstSeen,old.firstSeen||now),lastSeen:validDate(value?.lastSeen,old.lastSeen||now)});return true;};
  let skippedPeople=0;for(const person of people)if(!addPerson(person))skippedPeople++;
  for(const detail of values(data.profileDetails))addPerson(detail?.person);
  for(const comment of values(data.commentObservations)){addPerson(comment?.commenter);addPerson(comment?.author);}
  const edges=[],edgeKeys=new Map();let skippedConnections=0;
  const merge=(source,target,evidence,link={})=>{
    if(!evidence.length)return false;
    const id=[source,target].sort().join('|'),existing=edgeKeys.get(id);
    if(existing){for(const item of evidence)if(!existing.evidence.some(old=>old.url===item.url))existing.evidence.push(item);return true;}
    const edge={id,source,target,directed:false,weight:1,firstSeen:validDate(link.firstSeen,now),lastSeen:validDate(link.lastSeen,now),evidence};
    edgeKeys.set(id,edge);edges.push(edge);return true;
  };
  const observation=(item,source,target,fallback,kind)=>{
    const comment=item?.type==='comment_interaction'||item?.kind==='comment_interaction'||kind==='commented_on_post';
    if(comment)return normalizeEvidence({...item,type:'comment_interaction',post:item.post||item.url,commentId:item.commentId||item.comment_id,commenter:personId(item.commenter)||(kind==='commented_on_post'?source:null),author:personId(item.author)||(kind==='commented_on_post'?target:null),observedAt:validDate(item.observedAt||item.lastSeen||item.firstSeen||item.last_seen||item.first_seen,fallback)},source,target);
    const url=listURL(typeof item==='string'?item:item?.url||item?.source||item?.listUrl);
    return url?normalizeEvidence({url,observedAt:validDate(item?.observedAt||item?.lastSeen||item?.firstSeen,fallback)},source,target):null;
  };
  for(const link of links){
    const source=profileURL(link?.source||link?.from||link?.sourceId||link?.person1),target=profileURL(link?.target||link?.to||link?.targetId||link?.person2);if(!source||!target||source===target){skippedConnections++;continue;}
    addPerson(source);addPerson(target);const fallback=validDate(link?.lastSeen||link?.firstSeen,now),evidence=[];
    const observations=values(link?.evidence??link?.observations??link?.sources);
    for(const item of observations){const e=observation(item,source,target,fallback,link.kind);if(e)evidence.push(e);}
    const direct=listURL(link?.evidenceUrl||link?.listUrl);if(direct)evidence.push({url:direct,type:'visible_connection_list',observedAt:fallback});
    if(!merge(source,target,evidence,link))skippedConnections++;
  }
  for(const comment of values(data.commentObservations)){
    const source=personId(comment.commenter),target=personId(comment.author);
    const e=observation({...comment,type:'comment_interaction',commenter:source,author:target},source,target,now);
    if(e){addPerson(comment.commenter);addPerson(comment.author);merge(source,target,[e],comment);}else skippedConnections++;
  }
  const importId=await sha256(rawText),metadata={},records=[];
  for(const [section,value] of Object.entries(data)){if(Array.isArray(value)){value.forEach((record,index)=>records.push({importId,section:text(section,100),index,data:record}));}else metadata[section]=value;}
  return {nodes:[...nodes.values()],edges,imports:[{id:importId,fileName:text(fileName,255),format:text(data.format||'unknown',100),schemaVersion:text(data.schemaVersion||'',40),exportedAt:validDate(data.exportedAt,now),metadata}],records,skippedPeople,skippedConnections,sourceCounts:{people:people.length,connections:links.length,records:records.length}};
}
