import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import multer from 'multer';
import {mountShareRoutes} from '../server/share.mjs';
import {mountGuestLocalBridge} from '../server/guest-local-bridge.mjs';
import {diffCanvas,snapshotCanvas} from '../src/share-sync.mjs';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'tapnow-local-guest-'));
const hostUploads=path.join(temp,'host-uploads');
const localUploads=path.join(temp,'guest-uploads');
fs.mkdirSync(hostUploads,{recursive:true});
fs.mkdirSync(localUploads,{recursive:true});
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
fs.writeFileSync(path.join(hostUploads,'reference.png'),image);
fs.writeFileSync(path.join(localUploads,'result.png'),image);
let shared=[{
  id:'shared-canvas',title:'Host shared canvas',nodes:[
    {id:'ref',type:'studio',position:{x:10,y:10},
      data:{kind:'image',title:'Reference',mediaUrl:'/api/uploads/reference.png'}},
    {id:'task',type:'studio',position:{x:310,y:40},
      data:{kind:'image',title:'Task',provider:'muse',prompt:'sky'}},
  ],edges:[{id:'e',source:'ref',target:'task'}],
  groups:[],groupColorCursor:0,viewport:{x:0,y:0,zoom:1},
  createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
}];
let privateProjects=[];
const app=express();
app.use(express.json({limit:'20mb'}));
let hostJobs=0,localJobs=0;
app.get('/api/muse/accounts',(_req,res)=>res.json([{id:'HOST-PRIVATE',name:'User1'}]));
app.post('/api/muse/jobs',(_req,res)=>{hostJobs++;res.json({id:'host-job'});});
app.get('/api/uploads/:name',(req,res)=>res.sendFile(path.join(hostUploads,req.params.name)));
app.post('/api/assets',multer({dest:hostUploads}).single('file'),(req,res)=>{
  const filename=crypto.randomUUID()+path.extname(req.file.originalname);
  fs.renameSync(req.file.path,path.join(hostUploads,filename));
  res.json({url:'/api/uploads/'+filename,name:req.file.originalname});
});
const hostServer=await new Promise(resolve=>{
  const server=app.listen(0,'127.0.0.1',()=>resolve(server));
});
const hostOrigin='http://127.0.0.1:'+hostServer.address().port;
const sharedRoutes=mountShareRoutes(app,{
  read:()=>structuredClone(shared),write:value=>{shared=structuredClone(value);},
  root:path.join(path.dirname(fileURLToPath(import.meta.url)),'..','server'),
  uploadDir:hostUploads,lanPort:0,upstreamPort:hostServer.address().port
});
const local=express();
local.use(express.json({limit:'20mb'}));
const localServer=await new Promise(resolve=>{
  const server=local.listen(0,'127.0.0.1',()=>resolve(server));
});
const localOrigin='http://127.0.0.1:'+localServer.address().port;
const bridge=mountGuestLocalBridge(local,{
  read:()=>structuredClone(privateProjects),
  write:value=>{privateProjects=structuredClone(value);},
  uploadDir:localUploads,extraLoopbackOrigins:[localOrigin]
});
local.get('/api/muse/accounts',(_req,res)=>res.json([
  {id:'GUEST-LOCAL',name:'User2'}
]));
local.post('/api/muse/jobs',(req,res)=>{
  localJobs++;
  assert.equal(req.body.accountId,'GUEST-LOCAL');
  assert.ok(privateProjects.some(p=>p.id===req.body.projectId));
  res.json({id:'local-job',status:'queued'});
});
const send=async(base,route,options={})=>{
  const response=await fetch(base+route,{
    ...options,headers:{
      ...(options.body?{'content-type':'application/json'}:{}),
      ...(base===localOrigin?{origin:localOrigin}:{}),
      ...(options.headers||{})
    }
  });
  let body;
  if(response.headers.get('content-type')?.includes('application/json'))
    body=await response.json();
  else body=await response.arrayBuffer();
  return {status:response.status,body,headers:response.headers};
};
const post=(base,url,body,headers)=>send(base,url,{
  method:'POST',headers,body:JSON.stringify(body)
});
try{
  const start=await post(hostOrigin,'/api/share/start',{
    projectId:'shared-canvas',clientId:'owner'
  });
  assert.equal(start.status,200);
  const guestOrigin='http://127.0.0.1:'+sharedRoutes.info().port;
  const directJob=await post(guestOrigin,'/api/muse/jobs',{
    projectId:'shared-canvas',nodeId:'task',accountId:'HOST-PRIVATE'
  });
  assert.equal(directJob.status,401,'Unauthenticated visitors cannot generate');
  const joined=await post(localOrigin,'/api/remote/connect',{
    address:guestOrigin,code:start.body.code
  });
  assert.equal(joined.status,200);
  const id=joined.body.sessionId;
  assert.match(id,/^[0-9a-f]{48}$/);
  const prefix='/api/remote/'+id;
  assert.equal(bridge.sessions.has(id),true);
  const info=await send(localOrigin,prefix+'/share/info');
  assert.equal(info.body.role,'guest');
  const eventsAbort=new AbortController();
  const stream=await fetch(localOrigin+prefix+'/share/events?clientId=guest',{
    headers:{origin:localOrigin},signal:eventsAbort.signal
  });
  assert.equal(stream.status,200);
  assert.match(stream.headers.get('content-type')||'',/text\/event-stream/);
  const reader=stream.body.getReader();
  const readEvent=()=>Promise.race([
    reader.read(),
    new Promise((_,reject)=>setTimeout(
      ()=>reject(new Error('Guest SSE disconnected or stalled')),2500))
  ]);
  const firstEvent=await readEvent();
  assert.equal(firstEvent.done,false);
  assert.match(new TextDecoder().decode(firstEvent.value),/data:/);
  const beforeSSE=snapshotCanvas(shared[0]);
  const changedSSE=structuredClone(beforeSSE);
  changedSSE.nodes[0].position.x+=3;
  const hostEvent=await post(hostOrigin,'/api/share/patch',{
    clientId:'owner',patch:diffCanvas(beforeSSE,changedSSE)
  });
  assert.equal(hostEvent.status,200);
  const secondEvent=await readEvent();
  assert.equal(secondEvent.done,false,'SSE connection must stay open after initial state');
  await reader.cancel();
  eventsAbort.abort();
  const sharedList=await send(localOrigin,prefix+'/projects');
  assert.equal(sharedList.body[0].id,'shared-canvas');
  const blockedHostJob=await post(guestOrigin,'/api/muse/jobs',{
    projectId:'shared-canvas',nodeId:'task',accountId:'HOST-PRIVATE'
  },{cookie:bridge.sessions.get(id).cookie});
  assert.equal(blockedHostJob.status,403,
    'Even an authenticated guest must never start User1 browser jobs');
  assert.equal(hostJobs,0);
  const hiddenAccounts=await send(guestOrigin,'/api/muse/accounts',{
    headers:{cookie:bridge.sessions.get(id).cookie}
  });
  assert.equal(hiddenAccounts.status,403,'User1 account list must not leak');
  const localAccounts=await send(localOrigin,'/api/muse/accounts');
  assert.equal(localAccounts.body[0].id,'GUEST-LOCAL');
  const snapshot=await send(localOrigin,prefix+'/projects/shared-canvas');
  const prepared=await post(localOrigin,prefix+'/prepare',{
    nodeId:'task',title:snapshot.body.title,
    nodes:snapshot.body.nodes,edges:snapshot.body.edges,
    mediaNodeIds:['ref']
  });
  assert.equal(prepared.status,200);
  const mirror=privateProjects.find(p=>p.id===prepared.body.projectId);
  assert.equal(mirror.hiddenGuestJob,true);
  const mirrorRef=mirror.nodes.find(n=>n.id==='ref').data.mediaUrl;
  assert.notEqual(mirrorRef,'/api/uploads/reference.png');
  assert.deepEqual(fs.readFileSync(path.join(localUploads,
    mirrorRef.slice('/api/uploads/'.length))),image);
  const job=await post(localOrigin,'/api/muse/jobs',{
    projectId:mirror.id,nodeId:'task',accountId:localAccounts.body[0].id
  });
  assert.equal(job.status,200);
  assert.equal(localJobs,1);
  assert.equal(hostJobs,0);
  const published=await post(localOrigin,prefix+'/publish',{
    mediaUrl:'/api/uploads/result.png'
  });
  assert.equal(published.status,200);
  assert.match(published.body.url,/^\/api\/uploads\/[0-9a-f-]+\.png$/);
  const uploaded=await send(localOrigin,prefix+'/uploads/'+
    published.body.url.split('/').at(-1));
  assert.deepEqual(Buffer.from(uploaded.body),image);
  const range=await send(localOrigin,prefix+'/uploads/'+
    published.body.url.split('/').at(-1),{
    headers:{range:'bytes=0-3'}
  });
  assert.equal(range.status,206,'Guest media proxy must support video seeking');
  assert.equal(range.headers.get('content-range'),'bytes 0-3/'+image.length);
  assert.deepEqual(Buffer.from(range.body),image.subarray(0,4));
  const old=snapshotCanvas(shared[0]);
  const updated=structuredClone(old);
  updated.nodes.find(n=>n.id==='task').data.mediaUrl=published.body.url;
  const saved=await post(localOrigin,prefix+'/share/patch',{
    patch:diffCanvas(old,updated)
  });
  assert.equal(saved.status,200);
  assert.equal(shared[0].nodes.find(n=>n.id==='task').data.mediaUrl,
    published.body.url);
  const cleaned=await send(localOrigin,prefix+'/prepare/'+mirror.id,
    {method:'DELETE'});
  assert.equal(cleaned.status,200);
  assert.equal(privateProjects.length,0);
  assert.equal(fs.existsSync(path.join(localUploads,
    mirrorRef.slice('/api/uploads/'.length))),false,
    'Temporary reference copies must be removed after local generation');
  console.log('PASS: User2 local account/jobs, host account isolation, references, media publishing and shared canvas sync');
}finally{
  await sharedRoutes.stop().catch(()=>{});
  await new Promise(resolve=>localServer.close(resolve));
  await new Promise(resolve=>hostServer.close(resolve));
  fs.rmSync(temp,{recursive:true,force:true,maxRetries:4,retryDelay:100});
}
