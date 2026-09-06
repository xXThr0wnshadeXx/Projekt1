import {createHash} from 'node:crypto';
import type {FactActor} from '../facts/contracts.js';import {ServiceError} from '../service.js';
import type {DiscoveryRequest,DiscoveryResult,SearchProvider} from './contracts.js';import {normalizeProfileUrl} from './contracts.js';
import {createDiscoveryPlanner} from './planning/index.js';import {extractPublicClaimFragments,createPublicExtractionProducer} from './extraction/index.js';
import type {DiscoverySourcesOptions} from './providers/service.js';import type {DiscoveryReceipts} from './receipts.js';import type {DiscoveryWorkflow} from './workflow.js';
import type {PublicFactsService} from '../public-facts/service.js';import type {PublicSourceProvisioner} from '../storage/public-source-provision.js';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function kind(url:string):'PUBLIC_PROFILE'|'PUBLIC_ARTICLE'{for(const platform of ['linkedin','instagram'] as const){try{normalizeProfileUrl(url,platform);return 'PUBLIC_PROFILE';}catch{}}return 'PUBLIC_ARTICLE';}
export interface OrchestrationPorts {receipts:DiscoveryReceipts;provider:SearchProvider;documents:DiscoverySourcesOptions['documents'];publicFacts:Pick<PublicFactsService,'stage'>;publicSources:Pick<PublicSourceProvisioner,'provision'>;actor(credential:unknown):Promise<FactActor>}
/** One global planner; retries resume retained observations and exact durable step inputs. */
export async function orchestrateDiscovery(ports:OrchestrationPorts,credential:unknown,request:DiscoveryRequest,id:string,runId:string,retained:DiscoveryWorkflow|null,signal?:AbortSignal):Promise<DiscoveryResult>{
 const actor=()=>ports.actor(credential);
 const check=()=>{if(signal?.aborted)throw new ServiceError('SOURCE_UNAVAILABLE',502);};
 const save=async(work:DiscoveryWorkflow)=>{check();await ports.receipts.saveWorkflow(await actor(),request,id,runId,work);};
 let work=retained;
 if(!work){
  const authority=await ports.receipts.authorize(await actor(),request);
  const planner=createDiscoveryPlanner({provider:ports.provider,documents:ports.documents,extraction:{extract:async(doc)=>extractPublicClaimFragments(doc)}});
  const output=await planner.collect({request,authority},signal);check();
  await ports.receipts.authorize(await actor(),request);
  const successful=output.queries.some(q=>q.outcome==='SUCCEEDED'),provider=ports.provider;
  const result:DiscoveryResult={discoveryId:id,scopeId:request.scopeId,baseGraphVersion:request.expectedGraphVersion,status:!successful&&!output.documents.length?'SOURCE_UNAVAILABLE':'INSUFFICIENT_PUBLIC_EVIDENCE',
   capabilities:{wikimedia:provider.kind==='WIKIMEDIA'&&successful?'AVAILABLE':'UNAVAILABLE',generalWeb:provider.kind==='WIKIMEDIA'||!provider.configured?'NOT_CONFIGURED':successful?'AVAILABLE':'UNAVAILABLE',coverage:provider.kind==='WIKIMEDIA'?'WIKIMEDIA_ONLY':'GENERAL_PUBLIC_WEB'},
   proposalRefs:[],unresolvedIdentityCount:2+(request.target.personName||request.target.profileUrl?1:0),warnings:output.limitations.filter(w=>!w.startsWith('Claims remain unreviewed and unpersisted;')),
   budget:{queriesUsed:output.budget.searchesAttempted,pagesRead:output.budget.documentAttempts,exhausted:output.budget.exhausted}};
  // Keep exact immutable observations only when extraction found supported fragments; no snippets.
  const documents=output.documents.filter(d=>output.extractions.some(e=>e.documentId===d.id&&e.documentRevision===d.revision&&e.output.proposals.length));
  work={version:request.expectedGraphVersion,result,documents,steps:[]};await save(work);
 }
 for(const document of work.documents){
  check();let step=work.steps.find(s=>s.documentId===document.id);
  if(step?.done)continue;
  if(!step){step={documentId:document.id,provision:{scopeId:request.scopeId,expectedGraphVersion:work.version,document:{url:document.sourceUrl,kind:kind(document.sourceUrl),title:document.title,retrievedAt:document.retrievedAt}},done:false};work.steps.push(step);await save(work);}
  if(!step.sourceId){
   const provisioned=await ports.publicSources.provision(await actor(),step.provision,`source_${hash([id,document.id,document.revision])}`);
   step.sourceId=provisioned.sourceId;step.sourceVersion=provisioned.graphVersion;work.version=provisioned.graphVersion;await save(work);
  }
  if(!step.stageRequest){
   const sourceId=step.sourceId,batchId=`batch_${hash([id,document.id,document.revision])}`,stageKey=`stage_${hash([id,document.id,document.revision])}`;
   const producer=createPublicExtractionProducer({authorize:async(c,r,docs)=>{
    const who=await ports.actor(c),source=await ports.receipts.publicSource(who,{...request,expectedGraphVersion:r.expectedGraphVersion},sourceId);
    return{context:{ownerUserId:who.userId,scopeId:request.scopeId,sourceId,batchId,sourcePolicyVersion:'public-citation-review-v1',sharingDecisionId:null},graphVersion:source.graphVersion,source:{enabled:true,origin:'PUBLIC_SOURCE',provider:source.provider},
     documents:docs.map(doc=>({documentId:doc.id,documentRevision:doc.revision,privatePayloadRef:`payload_${hash([id,doc.id,doc.revision])}`,kind:source.provider,independenceGroup:'UNASSESSED_PUBLIC_ORIGIN'}))};
   }});
   const produced=await producer.produce(credential,{scopeId:request.scopeId,expectedGraphVersion:step.sourceVersion!,idempotencyKey:stageKey},[document],signal);
   if(!produced.stageRequest){step.done=true;await save(work);continue;}
   step.stageRequest=produced.stageRequest;await save(work);
  }
  if(!step.stageResponse){check();step.stageResponse=await ports.publicFacts.stage(credential,step.stageRequest);work.version=step.stageResponse.graphVersion;await save(work);}
  step.done=true;await save(work);
 }
 const refs=work.steps.flatMap(step=>step.stageResponse?step.stageRequest!.envelope.proposals.map(p=>({id:p.id,revision:p.revision})):[]);
 work.result.proposalRefs=refs;
 if(refs.length){work.result.status='REVIEW_REQUIRED';work.result.warnings=[...new Set([...work.result.warnings,'Public proposals are durably staged, still unreviewed and nontraversable. Resolve identities and explicitly review public relationships before searching for introduction routes.'])];}
 else work.result.warnings=[...new Set([...work.result.warnings,'No supported proposals were persisted; public evidence is insufficient to establish an introduction route.'])];
 work.result.unresolvedIdentityCount=2+(request.target.personName||request.target.profileUrl?1:0)+work.steps.reduce((sum,step)=>sum+(step.stageRequest?new Set(step.stageRequest.envelope.proposals.flatMap(p=>[p.subject,...(p.object?[p.object]:[])].map(e=>JSON.stringify(e.sourceIdentity)))).size:0),0);
 await save(work);return work.result;
}
