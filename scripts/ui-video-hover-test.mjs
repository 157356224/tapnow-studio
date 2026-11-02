import assert from 'node:assert/strict';
import {chromium} from 'playwright';

// Fully mocked local backend: the hover test must not create/delete any real
// canvas or require an existing TapNow service.
const root=process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5173/';
const project={
    id:'hover-preview-mock',title:'TEMP_HOVER_VIDEO_TEST',
    updatedAt:new Date().toISOString(),
    nodes:[{
      id:'hover-video',type:'studio',position:{x:260,y:125},
      data:{kind:'video',title:'Video',status:'done',ratio:'16:9',duration:'5s',
        mediaUrl:'/api/uploads/test-hover-media.mp4',prompt:''}
    }],
    edges:[],viewport:{x:180,y:100,zoom:1}
};
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1450,height:910}});
try{
  await page.route('**/api/projects**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(route.request().method()==='PUT'){
      await route.fulfill({status:200,contentType:'application/json',
        body:JSON.stringify({id:project.id,updatedAt:new Date().toISOString()})});
    }else{
      await route.fulfill({status:200,contentType:'application/json',
        body:JSON.stringify(pathname==='/api/projects'
          ?[{id:project.id,title:project.title,updatedAt:project.updatedAt}]
          :project)});
    }
  });
  await page.route('**/api/doubao/accounts',r=>r.fulfill({
    status:200,contentType:'application/json',body:'[]'
  }));
  await page.route('**/api/muse/accounts',r=>r.fulfill({
    status:200,contentType:'application/json',body:'[]'
  }));
  await page.route('**/api/muse/quotas**',r=>r.fulfill({
    status:200,contentType:'application/json',
    body:JSON.stringify({totalAccounts:0,knownAccounts:0,unknownAccounts:0,
      totalCapacity:0,measuredCapacity:0,totalUsed:0,totalRemaining:0,
      rows:[],refreshedAt:Date.now(),refreshIntervalMs:60000})
  }));
  await page.route('**/api/uploads/test-hover-media.mp4',r=>r.fulfill({
    status:200,contentType:'video/mp4',body:''
  }));
  await page.addInitScript(()=>{
    window.__videoHoverEvents=[];
    HTMLMediaElement.prototype.play=function(){
      window.__videoHoverEvents.push({type:'play',muted:this.muted,tag:this.tagName});
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause=function(){
      window.__videoHoverEvents.push({type:'pause',tag:this.tagName});
    };
  });
  await page.goto(root,{waitUntil:'domcontentloaded'});
  await page.locator('.tn-project-pill button[title="切换画布"]').click();
  await page.locator('.project-list-item').filter({hasText:project.title})
    .locator('button').first().click();
  const node=page.locator('.react-flow__node[data-id="hover-video"]');
  await node.locator('video').waitFor({state:'attached',timeout:16000});
  const video=node.locator('video');
  assert.equal(await video.evaluate(el=>el.muted),false,
    'Video must start with audio enabled');
  await node.locator('.tn-node-frame').click();
  const compose=page.locator('.floating-compose').filter({
    has:page.locator('.tn-compose-editor')
  }).first();
  await compose.locator('.tn-compose-editor').waitFor({state:'visible'});
  await node.locator('.tn-node-frame').hover();
  await page.waitForTimeout(90);
  let events=await page.evaluate(()=>window.__videoHoverEvents);
  assert.ok(events.some(e=>e.type==='play'&&!e.muted&&e.tag==='VIDEO'),
    'Entering a video node must not disable video audio');
  const playsBeforeEditor=events.filter(e=>e.type==='play').length;
  const pausesBeforeEditor=events.filter(e=>e.type==='pause').length;
  await compose.locator('.tn-compose-editor').hover();
  await page.waitForTimeout(100);
  events=await page.evaluate(()=>window.__videoHoverEvents);
  assert.ok(events.filter(e=>e.type==='pause').length>pausesBeforeEditor,
    'Entering the floating input below the video must immediately pause playback');
  assert.equal(events.filter(e=>e.type==='play').length,playsBeforeEditor,
    'Hovering the video input must not trigger video playback');
  await node.locator('.tn-node-caption').hover();
  await page.waitForTimeout(60);
  events=await page.evaluate(()=>window.__videoHoverEvents);
  assert.equal(events.filter(e=>e.type==='play').length,playsBeforeEditor,
    'Hovering the video caption must not trigger video playback');
  await page.mouse.move(1290,700);
  await page.waitForTimeout(90);
  events=await page.evaluate(()=>window.__videoHoverEvents);
  assert.ok(events.some(e=>e.type==='pause'&&e.tag==='VIDEO'),
    'Leaving a video node must pause the preview');
  await node.locator('.tn-node-frame').hover();
  await page.waitForTimeout(50);
  events=await page.evaluate(()=>window.__videoHoverEvents);
  assert.ok(events.filter(e=>e.type==='play').length>=2,
    'Re-entering the video node must resume playback');
  assert.equal(await video.evaluate(el=>el.muted),false,
    'Hover exit and re-enter must preserve audio being enabled');
  console.log('PASS: hover video-only unmuted playback, input and caption pause, exit pause, re-enter resume');
}finally{
  await browser.close();
}
