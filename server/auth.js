import {createRemoteJWKSet,jwtVerify} from 'jose';

const GOOGLE_JWKS=createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const SESSION_COOKIE='__Host-orbit-session';
const NONCE_COOKIE='__Host-orbit-google-nonce';
const SESSION_SECONDS=60*60*24*7;
const NONCE_SECONDS=10*60;

const configured=env=>typeof env.GOOGLE_CLIENT_ID==='string'&&env.GOOGLE_CLIENT_ID.length>20;
const base64url=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const random=length=>{const bytes=new Uint8Array(length);crypto.getRandomValues(bytes);return base64url(bytes);};
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
const cookie=(request,name)=>{for(const pair of (request.headers.get('cookie')||'').split(';')){const [key,...value]=pair.trim().split('=');if(key===name){try{return decodeURIComponent(value.join('='));}catch{return null;}}}return null;};
const setCookie=(name,value,maxAge)=>`${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
const clearCookie=name=>setCookie(name,'',0);
const same=(left,right)=>{if(typeof left!=='string'||typeof right!=='string')return false;let mismatch=left.length^right.length;for(let i=0;i<Math.max(left.length,right.length);i++)mismatch|=(left.charCodeAt(i)||0)^(right.charCodeAt(i)||0);return mismatch===0;};
const displayHeader=request=>{const value=request.headers.get('oai-authenticated-user-full-name');if(!value)return null;try{return request.headers.get('oai-authenticated-user-full-name-encoding')==='percent-encoded-utf-8'?decodeURIComponent(value):value;}catch{return null;}};

async function userId(provider,subject){return `usr_${(await digest(`${provider}:${subject}`)).slice(0,32)}`;}

async function ensureIdentity(db,{provider,subject,email=null,displayName=null}){
  const existing=await db.prepare('SELECT user_id FROM identities WHERE provider=? AND subject=?').bind(provider,subject).first();
  const id=existing?.user_id||await userId(provider,subject),now=Date.now();
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO users(id,email,display_name,linkedin_profile_url,created_at,updated_at) VALUES(?,?,?,NULL,?,?)').bind(id,email,displayName,now,now),
    db.prepare('INSERT INTO identities(provider,subject,user_id,email,display_name,created_at,last_seen) VALUES(?,?,?,?,?,?,?) ON CONFLICT(provider,subject) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,last_seen=excluded.last_seen').bind(provider,subject,id,email,displayName,now,now),
    db.prepare('UPDATE users SET email=COALESCE(?,email),display_name=COALESCE(?,display_name),updated_at=? WHERE id=?').bind(email,displayName,now,id),
  ]);
  return {id,newUser:!existing};
}

async function account(db,id){
  return db.prepare('SELECT id,email,display_name,linkedin_profile_url,created_at FROM users WHERE id=?').bind(id).first();
}

export const googleLoginEnabled=configured;

export async function googleConfig(request,env){
  if(!configured(env))return {body:{enabled:false},headers:new Headers()};
  const nonce=random(32),headers=new Headers();headers.append('Set-Cookie',setCookie(NONCE_COOKIE,nonce,NONCE_SECONDS));
  return {body:{enabled:true,clientId:env.GOOGLE_CLIENT_ID,nonce},headers};
}

export async function authenticatedActor(request,env){
  const sitesId=request.headers.get('oai-authenticated-user-id');
  if(sitesId){
    const email=request.headers.get('oai-authenticated-user-email'),displayName=displayHeader(request);
    if(!env.DB?.prepare||!env.DB?.batch)return {id:`chatgpt:${sitesId}`,email,displayName,provider:'chatgpt',linkedinProfileUrl:null};
    const identity=await ensureIdentity(env.DB,{provider:'chatgpt',subject:sitesId,email,displayName});
    const user=await account(env.DB,identity.id);return {id:user.id,email:user.email,displayName:user.display_name,provider:'chatgpt',linkedinProfileUrl:user.linkedin_profile_url};
  }
  const token=cookie(request,SESSION_COOKIE);if(!token||!env.DB)return null;
  const tokenHash=await digest(token);
  const row=await env.DB.prepare('SELECT users.id,users.email,users.display_name,users.linkedin_profile_url FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?').bind(tokenHash,Date.now()).first();
  return row?{id:row.id,email:row.email,displayName:row.display_name,provider:'google',linkedinProfileUrl:row.linkedin_profile_url}:null;
}

export async function finishGoogleLogin(request,env,body){
  if(!configured(env)||!env.DB)throw Error('Google sign-in is not configured.');
  const expectedNonce=cookie(request,NONCE_COOKIE),providedNonce=body?.nonce;
  if(!same(expectedNonce,providedNonce)||typeof body?.credential!=='string'||body.credential.length>12000)throw Error('The Google sign-in response is invalid or expired.');
  const verify=env.GOOGLE_VERIFY||((token)=>jwtVerify(token,GOOGLE_JWKS,{audience:env.GOOGLE_CLIENT_ID,issuer:['accounts.google.com','https://accounts.google.com']}));
  const verified=await verify(body.credential),claims=verified?.payload||verified;
  if(typeof claims?.sub!=='string'||!same(claims.nonce,expectedNonce))throw Error('The Google sign-in response could not be verified.');
  const email=claims.email_verified===true&&typeof claims.email==='string'?claims.email:null;
  const displayName=typeof claims.name==='string'?claims.name.slice(0,200):null;
  const identity=await ensureIdentity(env.DB,{provider:'google',subject:claims.sub,email,displayName});
  const rawToken=random(32),tokenHash=await digest(rawToken),now=Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now),
    env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(tokenHash,identity.id,now+SESSION_SECONDS*1000,now),
  ]);
  const user=await account(env.DB,identity.id),headers=new Headers();
  headers.append('Set-Cookie',clearCookie(NONCE_COOKIE));headers.append('Set-Cookie',setCookie(SESSION_COOKIE,rawToken,SESSION_SECONDS));
  return {body:{authenticated:true,newUser:identity.newUser,onboardingComplete:Boolean(user.linkedin_profile_url),user:{id:user.id,email:user.email,displayName:user.display_name}},headers};
}

export async function updateLinkedInProfile(db,actor,url){
  await db.prepare('UPDATE users SET linkedin_profile_url=?,updated_at=? WHERE id=?').bind(url,Date.now(),actor.id).all();
  return {...actor,linkedinProfileUrl:url};
}

export async function signOut(request,env){
  const token=cookie(request,SESSION_COOKIE);if(token&&env.DB)await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(token)).all();
  const headers=new Headers();headers.append('Set-Cookie',clearCookie(SESSION_COOKIE));return headers;
}
