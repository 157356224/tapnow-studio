import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {chromium} from 'playwright';
import ffmpegPath from 'ffmpeg-static';

const work=fs.mkdtempSync(path.join(os.tmpdir(),'tapnow-frame-ui-'));
const clip=path.join(work,'clip.mp4');
const make=spawnSync(ffmpegPath,[
  '-y','-hide_banner','-loglevel','error',
  '-f','lavfi','-i','color=c=blue:s=160x90:r=10:d=2',
  '-f','lavfi','-i','color=c=red:s=160x90:r=10:d=1',
  '-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]',
  '-map','[v]','-c:v','libx264','-pix_fmt','yuv420p',
  '-movflags','+faststart',clip
],{encoding:'utf8'});
assert.equal(make.status,0,'Create fixture video: '+make.stderr);
const bytes=fs.readFileSync(clip);
const png=path.join(work,'frame.png');
const makePng=spawnSync(ffmpegPath,[
  '-y','-hide_banner','-loglevel','error','-i',clip,
  '-ss','2.2','-frames:v','1',png
],{encoding:'utf8'});
assert.equal(makePng.status,0,'Create fixture PNG: '+makePng.stderr);
const image=fs.readFileSync(png);

const base=process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5173/';
const now=new Date().toISOString();
const videoUrl='/api/uploads/ui-frame-editor-video.mp4';
const imageUrl='/api/uploads/ui-frame-editor-output.png';
const project={
  id:'video-frame-editor-test',title:'Video frame timeline regression',
  updatedAt:now,viewport:{x:100,y:85,zoom:.92},
  nodes:[
    {id:'video-source',type:'studio',position:{x:110,y:110},
      data:{kind:'video',title:'独立画面',status:'done',demo:false,
        mediaUrl:videoUrl,prompt:'',ratio:'16:9',provider:'doubao'}},
    {id:'video-empty',type:'studio',position:{x:90,y:560},
      data:{kind:'video',title:'空视频',status:'idle',demo:false,
        ratio:'16:9',provider:'doubao'}}
  ],edges:[]
};
const errors=[];
let extracts=[];
let saved=0;
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1800,height:1040}});
page.setDefaultTimeout(12000);
page.on('pageerror',error=>errors.push(error.message));
const send=(route,data,status=200)=>route.fulfill({
  status,contentType:'application/json',body:JSON.stringify(data)
});
try{
  await page.route('**/api/**',async route=>{
    const request=route.request();
    const pathname=new URL(request.url()).pathname;
    if(pathname==='/api/projects')return send(route,[
      {id:project.id,title:project.title,updatedAt:now}
    ]);
    if(pathname==='/api/projects/'+project.id){
      if(request.method()==='PUT'){
        const body=request.postDataJSON();
        project.nodes=body.nodes;project.edges=body.edges;saved++;
        return send(route,{id:project.id,updatedAt:now});
      }
      return send(route,project);
    }
    if(pathname==='/api/videos/extract-frame'){
      extracts.push(request.postDataJSON());
      assert.equal(request.method(),'POST');
      assert.equal(extracts.at(-1).mediaUrl,videoUrl);
      await new Promise(resolve=>setTimeout(resolve,250));
      return send(route,{
        url:imageUrl,name:'extracted-2s.png',
        width:160,height:90,seconds:extracts.at(-1).seconds
      },201);
    }
    if(pathname==='/api/uploads/ui-frame-editor-video.mp4'){
      const range=request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
      const start=range?Number(range[1]):0;
      const end=range&&range[2]?Math.min(bytes.length-1,Number(range[2])):
        bytes.length-1;
      return route.fulfill({
        status:range?206:200,contentType:'video/mp4',
        headers:{
          'accept-ranges':'bytes',
          'content-length':String(end-start+1),
          ...(range?{'content-range':'bytes '+start+'-'+end+'/'+bytes.length}:{})
        },
        body:bytes.subarray(start,end+1)
      });
    }
    if(pathname==='/api/uploads/ui-frame-editor-output.png')
      return route.fulfill({status:200,contentType:'image/png',body:image});
    if(pathname==='/api/muse/quotas')return send(route,{
      totalAccounts:0,knownAccounts:0,unknownAccounts:0,
      totalCapacity:0,totalUsed:0,totalRemaining:0,rows:[],refreshing:false
    });
    return send(route,[]);
  });
  await page.goto(base,{waitUntil:'domcontentloaded'});
  const video=page.locator('.react-flow__node[data-id="video-source"]');
  const empty=page.locator('.react-flow__node[data-id="video-empty"]');
  await empty.waitFor({state:'visible',timeout:17000});
  await video.locator('.tn-node-caption').click();
  assert.equal(await empty.getByRole('button',{name:'提取指定视频帧'}).count(),0,
    'Empty video has no frame-editor action');
  const open=page.getByRole('button',{name:'提取指定视频帧'});
  await open.waitFor({state:'visible'});
  await open.click();
  const dialog=page.getByRole('dialog',{name:'视频帧编辑器'});
  await dialog.waitFor({state:'visible'});
  const slider=dialog.getByRole('slider',{name:'视频时间轴'});
  await page.waitForFunction(()=>Number(document.querySelector(
    '[aria-label="视频时间轴"]')?.max)>2.8);
  assert.ok(await dialog.locator('video').count()===1,
    'Editor shows original video preview');
  const timeline=dialog.locator('.tn-frame-timeline');
  const box=await timeline.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x+box.width*.25,box.y+box.height*.54);
  await page.mouse.down();
  await page.mouse.move(box.x+box.width*.74,box.y+box.height*.54,{steps:8});
  await page.mouse.up();
  const chosen=Number(await slider.inputValue());
  assert.ok(chosen>1.8&&chosen<2.7,
    'Drag must move pointer to selected video time: '+chosen);
  const previewTime=await dialog.locator('video').evaluate(el=>el.currentTime);
  assert.ok(Math.abs(previewTime-chosen)<.15,
    'Preview must seek together with draggable timeline');
  assert.ok(await dialog.locator('.tn-frame-playhead').count()===1,
    'One timeline playhead is shown');
  const screenshot=path.resolve('work','ui-video-frame-editor.png');
  fs.mkdirSync(path.dirname(screenshot),{recursive:true});
  await page.screenshot({path:screenshot});
  await dialog.getByRole('button',{name:'提取当前帧到画布'}).click();
  await dialog.waitFor({state:'detached',timeout:7000});
  assert.equal(extracts.length,1);
  assert.ok(Math.abs(extracts[0].seconds-chosen)<.04,
    'The FFmpeg extraction request receives the user-selected time');
  const newImage=page.locator('.react-flow__node').filter({
    has:page.locator('img[src="'+imageUrl+'"]')
  });
  await newImage.waitFor({state:'visible'});
  await page.waitForTimeout(1250);
  assert.ok(saved>0,'Extracted frame is autosaved to canvas');
  const produced=project.nodes.find(node=>node.data.mediaUrl===imageUrl);
  assert.ok(produced);
  assert.equal(produced.data.kind,'image');
  assert.equal(produced.data.status,'done');
  assert.equal(produced.data.demo,false);
  assert.equal(produced.data.mediaWidth,160);
  assert.equal(produced.data.mediaHeight,90);
  assert.equal(project.edges.length,0,'Selected frame must not auto-connect');
  assert.equal(project.nodes.find(node=>node.id==='video-source').data.mediaUrl,
    videoUrl,'Original video remains unchanged');
  await video.locator('.tn-node-caption').click();
  await open.click();
  await dialog.waitFor({state:'visible'});
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'detached'});
  assert.equal(project.nodes.length,3,'Cancel must not create a new node');
  assert.deepEqual(errors,[],'No browser errors');
  console.log('PASS: selected video top action, preview + drag thumbnail timeline + playhead, accurate seconds, auto-close, persisted independent image, no connection, Esc cancel');
  console.log('SCREENSHOT='+screenshot);
}finally{
  await browser.close();
  fs.rmSync(work,{recursive:true,force:true});
}
