import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const base=process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5173/';
const image=id=>({id,type:'studio',position:{x:30,y:100+200*('abcd'.indexOf(id))},
  data:{kind:'image',title:'Source '+id.toUpperCase(),status:'done',
    mediaUrl:'/api/uploads/'+id+'.png'}});
const project={
  id:'test-reference-order',title:'Reference order integration',
  updatedAt:new Date().toISOString(),
  viewport:{x:230,y:120,zoom:.8},
  // Intentionally different from the connection order below.
  nodes:[
    {id:'video',type:'studio',position:{x:620,y:110},
      data:{kind:'video',title:'Video',status:'idle',provider:'doubao',
        accountId:'doubao-test',model:'Seedance 2.0 Mini',
        ratio:'16:9',duration:'5s',prompt:'@图片2 在后面，@图片1 在前面'}},
    {id:'image-target',type:'studio',position:{x:1130,y:700},
      data:{kind:'image',title:'Image Edit',status:'idle',ratio:'1:1',prompt:''}},
    image('c'),image('a'),image('b'),image('d')
  ],
  edges:[
    {id:'from-b',source:'b',target:'video'},
    {id:'from-a',source:'a',target:'video'},
    {id:'from-c',source:'c',target:'video'},
    {id:'image-from-a',source:'a',target:'image-target'},
    {id:'image-from-b',source:'b',target:'image-target'}
  ]
};
const submitted=[];
const imageSubmitted=[];
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1900,height:1000}});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
  await page.route('**/api/projects**',async route=>{
    const request=route.request();
    const pathname=new URL(request.url()).pathname;
    if(request.method()==='PUT'){
      const payload=request.postDataJSON();
      project.nodes=payload.nodes;
      project.edges=payload.edges;
      await route.fulfill({status:200,contentType:'application/json',
        body:JSON.stringify({id:project.id,updatedAt:new Date().toISOString()})});
    }else{
      await route.fulfill({status:200,contentType:'application/json',
        body:JSON.stringify(pathname==='/api/projects'
          ?[{id:project.id,title:project.title,updatedAt:project.updatedAt}]:project)});
    }
  });
  await page.route('**/api/health',route=>route.fulfill({
    status:200,contentType:'application/json',
    body:JSON.stringify({referenceSelectionRevision:'at-order-v2',
      videoModelRevision:'mini-fast-v1',multiImageUploadRevision:'v3-prompt-first',
      videoStartRevision:'reply-prefix-v1',
      videoDownloadRevision:'completed-card-v1',
      museBridgeRevision:'quota-auto-v6-image-resolution'})
  }));
  await page.route('**/api/doubao/accounts',route=>route.fulfill({
    status:200,contentType:'application/json',
    body:JSON.stringify([{id:'doubao-test',name:'Test Doubao'}])
  }));
  await page.route('**/api/muse/accounts',route=>route.fulfill({
    status:200,contentType:'application/json',
    body:JSON.stringify([{id:'mock-muse-account',name:'Muse test account'}])
  }));
  await page.route('**/api/muse/quotas**',route=>route.fulfill({
    status:200,contentType:'application/json',
    body:JSON.stringify({totalAccounts:0,knownAccounts:0,unknownAccounts:0,
      totalCapacity:0,measuredCapacity:0,totalUsed:0,totalRemaining:0,
      rows:[],refreshedAt:Date.now(),refreshIntervalMs:60000})
  }));
  await page.route('**/api/uploads/*.png',route=>route.fulfill({
    status:200,contentType:'image/png',
    body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64')
  }));
  await page.route('**/api/doubao/jobs**',async route=>{
    if(route.request().method()==='POST'){
      submitted.push(route.request().postDataJSON());
      await route.fulfill({status:202,contentType:'application/json',
        body:JSON.stringify({id:'mock-video-job',status:'queued',message:'已排队'})});
    }else{
      await route.fulfill({status:200,contentType:'application/json',
        body:JSON.stringify({id:'mock-video-job',status:'needs-attention',
          error:'mock test completed',progress:0})});
    }
  });
  await page.route('**/api/muse/jobs**',async route=>{
    if(route.request().method()==='POST'){
      imageSubmitted.push(route.request().postDataJSON());
      await route.fulfill({status:202,contentType:'application/json',
        body:JSON.stringify({id:'mock-image-job',status:'queued',message:'已排队'})});
    }else{
      await route.fulfill({status:200,contentType:'application/json',
        body:JSON.stringify({id:'mock-image-job',status:'needs-attention',
          error:'mock image test completed',progress:0})});
    }
  });
  await page.goto(base,{waitUntil:'domcontentloaded'});
  const video=page.locator('.react-flow__node[data-id="video"]');
  await video.waitFor({state:'visible',timeout:12000});
  await page.waitForTimeout(750); // openProject restores the viewport asynchronously
  for(const side of ['in','out'])await verifyPortBand(video,side);
  await video.locator('.tn-node-frame').click();
  // React Flow's NodeToolbar lives in a viewport portal, not under the node.
  const compose=page.locator('.floating-compose').filter({
    has:page.getByRole('button',{name:'豆包生成',exact:true})
  });
  await compose.locator('.tn-compose-editor').waitFor({state:'visible',timeout:12000});
  const tray=compose.locator('.tn-ref-attachments');
  const thumbnails=tray.locator('.tn-ref-attachment');
  await thumbnails.first().waitFor();
  const ids=()=>thumbnails.evaluateAll(elements=>elements.map(el=>el.dataset.refId));
  assert.deepEqual(await ids(),['b','a','c'],
    'Thumbnails must follow wire connection order, never the node list order');
  assert.match(await tray.locator('.tn-ref-attachment-count').innerText(),/已连接3张/);
  assert.match(await tray.locator('.tn-ref-attachment-count').innerText(),/已引用2张/);
  const a=tray.locator('.tn-ref-attachment[data-ref-id="a"]');
  await a.hover();
  await a.getByRole('button',{name:'将@图片2后移'}).click();
  assert.deepEqual(await ids(),['b','c','a'],
    'Moving a thumbnail must change its @ numbering and placement');
  const promptTokens=()=>compose.locator('.tn-inline-ref').evaluateAll(
    nodes=>nodes.map(node=>node.dataset.token));
  assert.deepEqual(await promptTokens(),['@图片3','@图片1'],
    'Existing @ chips must remain bound to the same source images after reordering');
  await compose.getByTitle('使用选定豆包账号生成视频').click();
  await page.waitForTimeout(200);
  assert.equal(submitted.length,1,'Generate must reach the Doubao job endpoint once');
  assert.deepEqual(submitted[0].references,[{id:'b'},{id:'a'}],
    'Upload order must be thumbnail order even if prompt mentions @图片3 first');
  assert.equal(project.nodes.find(node=>node.id==='video').data.referenceOrder.join(','),
    'b,c,a','Reference order must be saved in the node');
  assert.match(project.nodes.find(node=>node.id==='video').data.prompt,/@图片3/);
  // A newly connected image must be visible instantly without inserting @.
  const d=page.locator('.react-flow__node[data-id="d"]');
  await d.locator('.tn-node-frame').hover();
  await page.waitForTimeout(200);
  const port=await d.locator('.tn-port-out .tn-port-visual').boundingBox();
  const destination=await video.locator('.tn-node-frame').boundingBox();
  assert.ok(port&&destination,'Source/output and target/input handles are visible');
  await page.mouse.move(port.x+port.width/2,port.y+port.height/2);
  await page.mouse.down();
  await page.mouse.move(destination.x+destination.width*.5,
    destination.y+destination.height*.45,{steps:28});
  await page.mouse.up();
  await page.waitForTimeout(280);
  assert.ok(await page.locator('.react-flow__edge').count()>=4,
    'Connecting one more image must create another edge');
  await video.locator('.tn-node-frame').click();
  await compose.locator('.tn-ref-attachment[data-ref-id="d"]')
    .waitFor({state:'visible',timeout:6000});
  assert.deepEqual(await ids(),['b','c','a','d'],
    'Dynamically connected source must append as @图片4 without any typed @');
  assert.match(await tray.locator('.tn-ref-attachment-count').innerText(),/已引用2张/,
    'A connection must not silently add an upload to the prompt');
  // Image-to-image references: a default image node has no explicit
  // provider field, yet it must expose Muse reference thumbnails.
  const imageTarget=page.locator('.react-flow__node[data-id="image-target"]');
  await imageTarget.locator('.tn-node-frame').click();
  const imageCompose=page.locator('.floating-compose').filter({
    has:page.getByRole('button',{name:'Muse 生图',exact:true})
  });
  await imageCompose.locator('.tn-compose-editor').waitFor({state:'visible',timeout:7000});
  const imageTray=imageCompose.locator('.tn-ref-attachments');
  const imageIds=()=>imageTray.locator('.tn-ref-attachment')
    .evaluateAll(elements=>elements.map(el=>el.dataset.refId));
  assert.deepEqual(await imageIds(),['a','b']);
  assert.match(await imageTray.locator('.tn-ref-attachment-count').innerText(),
    /已连接2张 · 已引用0张/);
  await imageTray.locator('.tn-ref-attachment[data-ref-id="a"] .tn-ref-thumbnail').click();
  assert.deepEqual(await imageCompose.locator('.tn-inline-ref').evaluateAll(
    elements=>elements.map(el=>el.dataset.token)),['@图片1']);
  assert.match(await imageTray.locator('.tn-ref-attachment-count').innerText(),
    /已引用1张/);
  const imageA=imageTray.locator('.tn-ref-attachment[data-ref-id="a"]');
  await imageA.hover();
  await imageA.getByRole('button',{name:'将@图片1后移'}).click();
  await page.waitForTimeout(250);
  assert.deepEqual(await imageIds(),['b','a']);
  assert.deepEqual(await imageCompose.locator('.tn-inline-ref').evaluateAll(
    elements=>elements.map(el=>el.dataset.token)),['@图片2'],
    'Reordering image inputs must keep the @ reference on the original image');
  await imageCompose.getByTitle('使用 Muse 生成图片').click();
  await page.waitForTimeout(300);
  assert.equal(imageSubmitted.length,1,'Muse image job should submit once');
  assert.equal(imageSubmitted[0].nodeId,'image-target');
  assert.deepEqual(imageSubmitted[0].references,[{id:'a'}],
    'Only the @-mentioned image should be included for image editing');
  assert.match(imageSubmitted[0].prompt,/@图片2/);
  assert.equal(project.nodes.find(node=>node.id==='image-target').data.referenceOrder.join(','),
    'b,a','Image reference ordering should persist');

  // Screenshot requirement: the left and right magnetic "+" buttons track
  // the pointer only within the central ~18%-78% of the actual media frame.
  // Check a video, a square image, and the same image after changing to 21:9.
  async function verifyPortBand(node,side){
    const frame=await node.locator('.tn-node-frame').boundingBox();
    assert.ok(frame,'Node frame is available for magnetic port testing');
    const x=side==='in'?frame.x-56:frame.x+frame.width+56;
    const port=node.locator('.tn-port-'+side+' .tn-port-visual');
    const getCenter=async()=>{
      const box=await port.boundingBox();
      assert.ok(box);
      return box.y+box.height/2;
    };
    await page.mouse.move(x,frame.y+4);
    await page.waitForTimeout(110);
    const top=await getCenter();
    assert.ok(Math.abs(top-(frame.y+frame.height*.18))<9,
      side+' port must stop near the top of the marked center strip '+
      JSON.stringify({top,expected:frame.y+frame.height*.18,frame,
        translate:await port.evaluate(el=>el.style.translate),
        nodeClass:await node.locator('.tn-node').getAttribute('class')}));
    await page.mouse.move(x,frame.y+frame.height-4);
    await page.waitForTimeout(110);
    const bottom=await getCenter();
    assert.ok(Math.abs(bottom-(frame.y+frame.height*.78))<9,
      side+' port must stop near the bottom of the marked center strip');
    assert.ok(bottom-top>frame.height*.52,
      'Magnetic port must still follow the cursor within its permitted strip');
  }
  for(const side of ['in','out'])await verifyPortBand(imageTarget,side);
  await imageTarget.locator('.tn-node-frame').click();
  await imageCompose.getByTitle('设置图片比例和分辨率').click();
  await imageCompose.locator('.tn-image-settings .tn-video-ratios')
    .getByRole('button',{name:'21:9'}).click();
  await page.waitForTimeout(850);
  for(const side of ['in','out'])await verifyPortBand(imageTarget,side);

  assert.deepEqual(errors,[],'Browser must not report JavaScript errors');
  console.log('PASS: ordered reference thumbnails, persisted @ refs and central 18%-78% magnetic port follow band on image/video nodes at multiple ratios');
}finally{
  await browser.close();
}
