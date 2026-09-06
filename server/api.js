import {ingest,stats,search,neighborhood} from './database.js';
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export async function handleAPI(request,env){
  const url=new URL(request.url);
  if(url.pathname==='/api/session'&&request.method==='GET'){
    const id=request.headers.get('oai-authenticated-user-id');
    return json(id?{authenticated:true,id,email:request.headers.get('oai-authenticated-user-email')}:{authenticated:false});
  }
  if(url.pathname.startsWith('/api/')){
    const owner=request.headers.get('oai-authenticated-user-id');if(!owner)return json({error:'Sign in with ChatGPT to use your private library.'},401);
    if(!env.DB)return json({error:'The database is not available.'},503);
    if(request.method==='POST'&&request.headers.get('origin')!==url.origin)return json({error:'Invalid request origin.'},403);
    try{
      if(url.pathname==='/api/library/stats'&&request.method==='GET')return json(await stats(env.DB,owner));
      if(url.pathname==='/api/library/search'&&request.method==='GET')return json({people:await search(env.DB,owner,url.searchParams.get('q')||'')});
      if(url.pathname==='/api/library/graph'&&request.method==='GET')return json(await neighborhood(env.DB,owner,url.searchParams.get('url'),Number(url.searchParams.get('depth')||2),Number(url.searchParams.get('limit')||1000)));
      if(url.pathname==='/api/library/ingest'&&request.method==='POST'){
        if(!request.headers.get('content-type')?.startsWith('application/json'))return json({error:'Send JSON.'},415);
        const reader=request.body?.getReader();if(!reader)return json({error:'Send a JSON batch.'},400);const decoder=new TextDecoder();let body='',size=0;while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>500000){await reader.cancel();return json({error:'Batch is too large.'},413);}body+=decoder.decode(chunk.value,{stream:true});}body+=decoder.decode();
        return json(await ingest(env.DB,owner,JSON.parse(body)));
      }
      return json({error:'Not found.'},404);
    }catch(error){console.error('Library request failed',url.pathname,error.message);return json({error: /Invalid|Choose|Enter|Save at most|Each link/.test(error.message)?error.message:'The library request failed. Please retry.'},400);}
  }
  return null;
}
