import {session,profileKey} from './onboarding.js';
try {
  const user=await session();
  if(!user.local&&!user.authenticated)location.replace('/?return_to=%2Fsetup.html#login');
  else {
    const profile=localStorage.getItem(profileKey(user));
    const extension=location.protocol==='chrome-extension:';
    if(!profile&&!extension)location.replace('setup.html');
    else {await import('./app.js');const field=document.getElementById('profile-url');if(profile&&!field.value)field.value=profile;}
  }
}catch{
  document.querySelector('.workspace').replaceChildren(Object.assign(document.createElement('p'),{textContent:'Your account could not be checked. Reload this page to try again.'}));
}
