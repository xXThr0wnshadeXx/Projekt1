const TAU = Math.PI * 2;
const clamp = value => Math.max(0, Math.min(1, value));
const colors = ['#ead779', '#a8bf83', '#b4c5e0', '#b5a0cb'];

export function scrollAngle(progress) { return -.45 + clamp(progress) * TAU; }
export function easeAngle(current, target, milliseconds) {
  const next = current + (target-current) * (1-Math.exp(-Math.max(0,milliseconds)/110));
  return Math.abs(next-target)<.0001 ? target : next;
}
// True 3D points, Y-axis rotation, a fixed camera tilt, and perspective projection.
export function project(point, angle) {
  const x=point.x*Math.cos(angle)+point.z*Math.sin(angle);
  const depth=-point.x*Math.sin(angle)+point.z*Math.cos(angle);
  const tilt=.48, y=point.y*Math.cos(tilt)-depth*Math.sin(tilt);
  const z=point.y*Math.sin(tilt)+depth*Math.cos(tilt), perspective=780/(780-z);
  return {x:x*perspective,y:y*perspective,z,perspective};
}
/** The centre node is fixed; every other node travels on its own inclined circular path. */
export function orbitalPosition(node, seconds=0) {
  if(!node.orbit)return {x:node.x,y:node.y,z:node.z};
  const {radius,inclination,phase,speed}=node.orbit,theta=phase+seconds*speed;
  return {x:Math.cos(theta)*radius,y:Math.sin(theta)*radius*Math.sin(inclination),z:Math.sin(theta)*radius*Math.cos(inclination)};
}
export function makeSystem() {
  const nodes=[{x:0,y:0,z:0,r:24,color:colors[0]}], rings=[];
  for(let ring=0;ring<5;ring++){
    const radius=65+ring*37, inclination=(ring-2)*.12, points=[];
    const position=theta=>({x:Math.cos(theta)*radius,y:Math.sin(theta)*radius*Math.sin(inclination),z:Math.sin(theta)*radius*Math.cos(inclination)});
    for(let i=0;i<=100;i++)points.push(position(i/100*TAU));
    rings.push(points);
    for(let i=0;i<ring+3;i++){
      const phase=i/(ring+3)*TAU+ring*1.47,orbit={radius,inclination,phase,speed:(.13+ring*.035)*(ring%2?-1:1)};
      nodes.push({...orbitalPosition({orbit}),r:5+(i*7+ring*3)%8,color:colors[(ring+i+1)%4],orbit});
    }
  }
  return {nodes,rings};
}

if(typeof document!=='undefined'){
  const section=document.querySelector('.solar-journey'),canvas=section?.querySelector('canvas'),ctx=canvas?.getContext('2d');
  if(ctx){
    const stage=section.querySelector('.solar-stage'),scene=section.querySelector('.solar-scene');
    const preference=matchMedia('(prefers-reduced-motion: reduce)'),system=makeSystem();
    let width=0,height=0,angle=scrollAngle(0),target=angle,frame=null,last=null,orbitSeconds=0,inView=true,visible=true;
    function paint(){
      ctx.clearRect(0,0,width,height);
      const unit=Math.min(width/600,height/355),cx=width/2,cy=height*.52;
      const screen=p=>{const q=project(p,angle);return {...q,x:cx+q.x*unit,y:cy+q.y*unit};};
      const primitives=[];
      // Depth-sort ring segments with the spheres so rear arcs disappear behind nodes.
      for(const ring of system.rings)for(let i=1;i<ring.length;i++){
        const a=screen(ring[i-1]),b=screen(ring[i]);primitives.push({kind:'line',a,b,z:(a.z+b.z)/2});
      }
      for(const node of system.nodes)primitives.push({kind:'node',...node,...screen(orbitalPosition(node,orbitSeconds))});
      primitives.sort((a,b)=>a.z-b.z);
      const halo=ctx.createRadialGradient(cx,cy,0,cx,cy,90*unit);
      halo.addColorStop(0,'#ead77916');halo.addColorStop(1,'#ead77900');ctx.fillStyle=halo;ctx.fillRect(0,0,width,height);
      for(const item of primitives){
        if(item.kind==='line'){
          ctx.strokeStyle=`rgba(180,197,224,${.13+(item.z+250)/500*.22})`;ctx.lineWidth=Math.max(.65,unit*.85);
          ctx.beginPath();ctx.moveTo(item.a.x,item.a.y);ctx.lineTo(item.b.x,item.b.y);ctx.stroke();continue;
        }
        const radius=item.r*unit*item.perspective;
        // Fixed upper-left key light and a dark limb keep each node visibly spherical.
        const shade=ctx.createRadialGradient(item.x-radius*.34,item.y-radius*.4,radius*.06,item.x+radius*.24,item.y+radius*.3,radius*1.2);
        shade.addColorStop(0,'#fff9e6');shade.addColorStop(.24,item.color);shade.addColorStop(.68,item.color);shade.addColorStop(1,'#202128');
        ctx.fillStyle=shade;ctx.shadowColor=item.color+'35';ctx.shadowBlur=item.r>20?22*unit:7*unit;
        ctx.beginPath();ctx.arc(item.x,item.y,radius,0,TAU);ctx.fill();ctx.shadowBlur=0;
        ctx.strokeStyle=item.color+'60';ctx.lineWidth=.7;ctx.stroke();
      }
    }
    function tick(now){
      frame=null;
      if(!visible){last=null;return;}
      const elapsed=last===null?0:Math.min(64,now-last);
      angle=preference.matches?scrollAngle(0):easeAngle(angle,target,elapsed||16);
      if(!preference.matches)orbitSeconds+=elapsed/1000;
      last=now;
      paint();
      if(!preference.matches)frame=requestAnimationFrame(tick);else last=null;
    }
    function schedule(){if(frame===null&&visible)frame=requestAnimationFrame(tick);}
    function update(){
      const bounds=section.getBoundingClientRect(),distance=section.offsetHeight-stage.offsetHeight;
      target=scrollAngle(preference.matches?0:distance>0?-bounds.top/distance:0);schedule();
    }
    function resize(){
      width=scene.clientWidth;height=scene.clientHeight;
      const ratio=Math.min(window.devicePixelRatio||1,2);
      canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);ctx.setTransform(ratio,0,0,ratio,0,0);update();
    }
    section.classList.add('solar-enabled');
    window.addEventListener('scroll',update,{passive:true});
    window.addEventListener('resize',resize,{passive:true});
    window.addEventListener('pageshow',()=>{update();angle=target;schedule();});
    preference.addEventListener('change',()=>{resize();angle=target;schedule();});
    if('ResizeObserver' in window)new ResizeObserver(resize).observe(scene);
    document.addEventListener('visibilitychange',()=>{visible=inView&&!document.hidden;if(visible){last=null;update();schedule();}});
    if('IntersectionObserver' in window)new IntersectionObserver(entries=>{
      inView=entries[0].isIntersecting;visible=inView&&!document.hidden;if(visible){last=null;update();angle=target;schedule();}
    }).observe(section);
    resize();angle=target;
  }
}
