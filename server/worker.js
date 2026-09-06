import assets from '../.build/assets.js';
import {handleAPI} from './api.js';
import {authenticatedActor} from './auth.js';

const SHARED_WORKSPACE = 'demo-knowledge-graph';

export default {async fetch(request,env){
  const databaseEnv = {
    ...env,
    // The hosted Site supplies the built-in D1 DB binding. Every signed-in
    // contributor writes to the same demo graph through the authenticated API.
    // Application rate limiting remains available but is off during team testing.
    ORBIT_RATE_LIMIT_ENABLED: env.ORBIT_RATE_LIMIT_ENABLED || 'false',
    SHARED_OWNER: SHARED_WORKSPACE,
  };
  const response=await handleAPI(request,databaseEnv);if(response)return response;
  const url=new URL(request.url);
  if(['/setup.html','/map.html'].includes(url.pathname)&&!await authenticatedActor(request,databaseEnv))return Response.redirect(url.origin+'/?return_to='+encodeURIComponent(url.pathname)+'#login',302);
  if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
  const asset=assets[url.pathname==='/'?'/index.html':url.pathname];if(!asset)return new Response('Not found',{status:404});
  const bytes=asset.binary?Uint8Array.from(atob(asset.body),c=>c.charCodeAt(0)):asset.body;
  return new Response(request.method==='HEAD'?null:bytes,{headers:{'Content-Type':asset.type,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'}});
}};
