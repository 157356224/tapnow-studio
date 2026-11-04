import assert from 'node:assert/strict';
import {planGroupConnections} from '../src/node-alignment.mjs';
import {snapNodePositionChanges} from '../src/node-smart-guides.mjs';

const node=(id,x,y,w,h,selected=true)=>({
  id,selected,position:{x,y},measured:{width:w,height:h}
});
const nodes=[
  node('ref',400,200,300,200,false),
  node('moving',100,100,150,100),
  node('other',1000,700,200,120,false)
];
const move=(x,y)=>[{id:'moving',type:'position',position:{x,y},dragging:true}];
const topLeft=snapNodePositionChanges(nodes,move(393,193),1);
assert.deepEqual(topLeft.changes[0].position,{x:400,y:200},
  'Dragging near reference left and top edges snaps in both axes');
assert.equal(topLeft.guides.vertical.x,400);
assert.equal(topLeft.guides.horizontal.y,200);
const center=snapNodePositionChanges([
  nodes[0],node('moving',20,20,100,80)
],[{id:'moving',type:'position',position:{x:504,y:266}}],1);
assert.deepEqual(center.changes[0].position,{x:500,y:260},
  'Smart guides snap center-to-center for differently sized nodes');
const rightBottom=snapNodePositionChanges(nodes,move(547,303),1);
assert.deepEqual(rightBottom.changes[0].position,{x:550,y:300},
  'Right and bottom edges can snap against the other card');
const away=snapNodePositionChanges(nodes,move(180,88),1);
assert.equal(away.guides,null,'No guide outside threshold');
assert.deepEqual(away.changes,move(180,88),'No snap outside threshold');
const zoomIn=snapNodePositionChanges(nodes,move(393,193),2);
assert.equal(zoomIn.guides,null,
  'Screen-space snap radius decreases in flow units when zoomed in');
const zoomOut=snapNodePositionChanges(nodes,move(393,193),.5);
assert.equal(zoomOut.changes[0].position.x,400);
const group=[
  node('fixed',400,200,300,200,false),
  node('a',20,60,100,100),
  node('b',160,90,100,100)
];
const multi=snapNodePositionChanges(group,[
  {id:'a',type:'position',position:{x:157,y:180},dragging:true},
  {id:'b',type:'position',position:{x:297,y:210},dragging:true}
],1);
assert.equal(multi.changes[0].position.x,160);
assert.equal(multi.changes[1].position.x,300,
  'Dragging a selected group applies one common snap offset');
assert.equal(multi.changes[1].position.y-multi.changes[0].position.y,30,
  'Group snapping preserves the distance between selected nodes');
assert.equal(snapNodePositionChanges([nodes[1]],move(393,193),1).guides,null,
  'Dragging the only node cannot create a guide');

const valid=(source,target,edges)=>{
  if(source===target)return false;
  if(edges.some(e=>(e.source===source&&e.target===target)||
    (e.source===target&&e.target===source)))return false;
  const pending=[target],seen=new Set();
  while(pending.length){
    const id=pending.pop();
    if(id===source)return false;
    if(seen.has(id))continue;
    seen.add(id);
    for(const edge of edges)if(edge.source===id)pending.push(edge.target);
  }
  return true;
};
const existing=[{source:'a',target:'video'},{source:'video',target:'c'}];
assert.deepEqual(planGroupConnections(['a','b','c','b'],'video',existing,valid)
  .map(edge=>edge.source),['b'],
  'Fan-out must skip existing/reverse/cyclic connections and duplicated source IDs');
assert.deepEqual(planGroupConnections(['a','b'],'b',[],valid)
  .map(edge=>edge.source),['a'],'Self connections are blocked');
assert.equal(planGroupConnections(['a','a'],'video',[],valid).length,1);
console.log('PASS: Photoshop-style snap guides (edges, centers, zoom, group movement) and safe fan-out connections');
