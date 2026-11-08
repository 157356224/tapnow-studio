import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
const mk=(id,kind,title,x,y,extra={})=>({
  id,type:'studio',position:{x,y},
  data:{kind,title,status:'idle',prompt:'',...extra}
});
const original='最初的分镜文字 @图片1 转身看向镜头，不要更改这里的文字。';
const project={
  id:'voice-definition-ui-test',title:'Role Voice UI test',
  updatedAt:new Date().toISOString(),
  viewport:{x:170,y:90,zoom:.9},
  nodes:[
    mk('a','image','林澈',50,80,{mediaUrl:'/api/uploads/a.png'}),
    mk('b','image','苏柠',60,480,{mediaUrl:'/api/uploads/b.png',
      voiceDefinition:'明亮、温柔、自然的女声'}),
    mk('c','image','未连接角色',1100,660,{mediaUrl:'/api/uploads/c.png',
      voiceDefinition:'未连接角色不允许进入提示词'}),
    mk('v','video','对话镜头',670,110,{
      provider:'doubao',accountId:'demo-account',model:'Seedance 2.0 Mini',
      ratio:'16:9',duration:'5s',prompt:original
    })
  ],
  edges:[{id:'a-v',source:'a',target:'v'},{id:'b-v',source:'b',target:'v'}],
  groups:[],groupColorCursor:0
};
const submitted=[];
const errors=[];
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1880,height:1260}});
  page.setDefaultTimeout(12000);
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
    const req=route.request(),pathname=new URL(req.url()).pathname;
    const json=(body,status=200)=>route.fulfill({
      status,contentType:'application/json',body:JSON.stringify(body)
    });
    if(pathname.startsWith('/api/uploads/'))
      return route.fulfill({status:200,contentType:'image/png',body:png});
    if(pathname==='/api/projects')return json([
      {id:project.id,title:project.title,updatedAt:project.updatedAt}
    ]);
    if(pathname==='/api/projects/'+project.id){
      if(req.method()==='PUT'){
        const payload=req.postDataJSON();
        Object.assign(project,payload);
        return json({id:project.id,updatedAt:new Date().toISOString()});
      }
      return json(project);
    }
    if(pathname==='/api/health')return json({
      referenceSelectionRevision:'at-order-v2',
      multiImageUploadRevision:'v3-prompt-first',
      videoModelRevision:'mini-fast-v1',
      videoStartRevision:'reply-prefix-v1',
      videoDownloadRevision:'completed-card-v1'
    });
    if(pathname==='/api/doubao/accounts')return json([{id:'demo-account',name:'示例账号'}]);
    if(pathname==='/api/doubao/jobs'){
      if(req.method()==='POST'){
        submitted.push(req.postDataJSON());
        return json({id:'voice-job',status:'queued',message:'已排队'},202);
      }
      return json({id:'voice-job',status:'needs-attention',error:'测试结束'});
    }
    if(pathname==='/api/muse/accounts')return json([]);
    if(pathname==='/api/muse/quotas')return json({
      totalAccounts:0,knownAccounts:0,unknownAccounts:0,
      totalCapacity:0,measuredCapacity:0,totalUsed:0,totalRemaining:0,rows:[]
    });
    return json([]);
  });
  await page.goto(process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5173/',{
    waitUntil:'domcontentloaded'
  });
  const a=page.locator('.react-flow__node[data-id="a"]');
  const v=page.locator('.react-flow__node[data-id="v"]');
  await v.waitFor({state:'visible'});

  await v.locator('.tn-node-frame').click();
  let composer=page.locator('.floating-compose:visible');
  assert.equal(await composer.locator('.tn-video-voice-prefix').count(),0,
    'connected image without voice + unreferenced voiced image must not inject voice');
  assert.equal(await composer.locator('.tn-inline-ref').first().getAttribute('data-token'),'@图片1');
  assert.equal(project.nodes.find(node=>node.id==='v').data.prompt,original);

  await a.locator('.tn-node-frame').click();
  const voice=page.getByRole('textbox',{name:'角色音色定义'});
  await voice.waitFor({state:'visible'});
  await voice.fill('年轻男性，音色偏清亮，略带磁性；说话沉稳，尾音自然。');
  assert.equal(await voice.inputValue(),
    '年轻男性，音色偏清亮，略带磁性；说话沉稳，尾音自然。');
  await v.locator('.tn-node-frame').click();
  composer=page.locator('.floating-compose:visible');
  const prefix=composer.locator('.tn-video-voice-prefix');
  await prefix.waitFor({state:'visible'});
  assert.match(await prefix.innerText(),/林澈/);
  assert.match(await prefix.innerText(),/略带磁性/);
  assert.doesNotMatch(await prefix.innerText(),/苏柠|未连接角色/);
  assert.equal(await composer.locator('.tn-inline-ref').first().getAttribute('data-token'),'@图片1');
  await page.waitForTimeout(1250);
  assert.equal(project.nodes.find(node=>node.id==='v').data.prompt,original,
    'the stored original prompt must remain byte-for-byte intact');

  // Simulate a real @ mention in existing user text without changing its prefix.
  const editor=composer.locator('.tn-compose-editor');
  await editor.click();
  await editor.press('End');
  await page.keyboard.insertText(' @图片2');
  await prefix.getByText(/苏柠/).waitFor();
  await page.waitForTimeout(1300);
  const current=project.nodes.find(n=>n.id==='v').data.prompt;
  assert.ok(current.startsWith(original));
  assert.match(current,/@图片2/);
  assert.doesNotMatch(current,/【角色音色定义】/,
    'derived voice prefix must never be written into the saved original prompt');

  await composer.locator('.tn-submit').click();
  await page.waitForFunction(()=>document.querySelector('.floating-compose')!==null);
  for(let i=0;i<30&&!submitted.length;i++)await page.waitForTimeout(100);
  assert.equal(submitted.length,1,'video submission must use generated prompt');
  const payload=submitted[0];
  assert.equal(payload.prompt,
    '【角色音色定义】\n'+
    '@图片1（林澈）音色：年轻男性，音色偏清亮，略带磁性；说话沉稳，尾音自然。\n'+
    '@图片2（苏柠）音色：明亮、温柔、自然的女声\n\n'+current);
  assert.equal(project.nodes.find(n=>n.id==='v').data.prompt,current);
  await page.reload({waitUntil:'domcontentloaded'});
  await v.waitFor({state:'visible'});
  await a.locator('.tn-node-frame').click();
  await voice.waitFor({state:'visible'});
  assert.equal(await voice.inputValue(),'年轻男性，音色偏清亮，略带磁性；说话沉稳，尾音自然。');
  assert.deepEqual(errors,[]);
  console.log('PASS: image voice editor, connect+@ gating, live UI prefix, multi-character prompt order, untouched original, actual video submission and reload');
}finally{
  await browser.close();
}
