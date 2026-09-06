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
