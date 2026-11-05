import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {
  mountH3Routes,H3_MODELS,buildH3Generation,validateH3Parameters,
  estimateH3Credits
} from '../server/yuanbo-h3.mjs';

assert.deepEqual(H3_MODELS,['h3-video','h3-video-flex','h3-video-frames']);
assert.throws(()=>validateH3Parameters('h3-video-frames',16,'768p','16:9'),/4–15/);
assert.throws(()=>validateH3Parameters('h3-video',12,'1080p','21:9'),/最长 10/);
assert.throws(()=>validateH3Parameters('h3-video',6,'720p','1:1'),/720p/);
assert.throws(()=>buildH3Generation({
  model:'h3-video-frames',prompt:'frame test',
  parameters:{duration:6,resolution:'768p',aspect_ratio:'16:9'},inputs:[]
}),/首帧或尾帧/);

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tapnow-yuanbo-h3-'));
const dataDir=path.join(dir,'data'),uploadDir=path.join(dir,'uploads');
fs.mkdirSync(dataDir);fs.mkdirSync(uploadDir);
const first=crypto.randomUUID()+'.png',last=crypto.randomUUID()+'.png';
const audio=crypto.randomUUID()+'.mp3';
fs.writeFileSync(path.join(uploadDir,first),Buffer.from('fake-png-first'));
fs.writeFileSync(path.join(uploadDir,last),Buffer.from('fake-png-last'));
fs.writeFileSync(path.join(uploadDir,audio),Buffer.from('fake-audio'));
const project={
  id:crypto.randomUUID(),title:'Test H3',updatedAt:new Date().toISOString(),
  nodes:[
    {id:'image-first',data:{kind:'image',title:'First',mediaUrl:'/api/uploads/'+first}},
    {id:'image-last',data:{kind:'image',title:'Last',mediaUrl:'/api/uploads/'+last}},
    {id:'music',data:{kind:'audio',title:'Music',mediaUrl:'/api/uploads/'+audio}},
    {id:'h3-video',data:{kind:'video',provider:'h3',model:'h3-video',
      prompt:'A sweeping cinematic shot',duration:'6s',resolution:'768p',ratio:'16:9'}},
    {id:'h3-flex',data:{kind:'video',provider:'h3',model:'h3-video-flex',
      prompt:'A story with @图片1 and @音频1',duration:'6s',
      resolution:'768p',ratio:'16:9'}},
    {id:'h3-frames',data:{kind:'video',provider:'h3',model:'h3-video-frames',
      prompt:'Animate between the frames',duration:'6s',resolution:'768p',
      ratio:'16:9',h3FirstFrameId:'image-first',h3LastFrameId:'image-last'}}
  ],
  edges:[
    {source:'image-first',target:'h3-flex'},
    {source:'music',target:'h3-flex'},
    {source:'image-first',target:'h3-frames'},
    {source:'image-last',target:'h3-frames'}
  ]
};
let projects=[project];
const uploads=[],creations=[],calls=[],putBodies=[];
const checkHeader=(options)=>assert.equal(
  options.headers?.Authorization,'Bearer sc_live_local_test_key');
const json=(value,status=200)=>new Response(JSON.stringify(value),{
  status,headers:{'content-type':'application/json'}
});
const remoteFetch=async(url,options={})=>{
  const target=new URL(url),method=options.method||'GET';
  calls.push(method+' '+target.pathname);
  if(target.hostname==='signed.test'){
    assert.equal(method,'PUT');
    assert.equal(options.headers['x-signed-test'],'ok');
    putBodies.push(Buffer.from(options.body));
    return new Response('',{status:200});
  }
  if(target.hostname==='video-cdn.test'){
    assert.equal(method,'GET');
    return new Response(Buffer.from('synthetic mp4 bytes'),{
      status:200,headers:{'Content-Length':'19'}
    });
  }
  checkHeader(options);
  if(target.pathname.endsWith('/models')){
    return json({data:H3_MODELS.map((id,index)=>({
      id,pricing:{
        minimumCredits:6,promptOptimizationCredits:5,
        perSecond:[
          {resolution:'480p',credits:1.5},
          {resolution:'768p',credits:3.5+index},
          {resolution:'1080p',credits:8.5}
        ],
        perOutput:[]
      }
    }))});
  }
  if(target.pathname.endsWith('/uploads')&&method==='POST'){
    const body=JSON.parse(options.body);
    assert.equal(body.byte_length,body.filename.endsWith('.png')?
      (body.filename===first?14:13):10);
    const id='asset-'+(uploads.length+1);
    uploads.push({...body,id});
    return json({asset_id:id,state:'UPLOADING',reused:false,
      upload:{url:'https://signed.test/upload/'+id,
        headers:{'x-signed-test':'ok'}}},201);
  }
  if(target.pathname.endsWith('/complete')&&method==='POST'){
    return json({state:'READY'});
  }
  if(target.pathname.endsWith('/generations')&&method==='POST'){
    const request=JSON.parse(options.body);
    assert.ok(H3_MODELS.includes(request.model));
    assert.match(options.headers['Idempotency-Key'],/^[a-f0-9-]{36}$/i);
    creations.push(request);
    return json({id:'remote-'+creations.length,status:'queued'},201);
  }
  const match=target.pathname.match(/\/generations\/(remote-\d+)$/);
  if(match){
    return json({id:match[1],status:'succeeded',outputs:[{
      media_type:'video',byte_length:19,
      download_url:'https://video-cdn.test/output.mp4'
    }]});
  }
  throw new Error('Unexpected upstream request '+url);
};
const app=express();
app.use(express.json());
const allowedHosts=['127.0.0.1:3701'];
mountH3Routes(app,()=>projects,items=>{projects=items;},{
  dataDir,uploadDir,fetchImpl:remoteFetch,
  baseUrl:'https://mock.yuanbo.test/api/open/v1',
  pollMs:1,wait:async()=>{},allowedHosts
});
const server=await new Promise(resolve=>{
  const active=app.listen(0,'127.0.0.1',()=>resolve(active));
});
const root='http://127.0.0.1:'+server.address().port;
allowedHosts.push('127.0.0.1:'+server.address().port);
const headers={'Content-Type':'application/json','Host':'127.0.0.1:3701'};
const req=async(route,method='GET',body)=>{
  const result=await fetch(root+route,{method,
    headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:result.status,body:await result.json()};
};
try{
  const empty=await req('/api/h3/config');
  assert.equal(empty.status,200,JSON.stringify(empty.body));
  assert.equal(empty.body.configured,false);
  const saved=await req('/api/h3/config','PUT',{
    apiKey:'sc_live_local_test_key'
  });
  assert.equal(saved.body.configured,true);
  assert.equal(JSON.stringify(saved.body).includes('sc_live_local_test_key'),false);
  const models=await req('/api/h3/models');
  assert.equal(models.status,200);
  assert.equal(models.body.models.length,3);
  assert.deepEqual(estimateH3Credits(models.body.models,{
    model:'h3-video',duration:6,resolution:'768p',ratio:'16:9'
  }),{
    model:'h3-video',duration:6,resolution:'768p',
    videoCredits:21,optimizationCredits:0,
    credits:21,yuan:0.21,estimated:true,source:'yuanbo-models'
  });
  const quoted=await req('/api/h3/estimate?model=h3-video&duration=6&resolution=768p&ratio=16%3A9');
  assert.equal(quoted.status,200,JSON.stringify(quoted.body));
  assert.equal(quoted.body.credits,21);
  assert.equal(quoted.body.yuan,0.21);
  const optimized=await req('/api/h3/estimate?model=h3-video-flex&duration=6&resolution=768p&ratio=16%3A9&optimizePrompt=true');
  assert.equal(optimized.status,200);
  assert.equal(optimized.body.videoCredits,27);
  assert.equal(optimized.body.optimizationCredits,5);
  assert.equal(optimized.body.credits,32);
  assert.equal(optimized.body.yuan,0.32);
  const floor=await req('/api/h3/estimate?model=h3-video-frames&duration=4&resolution=480p&ratio=9%3A16');
  assert.equal(floor.status,200);
  assert.equal(floor.body.credits,6,'Minimum credits must apply');
  const invalidQuote=await req('/api/h3/estimate?model=h3-video&duration=6&resolution=720p&ratio=1%3A1');
  assert.equal(invalidQuote.status,400);
  assert.equal(models.body.models.length,3);
  const blocked=await req('/api/h3/jobs','POST',{
    projectId:project.id,nodeId:'not-h3-node',references:[]
  });
  assert.equal(blocked.status,400,'Invalid node ID must be rejected');
  for(const [nodeId,refs] of [
    ['h3-video',[]],
    ['h3-flex',[{id:'image-first'},{id:'music'}]],
    ['h3-frames',[]]
  ]){
    const response=await req('/api/h3/jobs','POST',{
      projectId:project.id,nodeId,references:refs
    });
    assert.equal(response.status,202,JSON.stringify(response.body));
    const id=response.body.id;
    let done;
    for(let i=0;i<100;i++){
      await new Promise(resolve=>setTimeout(resolve,10));
      done=(await req('/api/h3/jobs/'+id)).body;
      if(['completed','failed'].includes(done.status))break;
    }
    assert.equal(done.status,'completed',JSON.stringify(done));
    assert.ok(done.videoUrl.startsWith('/api/uploads/'));
    assert.equal(fs.readFileSync(path.join(uploadDir,path.basename(done.videoUrl)),
      'utf8'),'synthetic mp4 bytes');
    assert.equal(projects[0].nodes.find(n=>n.id===nodeId).data.mediaUrl,done.videoUrl,
      'Backend must persist generated video into correct canvas node');
  }
  assert.deepEqual(creations.map(item=>item.model),H3_MODELS);
  assert.equal(creations[0].inputs,undefined);
  assert.deepEqual(creations[1].inputs.map(ref=>ref.role),
    ['reference_image','reference_audio']);
  assert.equal(creations[2].mode,'frames_to_video');
  assert.deepEqual(creations[2].inputs.map(ref=>ref.role),[
    'first_frame','last_frame'
  ]);
  assert.equal(putBodies.length,4);
  assert.equal(uploads.length,4);
  const keyFile=fs.readFileSync(path.join(dataDir,'yuanbo-h3-config.json'),'utf8');
  assert.ok(keyFile.includes('sc_live_local_test_key'));
  const jobfile=fs.readFileSync(path.join(dataDir,'yuanbo-h3-jobs.json'),'utf8');
  assert.equal(jobfile.includes('sc_live_local_test_key'),false);
  console.log('PASS: live-model-style H3 pricing by model, resolution, duration, minimum and optimization + 3 models API generation, assets and canvas persistence');
}finally{
  await new Promise(resolve=>server.close(resolve));
  fs.rmSync(dir,{recursive:true,force:true});
}
