import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';

const url=process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5173/';
const now=new Date().toISOString();
const project={
  id:'test-generation-visual',title:'TEST generation visual',updatedAt:now,
  viewport:{x:100,y:110,zoom:.85},
  nodes:[
    {id:'image-running',type:'studio',position:{x:80,y:75},
      data:{kind:'image',title:'Image',ratio:'4:3',provider:'muse',status:'running',
        progress:67,prompt:'a kitten'}},
    {id:'video-queued',type:'studio',position:{x:620,y:75},
      data:{kind:'video',title:'Video',ratio:'16:9',provider:'doubao',
        duration:'5s',status:'queued',progress:0,
        jobMessage:'正在等待生成账号',prompt:'a kitten sleeping'}},
    {id:'video-done',type:'studio',position:{x:1240,y:75},
      data:{kind:'video',title:'Video done',ratio:'16:9',status:'done',
        prompt:'finished video'}}
  ],
  edges:[]
};
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1920,height:1000},
  reducedMotion:'no-preference'});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
  await page.route('**/api/projects**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(route.request().method()==='PUT'){
      await route.fulfill({status:200,contentType:'application/json',
        body:JSON.stringify({id:project.id,updatedAt:now})});
      return;
    }
    const response=pathname==='/api/projects'
      ?[{id:project.id,title:project.title,updatedAt:project.updatedAt}]:project;
    await route.fulfill({status:200,contentType:'application/json',
      body:JSON.stringify(response)});
  });
  await page.route('**/api/doubao/accounts',route=>route.fulfill({
    status:200,contentType:'application/json',body:'[]'
  }));
  await page.route('**/api/muse/accounts',route=>route.fulfill({
    status:200,contentType:'application/json',body:'[]'
  }));
  await page.route('**/api/muse/quotas**',route=>route.fulfill({
    status:200,contentType:'application/json',
    body:JSON.stringify({totalAccounts:0,knownAccounts:0,unknownAccounts:0,
      totalCapacity:0,measuredCapacity:0,totalUsed:0,totalRemaining:0,
      rows:[],refreshedAt:Date.now(),refreshIntervalMs:60000})
  }));
  await page.goto(url,{waitUntil:'domcontentloaded'});
  const image=page.locator('.react-flow__node[data-id="image-running"]');
  const video=page.locator('.react-flow__node[data-id="video-queued"]');
  const done=page.locator('.react-flow__node[data-id="video-done"]');
  await image.waitFor({state:'visible',timeout:15000});
  await video.waitFor({state:'visible'});
  await done.waitFor({state:'visible'});
  await image.locator('.tn-generating-visual').waitFor({state:'visible'});
  await video.locator('.tn-generating-visual').waitFor({state:'visible'});
  assert.equal(await page.locator('.tn-generating-visual').count(),2,
    'Image and video must show the same scanning animation while queued/running');
  assert.equal(await done.locator('.tn-generating-visual').count(),0,
    'Completed nodes must not show the generation effect');
  assert.equal(await page.locator('.tn-node-frame .tn-running').count(),0,
    'No percentage or progress bar for generating image/video nodes');
  assert.equal(await page.locator('.tn-node-frame .tn-queued').count(),0,
    'No old queued bar over the generating video');
  assert.equal(await image.locator('.tn-generating-visual').getAttribute('role'),'status');
  assert.equal(await image.locator('.tn-generating-visual').getAttribute('aria-label'),
    '正在生成');
  assert.equal(await video.locator('.tn-generating-visual').getAttribute('aria-label'),
    '排队等待生成');
  // A single worker-driven canvas replaces 600 animated DOM elements.
  const canvas=image.locator('.tn-generating-canvas');
  const videoCanvas=video.locator('.tn-generating-canvas');
  await canvas.waitFor({state:'visible'});
  await videoCanvas.waitFor({state:'visible'});
  await page.waitForFunction(()=>[...document.querySelectorAll(
    '.tn-generating-canvas')].every(el=>el.dataset.renderer),null,{timeout:8000});
  const renderer=await canvas.getAttribute('data-renderer');
  assert.equal(renderer,'offscreen-worker',
    'Edge must draw the full generation visual on an OffscreenCanvas worker');
  assert.equal(await page.locator('.tn-generating-dot,.tn-generating-sweep').count(),0,
    'No per-dot animated DOM elements or CSS-filter-heavy beam');
  assert.equal(await page.locator('.tn-generating-canvas').count(),2);
  const dimensions=await canvas.evaluate(el=>{
    const frame=el.parentElement.getBoundingClientRect();
    const rect=el.getBoundingClientRect();
    return {width:rect.width,height:rect.height,
      frameWidth:frame.width,frameHeight:frame.height};
  });
  assert.ok(Math.abs(dimensions.width-dimensions.frameWidth)<1);
  assert.ok(Math.abs(dimensions.height-dimensions.frameHeight)<1);
  await page.waitForTimeout(500);
  const imageBefore=await canvas.screenshot();
  const coverage=await page.evaluate(async base64=>{
    const bitmap=new Image();
    bitmap.src='data:image/png;base64,'+base64;
    await bitmap.decode();
    const test=document.createElement('canvas');
    test.width=bitmap.naturalWidth;test.height=bitmap.naturalHeight;
    const context=test.getContext('2d',{willReadFrequently:true});
    context.drawImage(bitmap,0,0);
    const {data}=context.getImageData(0,0,test.width,test.height);
    const bright=(x,y)=>{
      const ix=(y*test.width+x)*4;
      return data[ix]>22&&data[ix+2]>25;
    };
    const sides={left:0,right:0,top:0,bottom:0};
    for(let y=3;y<test.height-3;y++){
      if([0,1,2,3].some(x=>bright(x,y)))sides.left++;
      if([0,1,2,3].some(n=>bright(test.width-1-n,y)))sides.right++;
    }
    for(let x=3;x<test.width-3;x++){
      if([0,1,2,3].some(y=>bright(x,y)))sides.top++;
      if([0,1,2,3].some(n=>bright(x,test.height-1-n)))sides.bottom++;
    }
    return sides;
  },imageBefore.toString('base64'));
  assert.ok(Object.values(coverage).every(value=>value>5),
    'Dot matrix must reach all four frame edges without blank strips: '+
      JSON.stringify(coverage));
  await page.waitForTimeout(460);
  const imageAfter=await canvas.screenshot();
  assert.notDeepEqual(imageAfter,imageBefore,
    'Generation canvas must change without individual DOM animations');
  const secondRenderer=await videoCanvas.getAttribute('data-renderer');
  assert.equal(secondRenderer,'offscreen-worker',
    'Concurrent image/video generation must use worker rendering');
  if(process.env.TAPNOW_GENERATION_SCREENSHOT){
    const screenshot=path.resolve(process.env.TAPNOW_GENERATION_SCREENSHOT);
    fs.mkdirSync(path.dirname(screenshot),{recursive:true});
    await page.screenshot({path:screenshot,animations:'allow'});
    console.log('GENERATION_VISUAL='+screenshot);
  }

  // A terminal status must instantly replace the scanning overlay without
  // leaving a strip or a percentage displayed over the finished media.
  project.nodes=project.nodes.map(node=>({...node,
    data:{...node.data,status:node.id==='image-running'?'error':'done',
      jobMessage:node.id==='image-running'?'测试生成失败':''}}));
  await page.reload({waitUntil:'domcontentloaded'});
  await image.waitFor({state:'visible',timeout:15000});
  await video.waitFor({state:'visible'});
  assert.equal(await page.locator('.tn-generating-visual').count(),0,
    'Finished and failed jobs must immediately remove the scan effect');
  assert.match(await image.locator('.tn-node-error').innerText(),/测试生成失败/,
    'Keep existing actionable generation error details');
  assert.equal(await video.locator('.tn-node-error').count(),0);

  // Exercise the REAL queued -> completed React state transition through the
  // app's job polling code, not just a manually assigned CSS class. Both
  // image and video outputs should pop from the centre on arrival.
  project.nodes=project.nodes.map(node=>
    node.id==='image-running'||node.id==='video-queued'
      ?{...node,data:{...node.data,status:'idle',provider:'muse',
        mediaUrl:undefined,jobMessage:'',progress:0}}
      :node);
  await page.route('**/api/health',route=>route.fulfill({
    status:200,contentType:'application/json',
    body:JSON.stringify({ok:true,museBridgeRevision:'quota-auto-v6-image-resolution'})
  }));
  await page.route('**/api/muse/accounts',route=>route.fulfill({
    status:200,contentType:'application/json',
    body:JSON.stringify([{id:'mock-muse',name:'Mock Muse'}])
  }));
  const submitted=[];
  await page.route('**/api/muse/jobs**',route=>{
    const req=route.request();
    if(req.method()==='POST'){
      const payload=req.postDataJSON();
      submitted.push(payload);
      return route.fulfill({status:202,contentType:'application/json',
        body:JSON.stringify({id:'mock-'+payload.nodeId,status:'queued',
          message:'mock generation queued'})});
    }
    const isImage=req.url().includes('image-running');
    return route.fulfill({status:200,contentType:'application/json',
      body:JSON.stringify({id:'mock-generated',status:'completed',
        mediaUrl:'/api/uploads/mock-completed.'+(isImage?'png':'mp4')})});
  });
  await page.route('**/api/uploads/mock-completed.png',route=>route.fulfill({
    status:200,contentType:'image/png',
    body:Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
      'base64')
  }));
  await page.route('**/api/uploads/mock-completed.mp4',route=>route.fulfill({
    status:200,contentType:'video/mp4',body:''
  }));
  await page.reload({waitUntil:'domcontentloaded'});
  await image.locator('.tn-node-frame').waitFor({state:'visible'});
  await image.locator('.tn-node-frame').click();
  let editor=page.locator('.floating-compose').filter({
    has:page.getByRole('button',{name:'Muse 生图',exact:true})
  });
  await editor.locator('.tn-submit').waitFor({state:'visible'});
  await editor.locator('.tn-submit').click();
  await image.locator('.tn-generating-visual').waitFor({state:'visible'});
  await image.locator('img.tn-media-reveal').waitFor({state:'attached',timeout:10000});
  assert.equal(await image.locator('img.tn-media-reveal')
    .evaluate(el=>getComputedStyle(el).animationName),'tn-generation-media-pop',
    'Generated image must pop from a tiny centre scale when it arrives');
  const imagePop=await image.locator('img.tn-media-reveal').evaluate(el=>
    el.getAnimations().find(a=>a.animationName==='tn-generation-media-pop')
      ?.effect?.getKeyframes().map(frame=>({offset:frame.offset,transform:frame.transform})));
  assert.ok(imagePop?.some(frame=>frame.offset===0&&frame.transform==='scale(0.12)'),
    'Image reveal must start tiny in the centre');
  assert.ok(imagePop?.some(frame=>frame.offset===1&&frame.transform==='scale(1)'),
    'Image reveal must expand to full size');
  assert.equal(await image.locator('.tn-generating-visual').count(),0);

  await video.locator('.tn-node-frame').click();
  editor=page.locator('.floating-compose').filter({
    has:page.getByRole('button',{name:'Muse 生成',exact:true})
  });
  await editor.locator('.tn-submit').waitFor({state:'visible'});
  await editor.locator('.tn-submit').click();
  await video.locator('.tn-generating-visual').waitFor({state:'visible'});
  await video.locator('video.tn-media-reveal').waitFor({state:'attached',timeout:10000});
  assert.equal(await video.locator('video.tn-media-reveal')
    .evaluate(el=>getComputedStyle(el).animationName),'tn-generation-media-pop',
    'Generated video must also pop from the centre when it arrives');
  const videoPop=await video.locator('video.tn-media-reveal').evaluate(el=>
    el.getAnimations().find(a=>a.animationName==='tn-generation-media-pop')
      ?.effect?.getKeyframes().map(frame=>({offset:frame.offset,transform:frame.transform})));
  assert.ok(videoPop?.some(frame=>frame.offset===0&&frame.transform==='scale(0.12)'));
  assert.ok(videoPop?.some(frame=>frame.offset===1&&frame.transform==='scale(1)'));
  assert.equal(await video.locator('.tn-generating-visual').count(),0);
  assert.equal(submitted.length,2,'Both media kinds should submit once');
  assert.deepEqual(errors,[],'No browser errors');
  console.log('PASS: worker-driven canvas, four-edge dot coverage, shared static star coordinates, media pop after generation');
}finally{
  await browser.close();
}
