import assert from 'node:assert/strict';
import express from 'express';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {mountShareRoutes} from '../server/share.mjs';
import {diffCanvas,snapshotCanvas} from '../src/share-sync.mjs';

const project={
  id:'test-canvas',title:'共享测试',
  nodes:[
    {id:'a',type:'studio',position:{x:90,y:110},data:{kind:'image',title:'A',prompt:''}},
    {id:'b',type:'studio',position:{x:420,y:110},data:{kind:'video',title:'B',prompt:''}}
  ],
  edges:[],groups:[],groupColorCursor:0,
  viewport:{x:0,y:0,zoom:1},
  createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
};
let items=[project];
const read=()=>structuredClone(items);
const write=value=>{items=structuredClone(value);};
const app=express();
app.use(express.json());
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','server');
const mounted=mountShareRoutes(app,{
  read,write,root,uploadDir:path.join(root,'uploads'),lanPort:0
});
const hostServer=await new Promise(resolve=>{
  const server=app.listen(0,'127.0.0.1',()=>resolve(server));
});
const host='http://127.0.0.1:'+hostServer.address().port;
const request=async(base,route,method='GET',body,cookie)=>{
  const response=await fetch(base+route,{
    method,
    headers:{
      ...(body===undefined?{}:{'content-type':'application/json'}),
      ...(cookie?{cookie}:{})
    },
    body:body===undefined?undefined:JSON.stringify(body)
  });
  return {status:response.status,body:await response.json(),headers:response.headers};
};
const post=(base,route,body,cookie)=>request(base,route,'POST',body,cookie);
try{
  const started=await post(host,'/api/share/start',{
    projectId:project.id,clientId:'host-client'
  });
  assert.equal(started.status,200);
  assert.match(started.body.code,/^\d{5}$/);
  const guest='http://127.0.0.1:'+mounted.info().port;
  assert.equal((await request(guest,'/api/projects')).status,401);
  const invalid=await post(guest,'/api/share/join',{code:'abcde'});
  assert.equal(invalid.status,403);
  const joined=await post(guest,'/api/share/join',{code:started.body.code});
  assert.equal(joined.status,200);
  const cookie=joined.headers.get('set-cookie').split(';')[0];
  assert.equal((await request(guest,'/api/share/info','GET',undefined,cookie)).body.role,'guest');
  assert.equal((await request(guest,'/api/projects','GET',undefined,cookie)).body.length,1);
  assert.equal((await request(guest,'/api/projects/unshared','GET',undefined,cookie)).status,404);
  const base=snapshotCanvas(read()[0]);
  const hostEdit=structuredClone(base),guestEdit=structuredClone(base);
  hostEdit.nodes[0].position.x=275;
  guestEdit.nodes[1].data.prompt='用户2的镜头内容';
  const h=await post(host,'/api/share/patch',{
    clientId:'host-client',patch:diffCanvas(base,hostEdit)
  });
  assert.equal(h.status,200);
  const g=await post(guest,'/api/share/patch',{
    patch:diffCanvas(base,guestEdit)
  },cookie);
  assert.equal(g.status,200);
  assert.equal(read()[0].nodes[0].position.x,275);
  assert.equal(read()[0].nodes[1].data.prompt,'用户2的镜头内容');
  const lock=await post(guest,'/api/share/lock',{nodeId:'a'},cookie);
  assert.equal(lock.status,200);
  assert.equal((await post(host,'/api/share/lock',{
    nodeId:'a',clientId:'host-client'
  })).status,423);
  assert.equal((await post(guest,'/api/share/lock',{
    nodeId:'a',action:'release'
  },cookie)).status,200);
  const closed=await post(host,'/api/share/stop',{clientId:'host-client'});
  assert.equal(closed.status,200);
  assert.equal(mounted.info().active,false);
  console.log('PASS: LAN join code, isolated project, concurrent node positions and text, lock release, share stop');
}finally{
  await mounted.stop().catch(()=>{});
  await new Promise(resolve=>hostServer.close(resolve));
}
