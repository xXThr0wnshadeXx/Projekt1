export class NetworkGraph {
  constructor(canvas,onSelect){
    this.canvas=canvas;this.ctx=canvas.getContext('2d');this.onSelect=onSelect;this.points=[];this.edges=[];this.positions=new Map();this.scale=1;this.offset={x:0,y:0};this.selected=null;this.query='';this.path=new Set();this.autoFit=true;this.frame=null;this.childCounts=new Map();this.directCount=0;this.reducedMotion=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches||false;
    this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(canvas.parentElement);
    canvas.addEventListener('wheel',e=>{e.preventDefault();this.zoom(e.deltaY<0?1.15:1/1.15,e.offsetX,e.offsetY);},{passive:false});
    canvas.addEventListener('pointerdown',e=>{this.drag={x:e.clientX,y:e.clientY,ox:this.offset.x,oy:this.offset.y,moved:false};canvas.setPointerCapture(e.pointerId);});
    canvas.addEventListener('pointermove',e=>{if(!this.drag)return;const dx=e.clientX-this.drag.x,dy=e.clientY-this.drag.y;if(Math.hypot(dx,dy)>3){this.drag.moved=true;this.autoFit=false;}this.offset={x:this.drag.ox+dx,y:this.drag.oy+dy};this.draw();});
    canvas.addEventListener('pointerup',e=>{if(this.drag&&!this.drag.moved){const r=canvas.getBoundingClientRect(),x=(e.clientX-r.left-this.w/2-this.offset.x)/this.scale,y=(e.clientY-r.top-this.h/2-this.offset.y)/this.scale;let near=null,dist=Infinity;for(const p of this.points){if(p.bornAt>performance.now())continue;const d=Math.hypot(p.x-x,p.y-y);if(d<Math.max(9/this.scale,p.r+4)&&d<dist){near=p;dist=d;}}if(near)this.onSelect(near.id);}this.drag=null;});
    canvas.addEventListener('pointercancel',()=>this.drag=null);
  }
  resize(){const r=this.canvas.parentElement.getBoundingClientRect();this.w=r.width;this.h=r.height;const dpr=window.devicePixelRatio||1;this.canvas.width=Math.round(r.width*dpr);this.canvas.height=Math.round(r.height*dpr);this.ctx.setTransform(dpr,0,0,dpr,0,0);if(this.autoFit)this.fit();else this.draw();}
  setData(state){
    this.state=state;
    if(!state||this.dataId!==state.id){this.points=[];this.edges=[];this.positions.clear();this.childCounts.clear();this.directCount=0;this.dataId=state?.id;this.graphRevision=null;this.autoFit=true;this.lastRevealed=null;}
    if(!state){this.draw();return;}
    if(state.graphRevision!==undefined&&this.graphRevision===state.graphRevision)return;
    this.graphRevision=state.graphRevision;
    const nodes=Object.values(state.nodes),adj=new Map();this.edges=Object.values(state.edges);
    for(const e of this.edges){for(const [a,b] of [[e.source,e.target],[e.target,e.source]]){if(!adj.has(a))adj.set(a,[]);adj.get(a).push(b);}}
    const added=nodes.filter(p=>!this.positions.has(p.id)).sort((a,b)=>a.depth-b.depth),now=performance.now();
    // Reveal each arrival without delaying collection or accumulating an animation backlog.
    const animate=state.status!=='imported'&&!this.reducedMotion,spacing=animate?Math.min(55,1200/Math.max(1,added.length)):0;
    for(const [i,p] of added.entries()){
      let x=0,y=0,owner=state.root;
      if(p.depth===1){const n=this.directCount++,angle=n*2.3999632297,r=220+80*Math.floor(Math.sqrt(n/12));x=Math.cos(angle)*r;y=Math.sin(angle)*r;}
      else if(p.depth>1){owner=(adj.get(p.id)||[]).find(id=>this.positions.has(id)&&state.nodes[id]?.depth<p.depth)||state.root;const parent=this.positions.get(owner)||{x:0,y:0},n=this.childCounts.get(owner)||0;this.childCounts.set(owner,n+1);const angle=Math.atan2(parent.y,parent.x),theta=n*2.3999632297,rr=12*Math.sqrt(n+1);x=parent.x+Math.cos(angle)*150+Math.cos(theta)*rr;y=parent.y+Math.sin(angle)*150+Math.sin(theta)*rr;}
      const point={...p,x,y,r:p.depth===0?9:p.depth===1?4.2:2.8,owner,bornAt:animate?now+i*spacing:now-1000};this.positions.set(p.id,point);this.points.push(point);
    }
    // Keep positions stable while names, evidence, and shortest known depths improve.
    for(const p of nodes){const point=this.positions.get(p.id);Object.assign(point,p);point.r=p.depth===0?9:p.depth===1?4.2:2.8;}
    if(this.autoFit)this.fit();else this.draw();
  }
  fit(){this.autoFit=true;if(!this.points.length||!this.w||!this.h){this.draw();return;}let ex=100,ey=100;for(const p of this.points){ex=Math.max(ex,Math.abs(p.x)+40);ey=Math.max(ey,Math.abs(p.y)+40);}this.scale=Math.max(.01,Math.min((this.w-65)/(ex*2),(this.h-100)/(ey*2),1.8));this.offset={x:0,y:0};this.draw();}
  zoom(factor,x=this.w/2,y=this.h/2){this.autoFit=false;const old=this.scale;this.scale=Math.max(.01,Math.min(12,this.scale*factor));const ratio=this.scale/old;this.offset={x:x-this.w/2-(x-this.w/2-this.offset.x)*ratio,y:y-this.h/2-(y-this.h/2-this.offset.y)*ratio};this.draw();}
  focus(id,path=[]){if(this.selected===id&&[...this.path].join('|')===path.join('|'))return;this.selected=id;this.path=new Set(path);this.draw();}
  search(q){q=q.toLowerCase();if(this.query===q)return;this.query=q;this.draw();}
  draw(){if(this.frame!==null)return;this.frame=requestAnimationFrame(now=>{this.frame=null;this.paint(now);});}
  paint(now){
    const ctx=this.ctx;if(!ctx||!this.w||!this.h)return;ctx.clearRect(0,0,this.w,this.h);ctx.save();ctx.translate(this.w/2+this.offset.x,this.h/2+this.offset.y);ctx.scale(this.scale,this.scale);
    let animating=false,latest=null,visible=0;
    // Batch ordinary edges into one canvas stroke, keeping highlighted paths separate.
    for(const chosen of [false,true]){ctx.strokeStyle=chosen?'#a8c2ff':this.selected?'#252d39':'#344153';ctx.lineWidth=(chosen?1.6:.55)/this.scale;ctx.beginPath();for(const e of this.edges){const a=this.positions.get(e.source),b=this.positions.get(e.target);if(!a||!b||a.bornAt>now||b.bornAt>now)continue;if((this.path.has(a.id)&&this.path.has(b.id))!==chosen)continue;ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);}ctx.stroke();}
    for(const p of this.points){const age=now-p.bornAt;if(age<0){animating=true;continue;}visible++;if(!latest||p.bornAt>latest.bornAt)latest=p;const entering=!this.reducedMotion&&age<450;if(entering)animating=true;const opacity=entering?Math.min(1,age/180):1,hit=!this.query||`${p.name} ${p.headline} ${p.location}`.toLowerCase().includes(this.query),selected=p.id===this.selected;ctx.globalAlpha=(hit?1:.12)*opacity;ctx.fillStyle=entering?'#dce6ff':p.depth===0?'#dce6ff':p.depth===1?'#8eafff':'#76859b';ctx.beginPath();ctx.arc(p.x,p.y,(selected?p.r+2:p.r)+(entering?2*(1-age/450):0),0,Math.PI*2);ctx.fill();if(selected||entering){ctx.strokeStyle=entering?'#799eff':'#e6eeff';ctx.lineWidth=1/this.scale;ctx.globalAlpha*=entering?1-age/450:1;ctx.beginPath();ctx.arc(p.x,p.y,p.r+(entering?5+age/40:6)/this.scale,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=opacity;}
      if(hit&&(selected||p.depth===0||(p.depth===1&&this.points.length<65)||(this.query&&this.points.length<2500))){ctx.font=`${11/this.scale}px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif`;ctx.textAlign='center';ctx.fillStyle='#d5deeb';ctx.fillText(p.name.slice(0,35),p.x,p.y+p.r+16/this.scale);}
    }
    ctx.globalAlpha=1;ctx.restore();
    if(latest&&latest.id!==this.lastRevealed){this.lastRevealed=latest.id;this.onReveal?.(latest,visible,this.points.length);}
    if(animating)this.draw();
  }
}
