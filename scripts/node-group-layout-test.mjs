import assert from 'node:assert/strict';
import {alignSelectedNodes,planGroupConnections} from '../src/node-alignment.mjs';

const node=(id,x,y,w,h,selected=true)=>({
  id,selected,position:{x,y},measured:{width:w,height:h}
});
const nodes=[
  node('a',60,80,200,100),
  node('b',480,290,400,190),
  node('c',1000,520,150,140),
  node('other',40,45,400,280,false)
];
const unchanged=alignSelectedNodes(nodes,'distribute-x');
assert.equal(unchanged[3],nodes[3],'Unselected nodes must be untouched');
assert.deepEqual(alignSelectedNodes(nodes,'left').slice(0,3)
  .map(n=>n.position.x),[60,60,60]);
assert.deepEqual(alignSelectedNodes(nodes,'right').slice(0,3)
  .map(n=>n.position.x),[950,750,1000]);
assert.deepEqual(alignSelectedNodes(nodes,'top').slice(0,3)
  .map(n=>n.position.y),[80,80,80]);
assert.deepEqual(alignSelectedNodes(nodes,'bottom').slice(0,3)
  .map(n=>n.position.y),[560,470,520]);
assert.deepEqual(alignSelectedNodes(nodes,'center-x').slice(0,3)
  .map(n=>n.position.x),[505,405,530]);
assert.deepEqual(alignSelectedNodes(nodes,'center-y').slice(0,3)
  .map(n=>n.position.y),[320,275,300]);
const spaced=alignSelectedNodes(nodes,'distribute-x');
const positions=spaced.slice(0,3).map(n=>n.position.x);
assert.equal(positions[0],60);
assert.equal(positions[2],1000);
assert.ok(Math.abs(
  (positions[1]-(positions[0]+200))-
  (positions[2]-(positions[1]+400))
)<.0001,'Horizontal distribution uses equal edge gaps even for mixed node widths');
const vertical=alignSelectedNodes(nodes,'distribute-y');
assert.ok(Math.abs(
  (vertical[1].position.y-(vertical[0].position.y+100))-
  (vertical[2].position.y-(vertical[1].position.y+190))
)<.0001,'Vertical distribution uses equal edge gaps');
assert.equal(alignSelectedNodes(nodes.slice(0,1),'left').length,1);
assert.equal(alignSelectedNodes(nodes.slice(0,2),'distribute-x')[1].position.x,480);

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
console.log('PASS: 8 group alignment/distribution modes; mixed dimensions; fan-out validation and duplicate protection');
