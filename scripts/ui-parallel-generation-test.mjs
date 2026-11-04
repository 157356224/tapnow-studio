// Browser integration: long-running mock jobs on one node must NOT block
// submission from another image/video node or another provider.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const url=process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5173/';
const accountIds={
  muse1:'11111111-1111-4111-8111-111111111111',
  muse2:'22222222-2222-4222-8222-222222222222',
  doubao1:'33333333-3333-4333-8333-333333333333',
  doubao2:'44444444-4444-4444-8444-444444444444'
};
const project={
  id:'parallel-ui-test',title:'Parallel generation regression',
  updatedAt:new Date().toISOString(),
  viewport:{x:70,y:70,zoom:.8},
  nodes:[
    {id:'muse-image-1',type:'studio',position:{x:50,y:75},data:{
      kind:'image',title:'Muse image 1',prompt:'蓝色的猫',provider:'muse',
      museAccountId:'auto',ratio:'3:4',resolution:'2K',status:'idle'
    }},
    {id:'muse-image-2',type:'studio',position:{x:1050,y:75},data:{
      kind:'image',title:'Muse image 2',prompt:'红色的狗',provider:'muse',
      museAccountId:'auto',ratio:'3:4',resolution:'2K',status:'idle'
    }},
    {id:'doubao-video-1',type:'studio',position:{x:50,y:1200},data:{
      kind:'video',title:'Doubao video 1',prompt:'镜头向前移动',provider:'doubao',
      accountId:accountIds.doubao1,model:'Seedance 2.0 Mini',
      ratio:'16:9',duration:'10s',status:'idle'
    }},
    {id:'doubao-video-2',type:'studio',position:{x:1150,y:1200},data:{
      kind:'video',title:'Doubao video 2',prompt:'镜头向后移动',provider:'doubao',
      accountId:accountIds.doubao2,model:'Seedance 2.0 Fast',
      ratio:'16:9',duration:'10s',status:'idle'
    }}
  ],
  edges:[]
};
const submitted=[],putOrder=[];
let simultaneousSaves=0,maxSaves=0;
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:2400,height:1900}});
page.setDefaultTimeout(9000);
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
const respond=(route,data,status=200)=>route.fulfill({
  status,contentType:'application/json',body:JSON.stringify(data)
});
try{
  await page.route('**/api/**',async route=>{
    const req=route.request(),endpoint=new URL(req.url()).pathname;
    if(endpoint==='/api/health')return respond(route,{
      museBridgeRevision:'quota-auto-v6-image-resolution',
      museMediaRevision:'fresh-chat-media-v2',
      referenceSelectionRevision:'at-order-v2',
      videoModelRevision:'mini-fast-v1',
      videoStartRevision:'reply-prefix-v1',
      videoDownloadRevision:'completed-card-v1',
      multiImageUploadRevision:'v3-prompt-first'
    });
    if(endpoint==='/api/projects')
      return respond(route,[{id:project.id,title:project.title,
        updatedAt:project.updatedAt}]);
    if(endpoint==='/api/projects/'+project.id){
      if(req.method()==='PUT'){
        const index=putOrder.length;
        putOrder.push({index,stage:'start'});
        simultaneousSaves++;
        maxSaves=Math.max(maxSaves,simultaneousSaves);
        // Deliberately slow the saves. A race-prone frontend would overlap.
        await new Promise(resolve=>setTimeout(resolve,170));
        const body=req.postDataJSON();
        project.nodes=body.nodes;
        project.edges=body.edges;
        simultaneousSaves--;
        putOrder.push({index,stage:'done'});
        return respond(route,{id:project.id,updatedAt:new Date().toISOString()});
      }
      return respond(route,project);
    }
    if(endpoint==='/api/muse/accounts')
      return respond(route,[accountIds.muse1,accountIds.muse2].map((id,i)=>({
        id,name:'Muse '+(i+1),createdAt:new Date().toISOString(),browserEngine:'edge'
      })));
    if(endpoint==='/api/doubao/accounts')
      return respond(route,[accountIds.doubao1,accountIds.doubao2].map((id,i)=>({
        id,name:'Doubao '+(i+1),hasCookie:false,createdAt:new Date().toISOString()
      })));
    if(endpoint==='/api/muse/quotas')return respond(route,{
      totalAccounts:2,knownAccounts:2,unknownAccounts:0,
      totalCapacity:200,measuredCapacity:200,totalUsed:20,totalRemaining:180,
      refreshing:false,rows:[]
    });
    if(endpoint==='/api/muse/jobs'||endpoint==='/api/doubao/jobs'){
      if(req.method()==='POST'){
        const payload=req.postDataJSON();
        submitted.push({provider:endpoint.includes('muse')?'muse':'doubao',...payload});
        return respond(route,{id:'mock-job-'+submitted.length,
          accountId:payload.accountId,status:'queued',
          message:'Mock job active; generation is intentionally unfinished'
        },202);
      }
    }
    if(/^\/api\/(muse|doubao)\/jobs\/mock-job-\d+$/.test(endpoint))
      return respond(route,{id:endpoint.split('/').at(-1),status:'running',
        progress:22,message:'First task is still running'});
    return respond(route,[]);
  });

  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.locator('.react-flow__node[data-id="doubao-video-2"]')
    .waitFor({state:'visible',timeout:18000});
  await page.waitForTimeout(500);
  for(const nodeId of ['muse-image-1','muse-image-2',
    'doubao-video-1','doubao-video-2']){
    const frame=page.locator('.react-flow__node[data-id="'+nodeId+'"] .tn-node-frame');
    await frame.click();
    const editor=page.locator('.floating-compose:not(.tn-editor-closing)');
    await editor.locator('.tn-submit').click();
    // The next click occurs while previous job GET continues reporting
    // 'running'; the UI may not wait for that job to complete.
    const expected=['muse-image-1','muse-image-2',
      'doubao-video-1','doubao-video-2'].indexOf(nodeId)+1;
    for(let n=0;n<24&&submitted.length<expected;n++)
      await page.waitForTimeout(80);
    assert.equal(submitted.length,expected,
      'Submission of '+nodeId+' must not wait for earlier active jobs');
  }
  assert.deepEqual(submitted.map(x=>x.provider),['muse','muse','doubao','doubao']);
  assert.deepEqual(submitted.filter(x=>x.provider==='muse').map(x=>x.accountId),
    ['auto','auto'],'Muse should pass auto assignment to the backend');
  assert.deepEqual(submitted.filter(x=>x.provider==='doubao').map(x=>x.accountId),
    [accountIds.doubao1,accountIds.doubao2],
    'Doubao must respect the explicitly selected account per node');
  assert.equal(maxSaves,1,
    'Full-project saves must serialize instead of racing across submissions');
  assert.deepEqual(errors,[]);
  console.log('PASS: 2 Muse images + 2 Doubao videos submitted while previous jobs still running; correct account selection and serialized project saves');
}finally{
  await browser.close();
}
