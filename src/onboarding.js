import {profileURL} from './core.js';
const $=id=>document.getElementById(id);
export const localPreview=location.protocol==='chrome-extension:'||['127.0.0.1','localhost'].includes(location.hostname);

export async function session(){
  if(localPreview)return {local:true,authenticated:false};
  const response=await fetch('/api/session',{credentials:'same-origin'});
  if(!response.ok)throw Error('Your account could not be checked. Please reload and try again.');
  return response.json();
}

export function profileKey(user){return `orbitProfile:${user.local?'local':user.id}`;}

export function bindLogout(user){
  const button=$('account-logout');if(!button||user?.local||!user?.authenticated)return;
  button.hidden=false;button.onclick=async()=>{button.disabled=true;if(user.provider==='chatgpt'){location.href='/signout-with-chatgpt?return_to=%2F';return;}try{await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'});}finally{location.href='/';}};
}

const safeReturnTo=()=>{const value=new URLSearchParams(location.search).get('return_to');return ['/setup.html','/map.html'].includes(value)?value:'/setup.html';};
const loadGoogle=()=>new Promise((resolve,reject)=>{
  if(window.google?.accounts?.id){resolve();return;}
  const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;script.onload=resolve;script.onerror=()=>reject(Error('Google sign-in could not be loaded.'));document.head.append(script);
});

async function showGoogleLogin(){
  const target=$('google-signin'),status=$('auth-status');if(!target)return;
  if(localPreview){$('local-preview').hidden=false;$('preview-note').hidden=false;status.textContent='Account sign-in is available on the hosted Site.';return;}
  $('existing-signin').hidden=false;
  try{
    const current=await session();
    if(current.authenticated){target.hidden=true;$('existing-signin').hidden=true;$('account-workspace').hidden=false;$('account-logout').hidden=false;if($('login-link'))$('login-link').hidden=true;if($('signup-link'))$('signup-link').hidden=true;if($('workspace-link'))$('workspace-link').hidden=false;bindLogout(current);status.textContent=`Signed in${current.email?' as '+current.email:''}.`;return;}
    const response=await fetch('/api/auth/google/config',{credentials:'same-origin'}),config=await response.json();
    if(!response.ok||!config.enabled){status.textContent='Google sign-in is not configured for this Site yet. You can continue with ChatGPT.';return;}
    await loadGoogle();
    window.google.accounts.id.initialize({client_id:config.clientId,nonce:config.nonce,ux_mode:'popup',callback:async result=>{
      status.textContent='Finishing sign-in…';target.classList.add('is-busy');
      try{
        const login=await fetch('/api/auth/google',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential:result.credential,nonce:config.nonce})});
        const data=await login.json();if(!login.ok)throw Error(data.error||'Google sign-in failed.');
        const requested=safeReturnTo();location.assign(data.onboardingComplete?(requested==='/setup.html'?'/map.html':requested):'/setup.html');
      }catch(error){target.classList.remove('is-busy');status.textContent=error.message+' Please try again.';}
    }});
    window.google.accounts.id.renderButton(target,{type:'standard',theme:'outline',size:'large',text:target.dataset.authIntent==='login'?'signin_with':'signup_with',shape:'rectangular',logo_alignment:'left',width:Math.min(360,target.clientWidth||360)});
    status.textContent='Use your Google account, or continue with ChatGPT.';
  }catch(error){status.textContent=error.message+' You can continue with ChatGPT.';}
}

if($('onboarding-form')){
  try{
    const user=await session();
    if(!user.local&&!user.authenticated){$('session-status').textContent='Sign in before adding your LinkedIn profile.';$('setup-signin').hidden=false;}
    else {
      bindLogout(user);$('session-status').textContent=user.local?'Local preview · your starting profile is saved on this device.':`Signed in${user.email?' as '+user.email:''}`;
      $('onboarding-form').hidden=false;$('linkedin-profile').value=user.linkedinProfileUrl||localStorage.getItem(profileKey(user))||'';
      $('onboarding-form').onsubmit=async event=>{
        event.preventDefault();const url=profileURL($('linkedin-profile').value),button=event.submitter;
        if(!url){$('setup-error').textContent='Enter a LinkedIn person profile, such as https://www.linkedin.com/in/your-name/.';return;}
        button.disabled=true;$('setup-error').textContent='Saving your starting point…';
        try{
          if(!user.local){const response=await fetch('/api/account/profile',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({linkedinProfileUrl:url})});const data=await response.json();if(!response.ok)throw Error(data.error||'Your profile could not be saved.');}
          localStorage.setItem(profileKey(user),url);location.href='map.html';
        }catch(error){$('setup-error').textContent=error.message;button.disabled=false;}
      };
    }
  }catch(error){$('session-status').textContent=error.message;}
}

if($('account-heading')){
  function accountMode(focus=false){
    const login=location.hash==='#login';$('google-signin').dataset.authIntent=login?'login':'signup';
    $('account-heading').textContent=login?'Welcome back to Orbit':'Create your Orbit account';
    $('account-description').textContent=login?'Log in with your Google account to return to your maps.':'Sign up with your Google account, then add your LinkedIn profile.';
    if(focus){$('get-started').scrollIntoView({block:'center',behavior:'smooth'});$('account-heading').focus({preventScroll:true});}
  }
  window.addEventListener('hashchange',()=>accountMode(['#login','#signup'].includes(location.hash)));
  for(const id of ['login-link','signup-link'])$(id).addEventListener('click',()=>{if(location.hash===$(id).hash)accountMode(true);});
  accountMode(['#login','#signup'].includes(location.hash));showGoogleLogin();
}
