import type { ApiError, CandidateBatch, Goal, GraphSnapshot, SearchEngine, SearchOptions, SearchResult, SourceContext, Target, NormalizedImportEnvelope } from '../../contracts/index.js';
import { ContractError, validateCandidateBatch, validateGoal, validateGraphSnapshot, validateSearchRequest, validateSearchResult, validateTarget, validateNormalizedImport } from '../../contracts/validation.js';

export class ServiceError extends Error {
 constructor(readonly code:ApiError['error']['code'],readonly status:number) {super(code);}
}
/** Implement using a verified, expiring server session. Never construct from request actor/root fields. */
export interface AuthPort { resolveSession(credential:unknown):Promise<{userId:string}|null> }
export interface PrivateScope {
 scopeId:string; ownerUserId:string; rootPersonId:string; sourceIds:ReadonlySet<string>;
}
/** Implement with a consistent read transaction, owner/scope predicates and display-safe evidence projection.
 * Private-only milestone: shared scopes require a separate reviewed contribution policy.
 */
export interface ReadPort {
 authorizePrivateScope(userId:string,scopeId:string):Promise<PrivateScope|null>;
 readSnapshot(scope:PrivateScope):Promise<unknown|null>;
}
export interface GoalPort { resolve(text:string,snapshot:GraphSnapshot):Promise<{goal:Goal;targets:Target[]}> }
/** Atomic staging transaction: lock scope/version, check immutable source ownership and policy, then
 * deduplicate by (scopeId,sourceId,batchId). Same key/different content must conflict.
 * Persist the private batch and provenance together. It does NOT confirm inference or publish graph events.
 */
export interface ImportPort {
 stage(input:{actorUserId:string;context:SourceContext;expectedGraphVersion:string;envelope:NormalizedImportEnvelope}):Promise<{jobId:string;status:'PENDING_REVIEW';duplicate:boolean}>;
}
export interface BackendPorts { auth:AuthPort; reads:ReadPort; goals?:GoalPort; engine?:SearchEngine; imports?:ImportPort }
export class BackendService {
 constructor(private readonly ports:BackendPorts) {}
 private async scope(credential:unknown,scopeId:string):Promise<PrivateScope> {
  const actor=await this.ports.auth.resolveSession(credential);if(!actor)throw new ServiceError('UNAUTHENTICATED',401);
  const scope=await this.ports.reads.authorizePrivateScope(actor.userId,scopeId);
  if(!scope || scope.scopeId!==scopeId || scope.ownerUserId!==actor.userId)throw new ServiceError('FORBIDDEN',403);
  return scope;
 }
 private async snapshot(scope:PrivateScope):Promise<GraphSnapshot> {
  const value=await this.ports.reads.readSnapshot(scope);if(value===null)throw new ServiceError('SOURCE_UNAVAILABLE',502);
  try{return structuredClone(validateGraphSnapshot(value,scope));}catch{throw new ServiceError('INTERNAL',500);}
 }
 async graph(credential:unknown,scopeId:string):Promise<GraphSnapshot> {return this.snapshot(await this.scope(credential,scopeId));}
 async search(credential:unknown,input:unknown):Promise<SearchResult> {
  const request=validateSearchRequest(input),scope=await this.scope(credential,request.scopeId),snapshot=await this.snapshot(scope);
  if(request.expectedGraphVersion!==snapshot.graphVersion)throw new ServiceError('VERSION_CONFLICT',409);
  if(!this.ports.goals || !this.ports.engine)throw new ServiceError('SOURCE_UNAVAILABLE',502);
  const options:SearchOptions={k:Math.min(request.k??3,5),maxHops:Math.min(request.maxHops??5,6),maxExpansions:10000,maxFrontier:25000,maxTraceEvents:3000,deadlineMs:1000};
  try {
   const resolved=await this.ports.goals.resolve(request.goalText,structuredClone(snapshot));
   const goal=validateGoal(resolved.goal,snapshot),targets=resolved.targets.map(t=>validateTarget(t,snapshot));
   const result=validateSearchResult(this.ports.engine.findBestPaths(structuredClone(snapshot),structuredClone(goal),structuredClone(targets),options),snapshot);
   if(result.paths.length>options.k || result.paths.some(p=>p.edgeIds.length>options.maxHops) || result.events.length>options.maxTraceEvents)throw new ServiceError('INTERNAL',500);
   return structuredClone(result);
  }catch{throw new ServiceError('INTERNAL',500);}
 }
 /** Server adapter invokes after normalization. SourceContext is never accepted from an HTTP body. */
 async stageImport(credential:unknown,context:SourceContext,expectedGraphVersion:string,input:unknown) {
  const scope=await this.scope(credential,context.scopeId);
  if(context.ownerUserId!==scope.ownerUserId || !scope.sourceIds.has(context.sourceId) || context.sharingDecisionId!==null)throw new ServiceError('FORBIDDEN',403);
  const snapshot=await this.snapshot(scope);if(snapshot.graphVersion!==expectedGraphVersion)throw new ServiceError('VERSION_CONFLICT',409);
  const envelope=validateNormalizedImport(input,{...context,existingIdentities:snapshot.identities.filter(i=>i.sourceId===context.sourceId),existingPersonIds:new Set(snapshot.people.map(p=>p.id)),existingEvidenceIds:new Set(snapshot.evidence.filter(e=>e.sourceId===context.sourceId).map(e=>e.id))});
  if(!this.ports.imports)throw new ServiceError('SOURCE_UNAVAILABLE',502);
  return this.ports.imports.stage({actorUserId:scope.ownerUserId,context:structuredClone(context),expectedGraphVersion,envelope});
 }
}
/** Use at HTTP boundary. Never serialize thrown exception text, provider messages, or raw input. */
export function apiFailure(error:unknown,requestId:string):{status:number;body:ApiError} {
 const e=error instanceof ServiceError?error:error instanceof ContractError?new ServiceError('INVALID_INPUT',400):new ServiceError('INTERNAL',500);
 const messages:Record<ApiError['error']['code'],string>={INVALID_INPUT:'Invalid request.',UNAUTHENTICATED:'Sign in required.',FORBIDDEN:'Access denied.',VERSION_CONFLICT:'Reload the current graph.',SOURCE_UNAVAILABLE:'Required source or service is unavailable.',RATE_LIMITED:'Try again later.',INTERNAL:'Request could not be completed.'};
 return {status:e.status,body:{error:{code:e.code,message:messages[e.code],requestId}}};
}
