import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {handleAPI} from '../server/api.js';

const base='https://orbit.example';
function database(){
  const raw=new DatabaseSync(':memory:');for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(file=>file.endsWith('.sql')).sort())raw.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8').replaceAll('--> statement-breakpoint',''));
  return {raw,db:{prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this;},async all(){return {results:raw.prepare(sql).all(...this.args)};},async first(){return raw.prepare(sql).get(...this.args)||null;}};},async batch(statements){raw.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.all());raw.exec('COMMIT');return results;}catch(error){raw.exec('ROLLBACK');throw error;}}}};
}
const cookie=(headers,name)=>{const match=new RegExp(`${name}=([^;,]+)`).exec(headers.get('set-cookie')||'');return match?decodeURIComponent(match[1]):null;};

test('Google ID-token login creates one account and stores only a session hash',async()=>{
  const {db,raw}=database(),clientId='246098953725-example.apps.googleusercontent.com',env={DB:db,GOOGLE_CLIENT_ID:clientId};
  const configResponse=await handleAPI(new Request(base+'/api/auth/google/config'),env),config=await configResponse.json(),nonceCookie=cookie(configResponse.headers,'__Host-orbit-google-nonce');
  assert.equal(config.enabled,true);assert.equal(config.nonce,nonceCookie);assert.equal(config.clientId,clientId);
  const login=await handleAPI(new Request(base+'/api/auth/google',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:`__Host-orbit-google-nonce=${encodeURIComponent(nonceCookie)}`},body:JSON.stringify({credential:'signed-google-id-token',nonce:config.nonce})}),{...env,GOOGLE_VERIFY:async()=>({payload:{sub:'google-subject',nonce:config.nonce,email:'person@example.com',email_verified:true,name:'Orbit Tester'}})});
  assert.equal(login.status,200);const result=await login.json();assert.equal(result.newUser,true);assert.equal(result.onboardingComplete,false);
  const sessionToken=cookie(login.headers,'__Host-orbit-session');assert.ok(sessionToken);const stored=raw.prepare('SELECT token_hash FROM sessions').get();assert.notEqual(stored.token_hash,sessionToken);assert.equal(stored.token_hash.length,64);
  const sessionResponse=await handleAPI(new Request(base+'/api/session',{headers:{Cookie:`__Host-orbit-session=${encodeURIComponent(sessionToken)}`}}),env),session=await sessionResponse.json();
  assert.equal(session.authenticated,true);assert.equal(session.provider,'google');assert.equal(session.email,'person@example.com');
  assert.equal(raw.prepare('SELECT COUNT(*) count FROM users').get().count,1);assert.equal(raw.prepare('SELECT COUNT(*) count FROM identities').get().count,1);
});

test('onboarding is server-backed and a bad Google nonce is rejected',async()=>{
  const {db}=database(),clientId='246098953725-example.apps.googleusercontent.com',env={DB:db,GOOGLE_CLIENT_ID:clientId};
  const configResponse=await handleAPI(new Request(base+'/api/auth/google/config'),env),config=await configResponse.json(),nonce=cookie(configResponse.headers,'__Host-orbit-google-nonce');
  const bad=await handleAPI(new Request(base+'/api/auth/google',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:`__Host-orbit-google-nonce=${nonce}`},body:JSON.stringify({credential:'token',nonce:'wrong'})}),env);assert.equal(bad.status,400);
  const login=await handleAPI(new Request(base+'/api/auth/google',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:`__Host-orbit-google-nonce=${nonce}`},body:JSON.stringify({credential:'token',nonce})}),{...env,GOOGLE_VERIFY:async()=>({payload:{sub:'person',nonce,email:'person@example.com',email_verified:true}})}),sessionToken=cookie(login.headers,'__Host-orbit-session');
  const save=await handleAPI(new Request(base+'/api/account/profile',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:`__Host-orbit-session=${encodeURIComponent(sessionToken)}`},body:JSON.stringify({linkedinProfileUrl:'https://linkedin.com/in/orbit-person'})}),env);assert.equal(save.status,200);
  const next=await handleAPI(new Request(base+'/api/session',{headers:{Cookie:`__Host-orbit-session=${encodeURIComponent(sessionToken)}`}}),env);assert.equal((await next.json()).linkedinProfileUrl,'https://www.linkedin.com/in/orbit-person/');
});
