// Frontend integration with fully mocked local APIs; no real accounts or jobs.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const base=process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5173/';
const account={id:'11111111-1111-4111-8111-111111111111',
  name:'Muse mock account',createdAt:new Date().toISOString(),browserEngine:'edge'};
const museAccounts=[account];
const newlyCreatedId='33333333-3333-4333-8333-333333333333';
const quotaSnapshot={
  totalAccounts:2,knownAccounts:2,unknownAccounts:0,
  totalCapacity:200,measuredCapacity:200,totalUsed:34,totalRemaining:166,
  refreshedAt:Date.now(),refreshIntervalMs:60000,rows:[
    {id:account.id,name:account.name,status:'ok',used:9,remaining:91,
      quotaStatus:'SUFFICIENT',tierName:'Muse 免费版',resetsAt:1793997139},
    {id:'22222222-2222-4222-8222-222222222222',name:'Muse mock account 2',
      status:'ok',used:25,remaining:75,quotaStatus:'SUFFICIENT',
      tierName:'Muse 免费版',resetsAt:1793997139}
  ]
};
const project={
  id:'muse-ui-project',title:'Muse Provider UI',
  updatedAt:new Date().toISOString(),
  viewport:{x:120,y:130,zoom:.8},
  nodes:[
    {id:'video-node',type:'studio',position:{x:70,y:80},
      data:{kind:'video',title:'Video',provider:'doubao',
        model:'Seedance 2.0 Mini',status:'idle',
        ratio:'16:9',duration:'15s',prompt:'街道上的小狗，参考 @图片2'}},
    {id:'image-node',type:'studio',position:{x:780,y:80},
      data:{kind:'image',title:'Image',provider:'muse',
        status:'idle',ratio:'3:4',prompt:'雪山日出，参考 @图片1'}},
    {id:'reference-a',type:'studio',position:{x:0,y:630},
      data:{kind:'image',title:'Reference A',status:'done',
        mediaUrl:'/api/uploads/11111111-1111-4111-8111-111111111112.png'}},
    {id:'reference-b',type:'studio',position:{x:390,y:630},
      data:{kind:'image',title:'Reference B',status:'done',
        mediaUrl:'/api/uploads/11111111-1111-4111-8111-111111111113.png'}}
  ],edges:[
    {id:'r1',source:'reference-a',target:'video-node'},
    {id:'r2',source:'reference-b',target:'video-node'},
    {id:'r3',source:'reference-a',target:'image-node'}
  ]
};
const submitted=[];
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1640,height:950}});
try{
  await page.route('**/api/health',r=>r.fulfill({status:200,
    contentType:'application/json',body:JSON.stringify({
      ok:true,museBridgeRevision:'quota-auto-v6-image-resolution',
      museMediaRevision:'fresh-chat-media-v2',videoModelRevision:'mini-fast-v1'
    })}));
  await page.route('**/api/projects**',async route=>{
    const req=route.request();
    const pathname=new URL(req.url()).pathname;
    let result;
    if(req.method()==='PUT'){
      const body=req.postDataJSON();
      project.nodes=body.nodes;
      result={id:project.id,updatedAt:new Date().toISOString()};
    }else if(pathname==='/api/projects'){
      result=[{id:project.id,title:project.title,updatedAt:project.updatedAt}];
    }else result=project;
    await route.fulfill({status:200,contentType:'application/json',
      body:JSON.stringify(result)});
  });
  await page.route('**/api/doubao/accounts',r=>r.fulfill({status:200,
    contentType:'application/json',body:'[]'}));
  await page.route('**/api/muse/accounts',async route=>{
    if(route.request().method()==='POST'){
      const newAccount={id:newlyCreatedId,
        name:route.request().postDataJSON().name,
        createdAt:new Date().toISOString(),browserEngine:'edge'};
      museAccounts.push(newAccount);
      await route.fulfill({status:201,contentType:'application/json',
        body:JSON.stringify(newAccount)});
    }else{
      await route.fulfill({status:200,contentType:'application/json',
        body:JSON.stringify(museAccounts)});
    }
  });
  await page.route('**/api/muse/accounts/*/native-login',
    r=>r.fulfill({status:200,contentType:'application/json',
      body:JSON.stringify({ok:true,message:'Muse mock Edge opened'})}));
  await page.route('**/api/muse/quotas**',r=>r.fulfill({status:200,
    contentType:'application/json',body:JSON.stringify(quotaSnapshot)}));
  await page.route('**/api/muse/jobs**',async route=>{
    const req=route.request();
    if(req.method()==='POST'){
      submitted.push(req.postDataJSON());
      await route.fulfill({status:202,contentType:'application/json',
        body:JSON.stringify({id:'mock-job-'+submitted.length,
          accountId:account.id,status:'queued',message:'mock queued'})});
    }else{
      const current=route.request().url().includes('mock-job-1')?'video':'image';
      await route.fulfill({status:200,contentType:'application/json',
        body:JSON.stringify({id:'mock-job',status:'completed',
          mediaUrl:'/api/uploads/mock-output.'+(current==='video'?'mp4':'png')})});
    }
  });
  await page.route('**/api/uploads/mock-output.*',r=>r.fulfill({status:200,body:''}));
  await page.route('**/api/uploads/11111111-1111-4111-8111-11111111111*.png',
    r=>r.fulfill({status:200,contentType:'image/png',body:''}));
  await page.goto(base,{waitUntil:'domcontentloaded'});
  // Account management must be discoverable without first opening a node.
  await page.getByRole('button',{name:'Muse 账号管理'}).click();
  const accountPanel=page.locator('.right-panel');
  await accountPanel.getByRole('heading',{name:'Muse 独立 Edge 浏览器'}).waitFor();
  await accountPanel.getByRole('button',{name:'豆包账号'}).click();
  await accountPanel.getByRole('heading',{name:'多账号浏览器隔离'}).waitFor();
  await accountPanel.getByRole('button',{name:'Muse 账号'}).click();
  await accountPanel.getByRole('heading',{name:'Muse 独立 Edge 浏览器'}).waitFor();
  await accountPanel.getByRole('textbox',{name:'Muse 账号备注'}).fill('新 Muse 账号 测试');
  await accountPanel.getByRole('button',{name:'创建并打开 Edge 登录'}).click();
  await accountPanel.getByText('新 Muse 账号 测试').waitFor();
  assert.equal(museAccounts.length,2,'Account must be created and shown in the Muse panel');
  await accountPanel.getByRole('button',{name:'关闭'}).click();
  const quotaButton=page.getByRole('button',{name:'查看 Muse 额度'});
  await quotaButton.hover();
  const popover=page.getByRole('tooltip',{name:'Muse 所有账号剩余额度'});
  await popover.waitFor({state:'visible'});
  assert.match(await popover.innerText(),/166%/);
  assert.match(await popover.innerText(),/34%/);
  assert.match(await popover.innerText(),/Muse mock account/);
  await popover.getByRole('button',{name:'管理 / 添加 Muse 账号'}).click();
  await accountPanel.getByRole('heading',{name:'Muse 独立 Edge 浏览器'}).waitFor();
  await accountPanel.getByText('新 Muse 账号 测试').waitFor();
  await accountPanel.getByRole('button',{name:'关闭'}).click();
  const videoNode=page.locator('.react-flow__node[data-id="video-node"]');
  await videoNode.locator('.tn-node-frame').click();
  const editor=page.locator('.floating-compose').filter({
    has:page.getByRole('button',{name:'豆包生成',exact:true})
  });
  await editor.getByRole('button',{name:'Muse 生成',exact:true}).click();
  assert.equal(await editor.locator('.tn-video-model-picker').count(),0,
    'Muse video mode hides all model options');
  assert.equal(await editor.getByRole('button',{name:'Muse 生成',exact:true})
    .getAttribute('aria-pressed'),'true');
  await editor.locator('select[aria-label="Muse 生成账号"] option[value="'+account.id+'"]')
    .waitFor({state:'attached'});
  assert.equal(await editor.locator('select[aria-label="Muse 生成账号"]').inputValue(),'auto',
    'Muse should auto select an account by default');
  assert.match(await editor.locator('.tn-video-settings-toggle').innerText(),/10s/,
    'Switching to Muse must cap 15s video node to 10s');
  await editor.locator('.tn-video-settings-toggle').click();
  assert.equal(await editor.locator('.tn-video-durations button').count(),7);
  assert.equal(await editor.locator('.tn-video-durations').getByText('11s').count(),0);
  await editor.locator('.tn-video-settings-toggle').click();
  await editor.locator('.tn-submit').click();
  await page.waitForTimeout(2600);
  assert.equal(submitted.length,1);
  assert.equal(submitted[0].accountId,'auto');
  assert.equal(submitted[0].duration,'10s');
  assert.equal(submitted[0].provider,'muse');
  assert.deepEqual(submitted[0].references,[{id:'reference-b'}],
    'Video must send only @图片2, not connected @图片1');

  const imageNode=page.locator('.react-flow__node[data-id="image-node"]');
  await imageNode.locator('.tn-node-frame').click();
  const imageEditor=page.locator('.floating-compose').filter({
    has:page.getByRole('button',{name:'Muse 生图',exact:true})
  });
  await imageEditor.getByRole('button',{name:'Muse 生图'}).waitFor({state:'visible'});
  assert.equal(await imageEditor.getByRole('button',{name:'演示模式'}).count(),0,
    'Image creation must not offer demo mode');
  assert.equal(await imageEditor.locator('.tn-compose-square').count(),0,
    'Image editor must not show the redundant upper-left add button');
  assert.equal(await imageEditor.getByRole('button',{name:'Muse 生图'})
    .getAttribute('aria-pressed'),'true');
  const imageFrame=imageNode.locator('.tn-node-frame');
  const beforeSize=await imageFrame.boundingBox();
  assert.ok(beforeSize&&Math.abs(beforeSize.width/beforeSize.height-.75)<.06,
    'Image node should start with its selected 3:4 aspect ratio');
  assert.equal(await imageEditor.locator('.tn-combobox [title="选择模型"]').count(),0);
  const imageSettingsButton=imageEditor.getByTitle('设置图片比例和分辨率');
  assert.match(await imageSettingsButton.innerText(),/3:4 · 2K/);
  await imageSettingsButton.click();
  const imageSettings=imageEditor.locator('.tn-image-settings');
  await imageSettings.waitFor({state:'visible'});
  assert.equal(await imageSettings.evaluate(el=>getComputedStyle(el).animationName),
    'tn-settings-open','Image settings must use the same open animation as video settings');
  assert.equal(await imageSettings.locator('.tn-video-ratios button').count(),7);
  assert.deepEqual(await imageSettings.locator('.tn-image-resolutions button').allInnerTexts(),
    ['1080p','2K','4K','8K']);
  for(const resolution of ['1080p','2K','4K','8K']){
    await imageSettings.locator('.tn-image-resolutions')
      .getByRole('button',{name:resolution,exact:true}).click();
    assert.match(await imageSettingsButton.innerText(),
      new RegExp('3:4 · '+resolution));
  }
  assert.equal(await imageSettings.locator('.tn-image-resolutions').getByRole('button',{name:'8K'})
    .getAttribute('aria-pressed'),'true');
  await imageSettings.locator('.tn-video-ratios').getByRole('button',{name:'21:9'}).click();
  assert.match(await imageSettingsButton.innerText(),/21:9 · 8K/);
  await page.waitForTimeout(760);
  const afterSize=await imageFrame.boundingBox();
  assert.ok(afterSize&&Math.abs(afterSize.width/afterSize.height-(21/9))<.12,
    'Changing image ratio must resize the image node frame like a video');
  assert.ok(beforeSize&&afterSize.width>beforeSize.width&&afterSize.height<beforeSize.height,
    'Image node width and height must animate toward the selected ratio');
  await imageSettingsButton.click();
  assert.equal(await imageSettingsButton.getAttribute('aria-expanded'),'false');
  await imageSettings.waitFor({state:'hidden',timeout:3000});
  await imageEditor.locator('select[aria-label="Muse 生成账号"]').selectOption(account.id);
  await imageEditor.locator('.tn-submit').click();
  await page.waitForTimeout(2600);
  assert.equal(submitted.length,2);
  assert.equal(submitted[1].provider,'muse');
  assert.equal(submitted[1].ratio,'21:9');
  assert.equal(submitted[1].resolution,'8K');
  assert.equal(submitted[1].accountId,account.id);
  assert.deepEqual(submitted[1].references,[{id:'reference-a'}],
    'Image reference generation must send only the @ image');
  console.log('PASS: Muse video/image modes, only @ refs (never all connected), hidden model, max 10s, separate account, correct Muse API route');
}finally{await browser.close();}
