import type { CandidateBatch, GraphSnapshot, SearchRequest, SearchResult, OpportunityPath, Target, InferenceResult, IdentityProposal, GraphBuildEvent, ReviewDecision, Goal } from './index.js';
import * as s from './schema.js';
import { canonicalJson as canonical } from './canonical.js';
export { ContractError } from './schema.js';
const require = (ok: unknown, rule: string): void => { if (!ok) s.fail('$',rule); };
const unique = (xs: string[]) => require(new Set(xs).size === xs.length,'unique identifiers');
const refs = (xs: string[], allowed: Set<string>) => { unique(xs); xs.forEach(x=>require(allowed.has(x),'authorized reference')); };
const set = (xs: {id:string}[]) => { unique(xs.map(x=>x.id)); return new Set(xs.map(x=>x.id)); };
const close = (a: number,b: number) => require(Math.abs(a-b) < 1e-10,'consistent score factors');
export interface GraphAuthority { scopeId: string; rootPersonId: string; sourceIds: ReadonlySet<string> }
/** Authority must be resolved server-side; DTO scope strings alone do not authorize records. */
export function validateGraphSnapshot(value: unknown, authority: GraphAuthority): GraphSnapshot {
 s.graph(value,'$'); const g = value as GraphSnapshot;
 require(g.scopeId === authority.scopeId && g.rootPersonId === authority.rootPersonId,'session scope and root');
 const people=set(g.people), identities=set(g.identities), orgs=set(g.organizations), evidence=set(g.evidence), sources=set(g.sources), links=set(g.observedLinks); set(g.relationships); set(g.searchEdges);
 require(people.has(g.rootPersonId),'root resolves');
 g.sources.forEach(x=>require(authority.sourceIds.has(x.id),'authorized source'));
 g.evidence.forEach(x=>require(sources.has(x.sourceId),'evidence source resolves'));
 const evidenceRefs=(xs:string[])=>refs(xs,evidence);
 const pair=(x:{fromPersonId:string;toPersonId:string;evidenceIds:string[]})=>{refs([x.fromPersonId,x.toPersonId],people);evidenceRefs(x.evidenceIds);};
 unique(g.identities.map(x=>JSON.stringify([x.sourceId,x.platform,x.externalId])));
 g.identities.forEach(x=>{require(sources.has(x.sourceId),'identity source');evidenceRefs(x.evidenceIds); if(x.personId!==null){require(x.assignmentState==='CONFIRMED' && people.has(x.personId),'accepted identity assignment');require(g.people.find(p=>p.id===x.personId)!.identityIds.includes(x.id),'reciprocal identity assignment');}else require(x.assignmentState!=='CONFIRMED','confirmed identity needs person');});
 g.people.forEach(p=>{refs(p.identityIds,identities);p.identityIds.forEach(i=>require(g.identities.find(x=>x.id===i)!.personId===p.id,'identity mapping'));p.affiliations.forEach(a=>{require(orgs.has(a.organizationId),'organization reference');evidenceRefs(a.support.evidenceIds);});if(p.location)evidenceRefs(p.location.evidenceIds);});
 g.observedLinks.forEach(pair);
 g.relationships.forEach(x=>{pair(x);refs(x.observedLinkIds,links);x.observedLinkIds.forEach(id=>{const l=g.observedLinks.find(l=>l.id===id)!;require(l.fromPersonId===x.fromPersonId && l.toPersonId===x.toPersonId,'relationship observation direction');});});
 g.searchEdges.forEach(x=>{pair(x);if(x.basis==='CONFIRMED_RELATIONSHIP'){
 const r=g.relationships.find(r=>r.id===x.relationshipId);require(r && r.state==='CONFIRMED' && r.fromPersonId===x.fromPersonId && r.toPersonId===x.toPersonId,'accepted directed relationship');
 refs(x.evidenceIds,new Set(r!.evidenceIds));close(x.strength,r!.strength);close(x.confidence,r!.confidence);close(x.recencyFactor,r!.recencyFactor);
 }else{require(x.relationshipId===null,'prior has no confirmed relationship');require(g.observedLinks.some(l=>l.fromPersonId===x.fromPersonId && l.toPersonId===x.toPersonId && ['CONTACT_SAVED','CONNECTED_ON_PLATFORM'].includes(l.kind) && x.evidenceIds.every(e=>l.evidenceIds.includes(e))),'supported directed observation prior');}});
 return g;
}
export interface BatchAuthority { sourceId: string; batchId: string; existingPersonIds: ReadonlySet<string>; existingEvidenceIds: ReadonlySet<string> }
export function validateCandidateBatch(value: unknown, context: BatchAuthority): CandidateBatch {
 s.candidateBatch(value,'$'); const b=value as CandidateBatch;
 require(b.sourceId===context.sourceId && b.batchId===context.batchId,'server source/batch binding');
 unique(b.people.map(x=>x.tempId));unique(b.relationships.map(x=>x.tempId));set(b.evidence);
 const personIds=new Set(context.existingPersonIds), evidenceIds=new Set(context.existingEvidenceIds);
 b.people.forEach(x=>{require(!personIds.has(x.tempId),'unambiguous temporary ID');personIds.add(x.tempId);if(x.existingPersonId)require(context.existingPersonIds.has(x.existingPersonId),'existing person authorized');});
 b.evidence.forEach(e=>{require(e.sourceId===b.sourceId && !evidenceIds.has(e.id),'immutable source-bound evidence');evidenceIds.add(e.id);});
 unique(b.people.flatMap(p=>p.identities.map(i=>JSON.stringify([i.platform,i.externalId]))));
 b.people.forEach(p=>refs(p.evidenceIds,evidenceIds));
 [...b.relationships,...b.observedLinks].forEach(x=>{refs([x.fromRef,x.toRef],personIds);refs(x.evidenceIds,evidenceIds);});
 b.affiliations.forEach(x=>{refs([x.personRef],personIds);refs(x.evidenceIds,evidenceIds);});return b;
}
export function validateSearchRequest(value: unknown): SearchRequest { s.searchRequest(value,'$'); const r=value as SearchRequest;require(r.goalText.length<=2000 && (r.k===undefined||r.k>=1) && (r.maxHops===undefined||r.maxHops>=1),'bounded search input');return r; }
export function validateGoal(value: unknown,g: GraphSnapshot): Goal {s.goal(value,'$');const goal=value as Goal;refs(goal.organizationIds,new Set(g.organizations.map(x=>x.id)));return goal;}
export function validateTarget(value: unknown,g: GraphSnapshot): Target {
 s.target(value,'$');const t=value as Target;require(g.people.some(p=>p.id===t.personId),'target person');refs(t.evidenceIds,new Set(g.evidence.map(x=>x.id)));
 if(t.organizationId)require(g.people.find(p=>p.id===t.personId)!.affiliations.some(a=>a.organizationId===t.organizationId && a.support.state==='CONFIRMED' && a.support.value && a.support.evidenceIds.some(e=>t.evidenceIds.includes(e))),'supported target affiliation');return t;
}
export function validateOpportunityPath(value: unknown,g: GraphSnapshot): OpportunityPath {
 s.path(value,'$');const p=value as OpportunityPath;validateTarget(p.target,g);
 refs(p.personIds,new Set(g.people.map(x=>x.id)));unique(p.edgeIds);require(p.personIds.length===p.edgeIds.length+1 && p.personIds[0]===g.rootPersonId && p.personIds.at(-1)===p.target.personId,'simple rooted path');
 require(p.score.edges.length===p.edgeIds.length && p.score.identities.length===p.personIds.length-1,'factor cardinality');
 let rq=1,iq=1;
 p.edgeIds.forEach((id,i)=>{const e=g.searchEdges.find(e=>e.id===id);require(e && e.fromPersonId===p.personIds[i] && e.toPersonId===p.personIds[i+1],'directed path edge');const f=p.score.edges[i]!;require(f.edgeId===id,'edge factor order');close(f.strength,e!.strength);close(f.confidence,e!.confidence);close(f.recencyFactor,e!.recencyFactor);close(f.value,f.strength*f.confidence*f.recencyFactor);rq*=f.value;});
 p.personIds.slice(1).forEach((id,i)=>{const f=p.score.identities[i]!;require(f.personId===id,'identity factor once per non-root person');close(f.value,g.people.find(p=>p.id===id)!.identityConfidence);iq*=f.value;});
 close(p.score.relationshipQuality,rq);close(p.score.identityQuality,iq);close(p.score.targetRelevance,p.target.relevance);close(p.score.hopPenalty,0.92**(p.edgeIds.length-1));close(p.score.value,rq*iq*p.target.relevance*p.score.hopPenalty);
 refs(p.explanation.evidenceIds,new Set([...p.target.evidenceIds,...p.edgeIds.flatMap(id=>g.searchEdges.find(x=>x.id===id)!.evidenceIds)]));require(p.explanation.suggestedFirstContactId===p.personIds[1],'first contact');return p;
}
export function validateSearchResult(value: unknown,g: GraphSnapshot): SearchResult {
 s.searchResult(value,'$');const r=value as SearchResult;require(r.scopeId===g.scopeId && r.graphVersion===g.graphVersion,'search snapshot binding');validateGoal(r.goal,g);r.targets.forEach(t=>validateTarget(t,g));unique(r.targets.map(t=>t.personId));unique(r.paths.map(p=>p.id));
 const prefix=(ids:string[])=>{require(ids[0]===g.rootPersonId,'trace root');for(let i=1;i<ids.length;i++)require(g.searchEdges.some(e=>e.fromPersonId===ids[i-1]&&e.toPersonId===ids[i]),'trace prefix adjacency');};
 const targetIds=new Set(r.targets.map(t=>t.personId)), pathIds=new Set(r.paths.map(p=>p.id)), people=new Set(g.people.map(p=>p.id));
 r.paths.forEach(p=>{validateOpportunityPath(p,g);require(r.targets.some(t=>canonical(t)===canonical(p.target)),'result target agrees');});
 require(r.events.length>=2 && r.events[0]!.type==='SEARCH_STARTED' && r.events.at(-1)!.type==='SEARCH_COMPLETED','complete event lifecycle');let seq=-1;
 r.events.forEach((e,i)=>{require(e.scopeId===g.scopeId && e.graphVersion===g.graphVersion && e.searchId===r.searchId && e.seq===seq+1,'event binding and sequence');seq=e.seq;
 switch(e.type){case 'SEARCH_STARTED':require(i===0 && e.rootPersonId===g.rootPersonId,'event root');break;
 case 'NODE_VISITED':refs(e.prefixPersonIds,people);prefix(e.prefixPersonIds);require(e.prefixPersonIds[0]===g.rootPersonId && e.prefixPersonIds.at(-1)===e.personId,'visited prefix');break;
 case 'PATH_PRUNED':prefix(e.prefixPersonIds);e.prefixPersonIds.forEach(p=>require(people.has(p),'pruned person'));require(e.prefixPersonIds[0]===g.rootPersonId,'pruned root');break;
 case 'EDGE_EXPLORED':{const edge=g.searchEdges.find(x=>x.id===e.edgeId);require(edge && edge.fromPersonId===e.fromPersonId && edge.toPersonId===e.toPersonId,'event edge');break;}
 case 'TARGET_FOUND':require(targetIds.has(e.personId),'event target');break;
 case 'PATH_CANDIDATE':validateOpportunityPath(e.path,g);require(targetIds.has(e.path.target.personId),'candidate target');break;
 case 'PATH_SELECTED':require(pathIds.has(e.pathId),'selected path');break;
 case 'SEARCH_COMPLETED':require(i===r.events.length-1,'terminal event');refs(e.pathIds,pathIds);require(e.pathIds.length===r.paths.length && canonical(e.stats)===canonical(r.stats),'completion agrees');break;
 case 'SEARCH_FAILED':s.fail('$','failed search cannot be a successful result');}
 });
 const selected=r.events.flatMap(e=>e.type==='PATH_SELECTED'?[e.pathId]:[]);refs(selected,pathIds);require(selected.length===r.paths.length,'retain selected events');
 require(r.stats.stop!=='BUDGET_REACHED'||!r.stats.optimalWithinHopLimit,'budget is not exhaustive');require(r.stats.traceTruncated===(r.stats.omittedTraceEvents>0),'trace counts');require(r.stats.stop!=='NO_TARGETS'||(r.targets.length===0&&r.paths.length===0),'no targets consistency');return r;
}
export function validateIdentityProposal(value: unknown,g: GraphSnapshot): IdentityProposal {s.proposal(value,'$');const p=value as IdentityProposal;refs(p.identityIds,new Set(g.identities.map(x=>x.id)));refs(p.candidatePersonIds,new Set(g.people.map(x=>x.id)));p.signals.forEach(x=>refs(x.evidenceIds,new Set(g.evidence.map(x=>x.id))));return p;}
export function validateInference<T>(value: unknown, kind: InferenceResult<T>['inferenceType'], payloadCheck: (value:unknown)=>T, authorizedEvidenceIds: ReadonlySet<string>): InferenceResult<T> {
 s.inference((v)=>{payloadCheck(v);})(value,'$');const r=value as InferenceResult<T>;require(r.inferenceType===kind,'inference operation');refs(r.evidenceIds,new Set(authorizedEvidenceIds));return r;
}
export function validateReviewDecision(value: unknown,scopeId:string,version:string,candidateIds:ReadonlySet<string>): ReviewDecision {s.review(value,'$');const r=value as ReviewDecision;require(r.scopeId===scopeId && r.expectedGraphVersion===version,'review snapshot');refs(r.candidateIds,new Set(candidateIds));return r;}
/** Deltas need both committed snapshots. Shape validation alone cannot prove commit or visibility. */
export function validateGraphBuildEvent(value: unknown, context: {jobId:string;scopeId:string;afterSeq:number;before:GraphSnapshot;after:GraphSnapshot;candidateIds:ReadonlySet<string>;proposalIds:ReadonlySet<string>}): GraphBuildEvent {
 s.buildEvent(value,'$');const e=value as GraphBuildEvent;require(e.jobId===context.jobId && e.scopeId===context.scopeId && e.seq>context.afterSeq && context.before.scopeId===e.scopeId && context.after.scopeId===e.scopeId,'job event binding');
 if(e.type==='SNAPSHOT_INVALIDATED'){require(e.baseGraphVersion===context.before.graphVersion && e.graphVersion===context.after.graphVersion && e.baseGraphVersion!==e.graphVersion,'invalidation versions');refs(e.removedSourceIds,new Set(context.before.sources.map(x=>x.id)));e.removedSourceIds.forEach(id=>require(!context.after.sources.some(s=>s.id===id),'source removed'));require(e.reason==='SOURCE_REMOVED'||e.removedSourceIds.length===0,'removal reason');}
 if(e.type==='IMPORT_STARTED')require(context.after.sources.some(x=>x.id===e.sourceId),'visible source');
 if(e.type==='IMPORT_COMPLETED')require(e.graphVersion===context.after.graphVersion,'completion version');
 if(e.type==='REVIEW_REQUIRED'){refs(e.candidateIds,new Set(context.candidateIds));refs(e.proposalIds,new Set(context.proposalIds));}
 if(e.type==='BATCH_COMMITTED'){
 require(e.baseGraphVersion===context.before.graphVersion && e.graphVersion===context.after.graphVersion && e.baseGraphVersion!==e.graphVersion,'committed version transition');
 require(context.before.rootPersonId===context.after.rootPersonId && canonical(context.before.coverage)===canonical(context.after.coverage) && context.before.schemaVersion===context.after.schemaVersion,'root/coverage/schema changes require snapshot invalidation');
 for(const key of ['people','identities','organizations','observedLinks','relationships','searchEdges','evidence','sources'] as const){
  unique(e[key].map(x=>x.id));
  const removed=key==='people'?e.removedPersonIds:['observedLinks','relationships','searchEdges'].includes(key)?e.removedEdgeIds:[];
  const reconstructed=new Map<string,{id:string}>(context.before[key].map(x=>[x.id,x]));
  removed.forEach(id=>reconstructed.delete(id));
  e[key].forEach(x=>{require(!removed.includes(x.id),'upsert and removal cannot overlap');reconstructed.set(x.id,x);});
  require(reconstructed.size===context.after[key].length && context.after[key].every(x=>canonical(reconstructed.get(x.id))===canonical(x)),'delta must reconstruct complete collection; unsupported deletions require snapshot invalidation');
 }
 refs(e.removedPersonIds,new Set(context.before.people.map(x=>x.id)));e.removedPersonIds.forEach(id=>require(!context.after.people.some(x=>x.id===id),'removed person'));
 refs(e.removedEdgeIds,new Set([...context.before.observedLinks,...context.before.relationships,...context.before.searchEdges].map(x=>x.id)));e.removedEdgeIds.forEach(id=>require(![...context.after.observedLinks,...context.after.relationships,...context.after.searchEdges].some(x=>x.id===id),'removed edge'));
 }return e;
}

export interface ImportAuthority extends BatchAuthority {
 scopeId:string;ownerUserId:string;sourcePolicyVersion:string;
 /** Already authorized immutable source identities, with current canonical projection. */
 existingIdentities: ReadonlyArray<{platform:string;externalId:string;personId:string|null}>;
}
export function validateNormalizedImport(value:unknown,authority:ImportAuthority): import('./index.js').NormalizedImportEnvelope {
 const n=normalizeImportShape(value);
 const c=n.context;require(c.scopeId===authority.scopeId && c.ownerUserId===authority.ownerUserId && c.sourceId===authority.sourceId && c.batchId===authority.batchId && c.sourcePolicyVersion===authority.sourcePolicyVersion && c.sharingDecisionId===null,'private import authority');
 validateCandidateBatch(n.batch,authority);n.batch.affiliations.forEach(a=>{a.current ??= null;});
 const recordIds=set(n.records);unique(n.records.map(r=>r.externalRecordId));
 n.records.forEach(r=>{require(r.ownerUserId===c.ownerUserId && r.sourceId===c.sourceId,'record owner/source');require(/^[a-f0-9]{64}$/.test(r.contentDigest),'SHA-256 digest');s.id(r.privatePayloadRef,'$.records.privatePayloadRef');});
 unique(n.evidenceRecords.map(e=>e.evidenceId));require(n.evidenceRecords.length===n.batch.evidence.length,'all evidence has record provenance');
 const evidenceIds=new Set(n.batch.evidence.map(e=>e.id));n.evidenceRecords.forEach(e=>{require(evidenceIds.has(e.evidenceId) && recordIds.has(e.sourceRecordId),'evidence record binding');});
 const key=(i:import('./index.js').SourceIdentityRef)=>JSON.stringify([i.platform,i.externalId]);
 const aliases=new Map(n.batch.people.map(p=>[p.tempId,p.existingPersonId??p.tempId]));
 const canonicalPerson=(ref:string)=>aliases.get(ref)??ref;
 const endpoints=new Map(authority.existingIdentities.map(i=>[key(i),i.personId]));
 n.batch.people.forEach(p=>p.identities.forEach(i=>{const previous=endpoints.get(key(i));require(previous===undefined || previous===null || previous===p.existingPersonId,'reimport cannot silently reassign identity');endpoints.set(key(i),canonicalPerson(p.tempId));}));
 const endpoint=(i:import('./index.js').SourceIdentityRef,ref:string)=>require(endpoints.get(key(i))===canonicalPerson(ref),'source identity endpoint provenance');
 unique(n.facts.map(f=>f.factKey));unique(n.facts.map(f=>`${f.kind}:${f.candidateIndex}`));
 require(n.facts.length===n.batch.observedLinks.length+n.batch.relationships.length+n.batch.affiliations.length,'complete fact provenance');
 n.facts.forEach(f=>{require(recordIds.has(f.sourceRecordId),'fact record binding');if(f.kind==='AFFILIATION'){const a=n.batch.affiliations[f.candidateIndex];require(a,'affiliation index');endpoint(f.personIdentity,a!.personRef);}else {const link=(f.kind==='OBSERVED_LINK'?n.batch.observedLinks:n.batch.relationships)[f.candidateIndex];require(link,'link index');endpoint(f.fromIdentity,link!.fromRef);endpoint(f.toIdentity,link!.toRef);require(canonicalPerson(link!.fromRef)!==canonicalPerson(link!.toRef),'distinct canonical endpoints');}});
 return n;
}
export function validateIdentityLinkRequest(value:unknown,g:GraphSnapshot):import('./index.js').IdentityLinkRequest {
 s.identityLinkRequest(value,'$');const r=value as import('./index.js').IdentityLinkRequest;
 require(r.scopeId===g.scopeId && r.expectedGraphVersion===g.graphVersion,'identity request snapshot');const i=g.identities.find(i=>i.id===r.identityId);require(i && i.personId===r.expectedPersonId,'expected identity mapping');require(r.nextPersonId===null || g.people.some(p=>p.id===r.nextPersonId),'next person authorized');return r;
}
export function validateIdentityRevertRequest(value:unknown,scopeId:string,version:string,decisionIds:ReadonlySet<string>):import('./index.js').IdentityRevertRequest {
 s.identityRevertRequest(value,'$');const r=value as import('./index.js').IdentityRevertRequest;require(r.scopeId===scopeId && r.expectedGraphVersion===version && decisionIds.has(r.decisionId),'authorized versioned reversal');return r;
}

/** Snapshot-independent shape normalization, also used to identify previously successful retries. */
export function normalizeImportShape(value:unknown):import('./index.js').NormalizedImportEnvelope {
 s.normalizedImport(value,'$');const n=structuredClone(value) as import('./index.js').NormalizedImportEnvelope;
 n.batch.affiliations.forEach(a=>{a.current ??= null;});return n;
}
