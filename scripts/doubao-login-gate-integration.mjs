// Optional integration test: creates a temporary guest browser account, then
// verifies that Send opens Edge and STOPS at login (no media generation).
// Requires the development API running locally. Does not use real credentials.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const root='http://127.0.0.1:3701/api';
const json=body=>({method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify(body)});
let accountId,projectId;
try{
  const accountResponse=await fetch(root+'/doubao/accounts',
    json({name:'TEMP_AUTOMATED_LOGIN_GATE_'+crypto.randomUUID().slice(0,8)}));
  assert.equal(accountResponse.status,201);
  const account=await accountResponse.json();
  accountId=account.id;
  assert.equal(account.hasCookie,false);

  const projectResponse=await fetch(root+'/projects',json({
    title:'TEMP_AUTOMATED_LOGIN_GATE',
    nodes:[{
      id:'video-test',type:'studio',position:{x:0,y:0},
      data:{kind:'video',title:'Video',model:'Seedance 2.0 Fast',
        ratio:'3:4',duration:'10s',prompt:'临时登陆检测，不发送给豆包'}
    }],edges:[],viewport:{x:0,y:0,zoom:1}
  }));
  assert.equal(projectResponse.status,201);
  projectId=(await projectResponse.json()).id;

  const started=await fetch(root+'/doubao/jobs',json({
    accountId,projectId,nodeId:'video-test',
    prompt:'临时登陆检测，不发送给豆包',
    model:'Seedance 2.0 Fast',ratio:'3:4',duration:'10s',
    references:[]
  }));
  assert.equal(started.status,202);
  const jobId=(await started.json()).id;
  let latest,opened=false;
  for(let i=0;i<30;i++){
    await new Promise(resolve=>setTimeout(resolve,1100));
    latest=await fetch(root+'/doubao/jobs/'+jobId).then(r=>r.json());
    const state=await fetch(root+'/doubao/accounts/'+accountId+'/status').then(r=>r.json());
    opened ||= state.browserOpen;
    if(['needs-login','needs-attention','completed'].includes(latest.status))break;
  }
  assert.equal(opened,true,'Account Edge should open immediately upon submission');
  assert.equal(latest.status,'needs-login','Guest account must stop before sending a generation request');
  assert.equal(latest.progress,0,'Login-required status must not display stuck 10%');
  assert.match(latest.message,/登录/);
  const project=await fetch(root+'/projects/'+projectId).then(r=>r.json());
  const node=project.nodes.find(x=>x.id==='video-test');
  assert.equal(node.data.status,'error');
  assert.match(node.data.jobMessage,/登录/);
  console.log('PASS: Send opens isolated Edge immediately, login gate blocks generation, video node shows error instead of 10%');
}finally{
  if(accountId)await fetch(root+'/doubao/accounts/'+accountId,{method:'DELETE'});
  if(projectId)await fetch(root+'/projects/'+projectId,{method:'DELETE'});
}
