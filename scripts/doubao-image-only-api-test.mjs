// Exercises real local API rejection BEFORE any browser is launched. It never
// attempts a valid generation request and needs no authentication.
import assert from 'node:assert/strict';

const api='http://127.0.0.1:3701/api';
const post=async(url,body)=>{
  const r=await fetch(api+url,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body)
  });
  return {status:r.status,body:await r.json()};
};
let accountId,projectId;
try{
  const account=await post('/doubao/accounts',{
    name:'TEMP_IMAGE_ONLY_TEST'
  });
  assert.equal(account.status,201);
  accountId=account.body.id;
  const project=await post('/projects',{
    title:'TEMP_IMAGE_ONLY_TEST',
    nodes:[
      {id:'video',type:'studio',position:{x:0,y:0},data:{
        kind:'video',model:'Seedance 2.0 Fast',prompt:'云层移动',ratio:'3:4',duration:'10s'
      }},
      {id:'audio',type:'studio',position:{x:20,y:20},data:{
        kind:'audio',mediaUrl:'/api/uploads/fake.mp3'
      }},
      {id:'video-source',type:'studio',position:{x:20,y:25},data:{
        kind:'video',mediaUrl:'/api/uploads/fake.mp4'
      }},
      {id:'image',type:'studio',position:{x:20,y:30},data:{
        kind:'image',mediaUrl:'https://example.org/not-local.jpg'
      }}
    ],
    edges:[]
  });
  assert.equal(project.status,201);
  projectId=project.body.id;
  for(const refId of ['audio','video-source']){
    const result=await post('/doubao/jobs',{
      accountId,projectId,nodeId:'video',prompt:'云层移动',
      ratio:'3:4',duration:'10s',references:[{id:refId}]
    });
    assert.equal(result.status,400,'Non-image reference must be rejected');
    assert.match(result.body.error,/必须与输入框 @图片/);
  }
  const external=await post('/doubao/jobs',{
    accountId,projectId,nodeId:'video',prompt:'云层移动',
    ratio:'3:4',duration:'10s',references:[{id:'image'}]
  });
  assert.equal(external.status,400,'Remote/nonlocal image must be uploaded first');
  assert.match(external.body.error,/必须与输入框 @图片/);
  console.log('PASS: audio/video reference and external image rejected before starting any Chromium job');
}finally{
  if(projectId)await fetch(api+'/projects/'+projectId,{method:'DELETE'});
  if(accountId)await fetch(api+'/doubao/accounts/'+accountId,{method:'DELETE'});
}
