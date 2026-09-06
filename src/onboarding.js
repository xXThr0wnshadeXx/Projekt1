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
if($('google-signin')){
  $('auth-status').textContent='Google sign-in is coming soon. Account setup is not yet available through Google.';
  if(localPreview){$('local-preview').hidden=false;$('preview-note').hidden=false;}
  else {$('existing-signin').hidden=false;}
}
if($('onboarding-form')){
  try{
    const user=await session();
    if(!user.local&&!user.authenticated){$('session-status').textContent='Sign in before adding your LinkedIn profile.';$('setup-signin').hidden=false;}
    else {
      $('session-status').textContent=user.local?'Local preview · your starting profile is saved on this device.':`Signed in${user.email?' as '+user.email:''}`;
      $('onboarding-form').hidden=false;
      $('linkedin-profile').value=localStorage.getItem(profileKey(user))||'';
      $('onboarding-form').onsubmit=e=>{
        e.preventDefault();const url=profileURL($('linkedin-profile').value);
        if(!url){$('setup-error').textContent='Enter a LinkedIn person profile, such as https://www.linkedin.com/in/your-name/.';return;}
        try{localStorage.setItem(profileKey(user),url);location.href='map.html';}catch{$('setup-error').textContent='Allow browser storage to save your starting profile and continue.';}
      };
    }
  }catch(error){$('session-status').textContent=error.message;}
}

// Both entry points will share Google's identity flow once the provider is configured.
if($('account-heading')){
  function accountMode(focus=false){
    const login=location.hash==='#login';
    $('google-signin').dataset.authIntent=login?'login':'signup';
    $('account-heading').textContent=login?'Welcome back to Orbit':'Create your Orbit account';
    $('account-description').textContent=login?'Log in with your Google account to return to your maps.':'Sign up with your Google account, then add your LinkedIn profile.';
    if(focus){$('get-started').scrollIntoView({block:'center'});$('account-heading').focus({preventScroll:true});}
  }
  window.addEventListener('hashchange',()=>accountMode(['#login','#signup'].includes(location.hash)));
  for(const id of ['login-link','signup-link'])$(id).addEventListener('click',()=>{if(location.hash===$(id).hash)accountMode(true);});
  accountMode(['#login','#signup'].includes(location.hash));
}
