import {createHash} from 'node:crypto';
import {DiscoveryError,publicUrl,normalizeProfileUrl,type DateValue} from './contracts.js';
import {PublicHttpClient,responseText} from './providers/http.js';

export interface RetrievedPublicDocument {
  /** Revision identifies an immutable retrieval observation, including retrievedAt; digest identifies text. */
  id: string; revision: string; sourceUrl: string; fetchedUrl: string; title: string;
  publisher: string|null; publishedAt: DateValue|null; retrievedAt: string;
  contentDigest: string; digestBasis: 'NORMALIZED_TEXT_SHA256';
  normalizedText: string; upstreamRevisionId: string|null;
  normalizationVersion: 'public-source-text-v1';
  persistence: 'NOT_PERSISTED'; metadataStatus: 'SOURCE_SUPPLIED_NOT_VERIFIED';
}
export interface DocumentExcerpt {
  documentId: string; documentRevision: string; contentDigest: string; supportingExcerpt: string;
  locator: {start: number; end: number; section: null};
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function normalize(value: string): string {return value.normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();}
function entities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp);/gi,(original,key:string)=>{
    const named: Record<string,string> = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
    if (!key.startsWith('#')) return named[key.toLowerCase()]??original;
    const point = key[1]!.toLowerCase()==='x' ? parseInt(key.slice(2),16) : Number(key.slice(1));
    return point>0 && point<=0x10ffff && !(point>=0xd800&&point<=0xdfff) ? String.fromCodePoint(point) : ' ';
  });
}
function attributes(tag: string): Record<string,string> {
  const attrs: Record<string,string> = {};
  const body = tag.replace(/^<\/?[a-z0-9:-]+/i,'').replace(/\/?\s*>$/,'');
  const pattern = /([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s<>]+)))?/g;
  for (const match of body.matchAll(pattern)) {
    const key = match[1]!.toLowerCase();
    if (Object.hasOwn(attrs,key)) throw new DiscoveryError('UNSUPPORTED_CONTENT');
    attrs[key] = entities(match[2]??match[3]??match[4]??'');
  }
  return attrs;
}
function publication(value: string|undefined): DateValue|null {
  if (!value) return null;
  const calendar=/^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!calendar || !Number.isFinite(Date.parse(`${calendar[0]}T00:00:00Z`)) || new Date(`${calendar[0]}T00:00:00Z`).toISOString().slice(0,10)!==calendar[0]) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value) return {value,precision:'DAY'};
  if (/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))) return {value:new Date(value).toISOString(),precision:'SECOND'};
  return null;
}
/** Conservative source-text extraction, not a browser DOM/visibility or semantic claim extractor.
 * Raw script/style/template/form contents and comments never become citation text. Unknown entities
 * remain literal. Malformed tags/raw-text blocks fail closed; no remote resources are evaluated. */
export function normalizePublicContent(content: string, html: boolean): {text:string;title:string;publisher:string|null;publishedAt:DateValue|null} {
  if (!html) return {text:normalize(content),title:'',publisher:null,publishedAt:null};
  const output: string[] = [], metadata: Record<string,string> = {};
  let cursor=0, title='', inHead=false;
  while (cursor < content.length) {
    const open = content.indexOf('<',cursor);
    if (open<0) {if(!inHead)output.push(content.slice(cursor));break;}
    if (!inHead) output.push(content.slice(cursor,open));
    if (content.startsWith('<!--',open)) {const end=content.indexOf('-->',open+4);if(end<0)throw new DiscoveryError('UNSUPPORTED_CONTENT');cursor=end+3;continue;}
    let end=open+1, quote='';
    for (;end<content.length;end++) {const c=content[end]!;if(quote){if(c===quote)quote='';}else if(c==='"'||c==="'"){quote=c;}else if(c==='>')break;}
    if (end>=content.length) throw new DiscoveryError('UNSUPPORTED_CONTENT');
    const tag=content.slice(open,end+1), parsed=/^<\s*(\/?)\s*([a-z][a-z0-9:-]*)\b/i.exec(tag);
    cursor=end+1;
    if (!parsed) {if(!/^<!doctype\b/i.test(tag))throw new DiscoveryError('UNSUPPORTED_CONTENT');continue;}
    const name=parsed[2]!.toLowerCase(), closing=Boolean(parsed[1]);
    if (name==='head') {inHead=!closing;continue;}
    const attrs=closing?{}:attributes(tag);
    if (name==='input' && attrs.type?.toLowerCase()==='password') throw new DiscoveryError('ACCESS_DENIED');
    if (name==='meta' && !closing) {
      const key=(attrs.property??attrs.name??'').toLowerCase();
      if (key==='robots' && /(?:noai|noimageai|none)/i.test(attrs.content??'')) throw new DiscoveryError('ACCESS_DENIED');
      if (['og:title','og:site_name','article:published_time','datepublished'].includes(key) && attrs.content) metadata[key]=attrs.content;
    }
    if (!closing && ['script','style','template','noscript','svg','form','title'].includes(name)) {
      const pattern=new RegExp(`</${name}\\s*>`,'ig');pattern.lastIndex=cursor;
      const close=pattern.exec(content);if(!close)throw new DiscoveryError('UNSUPPORTED_CONTENT');
      if(name==='title')title=normalize(entities(content.slice(cursor,close.index).replace(/<[^>]*>/g,' ')));
      if(name==='form' && /type\s*=\s*["']?password/i.test(content.slice(cursor,close.index)))throw new DiscoveryError('ACCESS_DENIED');
      cursor=close.index+close[0].length;continue;
    }
    if (!inHead && ['p','div','br','li','section','article','h1','h2','h3','td','tr','header','footer'].includes(name)) output.push(' ');
  }
  return {text:normalize(entities(output.join(''))),title:normalize(title||metadata['og:title']||'').slice(0,500),
    publisher:metadata['og:site_name']?normalize(metadata['og:site_name']).slice(0,300):null,
    publishedAt:publication(metadata['article:published_time']??metadata.datepublished)};
}
function pathOctets(value: string): string {
  return value.replace(/%[0-9a-f]{2}|[^\x00-\x7f]/gi,part=>{
    if(part.startsWith('%')) {const decoded=String.fromCharCode(parseInt(part.slice(1),16));return /^[A-Za-z0-9._~-]$/.test(decoded)?decoded:part.toUpperCase();}
    return encodeURIComponent(part);
  });
}
// Greedy wildcard matching avoids regex backtracking on untrusted robots rules.
function glob(pattern: string, value: string): boolean {
  let p=0,v=0,star=-1,retry=0;
  while(v<value.length) {if(pattern[p]===value[v]){p++;v++;}else if(pattern[p]==='*'){star=p++;retry=v;}else if(star>=0){p=star+1;v=++retry;}else return false;}
  while(pattern[p]==='*')p++;return p===pattern.length;
}
export function robotsAllowed(text: string, path: string, agent: string): boolean {
  const groups: Array<{agents:string[];rules:Array<{allow:boolean;path:string}>}> = [];
  let group: typeof groups[number]|undefined;
  for(const raw of text.split(/\r\n|\r|\n/)) {
    const line=raw.split('#')[0]!.trim();if(!line)continue;
    const colon=line.indexOf(':');if(colon<0)continue;
    const key=line.slice(0,colon).trim().toLowerCase(), value=line.slice(colon+1).trim();
    if(key==='user-agent') {if(!group||group.rules.length){group={agents:[],rules:[]};groups.push(group);}group.agents.push(value.toLowerCase());}
    else if((key==='allow'||key==='disallow')&&group&&value) {
      if(!value.startsWith('/')||value.length>2048)throw new DiscoveryError('ACCESS_DENIED');
      group.rules.push({allow:key==='allow',path:pathOctets(value)});
    }
  }
  let selected=groups.filter(g=>g.agents.includes(agent.toLowerCase()));
  if(!selected.length)selected=groups.filter(g=>g.agents.includes('*'));
  const target=pathOctets(path);let longest=-1,allowed=true;
  for(const rule of selected.flatMap(g=>g.rules)) {
    const end=rule.path.endsWith('$'), pattern=end?rule.path.slice(0,-1):`${rule.path}*`;
    const length=Buffer.byteLength(rule.path.replace(/\*/g,'').replace(/\$$/,''));
    if(glob(pattern,target)&&(length>longest||(length===longest&&rule.allow))){longest=length;allowed=rule.allow;}
  }
  return allowed;
}
export class PublicDocumentFetcher {
  constructor(private readonly http: PublicHttpClient, private readonly now: ()=>Date = ()=>new Date()) {}
  async fetch(value: string, parentSignal: AbortSignal): Promise<RetrievedPublicDocument> {
    const source=publicUrl(value);let current=source;
    const signal=AbortSignal.any([parentSignal,AbortSignal.timeout(8000)]);
    const checkedOrigins=new Map<string,string|null>();
    for(let redirects=0;redirects<=2;redirects++) {
      // Social anchors permit individual public profile pages only, not API/account/list endpoints.
      if (/(^|\.)linkedin\.com$/.test(current.hostname)) current=new URL(normalizeProfileUrl(current.href,'linkedin'));
      if (/(^|\.)instagram\.com$/.test(current.hostname)) current=new URL(normalizeProfileUrl(current.href,'instagram'));
      // Reject account/login/challenge routes instead of collecting an interstitial or probing lists.
      let decodedPath:string;try{decodedPath=decodeURIComponent(current.pathname);}catch{throw new DiscoveryError('ACCESS_DENIED');}
      if(/\/(?:login|signin|auth|accounts|checkpoint|challenge|followers|following)(?:\/|$)/i.test(decodedPath))throw new DiscoveryError('ACCESS_DENIED');
      if(!checkedOrigins.has(current.origin)) {
        const robots=await this.http.get(`${current.origin}/robots.txt`,{signal,maxBytes:64*1024,accept:'text/plain'});
        if(robots.status===404)checkedOrigins.set(current.origin,null);
        else if(robots.status===200 && /^text\/plain(?:\s*;|$)/i.test(robots.headers['content-type']??''))checkedOrigins.set(current.origin,responseText(robots));
        else throw new DiscoveryError('ACCESS_DENIED'); // Conservative: no robots redirects or unavailable-policy bypass.
      }
      const robots=checkedOrigins.get(current.origin);
      if(robots!==null && robots!==undefined && !robotsAllowed(robots,current.pathname+current.search,this.http.agentToken))throw new DiscoveryError('ACCESS_DENIED');
      const response=await this.http.get(current.href,{signal,maxBytes:1024*1024});
      if([301,302,303,307,308].includes(response.status)) {
        if(redirects===2||!response.headers.location)throw new DiscoveryError('ACCESS_DENIED');
        let next:URL;try{next=new URL(response.headers.location,current);}catch{throw new DiscoveryError('ACCESS_DENIED');}
        current=publicUrl(next.href);continue;
      }
      if(response.status!==200)throw new DiscoveryError([401,403,429,451].includes(response.status)?'ACCESS_DENIED':'SOURCE_UNAVAILABLE');
      if(/(?:noai|noimageai|none)/i.test(response.headers['x-robots-tag']??''))throw new DiscoveryError('ACCESS_DENIED');
      const type=(response.headers['content-type']??'').split(';')[0]!.trim().toLowerCase();
      if(!['text/html','text/plain'].includes(type))throw new DiscoveryError('UNSUPPORTED_CONTENT');
      const normalized=normalizePublicContent(responseText(response),type==='text/html');
      if(!normalized.text)throw new DiscoveryError('UNSUPPORTED_CONTENT');
      const contentDigest=digest(normalized.text),id=`doc_${digest(source.href)}`,retrievedAt=this.now().toISOString();
      // An immutable observation binds its actual retrieval time as well as content and source metadata.
      // Reusing an observation preserves this revision; a later retrieval requires fresh review selectors.
      const revision=digest(JSON.stringify([current.href,contentDigest,normalized.title,normalized.publisher,normalized.publishedAt,retrievedAt]));
      return {id,revision,sourceUrl:source.href,fetchedUrl:current.href,title:normalized.title||current.hostname,
        publisher:normalized.publisher,publishedAt:normalized.publishedAt,retrievedAt,
        contentDigest,digestBasis:'NORMALIZED_TEXT_SHA256',normalizedText:normalized.text,upstreamRevisionId:null,
        normalizationVersion:'public-source-text-v1',persistence:'NOT_PERSISTED',metadataStatus:'SOURCE_SUPPLIED_NOT_VERIFIED'};
    }
    throw new DiscoveryError('ACCESS_DENIED');
  }
}
/** Produces an exact document excerpt only: no relationship, identity mapping or confidence assertion. */
export function selectDocumentExcerpt(document: RetrievedPublicDocument, start: number, end: number): DocumentExcerpt {
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>document.normalizedText.length||end-start>500||digest(document.normalizedText)!==document.contentDigest)throw new DiscoveryError('INVALID_INPUT');
  const supportingExcerpt=document.normalizedText.slice(start,end);
  if(!supportingExcerpt.trim())throw new DiscoveryError('INVALID_INPUT');
  return {documentId:document.id,documentRevision:document.revision,contentDigest:document.contentDigest,supportingExcerpt,locator:{start,end,section:null}};
}
