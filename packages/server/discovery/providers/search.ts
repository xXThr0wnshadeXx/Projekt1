import {DiscoveryError,publicUrl,type SearchHit,type SearchProvider} from '../contracts.js';
import {PublicHttpClient,providerJson,abortable} from './http.js';

function queryText(query: string): string {
  if (!query.trim() || query.length > 600 || /[\u0000-\u001f\u007f]/.test(query)) throw new DiscoveryError('INVALID_INPUT');
  return query.trim();
}
function record(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DiscoveryError('SOURCE_UNAVAILABLE');
  return value as Record<string,unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new DiscoveryError('SOURCE_UNAVAILABLE');
  return value;
}
function hint(value: string): string {
  return value.replace(/<[^>]*>/g,' ').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,1200);
}
/** Actual keyless Wikipedia Action API search, not an unrestricted public-web search engine.
 * API requests are serialized. The small cache contains public hits only, never scope/private graph data. */
export class WikimediaSearchProvider implements SearchProvider {
  readonly kind = 'WIKIMEDIA' as const;
  readonly configured = true;
  private queue: Promise<void> = Promise.resolve();
  private readonly cache = new Map<string,{at:number;hits:SearchHit[]}>();
  constructor(private readonly http: PublicHttpClient) {}
  async search(query: string, signal: AbortSignal): Promise<SearchHit[]> {
    const q = queryText(query);
    const cached = this.cache.get(q);
    if (cached && Date.now()-cached.at < 60000) {if(signal.aborted)throw new DiscoveryError('CANCELLED');return structuredClone(cached.hits);}
    const previous = this.queue; let release!: ()=>void;
    this.queue = new Promise<void>(done=>{release=done;});
    try {
      await abortable(previous,signal);
      const url = new URL('https://en.wikipedia.org/w/api.php');
      url.search = new URLSearchParams({action:'query',list:'search',srsearch:q,srlimit:'5',srnamespace:'0',format:'json',utf8:'1'}).toString();
      const data = record(await providerJson(this.http,url,signal));
      if (data.error) throw new DiscoveryError('SOURCE_UNAVAILABLE');
      const rows = record(data.query).search;
      if (!Array.isArray(rows) || rows.length > 5) throw new DiscoveryError('SOURCE_UNAVAILABLE');
      const hits = rows.map(value => {
        const row = record(value), title = text(row.title,500), snippet = text(row.snippet??'',10000);
        if (!Number.isSafeInteger(row.pageid) || Number(row.pageid)<1) throw new DiscoveryError('SOURCE_UNAVAILABLE');
        return {url:`https://en.wikipedia.org/?curid=${row.pageid}`,title,snippet:hint(snippet),provider:this.kind,evidenceStatus:'DISCOVERY_HINT' as const};
      });
      if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(q,{at:Date.now(),hits}); return structuredClone(hits);
    } finally {
      // A cancelled waiter must not release the next call before the older request finishes.
      void previous.finally(release);
    }
  }
}
/** Secret is injected by server composition; this module reads no environment/key files. */
export class BraveSearchProvider implements SearchProvider {
  readonly kind = 'BRAVE' as const;
  readonly configured: boolean;
  constructor(private readonly http: PublicHttpClient, private readonly apiKey?: string) {
    this.configured = Boolean(apiKey);
    if (apiKey !== undefined && (!apiKey || apiKey.length>4096 || /[\s\u007f]/.test(apiKey))) throw new DiscoveryError('INVALID_INPUT');
  }
  async search(query: string, signal: AbortSignal): Promise<SearchHit[]> {
    if (!this.configured || !this.apiKey) throw new DiscoveryError('NOT_CONFIGURED');
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.search = new URLSearchParams({q:queryText(query),count:'5',safesearch:'moderate'}).toString();
    const data = record(await providerJson(this.http,url,signal,{'x-subscription-token':this.apiKey}));
    if (data.error) throw new DiscoveryError('SOURCE_UNAVAILABLE');
    if (data.web === undefined) return [];
    const rows = record(data.web).results;
    if (!Array.isArray(rows) || rows.length>20) throw new DiscoveryError('SOURCE_UNAVAILABLE');
    const hits: SearchHit[] = [];
    for (const value of rows.slice(0,5)) {
      const row = record(value);
      try {hits.push({url:publicUrl(text(row.url,2048)).href,title:hint(text(row.title,1000)),snippet:hint(text(row.description??'',10000)),provider:this.kind,evidenceStatus:'DISCOVERY_HINT'});}
      catch (error) {if (error instanceof DiscoveryError && error.code==='INVALID_INPUT') continue; throw error;}
    }
    return hits;
  }
}
