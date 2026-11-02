import {makeDots,paintGeneration} from './generationRenderer';
import type {Dot} from './generationRenderer';

type State={canvas:OffscreenCanvas;ctx:OffscreenCanvasRenderingContext2D;
  id:string;width:number;height:number;dpr:number;started:number;
  dots:Dot[];visible:boolean;reducedMotion:boolean};
type Message=
  |{kind:'init';key:number;id:string;canvas:OffscreenCanvas;reducedMotion:boolean}
  |{kind:'resize';key:number;width:number;height:number;dpr:number}
  |{kind:'visible';key:number;visible:boolean}
  |{kind:'dispose';key:number}
  |{kind:'page-visible';visible:boolean};
const surfaces=new Map<number,State>();
const scope=self as unknown as {
  requestAnimationFrame?:(callback:(time:number)=>void)=>number;
  postMessage:(payload:unknown)=>void;
};
let scheduled=false;
let pageVisible=true;
function schedule(){
  if(scheduled||!pageVisible||![...surfaces.values()].some(s=>s.visible&&s.width>0))return;
  scheduled=true;
  if(typeof scope.requestAnimationFrame==='function'){
    scope.requestAnimationFrame(draw);
  }else{
    // Used only on engines without worker RAF. Normal operation is not
    // subject to a manually imposed frame-rate cap.
    setTimeout(()=>draw(performance.now()),16);
  }
}
function draw(now:number){
  scheduled=false;
  if(!pageVisible)return;
  for(const state of surfaces.values()){
    if(!state.visible||!state.width)continue;
    paintGeneration(state.ctx,state.width,state.height,state.dpr,
      now-state.started,state.dots,state.reducedMotion);
  }
  schedule();
}
self.onmessage=(event:MessageEvent<Message>)=>{
  const message=event.data;
  if(message.kind==='page-visible'){pageVisible=message.visible;schedule();return;}
  if(message.kind==='init'){
    const ctx=message.canvas.getContext('2d',{
      alpha:false,desynchronized:true
    });
    if(!ctx){scope.postMessage({kind:'error',key:message.key});return;}
    surfaces.set(message.key,{canvas:message.canvas,ctx,id:message.id,
      width:0,height:0,dpr:1,started:performance.now(),dots:[],
      visible:true,reducedMotion:message.reducedMotion});
  }else if(message.kind==='resize'){
    const state=surfaces.get(message.key);
    if(!state)return;
    if(state.width===message.width&&state.height===message.height&&state.dpr===message.dpr)return;
    state.width=message.width;state.height=message.height;state.dpr=message.dpr;
    state.canvas.width=Math.round(state.width*state.dpr);
    state.canvas.height=Math.round(state.height*state.dpr);
    state.dots=makeDots(state.id,state.width,state.height);
  }else if(message.kind==='visible'){
    const state=surfaces.get(message.key);
    if(state)state.visible=message.visible;
  }else if(message.kind==='dispose'){
    surfaces.delete(message.key);
  }
  schedule();
};
