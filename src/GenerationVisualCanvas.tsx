import {memo,useEffect,useRef} from 'react';
import {makeDots,paintGeneration} from './generationRenderer';
import {subscribeAnimation} from './animationScheduler';

type WorkerSlot={worker:Worker;references:number};
const workers:(WorkerSlot|null)[]=[];
// Distribute active generation surfaces over up to four CPU worker threads.
// Workers are created lazily; a single node does not spawn four idle threads.
const workerLimit=Math.max(1,Math.min(4,
  Math.ceil((typeof navigator==='undefined'?4:navigator.hardwareConcurrency||4)/4)));
let nextId=0;
let registered=false;
function sharedWorker(key:number){
  const index=(key-1)%workerLimit;
  while(workers.length<=index)workers.push(null);
  if(!workers[index])workers[index]={
    worker:new Worker(new URL('./generation.worker.ts',import.meta.url),{type:'module'}),
    references:0
  };
  const slot=workers[index]!;
  slot.references++;
  if(!registered){
    document.addEventListener('visibilitychange',()=>{
      for(const running of workers)
        running?.worker.postMessage({kind:'page-visible',visible:!document.hidden});
    });
    registered=true;
  }
  return slot.worker;
}
function releaseWorker(worker:Worker){
  const index=workers.findIndex(slot=>slot?.worker===worker);
  if(index<0)return;
  const slot=workers[index]!;
  if(--slot.references>0)return;
  worker.terminate();
  workers[index]=null;
}
function GenerationVisualCanvasImpl({nodeId}:{nodeId:string}){
  const canvasRef=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{
    const canvas=canvasRef.current;
    if(!canvas)return;
    const key=++nextId;
    const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const canOffload='transferControlToOffscreen' in canvas&&typeof Worker!=='undefined';
    let localWorker:Worker|null=null;
    let transferred=false;
    let stopDraw:()=>void=()=>{};
    let resize:()=>void=()=>{};
    let setVisible:(value:boolean)=>void=()=>{};
    if(canOffload){
      try{
        localWorker=sharedWorker(key);
        const surface=canvas.transferControlToOffscreen();
        transferred=true;
        localWorker.postMessage({kind:'init',key,id:nodeId,canvas:surface,reducedMotion},[surface]);
        canvas.dataset.renderer='offscreen-worker';
        resize=()=>{
          localWorker?.postMessage({kind:'resize',key,
            width:Math.max(1,canvas.clientWidth),
            height:Math.max(1,canvas.clientHeight),
            dpr:window.devicePixelRatio||1});
        };
        setVisible=visible=>localWorker?.postMessage({kind:'visible',key,visible});
      }catch(error){
        // Only fall back if transfer did not succeed; a transferred canvas
        // cannot be recovered by calling getContext on the original element.
        console.warn('OffscreenCanvas 初始化失败：',error);
        if(localWorker)releaseWorker(localWorker);
        localWorker=null;
        if(!transferred)canvas.dataset.renderer='fallback';
      }
    }
    if(!localWorker&&!transferred){
      const ctx=canvas.getContext('2d',{alpha:false});
      if(!ctx)return;
      const started=performance.now();
      let width=0,height=0,dpr=1,visible=true;
      let dots=makeDots(nodeId,1,1);
      canvas.dataset.renderer='main-thread-fallback';
      resize=()=>{
        width=Math.max(1,canvas.clientWidth);
        height=Math.max(1,canvas.clientHeight);
        dpr=window.devicePixelRatio||1;
        canvas.width=Math.round(width*dpr);
        canvas.height=Math.round(height*dpr);
        dots=makeDots(nodeId,width,height);
      };
      setVisible=value=>{visible=value};
      stopDraw=subscribeAnimation(now=>{
        if(visible)paintGeneration(ctx,width,height,dpr,now-started,dots,reducedMotion);
      });
    }
    resize();
    const observer=new ResizeObserver(resize);
    observer.observe(canvas);
    const intersection=new IntersectionObserver(
      entries=>setVisible(entries[0]?.isIntersecting??true),
      {rootMargin:'150px'});
    intersection.observe(canvas);
    return ()=>{
      intersection.disconnect();observer.disconnect();stopDraw();
      if(localWorker){
        localWorker.postMessage({kind:'dispose',key});
        releaseWorker(localWorker);
      }
    };
  },[nodeId]);
  return <canvas ref={canvasRef} className="tn-generating-canvas"
    aria-hidden="true"/>;
}
export const GenerationVisualCanvas=memo(GenerationVisualCanvasImpl);
