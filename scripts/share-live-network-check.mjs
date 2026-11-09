import assert from 'node:assert/strict';

const api='http://127.0.0.1:3701';
const json=body=>({
  method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify(body)
});
let project;
let started=false;
try{
  const health=await fetch(api+'/api/health').then(reply=>reply.json());
  assert.equal(health.lanShareRevision,'sse-collab-v1');
  const response=await fetch(api+'/api/projects',json({
    title:'TEMP LAN share connectivity test',
    nodes:[],edges:[],groups:[]
  }));
  assert.equal(response.status,201);
  project=await response.json();
  const begin=await fetch(api+'/api/share/start',json({
    projectId:project.id,clientId:'lan-connectivity-check'
  }));
  assert.equal(begin.status,200);
  started=true;
  const session=await begin.json();
  assert.match(session.code,/^\d{5}$/);
  assert.ok(session.links.some(link=>/192\.168\.|10\.|172\./.test(link)));
  const link=session.links.find(value=>/192\.168\./.test(value))||session.links[0];
  const base=new URL(link).origin;
  const responseInfo=await fetch(base+'/api/share/info',{
    signal:AbortSignal.timeout(5000)
  });
  assert.equal(responseInfo.status,200);
  assert.equal((await responseInfo.json()).role,'join');
  const joined=await fetch(base+'/api/share/join',json({code:session.code}));
  assert.equal(joined.status,200);
  const cookie=joined.headers.get('set-cookie').split(';')[0];
  const shared=await fetch(base+'/api/projects/'+project.id,{
    headers:{cookie},signal:AbortSignal.timeout(5000)
  });
  assert.equal(shared.status,200);
  assert.equal((await shared.json()).id,project.id);
  console.log('PASS: actual LAN interface reachable:',base,
    'five-digit join successful, shared project available');
}finally{
  if(started)await fetch(api+'/api/share/stop',json({clientId:'lan-connectivity-check'}));
  if(project)await fetch(api+'/api/projects/'+project.id,{method:'DELETE'});
}
