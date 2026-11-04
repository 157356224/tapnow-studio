// Photoshop-style alignment during a drag. Distances are in flow coordinates
// and the threshold is in screen pixels so snapping feels the same at any zoom.
const dimension=(node,key)=>{
  const value=node.measured?.[key]??node[key]??
    (key==='width'?(node.data?.kind==='video'?500:320):170);
  return Number.isFinite(value)&&value>0?value:1;
};

const bounds=nodes=>{
  const x=Math.min(...nodes.map(n=>n.position.x));
  const y=Math.min(...nodes.map(n=>n.position.y));
  const right=Math.max(...nodes.map(n=>n.position.x+dimension(n,'width')));
  const bottom=Math.max(...nodes.map(n=>n.position.y+dimension(n,'height')));
  return {x,y,right,bottom,width:right-x,height:bottom-y};
};

// Picks one nearest X and one nearest Y alignment. Reference nodes never
// move, and a multi-node drag applies one common delta to the entire group.
export function snapNodePositionChanges(nodes,changes,zoom=1,thresholdPx=9){
  const moving=changes.filter(c=>c.type==='position'&&c.position);
  if(!moving.length)return {changes,guides:null};
  const positions=new Map(moving.map(c=>[c.id,c.position]));
  const moved=nodes.filter(n=>positions.has(n.id)).map(n=>({
    ...n,position:positions.get(n.id)
  }));
  const stationary=nodes.filter(n=>!positions.has(n.id));
  if(!moved.length||!stationary.length)return {changes,guides:null};
  const box=bounds(moved);
  const threshold=thresholdPx/Math.max(.1,zoom);
  let vertical=null,horizontal=null;
  const movingX=[box.x,box.x+box.width/2,box.right];
  const movingY=[box.y,box.y+box.height/2,box.bottom];
  for(const target of stationary){
    const other=bounds([target]);
    for(const from of movingX){
      for(const to of [other.x,other.x+other.width/2,other.right]){
        const delta=to-from;
        if(Math.abs(delta)<=threshold&&
          (!vertical||Math.abs(delta)<Math.abs(vertical.delta))){
          vertical={delta,coordinate:to,
            start:Math.min(box.y,other.y)-20/zoom,
            end:Math.max(box.bottom,other.bottom)+20/zoom};
        }
      }
    }
    for(const from of movingY){
      for(const to of [other.y,other.y+other.height/2,other.bottom]){
        const delta=to-from;
        if(Math.abs(delta)<=threshold&&
          (!horizontal||Math.abs(delta)<Math.abs(horizontal.delta))){
          horizontal={delta,coordinate:to,
            start:Math.min(box.x,other.x)-20/zoom,
            end:Math.max(box.right,other.right)+20/zoom};
        }
      }
    }
  }
  if(!vertical&&!horizontal)return {changes,guides:null};
  return {
    changes:changes.map(c=>c.type==='position'&&c.position?{
      ...c,position:{
        x:c.position.x+(vertical?.delta||0),
        y:c.position.y+(horizontal?.delta||0)
      }
    }:c),
    guides:{
      vertical:vertical&&{
        x:vertical.coordinate,y1:vertical.start,y2:vertical.end
      },
      horizontal:horizontal&&{
        y:horizontal.coordinate,x1:horizontal.start,x2:horizontal.end
      }
    }
  };
}
