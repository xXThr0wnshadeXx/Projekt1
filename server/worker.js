import assets from '../.build/assets.js';
import {handleAPI} from './api.js';
export default {async fetch(request,env){
  const response=await handleAPI(request,env);if(response)return response;
  const url=new URL(request.url);
  if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
  const asset=assets[url.pathname==='/'?'/index.html':url.pathname];if(!asset)return new Response('Not found',{status:404});
  const bytes=asset.binary?Uint8Array.from(atob(asset.body),c=>c.charCodeAt(0)):asset.body;
  return new Response(request.method==='HEAD'?null:bytes,{headers:{'Content-Type':asset.type,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'}});
}};
