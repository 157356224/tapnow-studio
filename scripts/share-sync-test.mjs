import assert from 'node:assert/strict';
import {snapshotCanvas,diffCanvas,applyCanvasPatch,rebaseLocalCanvas,emptyCanvasPatch} from '../src/share-sync.mjs';

const original={
  title:'Team',nodes:[
    {id:'a',type:'studio',position:{x:10,y:20},data:{kind:'image',prompt:'',status:'idle'},selected:true},
    {id:'b',type:'studio',position:{x:300,y:20},data:{kind:'video',prompt:'',status:'idle'}}
  ],edges:[],groups:[],groupColorCursor:0
};
const base=snapshotCanvas(original);
assert.equal(base.nodes[0].selected,undefined);
const host=structuredClone(base);
const guest=structuredClone(base);
host.nodes[0].position.x=80;
guest.nodes[1].data.prompt='共同创作';
let server=applyCanvasPatch(base,diffCanvas(base,host));
server=applyCanvasPatch(server,diffCanvas(base,guest));
assert.equal(server.nodes[0].position.x,80);
assert.equal(server.nodes[1].data.prompt,'共同创作');
assert.deepEqual(rebaseLocalCanvas(guest,base,server),server);
const locked=new Map([['a',{clientId:'guest'}]]);
const denied=applyCanvasPatch(server,diffCanvas(server,{
  ...server,nodes:server.nodes.map(node=>node.id==='a'
    ?{...node,position:{x:900,y:900}}:node)
}),{locks:locked,clientId:'host'});
assert.equal(denied.nodes[0].position.x,80);
assert.ok(emptyCanvasPatch(diffCanvas(server,server)));
console.log('PASS: simultaneous node edits, selection isolation, conflict rebasing, lock exclusion');
