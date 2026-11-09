// Pure drawing/data helpers, shared by worker and main-thread fallback.
// Coordinates are a SINGLE fixed grid used by the ascending ring, random
// stars and the horizontally sweeping light. Nothing shifts the points.
export type Dot={x:number;y:number;radius:number;size:number;twinkle:boolean;period:number;phase:number};
function randomFor(id:string){
  let seed=0x68c29e57;
  for(let i=0;i<id.length;i++)seed=(Math.imul(seed,33)^id.charCodeAt(i))>>>0;
  return ()=>{
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    return seed/4294967296;
  };
}
export function makeDots(id:string,width:number,height:number):Dot[]{
  const random=randomFor(id);
  const columns=Math.max(2,Math.round(width/16)+1);
  const rows=Math.max(2,Math.round(height/16)+1);
  const dots:Dot[]=[];
  const maxRadius=Math.hypot(width/2,height)||1;
  for(let row=0;row<rows;row++){
    for(let col=0;col<columns;col++){
      // Include all four edges, with half a dot clipped into the border.
      const x=(col/(columns-1))*width;
      const y=(row/(rows-1))*height;
      dots.push({x,y,radius:Math.hypot(x-width/2,height-y)/maxRadius,
        size:1.7+(col*7+row*3)%4*.17,twinkle:false,period:0,phase:0});
    }
  }
  // Seeded shuffle, then spatial exclusion: random but stable and not crowded.
  const candidates=[...dots.keys()];
  for(let i=candidates.length-1;i>0;i--){
    const j=Math.floor(random()*(i+1));
    [candidates[i],candidates[j]]=[candidates[j],candidates[i]];
  }
  const stars:Dot[]=[];
  const separation=Math.max(32,Math.min(68,Math.sqrt(width*height)*.18));
  for(const index of candidates){
    if(stars.length>=11)break;
    const dot=dots[index];
    if(stars.some(other=>Math.hypot(dot.x-other.x,dot.y-other.y)<separation))continue;
    dot.twinkle=true;
    dot.period=6000+random()*5000;
    dot.phase=random();
    stars.push(dot);
  }
  return dots;
}

type Surface=CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D;
const clamp=(v:number)=>Math.max(0,Math.min(1,v));
export function paintGeneration(ctx:Surface,width:number,height:number,dpr:number,
  elapsed:number,dots:Dot[],reducedMotion:boolean){
  if(width<1||height<1)return;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.fillStyle='#08090b';
  ctx.fillRect(0,0,width,height);
  const arcDuration=2200;
  const arcAge=680;
  const beamTime=elapsed-2400;
  const beamProgress=beamTime>=0?(beamTime%4600)/4600:-1;
  const beamCenter=width*(-.5+2*beamProgress);
  // The light sweep is a single diffused gradient, not hundreds of animated
  // DOM shadows or a CSS filter occupying a large compositor surface.
  if(!reducedMotion&&beamProgress>=0){
    const beamWidth=width*.48;
    const gradient=ctx.createLinearGradient(
      beamCenter-beamWidth,0,beamCenter+beamWidth,0);
    gradient.addColorStop(0,'#c9e5ff00');
    gradient.addColorStop(.25,'#bddeff10');
    gradient.addColorStop(.5,'#e4f2ff52');
    gradient.addColorStop(.75,'#bedcfb13');
    gradient.addColorStop(1,'#c9e5ff00');
    ctx.fillStyle=gradient;
    ctx.fillRect(0,0,width,height);
  }
  ctx.fillStyle='#c2cbd7';
  // The base grid never moves, and it reaches every edge of the frame.
  for(const dot of dots){
    ctx.globalAlpha=.14;
    ctx.fillRect(dot.x-dot.size*.5,dot.y-dot.size*.5,dot.size,dot.size);
  }
  ctx.globalAlpha=1;
  ctx.fillStyle='#edf5ff';
  ctx.shadowColor='#a5d3ff';
  for(const dot of dots){
    let arc=0,beam=0,twinkle=0;
    if(!reducedMotion){
      const age=elapsed-dot.radius*arcDuration;
      if(age>=0&&age<arcAge){
        const progress=age/arcAge;
        arc=(progress<.16?progress/.16:Math.pow(1-progress,1.65))*.95;
      }
      if(beamProgress>=0){
        const distance=(dot.x-beamCenter)/(width*.24);
        beam=Math.exp(-distance*distance*1.8)*.76;
      }
      if(dot.twinkle){
        const phase=((elapsed/dot.period)+dot.phase)%1;
        twinkle=phase<.17?phase/.17*.75:phase<.46?
          Math.pow((.46-phase)/.29,1.3)*.75:0;
      }
    }
    const alpha=clamp(Math.max(arc,beam,twinkle));
    if(alpha<.045)continue;
    ctx.globalAlpha=alpha;
    // Glow only on the currently illuminated subset; offscreen raster work
    // is batched in the worker rather than causing DOM layout/repaint.
    ctx.shadowBlur=alpha>.6?4:0;
    const size=dot.size*(1+alpha*.16);
    ctx.fillRect(dot.x-size*.5,dot.y-size*.5,size,size);
  }
  ctx.shadowBlur=0;
  ctx.globalAlpha=1;
}
