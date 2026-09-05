import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { BackendService, ServiceError, apiFailure, type AuthPort } from './service.js';
import type { GoogleLoginPort } from './auth/google.js';
import * as schema from '../../contracts/schema.js';

/** Matches src/auth/session.ts; credentials and optional email are deliberately not returned here. */
export interface SessionView { actor: { id:string;displayName:string };scopes:Array<{id:string;label:string}> }
export interface HttpAuthPort extends AuthPort {
  displaySession(userId:string):Promise<SessionView>;
  revokeSession(credential:unknown):Promise<void>;
}
export interface HttpDependencies { service:BackendService;auth:HttpAuthPort;browserOrigin:string;oauth?:Pick<GoogleLoginPort,'start'|'callback'|'clearTransactionCookie'> }
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
      if(method==='POST' && url.pathname==='/api/auth/logout') {
        await deps.auth.revokeSession(token);
        response.setHeader('Set-Cookie',`${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${expectedOrigin.startsWith('https:')?'; Secure':''}`);
        response.writeHead(204);response.end();return;
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
