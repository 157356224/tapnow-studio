import {memo,useEffect,useId,useLayoutEffect,useRef} from 'react';
import {BaseEdge,getBezierPath} from '@xyflow/react';
import type {EdgeProps} from '@xyflow/react';
import {subscribeAnimation} from './animationScheduler';

const LIGHT_COUNT=5;
const LOOP_MS=2400;
const TAIL_LENGTH=165;
const MIN_HEAD_SPACING=190;
const TRACK_RESOLUTION=11;
const RIBBON_RESOLUTION=8;

type Point={x:number;y:number};
type Track={length:number;distances:number[];points:Point[]};

// Calculate Bezier positions directly in JavaScript rather than calling the
// SVG geometry engine hundreds of times whenever a node is being dragged.
function sampleTrack(path:string):Track{
  const values=(path.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)||[]).map(Number);
  if(values.length<8) return {length:0,distances:[0,0],points:[{x:0,y:0},{x:0,y:0}]};
  const [x0,y0,x1,y1,x2,y2,x3,y3]=values;
  const estimate=Math.hypot(x1-x0,y1-y0)+Math.hypot(x2-x1,y2-y1)+Math.hypot(x3-x2,y3-y2);
  const count=Math.max(18,Math.min(180,Math.ceil(estimate/TRACK_RESOLUTION)));
  const points:Point[]=[],distances:number[]=[0];
  for(let i=0;i<=count;i++){
    const t=i/count,u=1-t;
    points.push({
      x:u*u*u*x0+3*u*u*t*x1+3*u*t*t*x2+t*t*t*x3,
      y:u*u*u*y0+3*u*u*t*y1+3*u*t*t*y2+t*t*t*y3
    });
    if(i)distances.push(distances[i-1]+
      Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y));
  }
  return {length:distances[count],distances,points};
}

function pointOnTrack(track:Track,distance:number){
  const position=Math.max(0,Math.min(track.length,distance));
  let lo=0,hi=track.distances.length-1;
  while(lo+1<hi){
    const mid=(lo+hi)>>>1;
    if(track.distances[mid]<=position)lo=mid;
    else hi=mid;
  }
  const first=Math.min(track.points.length-2,lo);
  const segment=Math.max(.000001,track.distances[first+1]-track.distances[first]);
  const fraction=Math.max(0,Math.min(1,(position-track.distances[first])/segment));
  const a=track.points[first],b=track.points[first+1];
  const dx=b.x-a.x,dy=b.y-a.y;
  const magnitude=Math.hypot(dx,dy)||1;
  return {
    x:a.x+dx*fraction,y:a.y+dy*fraction,
    nx:-dy/magnitude,ny:dx/magnitude,
    tx:dx/magnitude,ty:dy/magnitude
  };
}

function fmt(point:Point){
  return point.x.toFixed(2)+' '+point.y.toFixed(2);
}

// Quadratic interpolation prevents visible corners in the warped ribbon.
function boundary(points:Point[]){
  let d='';
  for(let i=1;i<points.length-1;i++){
    const mid={
      x:(points[i].x+points[i+1].x)/2,
      y:(points[i].y+points[i+1].y)/2
    };
    d+=' Q '+fmt(points[i])+' '+fmt(mid);
  }
  return d+' L '+fmt(points.at(-1)!);
}

function curvedDroplet(track:Track,headDistance:number,tailLength=TAIL_LENGTH){
  const tailDistance=Math.max(0,headDistance-tailLength);
  const span=headDistance-tailDistance;
  if(span<1)return null;
  const count=Math.max(8,Math.ceil(span/RIBBON_RESOLUTION));
  const left:Point[]=[],right:Point[]=[];
  for(let i=0;i<=count;i++){
    const distance=tailDistance+span*i/count;
    const point=pointOnTrack(track,distance);
    const progress=(distance-(headDistance-tailLength))/tailLength;
    const radius=2.9*Math.pow(Math.max(0,progress),1.45);
    left.push({x:point.x+point.nx*radius,y:point.y+point.ny*radius});
    right.push({x:point.x-point.nx*radius,y:point.y-point.ny*radius});
  }
  const head=pointOnTrack(track,headDistance);
  const tip={x:head.x+head.tx*3.1,y:head.y+head.ty*3.1};
  right.reverse();
  const d='M '+fmt(left[0])+boundary(left)+
    ' Q '+fmt(tip)+' '+fmt(right[0])+boundary(right)+' Z';
  return {d,tail:pointOnTrack(track,tailDistance),head};
}

/** Five continuous glowing ribbons, each curved along the actual Bezier wire. */
function FlowEdgeView(props:EdgeProps){
  const [path]=getBezierPath({
    sourceX:props.sourceX,sourceY:props.sourceY,
    sourcePosition:props.sourcePosition,
    targetX:props.targetX,targetY:props.targetY,
    targetPosition:props.targetPosition
  });
  const gradientId='tn-drop-gradient-'+useId().replace(/:/g,'');
  const trackRef=useRef<SVGPathElement>(null);
  const lightsRef=useRef<SVGGElement>(null);
  const sampledTrackRef=useRef<Track|null>(null);

  // Geometry follows dragging immediately, with no synchronous SVG layout
  // queries and without restarting any animation on each position change.
  useLayoutEffect(()=>{
    const track=sampleTrack(path);
    sampledTrackRef.current=Number.isFinite(track.length)&&track.length>=2?track:null;
  },[path]);

  useEffect(()=>{
    const root=lightsRef.current;
    if(!root||window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      return;
    const shapes=Array.from(root.querySelectorAll<SVGGElement>('.tn-blue-flow-droplet'));
    const gradients=Array.from(root.querySelectorAll<SVGLinearGradientElement>('linearGradient'));
    let visible=true;
    const observer=new IntersectionObserver(entries=>{
      visible=entries[0]?.isIntersecting??true;
    },{rootMargin:'150px'});
    observer.observe(root);
    const render=(now:number)=>{
      if(visible){
        const track=sampledTrackRef.current;
        if(track){
        // Near nodes do not need five overlapping 165px tails. Preserve five
        // lights on long connections, reducing count and length on short ones.
        const activeCount=Math.min(LIGHT_COUNT,
          Math.max(1,Math.floor(track.length/MIN_HEAD_SPACING)));
        const spacing=track.length/activeCount;
        const tailLength=Math.min(TAIL_LENGTH,spacing*.72);
        root.dataset.activeLights=String(activeCount);
        root.dataset.effectiveTail=tailLength.toFixed(2);
        for(let i=0;i<LIGHT_COUNT;i++){
          const shape=shapes[i],gradient=gradients[i];
          if(i>=activeCount){
            shape.setAttribute('visibility','hidden');
            continue;
          }
          // Absolute clock means geometry updates and even remounts cannot
          // restart the flow at zero while the operator drags a node.
          const phase=((now/LOOP_MS)%1+i/activeCount)%1;
          const headDistance=track.length*phase;
          const droplet=curvedDroplet(track,headDistance,tailLength);
          if(!droplet){
            shape.setAttribute('visibility','hidden');
            continue;
          }
          shape.removeAttribute('visibility');
          const [aura,body]=shape.querySelectorAll<SVGPathElement>('path');
          aura.setAttribute('d',droplet.d);
          body.setAttribute('d',droplet.d);
          gradient.setAttribute('x1',String(droplet.tail.x));
          gradient.setAttribute('y1',String(droplet.tail.y));
          gradient.setAttribute('x2',String(droplet.head.x));
          gradient.setAttribute('y2',String(droplet.head.y));
          shape.dataset.headDistance=headDistance.toFixed(2);
          shape.dataset.tailDistance=Math.max(0,headDistance-tailLength).toFixed(2);
          shape.dataset.phase=phase.toFixed(5);
        }
        }
      }
    };
    const unsubscribe=subscribeAnimation(render);
    return ()=>{unsubscribe();observer.disconnect();};
  },[]);

  return <>
    <BaseEdge id={props.id} path={path}
      style={{stroke:'#5a5a60',strokeWidth:1.9}}/>
    <g className="tn-blue-flow" ref={lightsRef}
      aria-hidden="true" pointerEvents="none">
      <defs>
        <path ref={trackRef} d={path} className="tn-blue-flow-track"/>
        {Array.from({length:LIGHT_COUNT},(_,index)=>
          <linearGradient key={index} id={gradientId+'-'+index}
            gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#318dff" stopOpacity="0"/>
            <stop offset="22%" stopColor="#318dff" stopOpacity=".08"/>
            <stop offset="48%" stopColor="#4fa9ff" stopOpacity=".3"/>
            <stop offset="72%" stopColor="#70c8ff" stopOpacity=".67"/>
            <stop offset="90%" stopColor="#b2eaff" stopOpacity=".96"/>
            <stop offset="100%" stopColor="#edfbff" stopOpacity="1"/>
          </linearGradient>
        )}
      </defs>
      {Array.from({length:LIGHT_COUNT},(_,index)=>
        <g key={index} className="tn-blue-flow-droplet" data-drop-index={index}>
          <path className="tn-blue-flow-aura"
            fill={`url(#${gradientId}-${index})`}/>
          <path className="tn-blue-flow-body"
            fill={`url(#${gradientId}-${index})`}/>
        </g>
      )}
    </g>
  </>;
}
export const FlowEdge=memo(FlowEdgeView);
