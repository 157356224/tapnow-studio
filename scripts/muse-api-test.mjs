// Entire Muse API test runs against an isolated temporary server copy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import express from 'express';
import {setMuseProjectJob,preserveMuseCompletedMedia} from '../server/muse-project.mjs';
const root=path.resolve('work','.tmp-muse-api-'+crypto.randomUUID());
const server=path.join(root,'server');
fs.mkdirSync(server,{recursive:true});
for(const filename of ['muse.mjs','muse-runner.mjs','muse-project.mjs','muse-quota.mjs',
  'browser-cleanup.mjs',
  'reference-selection.mjs',
  'chromium-binary.mjs'])
  fs.copyFileSync(path.resolve('server',filename),path.join(server,filename));
let listener;
try{
  const {mountMuseRoutes}=await import(pathToFileURL(path.join(server,'muse.mjs')).href);
  const project={id:'test-project',nodes:[
    {id:'test-video',data:{kind:'video',provider:'muse',prompt:'展示风景',
      ratio:'16:9',duration:'5s'}},
    {id:'test-image',data:{kind:'image',provider:'muse',prompt:'画风景',ratio:'3:4'}}
  ]};
  const app=express();app.use(express.json());
  mountMuseRoutes(app,()=>[project],()=>{});
  listener=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>listener.once('listening',resolve));
  const base='http://127.0.0.1:'+listener.address().port+'/api/muse';
  const post=(suffix,body)=>fetch(base+suffix,{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.deepEqual(await (await fetch(base+'/accounts')).json(),[]);
  const emptyQuotas=await (await fetch(base+'/quotas')).json();
  assert.equal(emptyQuotas.totalAccounts,0);
  assert.equal(emptyQuotas.totalRemaining,0);
  assert.equal(typeof emptyQuotas.refreshing,'boolean');
  const blocked=await post('/accounts',{name:'bad',token:'do-not-store'});
  assert.equal(blocked.status,400);
  const created=await post('/accounts',{name:'Muse isolated'});assert.equal(created.status,201);
  const account=await created.json();
  const accounts=await (await fetch(base+'/accounts')).json();
  assert.equal(accounts.length,1);
  assert.equal(accounts[0].id,account.id);
  const job={accountId:account.id,projectId:project.id,nodeId:'test-video',
    provider:'muse',prompt:'展示海边',ratio:'16:9',duration:'11s',references:[]};
  let reply=await post('/jobs',job);
  assert.equal(reply.status,400);
  assert.match((await reply.json()).error,/最多 10 秒/);
  reply=await post('/jobs',{...job,duration:'10s',
    references:[{id:'source-image'}]});
  assert.equal(reply.status,400);
  assert.match((await reply.json()).error,/必须与输入框/);
  reply=await post('/jobs',{...job,duration:'10s',provider:'doubao'});
  assert.equal(reply.status,400);
  reply=await post('/jobs',{...job,nodeId:'test-image',duration:'5s',ratio:'invalid'});
  assert.equal(reply.status,400);
  reply=await post('/jobs',{...job,nodeId:'test-image',duration:'5s',
    ratio:'1:1',resolution:'invalid'});
  assert.equal(reply.status,400);
  assert.match((await reply.json()).error,/图片分辨率请选择/);
  const initial=[{id:'p',nodes:[{id:'img',data:{
    kind:'image',provider:'muse',status:'idle'}}]}];
  const museJob={id:'j1',projectId:'p',nodeId:'img',kind:'image'};
  const queued=setMuseProjectJob(initial,museJob,{status:'queued'});
  assert.equal(queued.projects[0].nodes[0].data.jobId,'j1');
  const completed=setMuseProjectJob(queued.projects,museJob,{
    status:'done',mediaUrl:'/api/uploads/example.png',demo:false
  });
  assert.equal(completed.projects[0].nodes[0].data.mediaUrl,'/api/uploads/example.png');
  const staleAutosave=[{id:'img',data:{kind:'image',provider:'muse',
    status:'running',jobId:'j1'}}];
  const reconciled=preserveMuseCompletedMedia(completed.projects[0],staleAutosave);
  assert.equal(reconciled[0].data.status,'done');
  assert.equal(reconciled[0].data.mediaUrl,'/api/uploads/example.png');
  // Never POST a valid job in this offline test; it would launch Edge.
  assert.equal((await fetch(base+'/accounts/'+account.id+'/status')).status,200);
  assert.equal((await fetch(base+'/accounts/'+account.id,{method:'DELETE'})).status,204);
  assert.equal((await (await fetch(base+'/accounts')).json()).length,0);
  console.log('PASS: Muse isolated accounts, token import rejected, >10s video and refs rejected, no live browser job dispatched');
}finally{
  if(listener)await new Promise(resolve=>listener.close(resolve));
  fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}
