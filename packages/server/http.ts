import type {DiscoveryApplication} from './discovery/composition.js';
import {validateDiscoveryRequest} from './discovery/contracts.js';
import {discoveryServiceError} from './discovery/composition.js';
import type {FactReviewService} from './facts/service.js';
import {validateConfirmFacts,validateFactReview} from './facts/contracts.js';
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { BackendService, ServiceError, apiFailure, type AuthPort } from './service.js';
import type { GoogleImportBridge } from './imports/bridge.js';
import type { GoogleContacts } from './auth/contacts.js';
import type { GoogleLoginPort } from './auth/google.js';
import * as schema from '../../contracts/schema.js';

/** Matches src/auth/session.ts; credentials and optional email are deliberately not returned here. */
export interface SessionView { actor: { id:string;displayName:string };scopes:Array<{id:string;label:string}> }
export interface HttpAuthPort extends AuthPort {
  displaySession(userId:string):Promise<SessionView>;
  revokeSession(credential:unknown):Promise<void>;
}
export interface HttpDependencies { service:BackendService;auth:HttpAuthPort;browserOrigin:string;oauth?:Pick<GoogleLoginPort,'start'|'callback'|'clearTransactionCookie'>;contacts?:Pick<GoogleContacts,'start'|'callback'|'clearTransactionCookie'>;imports?:Pick<GoogleImportBridge,'start'|'review'|'approve'>;facts?:Pick<FactReviewService,'review'|'confirm'>;discovery?:Pick<DiscoveryApplication,'discover'|'capabilities'> }
const sessionShape = schema.object({actor:schema.object({id:schema.id,displayName:schema.string}),scopes:schema.array(schema.object({id:schema.id,label:schema.string}))});
const cookieName='projekt1_session';
const bodyLimit=16*1024;
function credential(request:IncomingMessage):string|null {
  const cookies=(request.headers.cookie??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(`${cookieName}=`));
  if(cookies.length!==1)return null;
  const value=cookies[0]!.slice(cookieName.length+1);
  return /^[A-Za-z0-9_-]{32,256}$/.test(value)?value:null;
}
function json(response:ServerResponse,status:number,value:unknown) {
  response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(value));
}
async function readJson(request:IncomingMessage):Promise<unknown> {
  if(request.headers['content-type']?.split(';')[0]?.trim()!=='application/json')throw new ServiceError('INVALID_INPUT',415);
  const declared=Number(request.headers['content-length']??0);
  if(!Number.isFinite(declared)||declared>bodyLimit)throw new ServiceError('INVALID_INPUT',413);
  const chunks:Buffer[]=[];let length=0;
  for await(const chunk of request){length+=chunk.length;if(length>bodyLimit)throw new ServiceError('INVALID_INPUT',413);chunks.push(Buffer.from(chunk));}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ServiceError('INVALID_INPUT',400);}
}
export function createApiHandler(deps:HttpDependencies):RequestListener {
  const expectedOrigin=new URL(deps.browserOrigin).origin;
  return async(request,response)=>{
    const requestId=randomUUID();
    response.setHeader('Cache-Control','no-store');
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Referrer-Policy','no-referrer');
    try {
      const url=new URL(request.url??'/',expectedOrigin),method=request.method??'GET';
      if(method==='POST' && request.headers.origin!==expectedOrigin)throw new ServiceError('FORBIDDEN',403);
      const token=credential(request);
      if(method==='GET' && url.pathname==='/api/health') {json(response,200,{status:'ok'});return;}
      if(method==='GET' && url.pathname==='/api/session') {
        const actor=await deps.auth.resolveSession(token);if(!actor)throw new ServiceError('UNAUTHENTICATED',401);
        const view=await deps.auth.displaySession(actor.userId);
        try {sessionShape(view,'$');if(view.actor.id!==actor.userId || new Set(view.scopes.map(s=>s.id)).size!==view.scopes.length)throw new Error();}catch{throw new ServiceError('INTERNAL',500);}
        json(response,200,view);return;
      }
      if(method==='GET' && url.pathname==='/api/auth/google/start') {
        if(!deps.oauth)throw new ServiceError('SOURCE_UNAVAILABLE',502);
        const redirect=await deps.oauth.start();
        response.setHeader('Set-Cookie',redirect.cookies);
        response.writeHead(302,{Location:redirect.location});response.end();return;
      }
      if(method==='GET' && url.pathname==='/api/auth/google/callback') {
        if(!deps.oauth)throw new ServiceError('SOURCE_UNAVAILABLE',502);
        try {
          // Preserve duplicate query parameters and the full raw cookie header for auth validation.
          const redirect=await deps.oauth.callback(url.searchParams,request.headers.cookie);
          response.setHeader('Set-Cookie',redirect.cookies);
          response.writeHead(302,{Location:redirect.location});response.end();return;
        }catch(error){response.setHeader('Set-Cookie',deps.oauth.clearTransactionCookie());throw error;}
      }
      if(method==='POST' && url.pathname==='/api/auth/google/contacts/start') {
        const input=await readJson(request);schema.object({scopeId:schema.id})(input,'$');
        if(!deps.contacts)throw new ServiceError('SOURCE_UNAVAILABLE',502);
        const redirect=await deps.contacts.start(token,(input as {scopeId:string}).scopeId);
        response.setHeader('Set-Cookie',redirect.cookies);
        json(response,200,{authorizationUrl:redirect.location});return;
      }
      if(method==='GET' && url.pathname==='/api/auth/google/contacts/callback') {
        try {
          if(!deps.contacts)throw new ServiceError('SOURCE_UNAVAILABLE',502);
          const redirect=await deps.contacts.callback(url.searchParams,request.headers.cookie);
          if(redirect.location!==`${expectedOrigin}/`)throw new ServiceError('INTERNAL',500);
          response.setHeader('Set-Cookie',redirect.cookies);
          response.writeHead(303,{Location:redirect.location});response.end();return;
        }catch(error){
          response.setHeader('Set-Cookie',deps.contacts?.clearTransactionCookie()??`projekt1_contacts_oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${expectedOrigin.startsWith('https:')?'; Secure':''}`);
          throw error;
        }
      }
      if(method==='POST' && url.pathname==='/api/auth/logout') {
        await deps.auth.revokeSession(token);
        response.setHeader('Set-Cookie',`${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${expectedOrigin.startsWith('https:')?'; Secure':''}`);
        response.writeHead(204);response.end();return;
      }
      if((method==='GET'&&url.pathname==='/api/discovery/capabilities')||(method==='POST'&&url.pathname==='/api/discovery')) {
        if(!await deps.auth.resolveSession(token))throw new ServiceError('UNAUTHENTICATED',401);
        if(!deps.discovery)throw new ServiceError('SOURCE_UNAVAILABLE',502);
        const cancelled=new AbortController();
        const abort=()=>{if(!response.writableEnded)cancelled.abort();};response.on('close',abort);
        try {
          if(method==='GET')json(response,200,await deps.discovery.capabilities(token));
          else json(response,200,await deps.discovery.discover(token,validateDiscoveryRequest(await readJson(request)),cancelled.signal));
        }catch(error){throw discoveryServiceError(error);}finally{response.removeListener('close',abort);}return;
      }
      if((method==='GET'&&url.pathname==='/api/facts/review')||(method==='POST'&&url.pathname==='/api/facts/confirm')) {
        if(!await deps.auth.resolveSession(token))throw new ServiceError('UNAUTHENTICATED',401);
        const input=method==='GET'?validateFactReview({scopeId:url.searchParams.get('scopeId')}):validateConfirmFacts(await readJson(request));
        if(!deps.facts)throw new ServiceError('SOURCE_UNAVAILABLE',502);
        json(response,200,method==='GET'?await deps.facts.review(token,input):await deps.facts.confirm(token,input));return;
      }
      if(method==='GET' && url.pathname==='/api/sources') {
        const scope=url.searchParams.get('scopeId');schema.id(scope,'$.scopeId');
        const graph=await deps.service.graph(token,scope!);
        json(response,200,{scopeId:graph.scopeId,graphVersion:graph.graphVersion,sources:graph.sources});return;
      }
      if(method==='POST' && url.pathname==='/api/imports/google') {
        const input=await readJson(request);
        schema.object({scopeId:schema.id,sourceId:schema.id,expectedGraphVersion:schema.id,idempotencyKey:schema.id})(input,'$');
        if(!await deps.auth.resolveSession(token))throw new ServiceError('UNAUTHENTICATED',401);
        if(!deps.imports)throw new ServiceError('SOURCE_UNAVAILABLE',502);
        json(response,202,await deps.imports.start(token,input));return;
      }
      const jobRoute=/^\/api\/imports\/([^/]+)(\/approve)?$/.exec(url.pathname);
      if(jobRoute && ((method==='GET'&&!jobRoute[2])||(method==='POST'&&jobRoute[2]))) {
        const jobId=jobRoute[1];schema.id(jobId,'$.jobId');
        if(!await deps.auth.resolveSession(token))throw new ServiceError('UNAUTHENTICATED',401);
        if(!deps.imports)throw new ServiceError('SOURCE_UNAVAILABLE',502);
        if(method==='GET') {
          const scopeId=url.searchParams.get('scopeId');schema.id(scopeId,'$.scopeId');
          json(response,200,await deps.imports.review(token,{scopeId,jobId}));return;
        }
        const input=await readJson(request);
        schema.object({scopeId:schema.id,expectedGraphVersion:schema.id,idempotencyKey:schema.id,confirm:schema.literal(true)})(input,'$');
        json(response,200,await deps.imports.approve(token,{...(input as object),jobId}));return;
      }
      if(method==='GET' && url.pathname==='/api/graph') {
        const scope=url.searchParams.get('scopeId');schema.id(scope,'$.scopeId');
        json(response,200,await deps.service.graph(token,scope!));return;
      }
      if(method==='POST' && url.pathname==='/api/search') {
        json(response,200,await deps.service.search(token,await readJson(request)));return;
      }
      json(response,404,{error:{code:'INVALID_INPUT',message:'Route not found.',requestId}});
    }catch(error){
      if(!response.headersSent){const failure=apiFailure(error,requestId);json(response,failure.status,failure.body);}else response.end();
    }
  };
}
export function createApiServer(deps:HttpDependencies) { return createServer(createApiHandler(deps)); }
