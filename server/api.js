import {ingest,stats,search,neighborhood} from './database.js';
import {consumeRateLimit,rateLimitConfig} from './rate-limit.js';
const json=(value,status=200,headers={})=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
export async function handleAPI(request,env){
  const url=new URL(request.url);
  if(url.pathname==='/api/session'&&request.method==='GET'){
    const id=request.headers.get('oai-authenticated-user-id');
    return json(id?{authenticated:true,id,email:request.headers.get('oai-authenticated-user-email')}:{authenticated:false});
  }
  if(url.pathname.startsWith('/api/')){
    const actor=request.headers.get('oai-authenticated-user-id');if(!actor)return json({error:'Sign in with ChatGPT to use the shared library.'},401);
    const owner=env.SHARED_OWNER||actor;
    if(!env.DB)return json({error:'The database is not available.'},503);
    if(request.method==='POST'&&request.headers.get('origin')!==url.origin)return json({error:'Invalid request origin.'},403);
    try{
      const limited=async kind=>{const limit=rateLimitConfig(env,kind),rate=await consumeRateLimit(env.DB,`${actor}:${kind}`,limit);return rate.allowed?null:json({error:'Rate limit exceeded. Please retry shortly.'},429,{'Retry-After':String(Math.max(1,Math.ceil((rate.resetAt-Date.now())/1000))),'X-RateLimit-Limit':String(rate.limit),'X-RateLimit-Remaining':'0'});};
      if(url.pathname==='/api/library/stats'&&request.method==='GET'){const stop=await limited('read');return stop||json(await stats(env.DB,owner));}
      if(url.pathname==='/api/library/search'&&request.method==='GET'){const stop=await limited('read');return stop||json({people:await search(env.DB,owner,url.searchParams.get('q')||'')});}
      if(url.pathname==='/api/library/graph'&&request.method==='GET'){const stop=await limited('read');return stop||json(await neighborhood(env.DB,owner,url.searchParams.get('url'),Number(url.searchParams.get('depth')||2),Number(url.searchParams.get('limit')||1000)));}
      if(url.pathname==='/api/library/ingest'&&request.method==='POST'){
        if(!request.headers.get('content-type')?.startsWith('application/json'))return json({error:'Send JSON.'},415);
        const reader=request.body?.getReader();if(!reader)return json({error:'Send a JSON batch.'},400);const decoder=new TextDecoder();let body='',size=0;while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>500000){await reader.cancel();return json({error:'Batch is too large.'},413);}body+=decoder.decode(chunk.value,{stream:true});}body+=decoder.decode();
        const stop=await limited('write');return stop||json(await ingest(env.DB,owner,JSON.parse(body)));
      }
      return json({error:'Not found.'},404);
    }catch(error){console.error('Library request failed',url.pathname,error.message);return json({error: /Invalid|Choose|Enter|Save at most|Each link/.test(error.message)?error.message:'The library request failed. Please retry.'},400);}
  }
  return null;
}
