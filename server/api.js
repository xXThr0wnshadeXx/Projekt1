import {ingest,stats,search,neighborhood,listImports} from './database.js';
import {consumeRateLimit,rateLimitConfig} from './rate-limit.js';
import {profileURL} from '../src/core.js';
import {authenticatedActor,finishGoogleLogin,googleConfig,googleLoginEnabled,signOut,updateLinkedInProfile} from './auth.js';
const json=(value,status=200,extra={})=>{const headers=extra instanceof Headers?extra:new Headers(extra);headers.set('Cache-Control','no-store');headers.set('X-Content-Type-Options','nosniff');return Response.json(value,{status,headers});};
async function readJSON(request,limit=20000){
  if(!request.headers.get('content-type')?.startsWith('application/json'))throw Object.assign(Error('Send JSON.'),{status:415});
  const reader=request.body?.getReader();if(!reader)throw Object.assign(Error('Send a JSON request.'),{status:400});const decoder=new TextDecoder();let body='',size=0;
  while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>limit){await reader.cancel();throw Object.assign(Error('Request is too large.'),{status:413});}body+=decoder.decode(chunk.value,{stream:true});}body+=decoder.decode();
  try{return JSON.parse(body);}catch{throw Object.assign(Error('Send valid JSON.'),{status:400});}
}
export async function handleAPI(request,env){
  const url=new URL(request.url);
  if(url.pathname==='/api/auth/google/config'&&request.method==='GET'){
    const config=await googleConfig(request,env);return json(config.body,200,config.headers);
  }
  if(url.pathname==='/api/auth/google'&&request.method==='POST'){
    if(request.headers.get('origin')!==url.origin)return json({error:'Invalid request origin.'},403);
    try{const result=await finishGoogleLogin(request,env,await readJSON(request));return json(result.body,200,result.headers);}catch(error){console.error('Google sign-in failed',error.message);return json({error:error.message||'Google sign-in failed.'},400);}
  }
  if(url.pathname==='/api/auth/logout'&&request.method==='POST'){
    if(request.headers.get('origin')!==url.origin)return json({error:'Invalid request origin.'},403);
    return json({signedOut:true},200,await signOut(request,env));
  }
  if(url.pathname==='/api/session'&&request.method==='GET'){
    const actor=await authenticatedActor(request,env);
    return json(actor?{authenticated:true,id:actor.id,email:actor.email,displayName:actor.displayName,provider:actor.provider,linkedinProfileUrl:actor.linkedinProfileUrl,onboardingComplete:Boolean(actor.linkedinProfileUrl),googleEnabled:googleLoginEnabled(env)}:{authenticated:false,googleEnabled:googleLoginEnabled(env)});
  }
  if(url.pathname.startsWith('/api/')){
    const actor=await authenticatedActor(request,env);if(!actor)return json({error:'Sign in with Google or ChatGPT to continue.'},401);
    const owner=env.SHARED_OWNER||actor.id;
    if(!env.DB)return json({error:'The database is not available.'},503);
    if(request.method==='POST'&&request.headers.get('origin')!==url.origin)return json({error:'Invalid request origin.'},403);
    try{
      if(url.pathname==='/api/account/profile'&&request.method==='POST'){
        const body=await readJSON(request),profile=profileURL(body.linkedinProfileUrl);if(!profile)return json({error:'Enter a valid LinkedIn person profile URL.'},400);
        const updated=await updateLinkedInProfile(env.DB,actor,profile);return json({saved:true,linkedinProfileUrl:updated.linkedinProfileUrl,onboardingComplete:true});
      }
      const limited=async kind=>{if(env.ORBIT_RATE_LIMIT_ENABLED!=='true')return null;const limit=rateLimitConfig(env,kind),rate=await consumeRateLimit(env.DB,`${actor.id}:${kind}`,limit);return rate.allowed?null:json({error:'Rate limit exceeded. Please retry shortly.'},429,{'Retry-After':String(Math.max(1,Math.ceil((rate.resetAt-Date.now())/1000))),'X-RateLimit-Limit':String(rate.limit),'X-RateLimit-Remaining':'0'});};
      if(url.pathname==='/api/library/stats'&&request.method==='GET'){const stop=await limited('read');return stop||json(await stats(env.DB,owner));}
      if(url.pathname==='/api/library/imports'&&request.method==='GET'){const stop=await limited('read');return stop||json({imports:await listImports(env.DB,owner)});}
      if(url.pathname==='/api/library/search'&&request.method==='GET'){const stop=await limited('read');return stop||json({people:await search(env.DB,owner,url.searchParams.get('q')||'')});}
      if(url.pathname==='/api/library/graph'&&request.method==='GET'){const stop=await limited('read');return stop||json(await neighborhood(env.DB,owner,url.searchParams.get('url'),Number(url.searchParams.get('depth')||2),Number(url.searchParams.get('limit')||1000)));}
      if(url.pathname==='/api/library/ingest'&&request.method==='POST'){
        const body=await readJSON(request,500000),stop=await limited('write');return stop||json(await ingest(env.DB,owner,body));
      }
      return json({error:'Not found.'},404);
    }catch(error){console.error('Library request failed',url.pathname,error.message);return json({error: /Invalid|Choose|Enter|Save at most|Each link|Send|Request/.test(error.message)?error.message:'The library request failed. Please retry.'},error.status||400);}
  }
  return null;
}
