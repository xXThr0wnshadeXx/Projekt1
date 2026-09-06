import type {DiscoveryWorkflow} from './workflow.js';
import {createHash,randomUUID} from 'node:crypto';import type {Pool} from 'pg';
import type {GraphSnapshot} from '../../../contracts/index.js';import {canonicalJson} from '../../../contracts/canonical.js';
import {ServiceError} from '../service.js';import type {FactActor} from '../facts/contracts.js';
import {withFactScope,checkedFactSnapshot,type FactSourceRow} from '../facts/transaction.js';
import type {DiscoveryRequest,DiscoveryResult,DiscoveryReviewRequest,DiscoveryReviewResponse} from './contracts.js';import type {AuthorizedDiscoveryContext} from './providers/service.js';
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const conflict=()=>new ServiceError('VERSION_CONFLICT',409);
interface Receipt {id:string;request_digest:string;base_graph_version:string;context_digest:string;source_policies:Record<string,string>;phase:'RUNNING'|'COMPLETE'|'FAILED';result:DiscoveryResult|null;failure_code:string|null;expired:boolean;workflow:DiscoveryWorkflow|null;run_id:string|null}
export type DiscoveryClaim={kind:'NEW';id:string;runId:string;workflow:DiscoveryWorkflow|null}|{kind:'COMPLETE';result:DiscoveryResult}|{kind:'FAILED'}|{kind:'BUSY'};
export interface DiscoveryReceipts {
 authorize(actor:FactActor,request:DiscoveryRequest):Promise<AuthorizedDiscoveryContext>;
 publicSource(actor:FactActor,request:DiscoveryRequest,sourceId:string):Promise<{graphVersion:string;provider:'PUBLIC_PROFILE'|'PUBLIC_ARTICLE'}>;
 claim(actor:FactActor,request:DiscoveryRequest):Promise<DiscoveryClaim>;
 complete(actor:FactActor,request:DiscoveryRequest,id:string,result:DiscoveryResult,runId:string):Promise<DiscoveryResult>;
 fail(actor:FactActor,request:DiscoveryRequest,id:string,runId:string):Promise<void>;
  saveWorkflow(actor:FactActor,request:DiscoveryRequest,id:string,runId:string,workflow:DiscoveryWorkflow):Promise<void>;
  lookup(actor:FactActor,request:DiscoveryReviewRequest):Promise<DiscoveryReviewResponse>;
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
 async publicSource(actor:FactActor,request:DiscoveryRequest,sourceId:string){return withFactScope(this.pool,actor,request.scopeId,async(_c,row,sources)=>{
  publicDiscoveryContext(checkedFactSnapshot(row,sources),request,sources);if(row.graph_version!==request.expectedGraphVersion)throw conflict();
  const source=sources.find(s=>s.id===sourceId);if(!source||source.policy_version!=='public-citation-review-v1'||source.summary.origin!=='PUBLIC_SOURCE'||!['PUBLIC_PROFILE','PUBLIC_ARTICLE'].includes(source.summary.provider))throw new ServiceError('FORBIDDEN',403);
  return{graphVersion:row.graph_version,provider:source.summary.provider as 'PUBLIC_PROFILE'|'PUBLIC_ARTICLE'};
 });}
 async claim(actor:FactActor,request:DiscoveryRequest):Promise<DiscoveryClaim>{return withFactScope(this.pool,actor,request.scopeId,async(c,row,sources)=>{
  const context=publicDiscoveryContext(checkedFactSnapshot(row,sources),request,sources),policies=Object.fromEntries(sources.map(s=>[s.id,s.policy_version]));
  const prior=(await c.query<Receipt>('SELECT *,lease_expires_at<=clock_timestamp() AS expired FROM discovery_receipts WHERE owner_user_id=$1 AND scope_id=$2 AND idempotency_key=$3 FOR UPDATE',[actor.userId,request.scopeId,request.idempotencyKey])).rows[0];
  const contextDigest=digest(context.selectedContexts);
  if(prior){
   if(prior.request_digest!==digest(request)||prior.context_digest!==contextDigest||Object.entries(prior.source_policies).some(([id,policy])=>policies[id]!==policy))throw conflict();
   if(prior.phase==='COMPLETE'){await this.currentProposals(c,actor,request.scopeId,prior.workflow);return{kind:'COMPLETE',result:prior.result!};}
   if(prior.workflow&&(prior.phase==='FAILED'||prior.expired)){
    const runId=randomUUID();await c.query("UPDATE discovery_receipts SET phase='RUNNING',failure_code=NULL,run_id=$2,lease_expires_at=clock_timestamp()+interval '60 seconds' WHERE id=$1",[prior.id,runId]);return{kind:'NEW',id:prior.id,runId,workflow:prior.workflow};
   }
   if(prior.phase==='FAILED')return{kind:'FAILED'};
   if(!prior.expired)return{kind:'BUSY'};
   // Never silently repeat a possibly billed query after an abandoned worker. New key is required.
   await c.query("UPDATE discovery_receipts SET phase='FAILED',failure_code='SOURCE_UNAVAILABLE' WHERE id=$1",[prior.id]);return{kind:'FAILED'};
  }
  if(row.graph_version!==request.expectedGraphVersion)throw conflict();
  const id=randomUUID(),runId=randomUUID();await c.query("INSERT INTO discovery_receipts(id,scope_id,owner_user_id,idempotency_key,request_digest,base_graph_version,context_digest,source_policies,phase,lease_expires_at,run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'RUNNING',clock_timestamp()+interval '60 seconds',$9)",[id,request.scopeId,actor.userId,request.idempotencyKey,digest(request),row.graph_version,contextDigest,policies,runId]);return{kind:'NEW',id,runId,workflow:null};
 });}
 async complete(actor:FactActor,request:DiscoveryRequest,id:string,result:DiscoveryResult,runId:string):Promise<DiscoveryResult>{return withFactScope(this.pool,actor,request.scopeId,async(c,row,sources)=>{
  const context=publicDiscoveryContext(checkedFactSnapshot(row,sources),request,sources);
  const prior=(await c.query<Receipt>('SELECT *,lease_expires_at<=clock_timestamp() AS expired FROM discovery_receipts WHERE id=$1 AND owner_user_id=$2 AND scope_id=$3 FOR UPDATE',[id,actor.userId,request.scopeId])).rows[0];
  const policies=Object.fromEntries(sources.map(s=>[s.id,s.policy_version]));
  if(!prior||prior.phase!=='RUNNING'||prior.run_id!==runId||prior.expired||prior.request_digest!==digest(request)||(!prior.workflow&&row.graph_version!==prior.base_graph_version)||prior.context_digest!==digest(context.selectedContexts)||Object.entries(prior.source_policies).some(([key,value])=>policies[key]!==value))throw conflict();
  if(result.scopeId!==request.scopeId||result.baseGraphVersion!==request.expectedGraphVersion)throw new ServiceError('INTERNAL',500);
  if(prior.workflow?.steps.some(step=>!step.done))throw conflict();
  await this.currentProposals(c,actor,request.scopeId,prior.workflow);
  const expected=prior.workflow?.steps.flatMap(step=>step.stageResponse?step.stageRequest!.envelope.proposals.map(p=>({id:p.id,revision:p.revision})):[])??[];
  if(digest(expected)!==digest(result.proposalRefs)||(expected.length>0)!==(result.status==='REVIEW_REQUIRED'))throw new ServiceError('INTERNAL',500);
  const saved={...result,discoveryId:id};await c.query("UPDATE discovery_receipts SET phase='COMPLETE',result=$2 WHERE id=$1",[id,saved]);return saved;
 });}
 async fail(actor:FactActor,request:DiscoveryRequest,id:string,runId:string):Promise<void>{await withFactScope(this.pool,actor,request.scopeId,async(c,row,sources)=>{
  checkedFactSnapshot(row,sources);await c.query("UPDATE discovery_receipts SET phase='FAILED',failure_code='SOURCE_UNAVAILABLE' WHERE id=$1 AND owner_user_id=$2 AND scope_id=$3 AND request_digest=$4 AND phase='RUNNING' AND run_id=$5",[id,actor.userId,request.scopeId,digest(request),runId]);
 });}
 private async currentProposals(c:import('pg').PoolClient,actor:FactActor,scopeId:string,workflow:DiscoveryWorkflow|null):Promise<void>{
  for(const step of workflow?.steps??[]){
   if(step.sourceId){const source=(await c.query('SELECT policy_version,summary FROM private_sources WHERE id=$1 AND scope_id=$2 AND owner_user_id=$3 AND enabled=true',[step.sourceId,scopeId,actor.userId])).rows[0];if(!source||source.policy_version!=='public-citation-review-v1'||source.summary.origin!=='PUBLIC_SOURCE'||source.summary.provider!==step.provision.document.kind)throw new ServiceError('FORBIDDEN',403);}
   if(!step.stageResponse)continue;
   for(const document of step.stageRequest!.envelope.documents){const head=(await c.query("SELECT revision FROM public_fact_heads WHERE source_id=$1 AND scope_id=$2 AND owner_user_id=$3 AND kind='DOCUMENT' AND id=$4",[step.sourceId,scopeId,actor.userId,document.id])).rows[0];if(head?.revision!==document.revision)throw conflict();}
   for(const proposal of step.stageRequest!.envelope.proposals){const head=(await c.query("SELECT revision FROM public_fact_heads WHERE source_id=$1 AND scope_id=$2 AND owner_user_id=$3 AND kind='PROPOSAL' AND id=$4",[step.sourceId,scopeId,actor.userId,proposal.id])).rows[0];if(head?.revision!==proposal.revision)throw conflict();}
  }
 }
 async saveWorkflow(actor:FactActor,request:DiscoveryRequest,id:string,runId:string,workflow:DiscoveryWorkflow):Promise<void>{
  if(workflow.documents.length>5||workflow.steps.length>5||Buffer.byteLength(JSON.stringify(workflow))>20*1024*1024)throw new ServiceError('INVALID_INPUT',400);
  await withFactScope(this.pool,actor,request.scopeId,async(c,row,sources)=>{
   const context=publicDiscoveryContext(checkedFactSnapshot(row,sources),request,sources);
   const prior=(await c.query<Receipt>('SELECT *,lease_expires_at<=clock_timestamp() AS expired FROM discovery_receipts WHERE id=$1 AND owner_user_id=$2 AND scope_id=$3 FOR UPDATE',[id,actor.userId,request.scopeId])).rows[0];
   if(!prior||prior.run_id!==runId||prior.phase!=='RUNNING'||prior.expired||prior.request_digest!==digest(request)||prior.context_digest!==digest(context.selectedContexts))throw conflict();
   if(!prior.workflow&&row.graph_version!==request.expectedGraphVersion)throw conflict();
   await c.query("UPDATE discovery_receipts SET workflow=$2,lease_expires_at=clock_timestamp()+interval '60 seconds' WHERE id=$1",[id,workflow]);
  });
 }

 async lookup(actor:FactActor,request:DiscoveryReviewRequest):Promise<DiscoveryReviewResponse>{return withFactScope(this.pool,actor,request.scopeId,async(c,row,sources)=>{
  const prior=(await c.query<Receipt>('SELECT * FROM discovery_receipts WHERE id=$1 AND owner_user_id=$2 AND scope_id=$3 FOR UPDATE',[request.discoveryId,actor.userId,row.id])).rows[0];
  if(!prior)throw new ServiceError('FORBIDDEN',403);
  if(prior.phase!=='COMPLETE'||!prior.workflow||prior.workflow.steps.some(step=>!step.done))throw conflict();
  await this.currentProposals(c,actor,row.id,prior.workflow);
  const batches=prior.workflow.steps.flatMap(step=>{
   if(!step.stageResponse&&!step.stageRequest)return [];
   if(!step.stageResponse||!step.stageRequest||!step.sourceId||step.stageRequest.envelope.normalized.context.scopeId!==row.id||step.stageRequest.envelope.normalized.context.sourceId!==step.sourceId)throw conflict();
   // Confirm the durable stage still exists under this actor/scope before exposing its batch ID.
   // The workflow is private state, so a missing backing row must fail closed rather than map stale data.
   // This query is intentionally performed in the surrounding scope transaction.
   return [{batchId:step.stageResponse.batchId,sourceId:step.sourceId!,proposalRefs:step.stageRequest.envelope.proposals.map(p=>({id:p.id,revision:p.revision}))}];
  });
  for(const batch of batches){const found=await c.query('SELECT id FROM public_fact_batches WHERE id=$1 AND scope_id=$2 AND owner_user_id=$3 AND source_id=$4',[batch.batchId,row.id,actor.userId,batch.sourceId]);if(!found.rowCount)throw conflict();}
  return{scopeId:row.id,discoveryId:prior.id,graphVersion:row.graph_version,batches};
 });}

}
