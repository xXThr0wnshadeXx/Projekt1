import {createHash} from 'node:crypto';
import {parse, type DefaultTreeAdapterTypes} from 'parse5';
import {DiscoveryError,publicUrl,normalizeProfileUrl,type DateValue} from './contracts.js';
import {PublicHttpClient,responseText} from './providers/http.js';
import {type SourceAttribution, validateDocumentAttribution} from './attribution.js';

export interface RetrievedPublicDocument {
  /** Revision identifies an immutable retrieval observation, including retrievedAt; digest identifies text. */
  id: string; revision: string; sourceUrl: string; fetchedUrl: string; title: string;
  publisher: string|null; publishedAt: DateValue|null; retrievedAt: string;
  contentDigest: string; digestBasis: 'NORMALIZED_TEXT_SHA256';
  normalizedText: string; upstreamRevisionId: string|null;
  normalizationVersion: 'public-source-text-v1'|'public-source-attributed-v2';
  persistence: 'NOT_PERSISTED'; metadataStatus: 'SOURCE_SUPPLIED_NOT_VERIFIED';
  attribution?: SourceAttribution|null;
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
    const value = entities(match[2]??match[3]??match[4]??'');
    // Repeated identical attributes are unambiguous; conflicting values still fail closed.
    if (Object.hasOwn(attrs,key) && attrs[key] !== value) throw new DiscoveryError('UNSUPPORTED_CONTENT');
    attrs[key] = value;
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

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;
const element = (node: Node): node is Element => 'tagName' in node;
const attr = (node: Element, name: string): string|undefined => node.attrs.find(a => a.name.toLowerCase() === name)?.value;
function classes(node: Element): Set<string> {return new Set((attr(node, 'class') ?? '').split(/\s+/).filter(Boolean));}
function descendants(node: Node): Node[] {
  const out: Node[] = [];
  const visit = (value: Node) => {out.push(value); if ('childNodes' in value) for (const child of value.childNodes) visit(child);};
  visit(node); return out;
}
function textOf(node: Node): string {
  if (node.nodeName === '#text') return (node as DefaultTreeAdapterTypes.TextNode).value;
  if (!('childNodes' in node) || (element(node) && ['script','style','template','noscript','svg','form'].includes(node.tagName))) return '';
  return node.childNodes.map(textOf).join(' ');
}
function scriptText(node: Element): string {
  return node.childNodes.filter(child => child.nodeName === '#text').map(child => (child as DefaultTreeAdapterTypes.TextNode).value).join('');
}
function parentOf(node: Node): DefaultTreeAdapterTypes.ParentNode|null {
  return 'parentNode' in node ? (node as {parentNode: DefaultTreeAdapterTypes.ParentNode|null}).parentNode : null;
}
function normalizeName(value: string): string {return normalize(entities(value));}
function articleObjects(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return [];
  const root = value as Record<string, unknown>, graph = Array.isArray(root['@graph']) ? root['@graph'] : [root];
  return graph.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object').filter(item => {
    const type = item['@type']; return type === 'Article' || type === 'BlogPosting' || (Array.isArray(type) && type.some(v => v === 'Article' || v === 'BlogPosting'));
  });
}
function exactPublicUrl(value: unknown, expected: string): boolean {
  const raw = typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as Record<string, unknown>)['@id'] === 'string' ? (value as Record<string, string>)['@id'] : null;
  if (!raw) return false;
  try {return publicUrl(raw).href === expected;} catch {return false;}
}
function articleAuthor(value: Record<string, unknown>): string|null {
  const author = value.author;
  const name = typeof author === 'string' ? author : author && typeof author === 'object' && typeof (author as Record<string, unknown>).name === 'string' ? (author as Record<string, string>).name : null;
  return name ? normalizeName(name) : null;
}
function articleHeadline(value: Record<string, unknown>): string|null {
  return typeof value.headline === 'string' ? normalizeName(value.headline) : null;
}
function ancestor(node: Node, predicate: (element: Element) => boolean): boolean {
  let current = parentOf(node);
  while (current && current.nodeName !== '#document') {if (element(current) && predicate(current)) return true; current = parentOf(current);}
  return false;
}
function inNestedArticle(node: Node, article: Element): boolean {
  let current = parentOf(node);
  while (current && current !== article) {if (element(current) && current.tagName === 'article') return true; current = parentOf(current);}
  return false;
}
const contextBlockTags = new Set(['h1','h2','h3','h4','h5','h6','p','li','dt','dd','blockquote']);
const excludedProseAncestors = new Set(['blockquote','q','cite','pre','code']);
const excludedContainerTags = new Set(['aside','nav','footer','form']);
const excludedContainerTokens = /(?:^|[-_\s])(comment|sidebar|footer|related|navigation|nav|menu|next|previous|pagination)(?:$|[-_\s])/i;
const contentContainer = /(?:^|[-_\s])(?:entry|article|post|page)[-_\s]+content(?:$|[-_\s])/i;
function unsafeContainer(node: Node, stop: Node|null = null): boolean {
  let current: Node|null = node;
  while (current && current !== stop && current.nodeName !== '#document') {
    if (element(current) && (excludedContainerTags.has(current.tagName) || excludedContainerTokens.test(`${attr(current,'class') ?? ''} ${attr(current,'id') ?? ''}`))) return true;
    current = parentOf(current);
  }
  return false;
}
function hasContextBlockAncestor(node: Node, article: Element): boolean {
  let current = parentOf(node);
  while (current && current !== article) {
    if (element(current) && contextBlockTags.has(current.tagName) && !(current.tagName === 'li' && element(node) && node.tagName === 'p')) return true;
    current = parentOf(current);
  }
  return false;
}
function hasExcludedProseDescendant(node: Element): boolean {
  return descendants(node).some(child => element(child) && child !== node && excludedProseAncestors.has(child.tagName));
}
function textOutsideParagraphs(node: Node): string {
  if (node.nodeName === '#text') return (node as DefaultTreeAdapterTypes.TextNode).value;
  if (element(node) && node.tagName === 'p') return '';
  return 'childNodes' in node ? node.childNodes.map(textOutsideParagraphs).join(' ') : '';
}
function eligibleParagraphCount(node: Element, container: Element): number {
  return descendants(node).filter(element).filter(child => child.tagName === 'p' && normalizeName(textOf(child)).length > 0 && !inNestedArticle(child, container) && !unsafeContainer(child, container) &&
    !ancestor(child, parent => excludedProseAncestors.has(parent.tagName)) && !hasExcludedProseDescendant(child)).length;
}
/** A deliberately narrow second normalization. It only admits an agreed, source-declared author
 * and direct main-article prose. Scripts and comments remain unavailable as relationship text. */
export function normalizeAttributedPublicContent(content: string, fetchedUrl: string): {text:string;attribution:SourceAttribution}|null {
  let document: DefaultTreeAdapterTypes.Document;
  try {document = parse(content);} catch {return null;}
  const nodes = descendants(document), metas = nodes.filter(element).filter(n => n.tagName === 'meta' && attr(n, 'name')?.toLowerCase() === 'author')
    .map(n => attr(n, 'content')).filter((v): v is string => typeof v === 'string').map(normalizeName);
  const meta = [...new Set(metas)]; if (meta.length !== 1 || !meta[0]) return null;
  const articleDeclarations = nodes.filter(element).filter(n => n.tagName === 'script' && attr(n, 'type')?.toLowerCase() === 'application/ld+json').flatMap(node => {
    try {return articleObjects(JSON.parse(scriptText(node)));} catch {return [];}
  }).filter(item => exactPublicUrl(item.mainEntityOfPage, fetchedUrl));
  const declarationAuthors = articleDeclarations.map(articleAuthor), declarationHeadlines = articleDeclarations.map(articleHeadline);
  if (!articleDeclarations.length || declarationAuthors.some(author => author !== meta[0]) || declarationHeadlines.some(headline => !headline) ||
    new Set(declarationHeadlines).size !== 1) return null;
  const headline = articleHeadline(articleDeclarations[0]!);
  const headings = nodes.filter(element).filter(node => node.tagName === 'h1' && normalizeName(textOf(node)) === headline && !unsafeContainer(node));
  const articleMain = nodes.filter(element).filter(node => node.tagName === 'article' && !unsafeContainer(node) &&
    !ancestor(node, parent => parent.tagName === 'article') && descendants(node).filter(element).some(h => h.tagName === 'h1' && normalizeName(textOf(h)) === headline));
  const fallbackMain = (() => {
    if (headings.length !== 1) return [] as Element[];
    const header = parentOf(headings[0]!); if (!header || !element(header) || unsafeContainer(header)) return [] as Element[];
    const bylines = descendants(header).filter(element).filter(node => normalizeName(textOf(node)).toLocaleLowerCase() === `written by ${meta[0]!.toLocaleLowerCase()}`);
    const shell = parentOf(header); if (bylines.length !== 1 || !shell || !element(shell) || ['html','body'].includes(shell.tagName)) return [] as Element[];
    const siblings = shell.childNodes.filter(element), index = siblings.indexOf(header);
    if (index < 0) return [] as Element[];
    const candidate = siblings[index + 1];
    const semantic = candidate && (attr(candidate,'itemprop') === 'articleBody' || attr(candidate,'role') === 'main' || contentContainer.test(`${attr(candidate,'class') ?? ''} ${attr(candidate,'id') ?? ''}`));
    return candidate && semantic && !['html','body'].includes(candidate.tagName) && !unsafeContainer(candidate, shell) &&
      !descendants(candidate).some(node => element(node) && node !== candidate && node.tagName === 'h1') && eligibleParagraphCount(candidate, candidate) >= 2 ? [candidate] : [];
  })();
  const main = articleMain.length === 1 ? articleMain : articleMain.length === 0 ? fallbackMain : [];
  if (main.length !== 1) return null;
  const blocks = descendants(main[0]!).filter(element).filter(node => contextBlockTags.has(node.tagName) && !inNestedArticle(node, main[0]!) && !unsafeContainer(node, main[0]!) && !hasContextBlockAncestor(node, main[0]!))
    .map(node => ({node,text:normalizeName(node.tagName === 'li' && descendants(node).some(child => element(child) && child.tagName === 'p') ? textOutsideParagraphs(node) : textOf(node))})).filter((item): item is {node: Element; text: string} => Boolean(item.text));
  const eligible = (item: {node: Element; text: string}) => item.node.tagName === 'p' &&
    !ancestor(item.node, parent => excludedProseAncestors.has(parent.tagName)) && !hasExcludedProseDescendant(item.node);
  if (!blocks.some(eligible)) return null;
  const author = meta[0]!, parts = [author, ...blocks.map(item => item.text)]; let cursor = author.length + 1;
  const proseRanges = blocks.map(item => {
    const result = {start: cursor, end: cursor + item.text.length}; cursor = result.end + 1;
    return eligible(item) ? result : null;
  }).filter((range): range is {start: number; end: number} => range !== null);
  const text = parts.join('\n'), attribution: SourceAttribution = {version:'source-declared-author-v1',
    author:{locator:{start:0,end:author.length},declarationKinds:['HTML_META_NAME_AUTHOR','JSONLD_ARTICLE_AUTHOR_NAME']},
    article:{locator:{start:author.length + 1,end:text.length},proseRanges}};
  try {validateDocumentAttribution({normalizationVersion:'public-source-attributed-v2', metadataStatus:'SOURCE_SUPPLIED_NOT_VERIFIED', attribution}, text);} catch {return null;}
  return {text, attribution};
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
      const body=responseText(response), normalized=normalizePublicContent(body,type==='text/html');
      if(!normalized.text)throw new DiscoveryError('UNSUPPORTED_CONTENT');
      const attributed=type==='text/html' ? normalizeAttributedPublicContent(body,current.href) : null;
      const normalizedText=attributed?.text ?? normalized.text, normalizationVersion=attributed ? 'public-source-attributed-v2' as const : 'public-source-text-v1' as const;
      const contentDigest=digest(normalizedText),id=`doc_${digest(source.href)}`,retrievedAt=this.now().toISOString();
      // An immutable observation binds its actual retrieval time as well as content and source metadata.
      // Reusing an observation preserves this revision; a later retrieval requires fresh review selectors.
      const revision=digest(JSON.stringify([current.href,contentDigest,normalized.title,normalized.publisher,normalized.publishedAt,normalizationVersion,attributed?.attribution ?? null,retrievedAt]));
      return {id,revision,sourceUrl:source.href,fetchedUrl:current.href,title:normalized.title||current.hostname,
        publisher:normalized.publisher,publishedAt:normalized.publishedAt,retrievedAt,
        contentDigest,digestBasis:'NORMALIZED_TEXT_SHA256',normalizedText,upstreamRevisionId:null,
        normalizationVersion,persistence:'NOT_PERSISTED',metadataStatus:'SOURCE_SUPPLIED_NOT_VERIFIED',attribution:attributed?.attribution ?? null};
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
