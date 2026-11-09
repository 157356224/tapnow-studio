import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mountShareRoutes} from '../server/share.mjs';
import {diffCanvas,snapshotCanvas} from '../src/share-sync.mjs';

const project={
  id:'host-media-test',title:'素材回传测试',
  nodes:[
    {id:'img',type:'studio',position:{x:10,y:20},
      data:{kind:'image',title:'图片',prompt:'生成图片'}},
    {id:'vid',type:'studio',position:{x:300,y:20},
      data:{kind:'video',title:'视频',prompt:'生成视频'}}
  ],
  edges:[],groups:[],groupColorCursor:0,
  viewport:{x:0,y:0,zoom:1},updatedAt:new Date().toISOString()
};
let saved=[project];
const read=()=>structuredClone(saved);
const write=value=>{saved=structuredClone(value);};
const upstream=express();
upstream.use(express.json({limit:'15mb'}));
const jobs=[];
for(const [provider,nodeId,extension] of [
  ['muse','img','jpg'],['doubao','vid','mp4']
]){
  upstream.post('/api/'+provider+'/jobs',(req,res)=>{
    jobs.push(req.body);
    const next=read();
    const node=next[0].nodes.find(item=>item.id===nodeId);
    node.data.mediaUrl='/api/uploads/guest-output.'+extension;
    node.data.status='done';
    write(next);
    res.status(202).json({id:'job-'+nodeId,status:'queued'});
  });
  upstream.get('/api/'+provider+'/jobs/job-'+nodeId,(_req,res)=>
    res.json({id:'job-'+nodeId,status:'completed'}));
}
upstream.get('/api/uploads/guest-output.jpg',(_req,res)=>
  res.type('image/jpeg').send(Buffer.from('HOST_IMAGE')));
upstream.get('/api/uploads/guest-output.mp4',(_req,res)=>
  res.type('video/mp4').send(Buffer.from('HOST_VIDEO')));
upstream.get('/api/chatgpt/accounts',(_req,res)=>res.json([
  {id:'account',name:'模型账号',hasCookie:true,accessToken:'not-for-guests'}
]));
const upstreamServer=await new Promise(resolve=>{
  const instance=upstream.listen(0,'127.0.0.1',()=>resolve(instance));
});
const app=express();
app.use(express.json());
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','server');
const shared=mountShareRoutes(app,{
  read,write,root,uploadDir:path.join(root,'uploads'),
  lanPort:0,upstreamPort:upstreamServer.address().port
});
const hostServer=await new Promise(resolve=>{
  const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));
});
try{
  const host='http://127.0.0.1:'+hostServer.address().port;
  const starter=await fetch(host+'/api/share/start',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({projectId:project.id,clientId:'host'})
  }).then(response=>response.json());
  const guest='http://127.0.0.1:'+shared.info().port;
  const joined=await fetch(guest+'/api/share/join',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({code:starter.code})
  });
  assert.equal(joined.status,200);
  const cookie=joined.headers.get('set-cookie').split(';')[0];
  const streamController=new AbortController();
  const stream=await fetch(guest+'/api/share/events',{
    headers:{cookie},signal:streamController.signal
  });
  assert.equal(stream.status,200);
  const reader=stream.body.getReader();
  const received=[];
  const collect=(async()=>{
    let pending='';
    while(received.length<20){
      const {done,value}=await reader.read();
      if(done)break;
      pending+=new TextDecoder().decode(value);
      const parts=pending.split('\n\n');
      pending=parts.pop()||'';
      for(const part of parts){
        const line=part.split('\n').find(row=>row.startsWith('data: '));
        if(line)received.push(JSON.parse(line.slice(6)));
        if(received.some(event=>
          event.project?.nodes?.some(node=>node.data.mediaUrl?.endsWith('.jpg'))&&
          event.project?.nodes?.some(node=>node.data.mediaUrl?.endsWith('.mp4'))))
          return;
      }
    }
  })().catch(error=>{if(!streamController.signal.aborted)throw error;});
  const send=async(path,body)=>{
    const response=await fetch(guest+path,{
      method:'POST',headers:{cookie,'content-type':'application/json'},
      body:JSON.stringify(body)
    });
    return {status:response.status,data:await response.json()};
  };
  const accountResponse=await fetch(guest+'/api/chatgpt/accounts',{
    headers:{cookie}
  });
  assert.equal(accountResponse.status,403,
    'Guests must never read host model account names or credentials');
  assert.equal((await send('/api/doubao/accounts',{role:'admin'})).status,403);
  assert.equal((await send('/api/doubao/jobs',{
    projectId:'unshared',nodeId:'vid'
  })).status,403);
  const image=await send('/api/muse/jobs',{
    projectId:project.id,nodeId:'img',prompt:'协作者请求图片'
  });
  const video=await send('/api/doubao/jobs',{
    projectId:project.id,nodeId:'vid',prompt:'协作者请求视频'
  });
  assert.equal(image.status,403);
  assert.equal(video.status,403);
  assert.equal(jobs.length,0,'User2 must never submit work to User1 API');
  // The guest's own local API would upload these generated files to the host.
  // Simulate the host's resulting canvas patch, then verify the guest receives
  // both files and the live SSE state without gaining account access.
  const before=snapshotCanvas(read()[0]);
  const completed=structuredClone(before);
  completed.nodes[0].data.mediaUrl='/api/uploads/guest-output.jpg';
  completed.nodes[0].data.status='done';
  completed.nodes[1].data.mediaUrl='/api/uploads/guest-output.mp4';
  completed.nodes[1].data.status='done';
  const patched=await fetch(host+'/api/share/patch',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({clientId:'host',patch:diffCanvas(before,completed)})
  });
  assert.equal(patched.status,200);
  assert.equal(read()[0].nodes[0].data.mediaUrl,'/api/uploads/guest-output.jpg');
  assert.equal(read()[0].nodes[1].data.mediaUrl,'/api/uploads/guest-output.mp4');
  for(const [file,expected] of [
    ['guest-output.jpg','HOST_IMAGE'],['guest-output.mp4','HOST_VIDEO']
  ]){
    const media=await fetch(guest+'/api/uploads/'+file,{headers:{cookie}});
    assert.equal(media.status,200);
    assert.equal(await media.text(),expected);
  }
  const guestProject=await fetch(guest+'/api/projects/'+project.id,{
    headers:{cookie}
  }).then(response=>response.json());
  assert.equal(guestProject.nodes[0].data.status,'done');
  assert.equal(guestProject.nodes[1].data.status,'done');
  let timer;
  try{
    await Promise.race([
      collect,new Promise((_,reject)=>{
        timer=setTimeout(()=>
          reject(new Error('Host media completion did not reach collaborator SSE')),4500);
      })
    ]);
  }finally{clearTimeout(timer);}
  assert.ok(received.some(event=>
    event.project?.nodes?.some(node=>node.data.mediaUrl?.endsWith('.jpg'))&&
    event.project?.nodes?.some(node=>node.data.mediaUrl?.endsWith('.mp4'))),
    'both completed media assets must arrive through the live event stream');
  streamController.abort();
  console.log('PASS: host generation endpoints denied, shared media downloads and live SSE updates');
}finally{
  await shared.stop().catch(()=>{});
  await new Promise(resolve=>hostServer.close(resolve));
  await new Promise(resolve=>upstreamServer.close(resolve));
}
