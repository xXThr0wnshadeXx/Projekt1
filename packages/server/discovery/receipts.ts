import {createHash,randomUUID} from 'node:crypto';import type {Pool} from 'pg';
import type {GraphSnapshot} from '../../../contracts/index.js';import {canonicalJson} from '../../../contracts/canonical.js';
import {ServiceError} from '../service.js';import type {FactActor} from '../facts/contracts.js';
import {withFactScope,checkedFactSnapshot,type FactSourceRow} from '../facts/transaction.js';
import type {DiscoveryRequest,DiscoveryResult} from './contracts.js';import type {AuthorizedDiscoveryContext} from './providers/service.js';
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const conflict=()=>new ServiceError('VERSION_CONFLICT',409);
interface Receipt {id:string;request_digest:string;base_graph_version:string;context_digest:string;source_policies:Record<string,string>;phase:'RUNNING'|'COMPLETE'|'FAILED';result:DiscoveryResult|null;failure_code:string|null;expired:boolean}
export type DiscoveryClaim={kind:'NEW';id:string}|{kind:'COMPLETE';result:DiscoveryResult}|{kind:'FAILED'}|{kind:'BUSY'};
export interface DiscoveryReceipts {
 authorize(actor:FactActor,request:DiscoveryRequest):Promise<AuthorizedDiscoveryContext>;
 claim(actor:FactActor,request:DiscoveryRequest):Promise<DiscoveryClaim>;
 complete(actor:FactActor,request:DiscoveryRequest,id:string,result:DiscoveryResult):Promise<DiscoveryResult>;
 fail(actor:FactActor,request:DiscoveryRequest,id:string):Promise<void>;
}
/** Explicitly selected PUBLIC identities only; never derive queries from private Person fields. */
export function publicDiscoveryContext(graph:GraphSnapshot,request:DiscoveryRequest,sources:FactSourceRow[]):AuthorizedDiscoveryContext{
 const allowed=new Set(sources.filter(s=>s.policy_version==='public-citation-review-v1'&&s.summary.origin==='PUBLIC_SOURCE'&&['PUBLIC_PROFILE','PUBLIC_ARTICLE'].includes(s.summary.provider)).map(s=>s.id));
 const selectedContexts=(request.selectedContextPersonIds??[]).map(personId=>{
  if(!graph.people.some(p=>p.id===personId))throw new ServiceError('FORBIDDEN',403);
  const terms=graph.identities.filter(i=>i.personId===personId&&i.assignmentState==='CONFIRMED'&&allowed.has(i.sourceId)&&i.evidenceIds.some(id=>graph.evidence.some(e=>e.id===id&&e.sourceId===i.sourceId&&e.claimKind==='IDENTITY'))).map(i=>i.displayName).filter((v):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=200&&!/[\u0000-\u001f\u007f]/.test(v));
  const publicTerms=[...new Set(terms)].sort().slice(0,2);if(!publicTerms.length)throw new ServiceError('FORBIDDEN',403);
  return{personId,publicTerms};
 });return{scopeId:graph.scopeId,graphVersion:graph.graphVersion,selectedContexts};
}
export class PgDiscoveryReceipts implements DiscoveryReceipts {
 constructor(private readonly pool:Pool){}
 async authorize(actor:FactActor,request:DiscoveryRequest){return withFactScope(this.pool,actor,request.scopeId,async(_c,row,sources)=>{
  const context=publicDiscoveryContext(checkedFactSnapshot(row,sources),request,sources);if(context.graphVersion!==request.expectedGraphVersion)throw conflict();return context;
 });}
 async claim(actor:FactActor,request:DiscoveryRequest):Promise<DiscoveryClaim>{return withFactScope(this.pool,actor,request.scopeId,async(c,row,sources)=>{
  const context=publicDiscoveryContext(checkedFactSnapshot(row,sources),request,sources),policies=Object.fromEntries(sources.map(s=>[s.id,s.policy_version]));
  const prior=(await c.query<Receipt>('SELECT *,lease_expires_at<=clock_timestamp() AS expired FROM discovery_receipts WHERE owner_user_id=$1 AND scope_id=$2 AND idempotency_key=$3 FOR UPDATE',[actor.userId,request.scopeId,request.idempotencyKey])).rows[0];
  const contextDigest=digest(context.selectedContexts);
  if(prior){
   if(prior.request_digest!==digest(request)||prior.context_digest!==contextDigest||Object.entries(prior.source_policies).some(([id,policy])=>policies[id]!==policy))throw conflict();
   if(prior.phase==='COMPLETE')return{kind:'COMPLETE',result:prior.result!};
   if(prior.phase==='FAILED')return{kind:'FAILED'};
   if(!prior.expired)return{kind:'BUSY'};
   // Never silently repeat a possibly billed query after an abandoned worker. New key is required.
   await c.query("UPDATE discovery_receipts SET phase='FAILED',failure_code='SOURCE_UNAVAILABLE' WHERE id=$1",[prior.id]);return{kind:'FAILED'};
  }
  if(row.graph_version!==request.expectedGraphVersion)throw conflict();
  const id=randomUUID();await c.query("INSERT INTO discovery_receipts(id,scope_id,owner_user_id,idempotency_key,request_digest,base_graph_version,context_digest,source_policies,phase,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'RUNNING',clock_timestamp()+interval '60 seconds')",[id,request.scopeId,actor.userId,request.idempotencyKey,digest(request),row.graph_version,contextDigest,policies]);return{kind:'NEW',id};
 });}
 async complete(actor:FactActor,request:DiscoveryRequest,id:string,result:DiscoveryResult):Promise<DiscoveryResult>{return withFactScope(this.pool,actor,request.scopeId,async(c,row,sources)=>{
  const context=publicDiscoveryContext(checkedFactSnapshot(row,sources),request,sources);
  const prior=(await c.query<Receipt>('SELECT *,lease_expires_at<=clock_timestamp() AS expired FROM discovery_receipts WHERE id=$1 AND owner_user_id=$2 AND scope_id=$3 FOR UPDATE',[id,actor.userId,request.scopeId])).rows[0];
  const policies=Object.fromEntries(sources.map(s=>[s.id,s.policy_version]));
  if(!prior||prior.phase!=='RUNNING'||prior.expired||prior.request_digest!==digest(request)||row.graph_version!==prior.base_graph_version||prior.context_digest!==digest(context.selectedContexts)||Object.entries(prior.source_policies).some(([key,value])=>policies[key]!==value))throw conflict();
  // This checkpoint is collection only: no external producer can invent durable proposal references.
  if(result.scopeId!==request.scopeId||result.baseGraphVersion!==request.expectedGraphVersion||result.proposalRefs.length||result.status==='REVIEW_REQUIRED')throw new ServiceError('INTERNAL',500);
  const saved={...result,discoveryId:id};await c.query("UPDATE discovery_receipts SET phase='COMPLETE',result=$2 WHERE id=$1",[id,saved]);return saved;
 });}
 async fail(actor:FactActor,request:DiscoveryRequest,id:string):Promise<void>{await withFactScope(this.pool,actor,request.scopeId,async(c,row,sources)=>{
  checkedFactSnapshot(row,sources);await c.query("UPDATE discovery_receipts SET phase='FAILED',failure_code='SOURCE_UNAVAILABLE' WHERE id=$1 AND owner_user_id=$2 AND scope_id=$3 AND request_digest=$4 AND phase='RUNNING'",[id,actor.userId,request.scopeId,digest(request)]);
 });}
}
