const GOOGLE_AUTHORIZATION_URL='https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL='https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL='https://openidconnect.googleapis.com/v1/userinfo';
const SESSION_COOKIE='__Host-orbit-session';
const STATE_COOKIE='__Host-orbit-google-state';
const VERIFIER_COOKIE='__Host-orbit-google-verifier';
const RETURN_TO_COOKIE='__Host-orbit-google-return-to';
const OAUTH_PATH='/auth/google/callback';
const SESSION_SECONDS=60*60*24*7;
const OAUTH_SECONDS=10*60;

const configured=env=>typeof env.GOOGLE_CLIENT_ID==='string'&&env.GOOGLE_CLIENT_ID.length>0&&typeof env.GOOGLE_CLIENT_SECRET==='string'&&env.GOOGLE_CLIENT_SECRET.length>0;
const base64url=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const random=length=>{const bytes=new Uint8Array(length);crypto.getRandomValues(bytes);return base64url(bytes);};
const digest=async value=>base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))));
const cleanReturnTo=value=>typeof value==='string'&&value.startsWith('/')&&!value.startsWith('//')&&!value.includes('\\')?value:'/setup.html';
const cookie=(request,name)=>{for(const pair of (request.headers.get('cookie')||'').split(';')){const [key,...value]=pair.trim().split('=');if(key===name){try{return decodeURIComponent(value.join('='));}catch{return null;}}}return null;};
const setCookie=(name,value,maxAge,path='/')=>`${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=${maxAge}`;
const clearCookie=(name,path='/')=>setCookie(name,'',0,path);
const redirect=(location,headers=new Headers())=>{headers.set('Location',location);headers.set('Cache-Control','no-store');return new Response(null,{status:302,headers});};
const same=(left,right)=>{if(typeof left!=='string'||typeof right!=='string')return false;let mismatch=left.length^right.length;for(let index=0;index<Math.max(left.length,right.length);index++)mismatch|=(left.charCodeAt(index)||0)^(right.charCodeAt(index)||0);return mismatch===0;};
const authFailure=(request,headers=new Headers())=>{headers.append('Set-Cookie',clearCookie(STATE_COOKIE,OAUTH_PATH));headers.append('Set-Cookie',clearCookie(VERIFIER_COOKIE,OAUTH_PATH));headers.append('Set-Cookie',clearCookie(RETURN_TO_COOKIE,OAUTH_PATH));return redirect(new URL('/?login=google_failed#login',request.url).toString(),headers);};

export const googleLoginEnabled=configured;

export async function authenticatedActor(request,env){
  const sitesId=request.headers.get('oai-authenticated-user-id');
  if(sitesId)return {id:sitesId,email:request.headers.get('oai-authenticated-user-email'),provider:'chatgpt'};
  const sessionId=cookie(request,SESSION_COOKIE);
  if(!sessionId||!env.DB)return null;
  const row=await env.DB.prepare('SELECT actor,email FROM google_sessions WHERE id=? AND expires_at>?').bind(sessionId,Date.now()).first();
  return row?{id:row.actor,email:row.email||null,provider:'google'}:null;
}

export async function startGoogleLogin(request,env){
  if(!configured(env))return new Response('Google sign-in is not configured.',{status:503,headers:{'Cache-Control':'no-store'}});
  const requestUrl=new URL(request.url),state=random(32),verifier=random(48),returnTo=cleanReturnTo(requestUrl.searchParams.get('return_to'));
  const authorization=new URL(GOOGLE_AUTHORIZATION_URL);
  authorization.searchParams.set('client_id',env.GOOGLE_CLIENT_ID);
  authorization.searchParams.set('redirect_uri',new URL(OAUTH_PATH,requestUrl.origin).toString());
  authorization.searchParams.set('response_type','code');
  authorization.searchParams.set('scope','openid email profile');
  authorization.searchParams.set('state',state);
  authorization.searchParams.set('code_challenge',await digest(verifier));
  authorization.searchParams.set('code_challenge_method','S256');
  authorization.searchParams.set('prompt','select_account');
  const headers=new Headers();
  headers.append('Set-Cookie',setCookie(STATE_COOKIE,state,OAUTH_SECONDS,OAUTH_PATH));
  headers.append('Set-Cookie',setCookie(VERIFIER_COOKIE,verifier,OAUTH_SECONDS,OAUTH_PATH));
  headers.append('Set-Cookie',setCookie(RETURN_TO_COOKIE,returnTo,OAUTH_SECONDS,OAUTH_PATH));
  return redirect(authorization.toString(),headers);
}

export async function finishGoogleLogin(request,env){
  const requestUrl=new URL(request.url),state=cookie(request,STATE_COOKIE),verifier=cookie(request,VERIFIER_COOKIE),returnTo=cleanReturnTo(cookie(request,RETURN_TO_COOKIE));
  if(!configured(env)||requestUrl.searchParams.has('error')||!same(state,requestUrl.searchParams.get('state'))||!verifier)return authFailure(request);
  const code=requestUrl.searchParams.get('code');if(!code)return authFailure(request);
  try{
    const payload=new URLSearchParams({code,client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,redirect_uri:new URL(OAUTH_PATH,requestUrl.origin).toString(),grant_type:'authorization_code',code_verifier:verifier});
    const exchange=await (env.GOOGLE_FETCH||fetch)(GOOGLE_TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:payload.toString()});
    if(!exchange.ok)throw Error('Google token exchange failed');
    const token=await exchange.json();if(typeof token.access_token!=='string')throw Error('Google did not return an access token');
    const profileResponse=await (env.GOOGLE_FETCH||fetch)(GOOGLE_USERINFO_URL,{headers:{Authorization:`Bearer ${token.access_token}`}});
    if(!profileResponse.ok)throw Error('Google profile lookup failed');
    const profile=await profileResponse.json();if(typeof profile.sub!=='string'||profile.sub.length<1)throw Error('Google profile is invalid');
    const email=typeof profile.email==='string'&&(profile.email_verified===true||profile.verified_email===true)?profile.email:null;
    const sessionId=random(32),expiresAt=Date.now()+SESSION_SECONDS*1000;
    await env.DB.prepare('DELETE FROM google_sessions WHERE expires_at<=?').bind(Date.now()).all();
    await env.DB.prepare('INSERT INTO google_sessions(id,actor,email,expires_at,created_at) VALUES(?,?,?,?,?)').bind(sessionId,`google:${profile.sub}`,email,expiresAt,Date.now()).all();
    const headers=new Headers();
    headers.append('Set-Cookie',clearCookie(STATE_COOKIE,OAUTH_PATH));
    headers.append('Set-Cookie',clearCookie(VERIFIER_COOKIE,OAUTH_PATH));
    headers.append('Set-Cookie',clearCookie(RETURN_TO_COOKIE,OAUTH_PATH));
    headers.append('Set-Cookie',setCookie(SESSION_COOKIE,sessionId,SESSION_SECONDS));
    return redirect(new URL(returnTo,requestUrl.origin).toString(),headers);
  }catch(error){console.error('Google sign-in failed',error?.message||'unknown error');return authFailure(request);}
}

export async function signOutGoogle(request,env){
  const sessionId=cookie(request,SESSION_COOKIE);if(sessionId&&env.DB)await env.DB.prepare('DELETE FROM google_sessions WHERE id=?').bind(sessionId).all();
  const headers=new Headers();headers.append('Set-Cookie',clearCookie(SESSION_COOKIE));return redirect(new URL('/',request.url).toString(),headers);
}
