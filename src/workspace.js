import {bindLogout,session,profileKey} from './onboarding.js';
import {SITE_ORIGIN} from './companion.js';
if(location.protocol==='chrome-extension:')location.replace(`${SITE_ORIGIN}/map.html?source=companion`);
else try {
  const user=await session();
  if(!user.local&&!user.authenticated)location.replace('/?return_to=%2Fmap.html#login');
  else {
    bindLogout(user);const accountLabel=document.getElementById('account-label');if(accountLabel&&!user.local)accountLabel.textContent=user.displayName||user.email||'SIGNED IN';
    const profile=user.linkedinProfileUrl||localStorage.getItem(profileKey(user));
    if(!profile)location.replace('setup.html');
    else {globalThis.ORBIT_USER=user;globalThis.ORBIT_PROFILE=profile;await import('./app.js');const field=document.getElementById('profile-url');if(profile&&!field.value)field.value=profile;}
  }
}catch{
  document.querySelector('.workspace').replaceChildren(Object.assign(document.createElement('p'),{textContent:'Your account could not be checked. Reload this page to try again.'}));
}
