// Isolated in-process integration test; never reads/modifies real accounts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import express from 'express';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sandbox=fs.mkdtempSync(path.join(root,'.tmp-browser-only-'));
const isolatedServer=path.join(sandbox,'server');
fs.mkdirSync(isolatedServer,{recursive:true});
for(const filename of fs.readdirSync(path.join(root,'server'))){
  if(filename.endsWith('.mjs'))
    fs.copyFileSync(path.join(root,'server',filename),path.join(isolatedServer,filename));
}
let listener;
try{
  const {mountDoubaoRoutes}=await import(pathToFileURL(path.join(isolatedServer,'doubao.mjs')).href);
  const app=express();
  app.use(express.json());
  const project={id:'test-project',title:'Test',nodes:[{id:'test-video',data:{
    kind:'video',model:'Seedance 2.0 Mini',prompt:'本地模型验证',
    ratio:'16:9',duration:'5s'}}],edges:[]};
  mountDoubaoRoutes(app,()=>[project],()=>{});
  listener=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>listener.once('listening',resolve));
  const base='http://127.0.0.1:'+listener.address().port+'/api/doubao/accounts';
  const post=(url,body)=>fetch(url,{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

  const refused=await post(base,{name:'rejected',cookie:'old=test'});
  assert.equal(refused.status,400);
  assert.match((await refused.json()).error,/Cookie 导入/);
  assert.equal((await (await fetch(base)).json()).length,0);

  const created=await post(base,{name:'browser-only'});
  assert.equal(created.status,201);
  const account=await created.json();
  assert.equal(account.hasCookie,false);
  for(const removed of ['/quota','/network']){
    assert.equal((await fetch(base+'/'+account.id+removed)).status,404,
      removed+' must no longer be registered');
  }
  assert.equal((await post(base+'/'+account.id+'/refresh-assets',{})).status,404);
  assert.equal((await fetch(base+'/'+account.id+'/trace')).status,200);
  const unsupported=await post('http://127.0.0.1:'+listener.address().port+'/api/doubao/jobs',{
    accountId:account.id,projectId:project.id,nodeId:'test-video',
    model:'Wan 2.6',prompt:'本地模型验证',ratio:'16:9',duration:'5s',references:[]
  });
  assert.equal(unsupported.status,400);
  assert.match((await unsupported.json()).error,/Seedance 2.0 Mini 和 Fast/);
  const vault=path.join(isolatedServer,'data','doubao-secrets',account.id+'.dpapi');
  assert.equal(fs.existsSync(vault),false);

  // Emulate a legacy account whose metadata and encrypted vault still exist.
  const accountFile=path.join(isolatedServer,'data','doubao-accounts.json');
  const stored=JSON.parse(fs.readFileSync(accountFile,'utf8'));
  stored[0].hasCookie=true;
  fs.writeFileSync(accountFile,JSON.stringify(stored));
  fs.writeFileSync(vault,'legacy-vault-must-not-be-read');
  const listed=await (await fetch(base)).json();
  assert.equal(listed[0].hasCookie,false);
  assert.equal(fs.readFileSync(vault,'utf8'),'legacy-vault-must-not-be-read');

  const status=await (await fetch(base+'/'+account.id+'/status')).json();
  assert.deepEqual(status,{browserOpen:false,loginRequired:null,nativeBrowserOpen:false});
  assert.equal((await fetch(base+'/'+account.id,{method:'DELETE'})).status,204);
  console.log('PASS: browser-only API rejects manual Cookies, never reads legacy vault, preserves browser-based login state');
}finally{
  if(listener)await new Promise(resolve=>listener.close(resolve));
  fs.rmSync(sandbox,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
