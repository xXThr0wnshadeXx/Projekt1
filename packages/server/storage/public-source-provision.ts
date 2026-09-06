import {canonicalJson} from '../../../contracts/canonical.js';
import {createHash} from 'node:crypto';import type {Pool} from 'pg';import type {SourceSummary} from '../../../contracts/index.js';import * as schema from '../../../contracts/schema.js';
import type {FactActor} from '../facts/contracts.js';import {withFactScope,checkedFactSnapshot,saveFactSnapshot,conflict,denied} from '../facts/transaction.js';import {publicUrl} from '../discovery/contracts.js';
export interface PublicSourceProvisionRequest {scopeId:string;expectedGraphVersion:string;document:{url:string;kind:'PUBLIC_PROFILE'|'PUBLIC_ARTICLE';title:string;retrievedAt:string}}
/** Server-only after reviewed public document collection. No browser envelopes or owner verification. */
export class PublicSourceProvisioner {
 constructor(private readonly pool:Pool){}
 async provision(actor:FactActor,input:PublicSourceProvisionRequest,operationId?:string):Promise<{sourceId:string;graphVersion:string}>{
  schema.object({scopeId:schema.id,expectedGraphVersion:schema.id,document:schema.object({url:schema.string,kind:schema.literal('PUBLIC_PROFILE','PUBLIC_ARTICLE'),title:schema.string,retrievedAt:schema.date})})(input,'$');
  if(operationId!==undefined)schema.id(operationId,'$.operationId');
  const requestDigest=createHash('sha256').update(canonicalJson(input)).digest('hex');
  const url=publicUrl(input.document.url).href,sourceId=createHash('sha256').update(JSON.stringify([actor.userId,input.scopeId,url])).digest('hex');
  return withFactScope(this.pool,actor,input.scopeId,async(c,row,sources)=>{
   const graph=checkedFactSnapshot(row,sources),policy='public-citation-review-v1';
   const save=async(response:{sourceId:string;graphVersion:string})=>{if(operationId)await c.query('INSERT INTO discovery_source_steps(operation_id,scope_id,owner_user_id,request_digest,source_id,response) VALUES($1,$2,$3,$4,$5,$6)',[operationId,row.id,actor.userId,requestDigest,sourceId,response]);return response;};
   if(operationId){const prior=(await c.query('SELECT * FROM discovery_source_steps WHERE operation_id=$1',[operationId])).rows[0];if(prior){if(prior.scope_id!==row.id||prior.owner_user_id!==actor.userId||prior.request_digest!==requestDigest)throw conflict();if(!sources.some(s=>s.id===prior.source_id&&s.policy_version===policy))throw denied();return prior.response as {sourceId:string;graphVersion:string};}}

   const existing=(await c.query('SELECT scope_id,owner_user_id,enabled,policy_version,summary,owner_identity FROM private_sources WHERE id=$1',[sourceId])).rows[0];
   if(existing){if(existing.scope_id!==row.id||existing.owner_user_id!==actor.userId||!existing.enabled)throw denied();if(existing.policy_version!==policy||existing.summary.provider!==input.document.kind||existing.summary.origin!=='PUBLIC_SOURCE'||existing.owner_identity!==null)throw conflict();if(operationId&&row.graph_version!==input.expectedGraphVersion)throw conflict();return save({sourceId,graphVersion:row.graph_version});}
   if(row.graph_version!==input.expectedGraphVersion)throw conflict();
   const source:SourceSummary={id:sourceId,provider:input.document.kind,label:input.document.title,origin:'PUBLIC_SOURCE',importedAt:input.document.retrievedAt};
   await c.query('INSERT INTO private_sources(id,scope_id,owner_user_id,policy_version,summary,owner_identity) VALUES($1,$2,$3,$4,$5,NULL)',[sourceId,row.id,actor.userId,policy,source]);
   graph.sources.push(source);await saveFactSnapshot(c,row,[...sources,{id:sourceId,policy_version:policy,summary:source}],graph);return save({sourceId,graphVersion:graph.graphVersion});
  });
 }
}
