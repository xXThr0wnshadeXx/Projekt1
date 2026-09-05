/** Small dependency-free strict JSON validators. Errors never include submitted values. */
export class ContractError extends Error {
  constructor(readonly path: string, readonly rule: string) { super(`Invalid contract at ${path}: ${rule}`); this.name = 'ContractError'; }
}
export type Check = (value: unknown, path: string) => void;
export const fail = (path: string, rule: string): never => { throw new ContractError(path, rule); };
export const string: Check = (v, p) => { if (typeof v !== 'string' || !v.trim() || v.length > 8192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) fail(p, 'nonempty bounded text'); };
export const id: Check = (v, p) => { if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v)) fail(p, 'opaque ID'); };
export const boolean: Check = (v, p) => { if (typeof v !== 'boolean') fail(p, 'boolean'); };
export const number: Check = (v, p) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail(p, 'finite nonnegative number'); };
export const integer: Check = (v,p) => { number(v,p); if (!Number.isSafeInteger(v)) fail(p,'safe integer'); };
export const score: Check = (v,p) => { number(v,p); if ((v as number) > 1) fail(p,'unit score'); };
export const literal = (...values: unknown[]): Check => (v,p) => { if (!values.includes(v)) fail(p,'enum'); };
export const optional = (c: Check): Check => (v,p) => { if (v !== undefined) c(v,p); };
export const nullable = (c: Check): Check => (v,p) => { if (v !== null) c(v,p); };
export const array = (c: Check, min = 0, max = 100000): Check => (v,p) => { if (!Array.isArray(v) || v.length < min || v.length > max) fail(p,'bounded array'); for(let i=0;i<(v as unknown[]).length;i++) c((v as unknown[])[i],`${p}[${i}]`); };
export const object = (shape: Record<string,Check>): Check => (v,p) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype,null].includes(Object.getPrototypeOf(v))) fail(p,'plain object');
  for (const k of Object.keys(v as object)) if (!Object.hasOwn(shape,k)) fail(p,'unknown field');
  for (const [k,c] of Object.entries(shape)) c((v as Record<string,unknown>)[k],`${p}.${k}`);
};
export const date: Check = (v,p) => { if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v.replace(/(?<!\.\d{3})Z$/,'.000Z')) fail(p,'UTC ISO datetime'); };
export const url: Check = (v,p) => { string(v,p); try { const u = new URL(v as string); if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) fail(p,'display URL without credentials/query/fragment'); } catch { fail(p,'safe HTTPS URL'); } };
export const ids = array(id);
export const evidenceIds = array(id,1);
export const strings = array(string);
export const state = literal('PENDING','CONFIRMED','REJECTED');
export const supported = (value: Check) => object({value,confidence:score,evidenceIds,state});
export const relationshipKind = literal('FAMILY','PARENT_OF','CLOSE_FRIEND','FRIEND','PROFESSOR_STUDENT','COWORKER','FORMER_COWORKER','CLASSMATE','ACQUAINTANCE','UNKNOWN');
export const observedKind = literal('CONTACT_SAVED','FOLLOWS','CONNECTED_ON_PLATFORM','CO_PARTICIPANT');
export const source = object({id,provider:literal('GOOGLE_CONTACTS','LINKEDIN_EXPORT','INSTAGRAM_EXPORT','MANUAL','PUBLIC_PROFILE','PUBLIC_ARTICLE'),label:string,origin:literal('USER_PROVIDED','AUTHORIZED_API','PUBLIC_SOURCE'),importedAt:date});
export const evidence = object({id,sourceId:id,summary:string,observedAt:date,confidence:score,publicUrl:optional(url),claimKind:literal('IDENTITY','RELATIONSHIP','AFFILIATION')});
export const organization = object({id,name:string,industry:optional(string)});
export const person = object({id,displayName:string,aliases:strings,identityIds:ids,affiliations:array(object({organizationId:id,role:optional(string),current:nullable(boolean),support:supported(boolean)})),location:optional(supported(string)),identityConfidence:score,updatedAt:date});
export const identity = object({id,sourceId:id,platform:string,externalId:string,displayName:optional(string),profileUrl:optional(url),personId:nullable(id),assignmentState:state,evidenceIds,updatedAt:date});
export const observedLink = object({id,fromPersonId:id,toPersonId:id,kind:observedKind,evidenceIds,confidence:score,observedAt:date});
export const relationship = object({id,fromPersonId:id,toPersonId:id,kind:relationshipKind,strength:score,confidence:score,recencyFactor:score,state,evidenceIds,observedLinkIds:ids,updatedAt:date});
export const searchEdge = object({id,relationshipId:nullable(id),fromPersonId:id,toPersonId:id,strength:score,confidence:score,recencyFactor:score,evidenceIds,basis:literal('CONFIRMED_RELATIONSHIP','OBSERVED_CONNECTION_PRIOR'),policyVersion:id});
export const entities = {people:array(person),identities:array(identity),organizations:array(organization),observedLinks:array(observedLink),relationships:array(relationship),searchEdges:array(searchEdge),evidence:array(evidence),sources:array(source)};
export const snapshotKey = {scopeId:id,graphVersion:id};
export const graph = object({schemaVersion:literal(1),...snapshotKey,rootPersonId:id,...entities,coverage:object({completeForAuthorizedSources:boolean,omittedNodeCount:integer,warnings:strings})});
export const goal = object({id,text:string,organizationIds:ids,roles:strings,locations:strings,industries:strings,unsupportedConstraints:strings});
export const target = object({personId:id,organizationId:optional(id),relevance:score,evidenceIds,reasons:strings,criteria:array(object({name:string,status:literal('MATCHED','UNKNOWN','NOT_MATCHED')}))});
export const pathScore = object({value:score,relationshipQuality:score,identityQuality:score,targetRelevance:score,hopPenalty:score,edges:array(object({edgeId:id,strength:score,confidence:score,recencyFactor:score,value:score})),identities:array(object({personId:id,value:score})),policyVersion:literal('route-v1')});
export const explanation = object({summary:string,evidenceIds,uncertainties:strings,suggestedFirstContactId:id});
export const path = object({id,personIds:array(id,2,7),edgeIds:array(id,1,6),target,score:pathScore,explanation});
export const stats = object({expansions:integer,elapsedMs:number,stop:literal('TOP_K_PROVEN','EXHAUSTED_WITHIN_HOP_LIMIT','BUDGET_REACHED','NO_TARGETS'),optimalWithinHopLimit:boolean,traceTruncated:boolean,omittedTraceEvents:integer});
const eventEnvelope = {schemaVersion:literal(1),...snapshotKey,searchId:id,seq:integer};
const union = (envelope: Record<string,Check>, variants: Record<string,Record<string,Check>>): Check => (v,p) => {
  const type = v && typeof v === 'object' ? (v as Record<string,unknown>).type : undefined;
  if (typeof type !== 'string' || !Object.hasOwn(variants,type)) fail(p,'event discriminator');
  object({...envelope,type:literal(type),...variants[type as string]})(v,p);
};
export const searchEvent = union(eventEnvelope,{
 SEARCH_STARTED:{rootPersonId:id}, NODE_VISITED:{personId:id,prefixPersonIds:array(id,1,7)}, EDGE_EXPLORED:{edgeId:id,fromPersonId:id,toPersonId:id}, PATH_PRUNED:{prefixPersonIds:array(id,1,8),reason:literal('CYCLE','HOP_LIMIT','ZERO_QUALITY')}, TARGET_FOUND:{personId:id}, PATH_CANDIDATE:{path}, PATH_SELECTED:{pathId:id}, SEARCH_COMPLETED:{pathIds:ids,stats}, SEARCH_FAILED:{code:id,message:string}
});
export const searchResult = object({schemaVersion:literal(1),...snapshotKey,searchId:id,goal,targets:array(target),paths:array(path,0,5),events:array(searchEvent),stats,warnings:strings});
export const searchRequest = object({scopeId:id,expectedGraphVersion:id,goalText:string,k:optional(integer),maxHops:optional(integer)});
export const candidateBatch = object({schemaVersion:literal(1),batchId:id,sourceId:id,people:array(object({tempId:id,displayName:string,existingPersonId:optional(id),identities:array(object({platform:string,externalId:string,profileUrl:optional(url)})),evidenceIds})),relationships:array(object({tempId:id,fromRef:id,toRef:id,kind:relationshipKind,strengthEstimate:score,confidence:score,evidenceIds})),observedLinks:array(object({fromRef:id,toRef:id,kind:observedKind,evidenceIds})),affiliations:array(object({personRef:id,organizationName:string,role:optional(string),current:optional(nullable(boolean)),evidenceIds})),evidence:array(evidence),warnings:strings});
export const proposal = object({id,identityIds:array(id,2,2),candidatePersonIds:ids,score,scoreMeaning:literal('HEURISTIC_NOT_CALIBRATED'),signals:array(object({label:string,supportsMatch:boolean,evidenceIds}),1),recommendation:literal('KEEP_SEPARATE','USER_CONFIRMATION'),priority:literal('NORMAL','HIGH')});
export const inference = (payload: Check) => object({payload,confidence:score,evidenceIds,inferenceType:literal('EXTRACTION','IDENTITY','EXPLANATION'),confirmationState:literal('PENDING'),producer:string,model:optional(string),promptVersion:id});
export const review = object({scopeId:id,expectedGraphVersion:id,candidateIds:array(id,1),decision:literal('ACCEPT','REJECT'),idempotencyKey:id});
export const buildEvent = union({schemaVersion:literal(1),jobId:id,scopeId:id,seq:integer},{SNAPSHOT_INVALIDATED:{baseGraphVersion:id,graphVersion:id,reason:literal('SOURCE_REMOVED','IDENTITY_CHANGED','ACCESS_CHANGED'),removedSourceIds:ids},IMPORT_STARTED:{sourceId:id},BATCH_COMMITTED:{operationKind:literal('IMPORT','REVIEW','IDENTITY_LINK','REVERT'),baseGraphVersion:id,graphVersion:id,...entities,removedPersonIds:ids,removedEdgeIds:ids},REVIEW_REQUIRED:{candidateIds:ids,proposalIds:ids},IMPORT_COMPLETED:{graphVersion:id,peopleAdded:integer,linksAdded:integer,warnings:strings},IMPORT_FAILED:{code:id,message:string,retryable:boolean}});

export const sourceContext = object({sourceId:id,ownerUserId:id,scopeId:id,batchId:id,sourcePolicyVersion:id,sharingDecisionId:nullable(id)});
export const sourceRecord = object({id,sourceId:id,ownerUserId:id,externalRecordId:string,retrievedAt:date,contentDigest:string,privatePayloadRef:string});
const sourceIdentity = object({platform:string,externalId:string});
const fact: Check = (v,p) => {
 const kind = (v as {kind?:unknown})?.kind;
 if(kind==='AFFILIATION')object({factKey:id,sourceRecordId:id,kind:literal(kind),candidateIndex:integer,personIdentity:sourceIdentity})(v,p);
 else object({factKey:id,sourceRecordId:id,kind:literal('OBSERVED_LINK','RELATIONSHIP'),candidateIndex:integer,fromIdentity:sourceIdentity,toIdentity:sourceIdentity})(v,p);
};
export const normalizedImport = object({context:sourceContext,batch:candidateBatch,records:array(sourceRecord),evidenceRecords:array(object({evidenceId:id,sourceRecordId:id})),facts:array(fact)});
export const identityLinkRequest = object({scopeId:id,expectedGraphVersion:id,identityId:id,expectedPersonId:nullable(id),nextPersonId:nullable(id),idempotencyKey:id});
export const identityRevertRequest = object({scopeId:id,expectedGraphVersion:id,decisionId:id,idempotencyKey:id});
export const identityLinkDecision = object({id,identityId:id,previousPersonId:nullable(id),nextPersonId:nullable(id),actorUserId:id,decidedAt:date,graphVersion:id,revertedByDecisionId:optional(id)});
