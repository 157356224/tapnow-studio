// Mock every application API request. Never reads or mutates a real project.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';

const base=process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5173/';
const project={
  id:'mock-video-model-menu',title:'Video model menu test',
  updatedAt:new Date().toISOString(),
  viewport:{x:350,y:175,zoom:1},
  nodes:[{id:'model-node',type:'studio',position:{x:140,y:140},data:{
    kind:'video',title:'Video',status:'done',demo:false,
    model:'Wan 2.6',prompt:'镜头缓慢移动',ratio:'16:9',duration:'5s',
    mediaUrl:'/api/uploads/mock-video.mp4'
  }}],edges:[]
};
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
try{
  await page.route('**/api/projects**',route=>{
    const req=route.request();
    const pathname=new URL(req.url()).pathname;
    const result=pathname==='/api/projects'
      ?[{id:project.id,title:project.title,updatedAt:project.updatedAt}]
      :req.method()==='PUT'?{id:project.id,updatedAt:project.updatedAt}:project;
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
  });
  await page.route('**/api/doubao/accounts',route=>route.fulfill({
    status:200,contentType:'application/json',body:'[]'
  }));
  await page.route('**/api/uploads/mock-video.mp4',route=>route.fulfill({
    status:200,contentType:'video/mp4',body:''
  }));
  await page.goto(base,{waitUntil:'domcontentloaded'});
  const frame=page.locator('.react-flow__node[data-id="model-node"] .tn-node-frame');
  await frame.waitFor({state:'visible',timeout:12000});
  const video=frame.locator('video');
  assert.equal(await video.evaluate(v=>v.disablePictureInPicture),true);
  assert.equal(await video.evaluate(v=>v.disableRemotePlayback),true);
  await frame.click();
  const toggle=page.locator('.floating-compose .tn-video-model-picker>button');
  await toggle.waitFor({state:'visible',timeout:5000});
  assert.match(await toggle.innerText(),/Seedance 2.0 Mini/,
    'Old persisted unavailable model must migrate to Mini');
  await toggle.click();
  const menu=page.getByRole('listbox',{name:'视频模型'});
  await menu.waitFor({state:'visible',timeout:5000});
  assert.equal(await menu.getByRole('option').count(),2);
  const mini=menu.getByRole('option',{name:/Seedance 2.0 Mini/});
  assert.equal(await mini.getAttribute('aria-selected'),'true');
  for(const removed of ['Kling 4.0','Wan 2.6','Hailuo-02','Vidu Q2','Seedance 2.0']){
    assert.equal(await menu.getByRole('option',{name:removed,exact:true}).count(),0,
      removed+' must be removed');
  }
  assert.equal(await menu.evaluate(el=>getComputedStyle(el).animationName),'tn-settings-open',
    'Model popover must reuse the aspect/duration opening animation');
  const screenshot=path.resolve('work','ui-video-model-menu.png');
  fs.mkdirSync(path.dirname(screenshot),{recursive:true});
  await page.screenshot({path:screenshot});
  await toggle.click();
  const closing=page.locator('.tn-video-model-menu.tn-settings-closing');
  await closing.waitFor({state:'attached'});
  assert.equal(await closing.evaluate(el=>getComputedStyle(el).animationName),'tn-settings-close',
    'Model popover must reuse the aspect/duration closing animation');
  await closing.waitFor({state:'detached',timeout:3000});
  await toggle.click();
  await menu.getByRole('option',{name:/Seedance 2.0 Fast/}).click();
  assert.match(await toggle.innerText(),/Seedance 2.0 Fast/);
  await menu.waitFor({state:'detached',timeout:3000});
  await toggle.click();
  await menu.getByRole('option',{name:/Seedance 2.0 Mini/}).click();
  assert.match(await toggle.innerText(),/Seedance 2.0 Mini/);
  console.log('PASS: 2 Seedance models only, matching aspect/duration opening and closing animation, Fast/Mini switching, browser video PiP disabled');
  console.log('SCREENSHOT='+screenshot);
}finally{
  await browser.close();
}
