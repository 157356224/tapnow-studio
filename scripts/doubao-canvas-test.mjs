import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {DoubaoCanvasClient,crc32,imageDimensions,signImagexRequest} from
  '../server/doubao-canvas-client.mjs';
import {mountDoubaoCanvasRoutes} from '../server/doubao-canvas.mjs';

const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'tapnow-doubao-canvas-'));
const uploadDir=path.join(scratch,'uploads'),dataDir=path.join(scratch,'data');
fs.mkdirSync(uploadDir);fs.mkdirSync(dataDir);
const image=Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
  'base64');
const source=path.join(uploadDir,crypto.randomUUID()+'.png');
fs.writeFileSync(source,image);
const source2=path.join(uploadDir,crypto.randomUUID()+'.png');
const source3=path.join(uploadDir,crypto.randomUUID()+'.png');
fs.writeFileSync(source2,image);
fs.writeFileSync(source3,image);
const mockVideo=Buffer.from('000000186674797069736f6d0000020069736f6d6d703431','hex');
const json=data=>new Response(JSON.stringify(data),{status:200,
  headers:{'content-type':'application/json'}});
const fixedDate=new Date('2026-11-16T01:02:03.000Z');
const credential={ak:'AK',sk:'SK',token:'TOKEN'};
const ordered=signImagexRequest('GET','/top/v1',[
  ['Version','2018-08-01'],['Action','ApplyImageUpload']],credential,fixedDate);
const reversed=signImagexRequest('GET','/top/v1',[
  ['Action','ApplyImageUpload'],['Version','2018-08-01']],credential,fixedDate);
assert.deepEqual(ordered,reversed);
assert.match(ordered.authorization,/Credential=AK\/20261116/);
assert.match(ordered.authorization,
  /Signature=4c20a589cee4c65bb50b5e5bd745c5f3625a3eb2fe47d2a4102dbd5d4ad3ea38/);
assert.equal(ordered.query,'Action=ApplyImageUpload&Version=2018-08-01');
assert.equal(crc32(Buffer.from('123456789')),'cbf43926');
assert.deepEqual(imageDimensions(image),{width:1,height:1,format:'png'});
assert.equal(DoubaoCanvasClient.videoURL({
  video_model:{video_list:{'720p':{
    main_url:Buffer.from('https://video.test/file.mp4').toString('base64')
  }}}
}),'https://video.test/file.mp4');
assert.equal(DoubaoCanvasClient.videoURL({
  video_model:'not-json',download_url:'https://video.test/fallback.mp4'
}),'https://video.test/fallback.mp4');

const events=[],calls=[],submitOps=[];
let documentVersion=0;
const remoteFetch=async(url,options={})=>{
  const target=new URL(url);
  const method=options.method||'GET';
  calls.push(method+' '+target.hostname+target.pathname);
  if(target.pathname==='/'){
    return new Response('home',{headers:{'set-cookie':'__anon=test-guest; Path=/'}});
  }
  if(target.pathname==='/alice/resource/prepare_upload'){
    assert.match(options.headers.cookie||'',/__anon=test-guest/);
    return json({code:0,data:{service_id:'svc',upload_host:'upload.test',
      upload_auth_token:{access_key:'AK',secret_key:'SK',session_token:'TOKEN'}}});
  }
  if(target.pathname==='/top/v1'){
    assert.match(options.headers.authorization,/AWS4-HMAC-SHA256/);
    assert.match(target.search,/Action=ApplyImageUpload/);
    return json({Result:{UploadAddress:{StoreInfos:[{
      StoreUri:'images/test.png',Auth:'signed-upload'}],
      UploadHosts:['upload.test'],SessionKey:'key'}}});
  }
  if(target.hostname==='upload.test'){
    assert.equal(method,'POST');
    assert.equal(options.headers.authorization,'signed-upload');
    assert.equal(options.headers['content-crc32'],crc32(image));
    assert.deepEqual(Buffer.from(options.body),image);
    assert.equal(options.headers.cookie,undefined,'do not leak Doubao cookie to upload host');
    return json({code:2000});
  }
  if(target.pathname==='/alice/resource/register'){
    const payload=JSON.parse(options.body);
    assert.equal(payload.resource_list[0].meta.image_meta.image_info.width,1);
    return json({code:0,data:{}});
  }
  if(target.pathname==='/alice/resource/v2/sign_url'){
    return json({code:0,data:[{param:{uri:'images/test.png'},
      main_url:'https://image.test/reference.png'}]});
  }
  if(target.pathname.endsWith('/doc/create')){
    return json({code:0,data:{snapshot:{canvas_workspace_id:'workspace-1'},
      conversation_id:'conversation-1'}});
  }
  if(target.pathname.endsWith('/doc/get')){
    documentVersion++;
    return json({code:0,data:{idgen_session:'idgen',
      snapshot:{version:documentVersion,doc:{items:
        documentVersion>=4?{'node-idgen-0202':{
          id:'node-idgen-0202',asset:{asset_key:'video-123',
            video_info:{vid:'video-123',video_model:{video_list:{
              '720p':{main_url:Buffer.from('https://video.test/file.mp4')
                .toString('base64')}
            }}}}
        }}:{}}}}});
  }
  if(target.pathname.endsWith('/doc/actions')){
    const payload=JSON.parse(options.body).req;
    assert.equal(payload.actions[0].type,101);
    assert.equal(payload.actions[0].target_item.type,102);
    return json({code:0,data:{results:[{result_msg:'success',
      result_item:{...payload.actions[0].target_item,id:'node-idgen-0202'}}]}});
  }
  if(target.pathname.endsWith('/tool/exec')){
    const operation=JSON.parse(options.body).req.execute_request.operation;
    submitOps.push(operation);
    return json({code:0,data:{}});
  }
  if(target.hostname==='video.test'){
    assert.equal(options.headers.cookie,undefined,
      'Anonymous session cookies must not be sent to video CDN');
    return new Response(mockVideo,{status:200,
      headers:{'content-length':String(mockVideo.length)}});
  }
  throw new Error('Unexpected request '+method+' '+target);
};

let server;
try{
  const client=new DoubaoCanvasClient({
    fetchImpl:remoteFetch,onStage:(message,progress)=>events.push({message,progress}),
    pollMs:1
  });
  await assert.rejects(client.downloadVideo('http://127.0.0.1/private',uploadDir),
    /无效的外部资源地址/);
  const result=await client.generateOnce({prompt:'猫跑过庭院 @图片1',
    images:[source],duration:8,ratio:'9:16',uploadDir});
  assert.match(result,/^\/api\/uploads\/[0-9a-f-]+\.mp4$/);
  assert.deepEqual(fs.readFileSync(path.join(uploadDir,path.basename(result))),mockVideo);
  assert.equal(submitOps.length,1);
  assert.equal(submitOps[0].use_model,'seedance_v2.0');
  assert.equal(submitOps[0].canvas_type,50);
  assert.deepEqual(submitOps[0].video_param,{duration:8,ratio:'9:16'});
  assert.equal(submitOps[0].attachments[0].prompt_placeholder,'{{ref:1}}');
  assert.equal(submitOps[0].attachments[0].image.uri,'images/test.png');
  assert.equal(Object.hasOwn(submitOps[0].video_param,'target_resolution'),false);
  assert.equal(calls.filter(call=>call.includes('tool/exec')).length,1);
  assert.ok(events.some(event=>event.message.includes('上传参考图')));

  const app=express();
  app.use(express.json());
  let projects=[{id:'project-1',title:'Video',nodes:[
    {id:'image',data:{kind:'image',title:'参考图',mediaUrl:'/api/uploads/'+
      path.basename(source)}},
    {id:'video',data:{kind:'video',provider:'doubao-canvas',
      prompt:'生成 @图片1',ratio:'9:16',duration:'8s'}},
    {id:'cancel',data:{kind:'video',provider:'doubao-canvas',
      prompt:'取消测试',ratio:'9:16',duration:'8s'}},
    {id:'image-second',data:{kind:'image',title:'第二张',mediaUrl:'/api/uploads/'+
      path.basename(source2)}},
    {id:'image-third',data:{kind:'image',title:'第三张',mediaUrl:'/api/uploads/'+
      path.basename(source3)}}
  ],edges:[{source:'image',target:'video'},
    {source:'image-second',target:'video'},
    {source:'image-third',target:'video'}]}];
  const payloads=[];
  const bridge=mountDoubaoCanvasRoutes(app,()=>structuredClone(projects),
    value=>{projects=structuredClone(value);},{
      dataDir,uploadDir,clientFactory:({signal,onStage})=>({
        generateOnce:async payload=>{
          payloads.push(payload);
          onStage('任务模拟运行中',70);
          if(payload.prompt==='取消测试'){
            await new Promise((_,reject)=>{
              if(signal.aborted)return reject(new Error('cancelled'));
              signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});
            });
          }
          const dest=crypto.randomUUID()+'.mp4';
          fs.writeFileSync(path.join(uploadDir,dest),mockVideo);
          return '/api/uploads/'+dest;
        }
      })
    });
  server=await new Promise(resolve=>{
    const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));
  });
  const root='http://127.0.0.1:'+server.address().port;
  const post=async(body)=>fetch(root+'/api/doubao-canvas/jobs',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(body)
  });
  const invalid=await post({projectId:'project-1',nodeId:'video',
    prompt:'生成 @图片1',duration:'11s',ratio:'9:16',references:[{id:'image'}]});
  assert.equal(invalid.status,400);
  assert.equal(bridge.jobs.size,0);
  const submitted=await post({projectId:'project-1',nodeId:'video',
    prompt:'生成 @图片1',duration:'8s',ratio:'9:16',references:[{id:'image'}]});
  assert.equal(submitted.status,201);
  const job=await submitted.json();
  for(let i=0;i<80&&bridge.jobs.get(job.id)?.status!=='completed';i++)
    await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(bridge.jobs.get(job.id).status,'completed');
  assert.ok(bridge.jobs.get(job.id).steps.length>=2,
    'Canvas jobs should persist their generation log');
  assert.match(bridge.jobs.get(job.id).steps.at(-1).message,/已保存/);
  assert.equal(payloads[0].images[0],source);
  assert.equal(payloads[0].prompt,'生成 {{ref:1}}');
  assert.match(projects[0].nodes[1].data.mediaUrl,/^\/api\/uploads\/.*\.mp4$/);
  assert.equal(projects[0].nodes[1].data.status,'done');
  assert.ok(projects[0].nodes[1].data.jobLogs.length>=2);
  const multi=await post({projectId:'project-1',nodeId:'video',
    prompt:'先看 @图片3，再看 @图片2，重复 @图片3',duration:'8s',
    ratio:'9:16',references:[{id:'image-second'},{id:'image-third'}]});
  assert.equal(multi.status,201);
  const multiJob=await multi.json();
  for(let i=0;i<80&&bridge.jobs.get(multiJob.id)?.status!=='completed';i++)
    await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(bridge.jobs.get(multiJob.id).status,'completed');
  assert.deepEqual(payloads[1].images,[source2,source3]);
  assert.equal(payloads[1].prompt,
    '先看 {{ref:2}}，再看 {{ref:1}}，重复 {{ref:2}}');
  assert.equal(projects[0].nodes[1].data.prompt,'生成 @图片1',
    'Remote placeholders must not overwrite editor text');
  const singleSecond=await post({projectId:'project-1',nodeId:'video',
    prompt:'只用 @图片2',duration:'8s',ratio:'9:16',
    references:[{id:'image-second'}]});
  assert.equal(singleSecond.status,201);
  const singleSecondJob=await singleSecond.json();
  for(let i=0;i<80&&bridge.jobs.get(singleSecondJob.id)?.status!=='completed';i++)
    await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(bridge.jobs.get(singleSecondJob.id).status,'completed');
  assert.deepEqual(payloads[2].images,[source2]);
  assert.equal(payloads[2].prompt,'只用 {{ref:1}}');
  const stopped=await post({projectId:'project-1',nodeId:'cancel',
    prompt:'取消测试',duration:'8s',ratio:'9:16',references:[]});
  assert.equal(stopped.status,201);
  const cancelled=await stopped.json();
  const stopResponse=await fetch(root+'/api/doubao-canvas/jobs/'+cancelled.id+'/cancel',{
    method:'POST'
  });
  assert.equal(stopResponse.status,200);
  assert.equal(bridge.jobs.get(cancelled.id).status,'interrupted');
  console.log('PASS: ImageX signature, CRC32, uploads, Canvas document protocol, Seedance submit, MP4 download, local jobs and cancel');
}finally{
  if(server)await new Promise(resolve=>server.close(resolve));
  fs.rmSync(scratch,{recursive:true,force:true});
}
