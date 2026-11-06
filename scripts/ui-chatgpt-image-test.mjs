import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const base=process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5173/';
const now=new Date().toISOString();
const project={
  id:'chatgpt-ui-test',title:'ChatGPT image progress',
  updatedAt:now,viewport:{x:120,y:150,zoom:1},
  nodes:[
    {id:'chatgpt-image',type:'studio',position:{x:170,y:80},
      data:{kind:'image',title:'进度测试',provider:'muse',
        prompt:'画一只橘猫',ratio:'2:3',resolution:'2K',status:'idle'}},
    {id:'muse-image',type:'studio',position:{x:740,y:80},
      data:{kind:'image',title:'Muse 图片',provider:'muse',
        prompt:'参考场景',ratio:'2:3',resolution:'2K',status:'idle'}}
  ],edges:[]
};
const errors=[];let submitted=0,polls=0;
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1750,height:980}});
page.setDefaultTimeout(10000);
page.on('pageerror',error=>errors.push(error.message));
const send=(route,data,status=200)=>route.fulfill({
  status,contentType:'application/json',body:JSON.stringify(data)
});
try{
  await page.route('**/api/**',async route=>{
    const req=route.request(),pathname=new URL(req.url()).pathname;
    if(pathname==='/api/projects')
      return send(route,[{id:project.id,title:project.title,updatedAt:now}]);
    if(pathname==='/api/projects/'+project.id){
      if(req.method()==='PUT'){
        const fresh=req.postDataJSON();
        project.nodes=fresh.nodes;project.edges=fresh.edges;
        return send(route,{id:project.id,updatedAt:now});
      }
      return send(route,project);
    }
    if(pathname==='/api/chatgpt/account')return send(route,{
      profileCreated:true,loginWindowOpen:false,browserOpen:false,jobsRunning:0
    });
    if(pathname==='/api/chatgpt/jobs'&&req.method()==='POST'){
      const body=req.postDataJSON();
      assert.equal(body.nodeId,'chatgpt-image');
      assert.equal(body.prompt,'画一只橘猫');
      submitted++;
      return send(route,{id:'mock-chatgpt-job',status:'queued',
        progress:null,message:'任务已排队'},202);
    }
    if(pathname==='/api/chatgpt/jobs/mock-chatgpt-job'){
      polls++;
      if(polls<=4)return send(route,{
        id:'mock-chatgpt-job',status:'running',
        progress:70,message:'ChatGPT 生图 70%'
      });
      return send(route,{
        id:'mock-chatgpt-job',status:'completed',progress:100,
        message:'图片已回填',mediaUrl:'/api/uploads/mock-generated.png',
        mediaWidth:512,mediaHeight:512
      });
    }
    if(pathname==='/api/muse/quotas')return send(route,{
      totalAccounts:0,knownAccounts:0,unknownAccounts:0,
      totalUsed:0,totalRemaining:0,rows:[],refreshing:false
    });
    return send(route,[]);
  });
  await page.goto(base,{waitUntil:'domcontentloaded'});
  const node=page.locator('.react-flow__node[data-id="chatgpt-image"]');
  await node.waitFor({state:'visible',timeout:15000});
  await node.locator('.tn-node-caption').click();
  const compose=page.locator('.floating-compose:not(.tn-editor-closing)');
  await compose.waitFor({state:'visible'});
  const bar=compose.getByRole('group',{name:'图片生成服务'});
  assert.equal(await bar.getByRole('button',{name:'Muse 生图'}).getAttribute('aria-pressed'),
    'true');
  await bar.getByRole('button',{name:'ChatGPT 生图'}).click();
  assert.equal(await bar.getByRole('button',{name:'ChatGPT 生图'}).getAttribute('aria-pressed'),
    'true');
  assert.ok(await compose.getByRole('button',{name:/ChatGPT 登录/}).count());
  assert.equal(await page.locator(
    '.react-flow__node[data-id="muse-image"] .tn-media').count(),0);
  await compose.locator('.tn-submit').click();
  const badge=node.getByLabel('ChatGPT生图进度');
  await badge.waitFor({state:'visible',timeout:12000});
  assert.equal(await badge.getAttribute('data-progress'),'70');
  assert.match(await badge.innerText(),/70%/);
  await badge.waitFor({state:'detached',timeout:16000});
  assert.equal(submitted,1);
  assert.ok(polls>=5);
  // The UI updates immediately; its debounced asynchronous project save
  // finishes afterward. Verify the durable server-side state, not a race.
  let persisted=false;
  for(let attempt=0;attempt<50;attempt++){
    const latest=project.nodes.find(n=>n.id==='chatgpt-image');
    if(latest?.data.status==='done'&&
      latest.data.mediaUrl==='/api/uploads/mock-generated.png'){
      persisted=true;
      break;
    }
    await page.waitForTimeout(100);
  }
  assert.equal(persisted,true,'Generated image must be saved to project');
  const image=project.nodes.find(n=>n.id==='chatgpt-image');
  assert.equal(image.data.provider,'chatgpt');
  assert.equal(image.data.status,'done');
  assert.equal(image.data.mediaUrl,'/api/uploads/mock-generated.png');
  assert.equal(project.nodes.find(n=>n.id==='muse-image').data.provider,'muse',
    'Existing Muse provider should be preserved');
  assert.deepEqual(errors,[]);
  console.log('PASS: image node Muse/ChatGPT switch, ChatGPT login entry, exact 70% badge and completed canvas media, Muse unaffected');
}finally{await browser.close();}
