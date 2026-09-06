import {matchesFilters,groupTargets,springProgress,relationshipMatches,relationshipNodeIds} from './filters.js';
import {scorePerson} from './search.js';
const MIN_SCALE=.001,MAX_SCALE=12,CONTROL_ZOOM_FACTOR=1.5;
// Reserve space for each observed branch, then arrange siblings in a golden-angle
// spiral. This keeps large second-degree clusters readable without an expensive
// all-pairs force simulation on every animation frame.
export function networkTargets(points,edges,root){
  const ordered=[...points].sort((a,b)=>a.depth-b.depth),byId=new Map(points.map(p=>[p.id,p])),parents=new Map(),children=new Map(points.map(p=>[p.id,[]]));
  for(const edge of edges)for(const [a,b] of [[edge.source,edge.target],[edge.target,edge.source]])if(byId.has(a)&&byId.has(b)&&byId.get(a).depth<byId.get(b).depth&&!parents.has(b))parents.set(b,a);
  for(const p of ordered){if(p.id===root)continue;const parent=parents.get(p.id)||root;if(children.has(parent))children.get(parent).push(p);}
  const radii=new Map(),local=new Map();for(const p of [...ordered].reverse()){const branch=children.get(p.id)||[],largest=Math.max(12,...branch.map(child=>radii.get(child.id)||12)),spacing=largest*2+28;let radius=16;for(const [i,child] of branch.entries()){const angle=i*2.3999632297,distance=spacing*Math.sqrt(i+1);local.set(child.id,{x:Math.cos(angle)*distance,y:Math.sin(angle)*distance});radius=Math.max(radius,distance+(radii.get(child.id)||12));}radii.set(p.id,radius);}
  const targets=new Map([[root,{x:0,y:0}]]);for(const p of ordered){if(p.id===root)continue;const parent=targets.get(parents.get(p.id)||root)||{x:0,y:0},offset=local.get(p.id)||{x:0,y:0};targets.set(p.id,{x:parent.x+offset.x,y:parent.y+offset.y});}return targets;
}
// A filtered or searched result set is intentionally arranged as people—not
// semantic buckets. The golden-angle layout is deterministic, airy and compact
// enough to fit without covering the canvas in labels.
export function focusTargets(points){
  const ordered=[...points].sort((a,b)=>a.id.localeCompare(b.id)),targets=new Map(),spacing=58;
  ordered.forEach((p,i)=>{const angle=i*2.3999632297,r=i?spacing*Math.sqrt(i):0;targets.set(p.id,{x:Math.cos(angle)*r,y:Math.sin(angle)*r});});
  return targets;
}
export class NetworkGraph {
  constructor(canvas,onSelect){
    this.canvas=canvas;this.ctx=canvas.getContext('2d');this.onSelect=onSelect;this.points=[];this.edges=[];this.positions=new Map();this.showAllConnections=false;this.filters={};this.relationshipIds=null;this.groupBy="none";this.groupLabels=[];this.treeRoot=null;this.treeNodes=null;this.treeDepths=new Map();this.motion=null;this.scale=1;this.fitScale=1;this.offset={x:0,y:0};this.selected=null;this.query='';this.searchContext=new Set();this.path=new Set();this.neighbors=new Set();this.autoFit=true;this.scrollZoom=false;this.zoomTarget=null;this.zoomTime=null;this.frame=null;this.childCounts=new Map();this.directCount=0;this.reducedMotion=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches||false;
    if(globalThis.document?.fonts)document.fonts.load('15px "Space Grotesk"').then(()=>this.draw()).catch(()=>{});
    this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(canvas.parentElement);
    canvas.addEventListener('wheel',e=>{if(!this.scrollZoom)return;e.preventDefault();const pixels=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?this.h:1);this.queueZoom(Math.exp(-Math.max(-120,Math.min(120,pixels))*.002),e.offsetX,e.offsetY);},{passive:false});
    canvas.addEventListener('pointerdown',e=>{this.zoomTarget=null;this.drag={x:e.clientX,y:e.clientY,ox:this.offset.x,oy:this.offset.y,moved:false};canvas.setPointerCapture?.(e.pointerId);});
    canvas.addEventListener('pointermove',e=>{if(!this.drag){if(canvas.style){const point=this.eventPoint(e);canvas.style.cursor=this.pickPoint(point.x,point.y)?'pointer':'grab';}return;}const dx=e.clientX-this.drag.x,dy=e.clientY-this.drag.y;if(Math.hypot(dx,dy)>3){this.drag.moved=true;this.autoFit=false;}this.offset={x:this.drag.ox+dx,y:this.drag.oy+dy};this.draw();});
    canvas.addEventListener('pointerup',e=>{if(this.drag&&!this.drag.moved){const point=this.eventPoint(e),near=this.pickPoint(point.x,point.y);this.onSelect(near?.id||null);}this.drag=null;});
    canvas.addEventListener('pointercancel',()=>this.drag=null);
  }
  resize(){const r=this.canvas.parentElement.getBoundingClientRect();this.w=r.width;this.h=r.height;const dpr=window.devicePixelRatio||1;this.canvas.width=Math.round(r.width*dpr);this.canvas.height=Math.round(r.height*dpr);this.ctx.setTransform(dpr,0,0,dpr,0,0);if(this.autoFit)this.fit();else this.draw();}
  setData(state){
    this.state=state;
    if(!state||this.dataId!==state.id){this.points=[];this.edges=[];this.searchContext.clear();this.positions.clear();this.zoomTarget=null;this.motion=null;this.groupLabels=[];this.treeRoot=null;this.treeNodes=null;this.treeDepths.clear();this.childCounts.clear();this.directCount=0;this.dataId=state?.id;this.graphRevision=null;this.autoFit=true;this.lastRevealed=null;}
    if(!state){this.draw();return;}
    if(state.graphRevision!==undefined&&this.graphRevision===state.graphRevision)return;
    this.graphRevision=state.graphRevision;
    const nodes=Object.values(state.nodes),adj=new Map();this.edges=Object.values(state.edges);this.relationshipIds=relationshipNodeIds(state,this.filters.relationship);
    for(const e of this.edges){for(const [a,b] of [[e.source,e.target],[e.target,e.source]]){if(!adj.has(a))adj.set(a,[]);adj.get(a).push(b);}}
    if(nodes.some(p=>this.positions.has(p.id)&&this.positions.get(p.id).depth!==p.depth)){this.points=[];this.positions.clear();this.childCounts.clear();this.directCount=0;this.autoFit=true;}
    const added=nodes.filter(p=>!this.positions.has(p.id)).sort((a,b)=>a.depth-b.depth),now=performance.now();
    // Reveal each arrival without delaying collection or accumulating an animation backlog.
    const animate=state.status!=='imported'&&!this.reducedMotion,spacing=animate?Math.min(55,1200/Math.max(1,added.length)):0;
    for(const [i,p] of added.entries()){
      const owner=(adj.get(p.id)||[]).find(id=>this.positions.has(id)&&state.nodes[id]?.depth<p.depth)||state.root,parent=this.positions.get(owner),x=parent?.x||0,y=parent?.y||0;
      const point={...p,x,y,homeX:x,homeY:y,r:p.depth===0?9:p.depth===1?4.2:2.8,owner,bornAt:animate?now+i*spacing:now-1000};this.positions.set(p.id,point);this.points.push(point);
    }
    // Refresh metadata, then animate every branch toward a collision-resistant home.
    for(const p of nodes){const point=this.positions.get(p.id);Object.assign(point,p);point.r=p.depth===0?9:p.depth===1?4.2:2.8;}
    const homes=networkTargets(this.points,this.edges,state.root);for(const p of this.points){const target=homes.get(p.id);p.homeX=target.x;p.homeY=target.y;}
    if(this.treeRoot)this.buildTree(this.treeRoot);this.updateNeighbors();this.layout();if(this.autoFit)this.fit();else this.draw();
  }
  fit(){this.zoomTarget=null;this.zoomTime=null;this.autoFit=true;if(!this.points.length||!this.w||!this.h){this.draw();return;}let ex=100,ey=100;for(const p of this.points){if(!this.isVisible(p)||(this.query&&!this.isSearchVisible(p)))continue;ex=Math.max(ex,Math.abs(p.tx??p.x)+80);ey=Math.max(ey,Math.abs(p.ty??p.y)+80);}for(const label of this.groupLabels){ex=Math.max(ex,Math.abs(label.x)+100);ey=Math.max(ey,Math.abs(label.y)+30);}this.scale=Math.max(MIN_SCALE,Math.min((this.w-65)/(ex*2),(this.h-100)/(ey*2),1.8));this.fitScale=this.scale;this.offset={x:0,y:0};this.autoFit=false;this.notifyZoom();this.draw();}
  zoomRatio(){return this.fitScale>0?this.scale/this.fitScale:1;}
  notifyZoom(){this.onZoom?.(this.scale,this.zoomRatio());}
  zoom(factor,x=this.w/2,y=this.h/2){this.autoFit=false;const old=this.scale;this.scale=Math.max(MIN_SCALE,Math.min(MAX_SCALE,this.scale*factor));const ratio=this.scale/old;this.offset={x:x-this.w/2-(x-this.w/2-this.offset.x)*ratio,y:y-this.h/2-(y-this.h/2-this.offset.y)*ratio};this.notifyZoom();this.draw();}
  stepZoom(direction,x=this.w/2,y=this.h/2){this.queueZoom(direction>0?CONTROL_ZOOM_FACTOR:1/CONTROL_ZOOM_FACTOR,x,y);}
  queueZoom(factor,x=this.w/2,y=this.h/2){
    if(this.reducedMotion){this.zoom(factor,x,y);return;}
    this.zoomTarget={scale:Math.max(MIN_SCALE,Math.min(MAX_SCALE,(this.zoomTarget?.scale??this.scale)*factor)),x,y};
    if(this.zoomTime===null)this.zoomTime=performance.now();this.draw();
  }
  advanceZoom(now){
    if(!this.zoomTarget)return false;
    const target=this.zoomTarget,dt=Math.max(0,Math.min(64,now-this.zoomTime));this.zoomTime=now;
    const next=this.scale+(target.scale-this.scale)*(1-Math.exp(-dt/65));
    if(Math.abs(target.scale-next)<Math.max(.00001,target.scale*.0005)){this.zoom(target.scale/this.scale,target.x,target.y);this.zoomTarget=null;this.zoomTime=null;return false;}
    this.zoom(next/this.scale,target.x,target.y);return true;
  }
  nodeRadius(p){return Math.max(p.r,(p.depth===0?8:p.depth===1?4.5:3)/this.scale);}
  edgeVisible(edge){return relationshipMatches(edge,this.filters.relationship);}
  isVisible(p){return matchesFilters(p,this.filters)&&(!this.relationshipIds||this.relationshipIds.has(p.id))&&(!this.treeNodes||this.treeNodes.has(p.id));}
  isSearchHit(p){return !this.query||scorePerson(p,this.query).score>0;}
  isSearchVisible(p){return this.isSearchHit(p)||this.searchContext.has(p.id);}
  updateSearchContext(){
    this.searchContext.clear();
    const f=this.filters,root=this.state?.root;
    if(!this.query||!root||this.treeRoot||f.relationship&&f.relationship!=='all'||f.location?.trim()||f.field?.trim()||f.keywords?.length||f.first===false||f.second===false||f.extended===false)return;
    // Match names alone: employer, school, and location searches keep their usual behavior.
    const hits=this.points.filter(p=>scorePerson({name:p.name},this.query).score>0);
    if(!hits.length)return;
    this.searchContext.add(root);
    const adjacency=new Map();
    for(const {source,target} of this.edges){
      if(!adjacency.has(source))adjacency.set(source,[]);
      if(!adjacency.has(target))adjacency.set(target,[]);
      adjacency.get(source).push(target);adjacency.get(target).push(source);
    }
    const parents=new Map([[root,null]]),queue=[root];
    for(let i=0;i<queue.length;i++)for(const next of adjacency.get(queue[i])||[]){
      if(parents.has(next))continue;
      parents.set(next,queue[i]);queue.push(next);
    }
    // Preserve real connecting people; never invent a direct edge to a distant match.
    for(const hit of hits){
      if(!parents.has(hit.id))continue;
      for(let id=hit.id;id!==null&&!this.searchContext.has(id);id=parents.get(id))this.searchContext.add(id);
    }
  }

  eventPoint(e){const r=this.canvas.getBoundingClientRect();return {x:(e.clientX-r.left-this.w/2-this.offset.x)/this.scale,y:(e.clientY-r.top-this.h/2-this.offset.y)/this.scale};}
  pickPoint(x,y){let near=null,dist=Infinity,now=performance.now();for(const p of this.points){if(!this.isVisible(p)||!this.isSearchVisible(p)||p.bornAt>now)continue;const d=Math.hypot(p.x-x,p.y-y);if(d<Math.max(9/this.scale,this.nodeRadius(p)+4/this.scale)&&d<dist){near=p;dist=d;}}return near;}
  setFilters(filters,by='none',keywords=[]){
    const before=new Map(this.points.map(p=>[p.id,this.isVisible(p)])),now=performance.now();this.filters=filters;this.relationshipIds=relationshipNodeIds(this.state,filters.relationship);this.groupBy=by;this.groupKeywords=keywords;
    for(const [i,p] of this.points.entries()){const was=before.get(p.id),visible=this.isVisible(p);if(was&&!visible&&!this.reducedMotion){p.snapAt=now+Math.min(i,60)*5;p.restoreAt=null;}else if(!was&&visible&&!this.reducedMotion){p.restoreAt=now+Math.min(i,40)*4;p.snapAt=null;}else if(visible)p.snapAt=null;}
    this.layout();this.fit();
  }
  buildTree(root,maxDepth=2,maxNodes=600){
    if(!this.positions.has(root))return null;const allowed=new Set(this.points.filter(p=>matchesFilters(p,this.filters)).map(p=>p.id)),adj=new Map();
    for(const e of this.edges){if(!this.edgeVisible(e)||!allowed.has(e.source)||!allowed.has(e.target))continue;if(!adj.has(e.source))adj.set(e.source,[]);if(!adj.has(e.target))adj.set(e.target,[]);adj.get(e.source).push(e.target);adj.get(e.target).push(e.source);}
    const nodes=new Set([root]),depths=new Map([[root,0]]),queue=[root];while(queue.length&&nodes.size<maxNodes){const id=queue.shift(),depth=depths.get(id);if(depth>=maxDepth)continue;for(const next of (adj.get(id)||[]).sort()){if(nodes.has(next))continue;nodes.add(next);depths.set(next,depth+1);queue.push(next);if(nodes.size>=maxNodes)break;}}
    this.treeRoot=root;this.treeNodes=nodes;this.treeDepths=depths;return {count:nodes.size,direct:[...depths.values()].filter(depth=>depth===1).length,extended:[...depths.values()].filter(depth=>depth===2).length};
  }
  showTree(root){const summary=this.buildTree(root);if(!summary)return null;this.groupBy='none';this.groupLabels=[];this.layout();this.fit();return summary;}
  clearTree(){if(!this.treeRoot)return;this.treeRoot=null;this.treeNodes=null;this.treeDepths.clear();this.layout();this.fit();}
  layout(){
    this.updateSearchContext();
    const now=performance.now();this.advanceMotion(now);
    const visible=this.points.filter(p=>this.isVisible(p)),focused=this.query?visible.filter(p=>this.isSearchVisible(p)):visible,faceted=Boolean(this.filters.location||this.filters.field||this.filters.keywords?.length||this.filters.relationship&&this.filters.relationship!=='all'),filteredEdges=this.edges.filter(edge=>this.edgeVisible(edge)),tree=this.treeRoot?networkTargets(visible.map(p=>({...p,depth:this.treeDepths.get(p.id)??3})),filteredEdges,this.treeRoot):null,grouped=!tree&&this.groupBy!=='none'?groupTargets(focused,this.groupBy,this.groupKeywords):null,focus=(!tree&&!grouped&&(this.query||faceted))?focusTargets(focused):null;
    this.groupLabels=grouped?.labels||[];
    const targets=this.points.map(p=>[p,tree?.get(p.id)||grouped?.targets.get(p.id)||focus?.get(p.id)||{x:p.homeX,y:p.homeY}]);
    if(!targets.some(([p,t])=>(p.tx??p.x)!==t.x||(p.ty??p.y)!==t.y))return;
    for(const [p,target] of targets){p.fromX=p.x;p.fromY=p.y;p.tx=target.x;p.ty=target.y;if(this.reducedMotion){p.x=p.tx;p.y=p.ty;}}
    this.motion=this.reducedMotion?null:now;
  }

  advanceMotion(now){if(this.motion===null)return false;const t=Math.min(1,Math.max(0,(now-this.motion)/950)),progress=springProgress(t);for(const p of this.points){if(p.tx===undefined)continue;p.x=t===1?p.tx:p.fromX+(p.tx-p.fromX)*progress;p.y=t===1?p.ty:p.fromY+(p.ty-p.fromY)*progress;}if(t===1)this.motion=null;return t<1;}
  updateNeighbors(){this.neighbors=new Set(this.selected?[this.selected]:[]);for(const e of this.edges){if(e.source===this.selected)this.neighbors.add(e.target);if(e.target===this.selected)this.neighbors.add(e.source);}}
  focus(id,path=[]){if(this.selected===id&&[...this.path].join('|')===path.join('|'))return;this.selected=id;this.path=new Set(path);this.updateNeighbors();this.draw();}
  search(q){q=q.trim().toLowerCase();if(this.query===q)return;this.query=q;this.layout();this.fit();}
  draw(){if(this.frame!==null)return;this.frame=requestAnimationFrame(now=>{this.frame=null;this.paint(now);});}
  drawDust(p,progress){
    const ctx=this.ctx,seed=[...p.id].reduce((n,c)=>(n*31+c.charCodeAt(0))>>>0,7),fade=1-progress,r=this.nodeRadius(p);
    ctx.fillStyle=p.depth===0?'#ead779':p.depth===1?'#a8bf83':'#b5a0cb';ctx.globalAlpha=fade*.7;
    ctx.beginPath();ctx.arc(p.x,p.y,Math.max(.3/this.scale,r*(1-progress)),0,Math.PI*2);ctx.fill();
    for(let i=0;i<6;i++){const angle=((seed%360)+i*137.5)*Math.PI/180,distance=progress*(12+(seed+i*17)%24)/this.scale,size=Math.max(.45/this.scale,r*(.24-i*.018)*fade);ctx.globalAlpha=fade*(.55-i*.045);ctx.beginPath();ctx.arc(p.x+Math.cos(angle)*distance,p.y+Math.sin(angle)*distance,size,0,Math.PI*2);ctx.fill();}
  }
  paint(now){
    const ctx=this.ctx;if(!ctx||!this.w||!this.h)return;const zooming=this.advanceZoom(now);ctx.clearRect(0,0,this.w,this.h);ctx.save();ctx.translate(this.w/2+this.offset.x,this.h/2+this.offset.y);ctx.scale(this.scale,this.scale);
    let animating=this.advanceMotion(now)||zooming,latest=null,visible=0;const faceted=Boolean(this.filters.location||this.filters.field||this.filters.keywords?.length||this.filters.relationship&&this.filters.relationship!=='all'),focused=this.points.filter(p=>this.isVisible(p)&&this.isSearchVisible(p)),focusCount=focused.length;
    for(const label of this.groupLabels){const text=`${label.name} · ${label.count}`,fontSize=13/this.scale;ctx.font=`600 ${fontSize}px "Space Grotesk",sans-serif`;ctx.textAlign='center';const width=Math.max(76,text.length*7.2)/this.scale,height=28/this.scale;ctx.globalAlpha=.94;ctx.fillStyle='#292a24';ctx.fillRect(label.x-width/2,label.y-height*.72,width,height);ctx.strokeStyle='#57594e';ctx.lineWidth=1/this.scale;ctx.strokeRect(label.x-width/2,label.y-height*.72,width,height);ctx.fillStyle='#ece8d8';ctx.fillText(text,label.x,label.y+fontSize*.25);}
    // Batch ordinary edges into one canvas stroke, keeping highlighted paths separate.
    for(const chosen of [false,true]){ctx.strokeStyle=chosen?'#ead779':this.selected?'#41443c':'#747b67';ctx.lineWidth=(chosen?1.6:.85)/this.scale;ctx.globalAlpha=chosen?1:(this.searchContext.size?.65:this.query?.22:.55);ctx.beginPath();for(const e of this.edges){if(!this.edgeVisible(e))continue;const a=this.positions.get(e.source),b=this.positions.get(e.target);if(!a||!b||!this.isVisible(a)||!this.isVisible(b)||a.bornAt>now||b.bornAt>now)continue;const highlighted=(this.path.has(a.id)&&this.path.has(b.id))||(Boolean(this.selected)&&(a.id===this.selected||b.id===this.selected));if(this.query&&(!this.isSearchVisible(a)||!this.isSearchVisible(b))&&!highlighted)continue;if((faceted||this.groupBy!=='none')&&!this.showAllConnections&&!highlighted&&!(this.searchContext.has(a.id)&&this.searchContext.has(b.id)))continue;if(highlighted!==chosen)continue;ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);}ctx.stroke();}
    const labelBoxes=[];
    for(const p of this.points){const shown=this.isVisible(p);if(!shown){if(p.snapAt&&!this.reducedMotion){const progress=(now-p.snapAt)/680;if(progress<0){animating=true;ctx.globalAlpha=.8;ctx.fillStyle=p.depth===0?'#ead779':p.depth===1?'#a8bf83':'#b5a0cb';ctx.beginPath();ctx.arc(p.x,p.y,this.nodeRadius(p),0,Math.PI*2);ctx.fill();}else if(progress<1){animating=true;this.drawDust(p,progress);}else p.snapAt=null;}continue;}const age=now-p.bornAt;if(age<0){animating=true;continue;}visible++;if(!latest||p.bornAt>latest.bornAt)latest=p;const entering=!this.reducedMotion&&age<450;if(entering)animating=true;let reveal=1;if(p.restoreAt&&!this.reducedMotion){const progress=(now-p.restoreAt)/360;if(progress<0){animating=true;continue;}reveal=Math.min(1,progress);if(progress<1)animating=true;else p.restoreAt=null;}const opacity=(entering?Math.min(1,age/180):1)*reveal,hit=this.isSearchVisible(p),selected=p.id===this.selected,muted=this.selected&&!this.neighbors.has(p.id);if(this.query&&this.isSearchHit(p)){ctx.globalAlpha=.18*opacity;ctx.fillStyle='#ead779';ctx.beginPath();ctx.arc(p.x,p.y,this.nodeRadius(p)+9/this.scale,0,Math.PI*2);ctx.fill();}ctx.globalAlpha=(hit?1:.035)*opacity;ctx.fillStyle=!hit?'#5b5d56':muted?'#747474':entering?'#ead779':p.depth===0?'#ead779':p.depth===1?'#a8bf83':'#b5a0cb';ctx.beginPath();ctx.arc(p.x,p.y,(this.nodeRadius(p)+(selected?2/this.scale:0))+(entering?2*(1-age/450):0),0,Math.PI*2);ctx.fill();if(selected||(entering&&!muted)){ctx.strokeStyle=entering?'#b4c5e0':'#f2f0e6';ctx.lineWidth=1/this.scale;ctx.globalAlpha*=entering?1-age/450:1;ctx.beginPath();ctx.arc(p.x,p.y,this.nodeRadius(p)+(entering?5+age/40:6)/this.scale,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=opacity;}
      const grouped=this.groupBy!=='none',treeDepth=this.treeDepths.get(p.id),labelCandidate=hit&&(selected||(!grouped&&p.depth===0)||p.id===this.treeRoot||(this.treeRoot&&treeDepth===1&&focusCount<=80)||(!grouped&&!this.treeRoot&&p.depth===1&&this.points.length<65)||(this.query&&focusCount<=(grouped?18:120))||(!grouped&&!this.treeRoot&&faceted&&focusCount<=80));if(labelCandidate){ctx.font=`${15/this.scale}px "Space Grotesk",sans-serif`;ctx.textAlign='center';ctx.fillStyle=muted?'#898989':'#e9e6d8';const text=(p.name||'Unknown person').slice(0,35),x=p.x*this.scale,y=p.y*this.scale+this.nodeRadius(p)*this.scale+22,w=Math.max(40,text.length*7.7),box={x:x-w/2,y:y-16,w,h:20};if(selected||!labelBoxes.some(b=>box.x<b.x+b.w&&box.x+box.w>b.x&&box.y<b.y+b.h&&box.y+box.h>b.y)){labelBoxes.push(box);ctx.fillText(text,p.x,p.y+this.nodeRadius(p)+22/this.scale);}}
    }
    ctx.globalAlpha=1;ctx.restore();
    if(latest&&latest.id!==this.lastRevealed){this.lastRevealed=latest.id;this.onReveal?.(latest,visible,this.points.length);}
    if(animating)this.draw();
  }
}
