// Keep all content visible if scripting, observers, or motion are unavailable.
const preference=matchMedia('(prefers-reduced-motion: reduce)');
if(!preference.matches&&'IntersectionObserver' in window){
 const observer=new IntersectionObserver(entries=>{
  for(const entry of entries)if(entry.isIntersecting){entry.target.classList.add('scroll-revealed');observer.unobserve(entry.target);}
 },{threshold:.12});
 for(const selector of ['.hero-copy','.art-person','.how-section>div:first-child','.steps article','.signup-section>div']){
  document.querySelectorAll(selector).forEach((element,index)=>{element.style.setProperty('--reveal-delay',`${index*90}ms`);observer.observe(element);});
 }
 preference.addEventListener('change',event=>{if(event.matches)observer.disconnect();});
}
