import assets from '../.build/assets.js';
import {handleAPI} from './api.js';
import {createTursoDatabase} from './turso.js';
export default {async fetch(request,env){
  const databaseEnv = {
    ...env,
    ...(env.TURSO_DATABASE_URL && env.TURSO_AUTH_TOKEN
      ? {DB:createTursoDatabase({url:env.TURSO_DATABASE_URL,authToken:env.TURSO_AUTH_TOKEN})}
      : {}),
    // Opt-in demo mode: authenticated users contribute to one named graph.
    // Leaving this unset preserves owner-isolated libraries.
    SHARED_OWNER: env.ORBIT_SHARED_WORKSPACE_ID || undefined,
  };
  const response=await handleAPI(request,databaseEnv);if(response)return response;
  const url=new URL(request.url);
  if(['/setup.html','/map.html'].includes(url.pathname)&&!request.headers.get('oai-authenticated-user-id'))return Response.redirect(url.origin+'/signin-with-chatgpt?return_to='+encodeURIComponent(url.pathname),302);
  if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
  const asset=assets[url.pathname==='/'?'/index.html':url.pathname];if(!asset)return new Response('Not found',{status:404});
  const bytes=asset.binary?Uint8Array.from(atob(asset.body),c=>c.charCodeAt(0)):asset.body;
  return new Response(request.method==='HEAD'?null:bytes,{headers:{'Content-Type':asset.type,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'}});
}};
