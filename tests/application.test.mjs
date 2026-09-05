import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApplication} from '../dist/packages/server/application.js';
const env={APP_ORIGIN:'https://app.example',GOOGLE_CLIENT_ID:'test.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'test-only',DATABASE_URL:'postgresql://unused'};
function storage(events){return {store:{},migrate:async()=>{events.push('migrated');},probe:async()=>{events.push('probed');return true;},close:async()=>{events.push('closed');}};}
test('storage migration completes before application is returned for listening',async()=>{
 const events=[],db=storage(events);
 const app=await createApplication({env,openStorage:async()=>{events.push('opened');return db;}});
 assert.deepEqual(events,['opened','migrated']);assert.equal(app.server.listening,false);assert.equal(app.configured.auth,true);assert.equal(app.configured.search,false);
 assert.equal(await app.readiness(new AbortController().signal),false);assert.ok(!events.includes('probed'));await app.close();assert.equal(events.at(-1),'closed');
});
test('migration failure closes pool and never produces a listener',async()=>{
 const events=[],db=storage(events);db.migrate=async()=>{throw new Error('migration failed');};
 await assert.rejects(createApplication({env,openStorage:async()=>db}),/migration failed/);assert.deepEqual(events,['closed']);
});
test('missing credentials and missing storage never create a configured auth adapter',async()=>{
 for(const config of [{}, {...env,DATABASE_URL:undefined}]){
  const app=await createApplication({env:config});assert.equal(app.configured.auth,false);assert.equal(app.configured.storage,false);assert.equal(await app.readiness(new AbortController().signal),false);await app.close();
 }
});
test('partially specified Google credentials fail before storage opens',async()=>{
 let opened=false;await assert.rejects(createApplication({env:{...env,GOOGLE_CLIENT_SECRET:undefined},openStorage:async()=>{opened=true;return storage([]);}}));assert.equal(opened,false);
});
test('production mounts static and API with readiness false when search unavailable',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'projekt1-composition-'));await writeFile(join(dir,'index.html'),'<main>empty</main>');t.after(()=>rm(dir,{recursive:true,force:true}));
 const app=await createApplication({env:{NODE_ENV:'production',APP_ORIGIN:'https://app.example'},config:{production:true,host:'127.0.0.1',port:0,browserOrigin:'https://app.example',googleRedirectUri:'https://app.example/api/auth/google/callback',webRoot:dir}});
 t.after(()=>app.close());app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${app.server.address().port}`;
 assert.equal((await fetch(base+'/')).status,200);assert.equal((await fetch(base+'/api/session')).status,401);assert.equal((await fetch(base+'/api/ready')).status,503);assert.equal((await fetch(base+'/api/auth/google/start')).status,502);
});
test('readiness probes storage only with every required adapter and honors abort',async()=>{
 const events=[],app=await createApplication({env,openStorage:async()=>storage(events),search:{goals:{resolve:async()=>{throw new Error('unused');}},engine:{findBestPaths:()=>{throw new Error('unused');}}}});
 assert.equal(await app.readiness(new AbortController().signal),true);assert.equal(await app.readiness(AbortSignal.abort()),false);assert.equal(events.filter(x=>x==='probed').length,1);await app.close();
});
test('composition derives omitted OAuth callback and rejects conflicting explicit callback',async t=>{
 const db=storage([]);db.store.putOAuthTransaction=async()=>{};
 const app=await createApplication({env,openStorage:async()=>db});t.after(()=>app.close());
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/auth/google/start`,{redirect:'manual'});
 assert.equal(response.status,302);assert.equal(new URL(response.headers.get('location')).searchParams.get('redirect_uri'),'https://app.example/api/auth/google/callback');
 let opened=false;
 await assert.rejects(createApplication({env:{...env,GOOGLE_REDIRECT_URI:'https://other.example/api/auth/google/callback'},openStorage:async()=>{opened=true;return db;}}),/GOOGLE_REDIRECT_URI/);
 assert.equal(opened,false);
});
