// Node positions are in React Flow coordinates, not browser/screen pixels.
// Use measured node dimensions because video, image and audio cards vary.
export const ALIGN_MODES=[
  'left','center-x','right','top','center-y','bottom',
  'distribute-x','distribute-y'
];

const dimension=(node,axis)=>{
  const value=node.measured?.[axis]??node[axis]??(
    axis==='width'?(node.data?.kind==='video'?500:320):170
  );
  return Number.isFinite(value)&&value>0?value:1;
};

export function alignSelectedNodes(nodes,mode){
  const selected=nodes.filter(node=>node.selected);
  if(selected.length<2||!ALIGN_MODES.includes(mode))return nodes;
  if(mode.startsWith('distribute')&&selected.length<3)return nodes;
  const left=Math.min(...selected.map(n=>n.position.x));
  const right=Math.max(...selected.map(n=>n.position.x+dimension(n,'width')));
  const top=Math.min(...selected.map(n=>n.position.y));
  const bottom=Math.max(...selected.map(n=>n.position.y+dimension(n,'height')));
  const next=new Map();
  if(mode.startsWith('distribute')){
    const horizontal=mode==='distribute-x';
    const axis=horizontal?'x':'y';
    const size=horizontal?'width':'height';
    const arranged=[...selected].sort((a,b)=>a.position[axis]-b.position[axis]);
    const start=arranged[0].position[axis];
    const end=arranged.at(-1).position[axis]+dimension(arranged.at(-1),size);
    const total=arranged.reduce((sum,n)=>sum+dimension(n,size),0);
    const gap=(end-start-total)/(arranged.length-1);
    let cursor=start;
    arranged.forEach((node,index)=>{
      if(index>0&&index<arranged.length-1)
        next.set(node.id,{...node.position,[axis]:cursor});
      cursor+=dimension(node,size)+gap;
    });
  }else{
    for(const node of selected){
      let x=node.position.x,y=node.position.y;
      if(mode==='left')x=left;
      if(mode==='center-x')x=(left+right-dimension(node,'width'))/2;
      if(mode==='right')x=right-dimension(node,'width');
      if(mode==='top')y=top;
      if(mode==='center-y')y=(top+bottom-dimension(node,'height'))/2;
      if(mode==='bottom')y=bottom-dimension(node,'height');
      next.set(node.id,{x,y});
    }
  }
  return nodes.map(node=>{
    const position=next.get(node.id);
    return position&&(
      position.x!==node.position.x||position.y!==node.position.y
    )?{...node,position}:node;
  });
}

// Compute the entire fan-out before changing state, and apply the same cycle,
// duplicate and reverse-link validation used for a normal single connection.
export function planGroupConnections(sourceIds,targetId,edges,canConnect){
  const accepted=[],pending=[...edges];
  for(const source of [...new Set(sourceIds)]){
    if(source===targetId||!canConnect(source,targetId,pending))continue;
    const edge={source,target:targetId,sourceHandle:'out',targetHandle:'in'};
    pending.push(edge);
    accepted.push(edge);
  }
  return accepted;
}
