import type {DiscoveryResult} from './contracts.js';import type {RetrievedPublicDocument} from './document-fetch.js';import type {StagePublicFactsRequest,StagePublicFactsResponse} from '../public-facts/contracts.js';import type {PublicSourceProvisionRequest} from '../storage/public-source-provision.js';
/** Private durable checkpoint. Never serialized through the discovery HTTP boundary. */
export interface DiscoveryWorkflow {
 version:string;result:DiscoveryResult;documents:RetrievedPublicDocument[];
 steps:Array<{documentId:string;provision:PublicSourceProvisionRequest;sourceId?:string;sourceVersion?:string;stageRequest?:StagePublicFactsRequest;stageResponse?:StagePublicFactsResponse;done:boolean}>;
}
