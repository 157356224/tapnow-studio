import {useCallback,useEffect,useRef,useState} from 'react';
import type {PointerEvent as ReactPointerEvent} from 'react';
import {ViewportPortal,getNodesBounds,useReactFlow} from '@xyflow/react';
import {Plus} from 'lucide-react';
import type {StudioNode,StudioEdge} from './types';

type ScreenPoint={x:number;y:number};
type Props={
  nodes:StudioNode[];
  zoom:number;
  onConnect:(sources:string[],target:string)=>void;
  onAdd:(sources:string[],point:ScreenPoint)=>void;
  onStart:(sources:string[])=>void;
  onHover:(target:string|null,sources:string[])=>boolean;
  onEnd:()=>void;
};
export function SelectionGroupControls({
  nodes,zoom,onConnect,onAdd,onStart,onHover,onEnd
}:Props){
  const rf=useReactFlow<StudioNode,StudioEdge>();
  const cleanup=useRef<(()=>void)|null>(null);
  const [pointer,setPointer]=useState<ScreenPoint|null>(null);
  const [hoverValid,setHoverValid]=useState(true);
  const selected=nodes.filter(node=>node.selected);
  const bounds=getNodesBounds(selected);
  const inverse=1/Math.max(zoom,.1);
  const portX=bounds.width+29*inverse,portY=bounds.height/2;
  const selectedIds=selected.map(node=>node.id);

  useEffect(()=>()=>cleanup.current?.(),[]);
  const startDrag=useCallback((event:ReactPointerEvent<HTMLButtonElement>)=>{
    if(event.button!==0||selected.length<2)return;
    event.preventDefault();
    event.stopPropagation();
    cleanup.current?.();
    const sourceIds=selectedIds;
    const start={x:event.clientX,y:event.clientY};
    let moved=false;
    onStart(sourceIds);
    const resolveTarget=(x:number,y:number)=>{
      const element=document.elementFromPoint(x,y);
      const candidate=element?.closest('.react-flow__node[data-id]')?.getAttribute('data-id');
      return candidate&&!sourceIds.includes(candidate)?candidate:null;
    };
    const onMove=(e:PointerEvent)=>{
      if(Math.hypot(e.clientX-start.x,e.clientY-start.y)>6)moved=true;
      if(!moved)return;
      const candidate=resolveTarget(e.clientX,e.clientY);
      setHoverValid(onHover(candidate,sourceIds));
      setPointer({x:e.clientX,y:e.clientY});
    };
    const release=()=>{
      document.removeEventListener('pointermove',onMove,true);
      document.removeEventListener('pointerup',onUp,true);
      document.removeEventListener('pointercancel',onCancel,true);
      window.removeEventListener('blur',onCancel);
      cleanup.current=null;
      setPointer(null);
      setHoverValid(true);
      onEnd();
    };
    const onCancel=()=>release();
    const onUp=(e:PointerEvent)=>{
      const target=resolveTarget(e.clientX,e.clientY);
      const overSelected=document.elementFromPoint(e.clientX,e.clientY)
        ?.closest('.react-flow__node[data-id]')?.getAttribute('data-id');
      const valid=target?onHover(target,sourceIds):false;
      release();
      // A click (or a drop onto empty canvas) opens the same add-node chooser
      // as an individual node's right-side +. Preserve the source IDs even
      // if React Flow changes selection during pointer release.
      if(target&&valid)onConnect(sourceIds,target);
      else if(!overSelected)setTimeout(()=>onAdd(sourceIds,{x:e.clientX,y:e.clientY}),0);
    };
    document.addEventListener('pointermove',onMove,true);
    document.addEventListener('pointerup',onUp,true);
    document.addEventListener('pointercancel',onCancel,true);
    window.addEventListener('blur',onCancel);
    cleanup.current=release;
  },[selected.length,selectedIds.join('|'),onStart,onHover,onEnd,onConnect,onAdd]);

  if(selected.length<2)return null;
  const target=pointer?rf.screenToFlowPosition(pointer):null;
  const toX=target?target.x-bounds.x:portX;
  const toY=target?target.y-bounds.y:portY;
  const curve=Math.max(70*inverse,Math.abs(toX-portX)*.4);
  return <ViewportPortal>
    <div className="tn-selection-group" data-testid="node-selection-group"
      style={{position:'absolute',left:bounds.x,top:bounds.y,
        width:bounds.width,height:bounds.height,pointerEvents:'none'}}>
      {pointer&&<svg className="tn-group-connection-preview"
        width="1" height="1" aria-hidden="true"
        style={{position:'absolute',left:0,top:0,overflow:'visible',pointerEvents:'none'}}>
        <path d={'M '+portX+' '+portY+' C '+(portX+curve)+' '+portY+
          ', '+(toX-curve)+' '+toY+', '+toX+' '+toY}
          stroke={hoverValid?'#cecedc':'#f28787'}
          strokeWidth={2*inverse} fill="none" strokeDasharray={hoverValid?undefined:'7 5'}/>
      </svg>}
      <button className={'tn-group-port'+(pointer?' tn-group-port-active':'')}
        type="button" aria-label="连接所选节点" title="拖到目标节点：批量连接；点击或拖到空白处：添加节点"
        style={{
          left:portX,top:portY,
          transform:'scale('+inverse+') translate(-50%,-50%)'
        }}
        onPointerDown={startDrag}>
        <Plus size={19} strokeWidth={1.9}/>
      </button>
    </div>
  </ViewportPortal>;
}
