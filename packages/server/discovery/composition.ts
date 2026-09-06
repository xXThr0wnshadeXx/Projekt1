import {createHash} from 'node:crypto';import {ServiceError,type AuthPort} from '../service.js';import type {FactActor} from '../facts/contracts.js';
import {DiscoveryError,validateDiscoveryRequest,type DiscoveryCapabilities,type SearchProvider} from './contracts.js';
import {createDiscoverySources,type DiscoverySourcesOptions} from './providers/service.js';import type {DiscoveryReceipts} from './receipts.js';
export function discoveryServiceError(error:unknown):ServiceError{
 if(error instanceof ServiceError)return error;
 if(error instanceof DiscoveryError){if(error.code==='INVALID_INPUT')return new ServiceError('INVALID_INPUT',400);if(error.code==='FORBIDDEN')return new ServiceError('FORBIDDEN',403);if(error.code==='VERSION_CONFLICT')return new ServiceError('VERSION_CONFLICT',409);return new ServiceError('SOURCE_UNAVAILABLE',502);}
 return new ServiceError('INTERNAL',500);
}
export class DiscoveryApplication {
 private availableUntil=0;
 constructor(private readonly ports:{auth:AuthPort;receipts:DiscoveryReceipts;provider:SearchProvider;documents:DiscoverySourcesOptions['documents']}){}
 private async actor(credential:unknown):Promise<FactActor>{const user=await this.ports.auth.resolveSession(credential);if(!user||typeof credential!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(credential))throw new ServiceError('UNAUTHENTICATED',401);return{userId:user.userId,sessionHash:createHash('sha256').update(credential).digest('hex')};}
 async capabilities(credential:unknown):Promise<DiscoveryCapabilities>{await this.actor(credential);const p=this.ports.provider;return{wikimedia:p.kind==='WIKIMEDIA'&&Date.now()<this.availableUntil?'AVAILABLE':'UNAVAILABLE',generalWeb:p.kind==='WIKIMEDIA'||!p.configured?'NOT_CONFIGURED':Date.now()<this.availableUntil?'AVAILABLE':'UNAVAILABLE',coverage:p.kind==='WIKIMEDIA'?'WIKIMEDIA_ONLY':'GENERAL_PUBLIC_WEB'};}
 async discover(credential:unknown,input:unknown,signal?:AbortSignal){
  let actor:FactActor|undefined,request:ReturnType<typeof validateDiscoveryRequest>|undefined,id:string|undefined;
  try{
   actor=await this.actor(credential);request=validateDiscoveryRequest(input);
   const claim=await this.ports.receipts.claim(actor,request);
   if(claim.kind==='COMPLETE')return claim.result;
   if(claim.kind==='FAILED')throw new ServiceError('SOURCE_UNAVAILABLE',502);
   if(claim.kind==='BUSY')throw new ServiceError('VERSION_CONFLICT',409);
   id=claim.id;
   const sources=createDiscoverySources({provider:this.ports.provider,documents:this.ports.documents,authorize:async(c,r)=>this.ports.receipts.authorize(await this.actor(c),r)});
   const output=await sources.discover(credential,request,signal);
   const result=await this.ports.receipts.complete(await this.actor(credential),request,id,output.result);
   this.availableUntil=result.capabilities.generalWeb==='AVAILABLE'||result.capabilities.wikimedia==='AVAILABLE'?Date.now()+60000:0;return result;
  }catch(error){if(id)this.availableUntil=0;if(actor&&request&&id){try{await this.ports.receipts.fail(actor,request,id);}catch{/* Expired/revoked authority cannot mutate its receipt; lease recovery remains fail-closed. */}}throw discoveryServiceError(error);}
 }
}
