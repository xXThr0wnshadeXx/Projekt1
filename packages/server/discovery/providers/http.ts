import {lookup} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';
import {BlockList, isIP} from 'node:net';
import {DiscoveryError, publicUrl} from '../contracts.js';

const denied4 = new BlockList();
for (const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const) denied4.addSubnet(address,prefix,'ipv4');
const global6 = new BlockList(); global6.addSubnet('2000::',3,'ipv6');
const denied6 = new BlockList();
for (const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const) denied6.addSubnet(address,prefix,'ipv6');
/** Conservative globally routable unicast only; mapped/translated IPv4 and transition ranges fail closed. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !denied4.check(address,'ipv4') : family === 6 && global6.check(address,'ipv6') && !denied6.check(address,'ipv6');
}
export interface ResolvedAddress {address: string; family: 4|6}
export interface NetworkResponse {status: number; headers: Record<string,string>; body: Uint8Array}
export interface PinnedRequest {
  url: URL; address: ResolvedAddress; headers: Record<string,string>; maxBytes: number; signal: AbortSignal;
}
export interface NetworkDependencies {
  resolve(hostname: string): Promise<ResolvedAddress[]>;
  request(input: PinnedRequest): Promise<NetworkResponse>;
}
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((done,reject) => {
    const abort = () => reject(new DiscoveryError('CANCELLED'));
    if (signal.aborted) {void work.catch(()=>{}); abort(); return;}
    signal.addEventListener('abort',abort,{once:true});
    work.then(done,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
/** TLS validates original hostname; DNS lookup is replaced with the one already validated address.
 * No agent reuse, automatic redirects, decompression, cookies, proxy environment or browser headers. */
export function requestPinned(input: PinnedRequest): Promise<NetworkResponse> {
  return new Promise((done,reject) => {
    const req = httpsRequest(input.url, {method:'GET',agent:false,signal:input.signal,
      family:input.address.family,headers:input.headers,
      lookup: (_host,_options,callback) => callback(null,input.address.address,input.address.family)}, response => {
      const headers: Record<string,string> = {};
      for (const [key,value] of Object.entries(response.headers)) if (value !== undefined) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
      const declared = headers['content-length'];
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > input.maxBytes)) {response.destroy(); reject(new DiscoveryError('LIMIT_EXCEEDED')); return;}
      if (headers['content-encoding'] && headers['content-encoding'].toLowerCase() !== 'identity') {response.destroy(); reject(new DiscoveryError('UNSUPPORTED_CONTENT')); return;}
      const chunks: Buffer[] = []; let size = 0;
      response.on('data',(chunk: Buffer) => {size += chunk.length; if (size > input.maxBytes) {response.destroy(new DiscoveryError('LIMIT_EXCEEDED')); return;} chunks.push(chunk);});
      response.once('error',reject);
      response.once('end',()=>done({status:response.statusCode??0,headers,body:Buffer.concat(chunks)}));
      response.once('aborted',()=>reject(new DiscoveryError('SOURCE_UNAVAILABLE')));
    });
    req.once('error',reject); req.end();
  });
}
const nativeNetwork: NetworkDependencies = {
  resolve: async hostname => (await lookup(hostname,{all:true,verbatim:true})).map(item=>({address:item.address,family:item.family as 4|6})),
  request: requestPinned,
};
export class PublicHttpClient {
  constructor(private readonly userAgent: string, private readonly network: NetworkDependencies = nativeNetwork) {
    if (!/^[A-Za-z][A-Za-z_-]{1,40}\/[^\r\n]{1,180}$/.test(userAgent)) throw new DiscoveryError('INVALID_INPUT');
  }
  get agentToken(): string {return this.userAgent.split('/')[0]!.toLowerCase();}
  async get(value: string, options: {signal: AbortSignal; maxBytes: number; accept?: string; headers?: Record<string,string>}): Promise<NetworkResponse> {
    const url = publicUrl(value), hostname = url.hostname.replace(/^\[|\]$/g,'');
    if (options.headers && (Object.keys(options.headers).some(key=>key!=='x-subscription-token') || url.origin!=='https://api.search.brave.com' || url.pathname!=='/res/v1/web/search')) throw new DiscoveryError('ACCESS_DENIED');
    if (hostname === 'localhost' || /\.(localhost|local|internal|home|lan)$/.test(hostname) || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 1024*1024) throw new DiscoveryError('ACCESS_DENIED');
    const signal = AbortSignal.any([options.signal,AbortSignal.timeout(8000)]);
    try {
      const addresses = isIP(hostname) ? [{address:hostname,family:isIP(hostname) as 4|6}] : await abortable(this.network.resolve(hostname),signal);
      if (!addresses.length || addresses.length > 32 || addresses.some(item => !isPublicAddress(item.address) || isIP(item.address) !== item.family)) throw new DiscoveryError('ACCESS_DENIED');
      if (signal.aborted) throw new DiscoveryError('CANCELLED');
      const response = await abortable(this.network.request({url,address:addresses[0]!,signal,maxBytes:options.maxBytes,
        headers:{'user-agent':this.userAgent,accept:options.accept??'text/html, text/plain;q=0.9','accept-encoding':'identity',...(options.headers??{})}}),signal);
      if (response.body.byteLength > options.maxBytes) throw new DiscoveryError('LIMIT_EXCEEDED');
      if (response.headers['content-encoding'] && response.headers['content-encoding'].toLowerCase() !== 'identity') throw new DiscoveryError('UNSUPPORTED_CONTENT');
      return response;
    } catch (error) {if (error instanceof DiscoveryError) throw error; throw new DiscoveryError(signal.aborted?'CANCELLED':'SOURCE_UNAVAILABLE');}
  }
}
export function responseText(response: NetworkResponse): string {
  const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(response.headers['content-type']??'')?.[1];
  if (charset && !['utf-8','utf8','us-ascii'].includes(charset.toLowerCase())) throw new DiscoveryError('UNSUPPORTED_CONTENT');
  try {return new TextDecoder('utf-8',{fatal:true}).decode(response.body);} catch {throw new DiscoveryError('UNSUPPORTED_CONTENT');}
}
export async function providerJson(client: PublicHttpClient, url: URL, signal: AbortSignal, headers?: Record<string,string>): Promise<unknown> {
  const response = await client.get(url.href,{signal,maxBytes:512*1024,accept:'application/json',...(headers?{headers}:{})});
  // Never forward a provider secret through an HTTP redirect, even to another public host.
  if (response.status !== 200) throw new DiscoveryError([401,403,429,451].includes(response.status)?'ACCESS_DENIED':'SOURCE_UNAVAILABLE');
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type']??'')) throw new DiscoveryError('UNSUPPORTED_CONTENT');
  try {return JSON.parse(responseText(response));} catch (error) {if(error instanceof DiscoveryError)throw error;throw new DiscoveryError('SOURCE_UNAVAILABLE');}
}
