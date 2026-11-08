import {useEffect,useRef,useState} from 'react';
import type {CSSProperties,PointerEvent as ReactPointerEvent} from 'react';
import {Trash2} from 'lucide-react';
import type {CanvasGroup,StudioNode} from './types';

type Bounds = Pick<CanvasGroup,'x'|'y'|'width'|'height'>;
type ResizeDirection = 'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'nw';
type Props = {
  groups: CanvasGroup[];
  nodes: StudioNode[];
  zoom: number;
  onChange: (id:string,patch:Partial<Bounds>)=>void;
  onMoveNodes: (positions:Map<string,{x:number;y:number}>,dx:number,dy:number)=>void;
  onRename: (id:string,name:string)=>void;
  onRemove: (id:string)=>void;
  onInteractionStart: ()=>void;
};

const MIN_WIDTH=210;
const MIN_HEIGHT=130;
const handles:ResizeDirection[]=['n','ne','e','se','s','sw','w','nw'];

function resizedRect(initial:Bounds,edge:ResizeDirection,dx:number,dy:number):Bounds {
  let {x,y,width,height}=initial;
  if(edge.includes('w')) {
    const adjustment=Math.min(dx,width-MIN_WIDTH);
    x+=adjustment;
    width-=adjustment;
  } else if(edge.includes('e')) width=Math.max(MIN_WIDTH,width+dx);
  if(edge.includes('n')) {
    const adjustment=Math.min(dy,height-MIN_HEIGHT);
    y+=adjustment;
    height-=adjustment;
  } else if(edge.includes('s')) height=Math.max(MIN_HEIGHT,height+dy);
  return {x,y,width,height};
}

export function CanvasGroupLayer({groups,nodes,zoom,onChange,onMoveNodes,onRename,onRemove,onInteractionStart}:Props) {
  const [editingId,setEditingId]=useState<string|null>(null);
  const [activeGroupId,setActiveGroupId]=useState<string|null>(null);
  const [draft,setDraft]=useState('');
  const cleanupRef=useRef<(()=>void)|null>(null);
  useEffect(()=>()=>cleanupRef.current?.(),[]);

  const finishRename=(group:CanvasGroup)=>{
    if(editingId!==group.id)return;
    const text=draft.trim().slice(0,60);
    if(text && text!==group.name)onRename(group.id,text);
    setEditingId(null);
  };

  const startInteraction=(event:ReactPointerEvent<HTMLElement>,group:CanvasGroup,mode:'move'|ResizeDirection)=>{
    if(event.button!==0)return;
    event.preventDefault();
    event.stopPropagation();
    setActiveGroupId(group.id);
    cleanupRef.current?.();
    onInteractionStart();
    const startX=event.clientX;
    const startY=event.clientY;
    const original={x:group.x,y:group.y,width:group.width,height:group.height};
    // Spatial membership: any node whose center lies in this frame moves
    // together with the group. Dropping nodes into or out of a frame works
    // without changing the generation-node schema or the connection graph.
    const memberPositions=new Map<string,{x:number;y:number}>();
    if(mode==='move')for(const node of nodes){
      const width=node.measured?.width??node.width??288;
      const height=node.measured?.height??node.height??240;
      const cx=node.position.x+width/2;
      const cy=node.position.y+height/2;
      if(cx>=group.x&&cx<=group.x+group.width&&cy>=group.y&&cy<=group.y+group.height)
        memberPositions.set(node.id,{...node.position});
    }
    const onPointerMove=(e:PointerEvent)=>{
      const dx=(e.clientX-startX)/Math.max(.1,zoom);
      const dy=(e.clientY-startY)/Math.max(.1,zoom);
      if(mode==='move'){
        onChange(group.id,{x:original.x+dx,y:original.y+dy});
        if(memberPositions.size)onMoveNodes(memberPositions,dx,dy);
      }else onChange(group.id,resizedRect(original,mode,dx,dy));
    };
    const cleanup=()=>{
      window.removeEventListener('pointermove',onPointerMove,true);
      window.removeEventListener('pointerup',cleanup,true);
      window.removeEventListener('pointercancel',cleanup,true);
      if(cleanupRef.current===cleanup)cleanupRef.current=null;
    };
    cleanupRef.current=cleanup;
    window.addEventListener('pointermove',onPointerMove,true);
    window.addEventListener('pointerup',cleanup,true);
    window.addEventListener('pointercancel',cleanup,true);
  };

  return <div className="tn-canvas-groups" data-testid="canvas-groups">
    {groups.map(group=><div key={group.id} className="tn-canvas-group"
      data-testid="canvas-group" data-group-id={group.id}
      style={{left:group.x,top:group.y,width:group.width,height:group.height,
        zIndex:activeGroupId===group.id?2:1,
        '--tn-group-color':group.color} as CSSProperties}>
      <div className="tn-canvas-group-header nodrag" data-testid="canvas-group-header"
        onPointerDown={e=>{if(editingId!==group.id)startInteraction(e,group,'move');}}
        onDoubleClick={e=>{e.preventDefault();e.stopPropagation();setEditingId(group.id);setDraft(group.name);}}>
        <span className="tn-canvas-group-mark"/>
        {editingId===group.id
          ? <input autoFocus className="tn-canvas-group-name-input nodrag" value={draft}
              maxLength={60} aria-label="分组名称"
              onPointerDown={e=>e.stopPropagation()}
              onChange={e=>setDraft(e.target.value)}
              onBlur={()=>finishRename(group)}
              onKeyDown={e=>{e.stopPropagation();if(e.key==='Enter')e.currentTarget.blur();
                if(e.key==='Escape'){setDraft(group.name);e.currentTarget.blur();}}}/>
          : <span className="tn-canvas-group-name" title="双击重命名">{group.name}</span>}
        <button type="button" className="tn-canvas-group-delete nodrag"
          aria-label={'删除'+group.name} title="删除分组（保留内部节点）"
          onPointerDown={e=>e.stopPropagation()}
          onClick={e=>{e.stopPropagation();onRemove(group.id);}}><Trash2 size={13}/></button>
      </div>
      {handles.map(direction=><div key={direction}
        className={'tn-canvas-group-resize tn-canvas-group-resize-'+direction}
        data-testid={'canvas-group-resize-'+direction}
        title="拖动调整分组大小"
        onPointerDown={e=>startInteraction(e,group,direction)}/>)}
    </div>)}
  </div>;
}
