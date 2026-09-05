import {randomUUID} from 'node:crypto';
import {DiscoveryError,validateDiscoveryRequest,type DiscoveryRequest,type DiscoveryResult,type SearchHit,type SearchProvider} from '../contracts.js';
import type {RetrievedPublicDocument} from '../document-fetch.js';
import {abortable} from './http.js';

/** Server composition must authenticate the credential, authorize selected IDs, and return only
 * deliberately selected PUBLIC query terms. No raw snapshot or private records are accepted here. */
export interface AuthorizedDiscoveryContext {
  scopeId: string; graphVersion: string;
  selectedContexts: Array<{personId: string; publicTerms: string[]}>;
}
export interface DiscoverySourcesOutput {
  result: DiscoveryResult;
  anchors: {linkedinUrl:string;instagramUrl:string;identityState:'OWNER_ASSERTED_ANCHOR'};
  hits: SearchHit[]; documents: RetrievedPublicDocument[];
  issues: Array<{stage:'SEARCH'|'DOCUMENT';code:string}>;
  extraction: 'NOT_IMPLEMENTED'; persistence: 'NOT_IMPLEMENTED';
}
export interface DiscoverySourcesOptions {
  provider: SearchProvider;
  documents: {fetch(url:string,signal:AbortSignal):Promise<RetrievedPublicDocument>};
  authorize(credential: unknown,request: DiscoveryRequest): Promise<AuthorizedDiscoveryContext>;
}
/** Source collection only. No durable jobs/idempotency, extractors, fake proposal IDs or graph writes.
 * The wrapper must persist/recheck scope/session/version before materializing any returned content. */
export function createDiscoverySources(options: DiscoverySourcesOptions) {
  return {async discover(credential: unknown,input: unknown,parentSignal:AbortSignal = new AbortController().signal):Promise<DiscoverySourcesOutput> {
    const request=validateDiscoveryRequest(input),signal=AbortSignal.any([parentSignal,AbortSignal.timeout(30000)]);
    const authority=await abortable(options.authorize(credential,request),signal);
    if(authority.scopeId!==request.scopeId)throw new DiscoveryError('FORBIDDEN');
    if(authority.graphVersion!==request.expectedGraphVersion)throw new DiscoveryError('VERSION_CONFLICT');
    const selected=new Set(request.selectedContextPersonIds??[]);
    if(authority.selectedContexts.length!==selected.size || new Set(authority.selectedContexts.map(c=>c.personId)).size!==selected.size || authority.selectedContexts.some(c=>!selected.has(c.personId)||c.publicTerms.length>2||c.publicTerms.some(t=>!t.trim()||t.length>200||/[\u0000-\u001f\u007f]/.test(t))))throw new DiscoveryError('FORBIDDEN');
    const provider=options.provider,issues:DiscoverySourcesOutput['issues']=[],hits:SearchHit[]=[],documents:RetrievedPublicDocument[]=[];
    const warnings=['Profile links are self-asserted identity anchors, not authenticated platform ownership.',
      'Search snippets are discovery hints, not verified relationship evidence.',
      'Claim extraction and persistence are not implemented; no reviewed relationship or route is produced.'];
    if(provider.kind==='WIKIMEDIA')warnings.push('Limited Wikimedia-only coverage: this does not enumerate LinkedIn connections or Instagram followers. General public-web search is not configured.');
    const target=[request.target.personName,request.target.organizationName,request.target.profileUrl].filter(Boolean).join(' ');
    // Literal URLs remain identifiers in queries; slugs are never converted to personal names.
    const planned=[`${JSON.stringify(request.anchors.linkedinUrl)} ${target}`,`${JSON.stringify(request.anchors.instagramUrl)} ${target}`,target,
      ...authority.selectedContexts.map(c=>`${c.publicTerms.join(' ')} ${target}`)];
    // Cap query length instead of silently truncating an identity discriminator.
    const queries=[...new Set(planned)].filter(q=>q.length<=600).slice(0,4);
    let queriesUsed=0,pagesRead=0,exhausted=planned.length>queries.length,successfulSearch=false;
    if(!provider.configured)issues.push({stage:'SEARCH',code:'NOT_CONFIGURED'});
    else for(const query of queries) {
      if(signal.aborted){exhausted=true;break;}
      queriesUsed++;
      try {const returned=await abortable(provider.search(query,signal),signal);successfulSearch=true;
        for(const hit of returned)if(!hits.some(prior=>prior.url===hit.url)&&hits.length<8)hits.push(hit);
      } catch(error) {issues.push({stage:'SEARCH',code:error instanceof DiscoveryError?error.code:'SOURCE_UNAVAILABLE'});
        // Do not repeatedly hit a denied/rate-limited/unavailable provider within this operation.
        break;
      }
    }
    const urls=[...new Set([...(request.selectedPublicUrls??[]),...hits.map(hit=>hit.url)])];
    exhausted ||= urls.length>5;
    for(const url of urls.slice(0,5)) {
      if(signal.aborted){exhausted=true;break;}
      pagesRead++;
      try {documents.push(await abortable(options.documents.fetch(url,signal),signal));}
      catch(error) {issues.push({stage:'DOCUMENT',code:error instanceof DiscoveryError?error.code:'SOURCE_UNAVAILABLE'});}
    }
    if(parentSignal.aborted)throw new DiscoveryError('CANCELLED');
    exhausted ||= signal.aborted;
    // Collection does not grant lasting authority: recheck before returning selected context/results.
    // A fresh short deadline permits this authorization even after the collection budget expires.
    const latest=await abortable(options.authorize(credential,request),AbortSignal.any([parentSignal,AbortSignal.timeout(1500)]));
    if(latest.scopeId!==authority.scopeId)throw new DiscoveryError('FORBIDDEN');
    if(latest.graphVersion!==authority.graphVersion)throw new DiscoveryError('VERSION_CONFLICT');
    if(JSON.stringify(latest.selectedContexts)!==JSON.stringify(authority.selectedContexts))throw new DiscoveryError('VERSION_CONFLICT');
    if(exhausted)warnings.push('Discovery budget exhausted; coverage is incomplete.');
    const available=provider.configured&&successfulSearch;
    const result:DiscoveryResult={discoveryId:randomUUID(),scopeId:request.scopeId,baseGraphVersion:authority.graphVersion,
      status:!successfulSearch&&!documents.length?'SOURCE_UNAVAILABLE':'INSUFFICIENT_PUBLIC_EVIDENCE',
      capabilities:{wikimedia:provider.kind==='WIKIMEDIA'&&available?'AVAILABLE':'UNAVAILABLE',
        generalWeb:provider.kind!=='WIKIMEDIA'?(provider.configured?(available?'AVAILABLE':'UNAVAILABLE'):'NOT_CONFIGURED'):'NOT_CONFIGURED',
        coverage:provider.kind==='WIKIMEDIA'?'WIKIMEDIA_ONLY':'GENERAL_PUBLIC_WEB'},
      proposalRefs:[],unresolvedIdentityCount:2+(request.target.personName||request.target.profileUrl?1:0),warnings,
      budget:{queriesUsed,pagesRead,exhausted}};
    return {result,anchors:{...request.anchors,identityState:'OWNER_ASSERTED_ANCHOR'},hits,documents,issues,extraction:'NOT_IMPLEMENTED',persistence:'NOT_IMPLEMENTED'};
  }};
}
