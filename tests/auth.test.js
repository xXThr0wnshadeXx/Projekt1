import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {handleAPI} from '../server/api.js';

const base='https://orbit.example';
function database(){
  const raw=new DatabaseSync(':memory:');for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(file=>file.endsWith('.sql')))raw.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
  return {prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this;},async all(){return {results:raw.prepare(sql).all(...this.args)};},async first(){return raw.prepare(sql).get(...this.args)||null;}};}};
}
const cookieValue=(headers,name)=>decodeURIComponent(new RegExp(`${name}=([^;]+)`).exec(headers.get('set-cookie'))[1]);
const env={DB:database(),GOOGLE_CLIENT_ID:'client-id',GOOGLE_CLIENT_SECRET:'client-secret'};

test('Google login start uses PKCE and never exposes the client secret',async()=>{
  const response=await handleAPI(new Request(base+'/auth/google/start?return_to=/map.html'),env);
  assert.equal(response.status,302);
  const location=new URL(response.headers.get('location'));
  assert.equal(location.origin,'https://accounts.google.com');
  assert.equal(location.searchParams.get('client_id'),'client-id');
  assert.equal(location.searchParams.get('redirect_uri'),base+'/auth/google/callback');
  assert.equal(location.searchParams.get('code_challenge_method'),'S256');
  assert.equal(location.searchParams.get('scope'),'openid email profile');
  assert.ok(location.searchParams.get('state'));
  assert.doesNotMatch(location.toString(),/client-secret/);
  assert.ok(cookieValue(response.headers,'__Host-orbit-google-state'));
  assert.ok(cookieValue(response.headers,'__Host-orbit-google-verifier'));
});

test('Google callback validates state, creates a server session, and reports the signed-in identity',async()=>{
  const start=await handleAPI(new Request(base+'/auth/google/start?return_to=/map.html'),env);
  const headers=start.headers;
  const state=cookieValue(headers,'__Host-orbit-google-state');
  const verifier=cookieValue(headers,'__Host-orbit-google-verifier');
  const returnTo=cookieValue(headers,'__Host-orbit-google-return-to');
  let calls=0;
  const response=await handleAPI(new Request(`${base}/auth/google/callback?code=one-time-code&state=${encodeURIComponent(state)}`,{headers:{Cookie:`__Host-orbit-google-state=${encodeURIComponent(state)}; __Host-orbit-google-verifier=${encodeURIComponent(verifier)}; __Host-orbit-google-return-to=${encodeURIComponent(returnTo)}`}}),{...env,GOOGLE_FETCH:async()=>{calls++;return calls===1?new Response(JSON.stringify({access_token:'access-token'})):new Response(JSON.stringify({sub:'12345',email:'person@example.com',email_verified:true}));}});
  assert.equal(response.status,302);
  assert.equal(response.headers.get('location'),base+'/map.html');
  assert.equal(calls,2);
  const session=cookieValue(response.headers,'__Host-orbit-session');
  const sessionResponse=await handleAPI(new Request(base+'/api/session',{headers:{Cookie:`__Host-orbit-session=${encodeURIComponent(session)}`}}),env);
  assert.deepEqual(await sessionResponse.json(),{authenticated:true,id:'google:12345',email:'person@example.com',provider:'google',googleEnabled:true});
});

test('Google callback rejects a mismatched state without exchanging a code',async()=>{
  let called=false;
  const response=await handleAPI(new Request(base+'/auth/google/callback?code=one-time-code&state=wrong',{headers:{Cookie:'__Host-orbit-google-state=right; __Host-orbit-google-verifier=verifier; __Host-orbit-google-return-to=%2Fsetup.html'}}),{...env,GOOGLE_FETCH:async()=>{called=true;return new Response();}});
  assert.equal(response.status,302);
  assert.equal(response.headers.get('location'),base+'/?login=google_failed#login');
  assert.equal(called,false);
});
