import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {chromium} from 'playwright';
import ffmpegPath from 'ffmpeg-static';
import {convertMp3ToMp4} from '../server/mp3-to-mp4.mjs';
import {uploadAudioReference} from '../server/doubao-runner.mjs';

const folder=fs.mkdtempSync(path.join(os.tmpdir(),'tapnow-mp3-test-'));
const source=path.join(folder,crypto.randomUUID()+'.mp3');
const generate=spawnSync(ffmpegPath,[
  '-y','-hide_banner','-loglevel','error',
  '-f','lavfi','-i','sine=frequency=440:duration=1.2',
  '-c:a','libmp3lame','-q:a','6',source
],{encoding:'utf8'});
assert.equal(generate.status,0,'Failed to make test MP3: '+generate.stderr);

let browser;
try{
  const tempBefore=new Set(fs.readdirSync(os.tmpdir()).filter(x=>x.startsWith('tapnow-audio-mp4-')));
  const converted=await convertMp3ToMp4(source);
  try{
    assert.equal(path.extname(converted.filename),'.mp4');
    const inspect=spawnSync(ffmpegPath,['-hide_banner','-i',converted.filename],{encoding:'utf8'});
    assert.match(inspect.stderr,/Video:\s+h264/i,'MP4 must contain a real H.264 picture track');
    assert.match(inspect.stderr,/Audio:\s+aac/i,'MP4 must contain a real AAC audio track');
    assert.ok(fs.statSync(converted.filename).size>1000);
  }finally{
    await converted.cleanup();
  }

  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage();
  let uploadedBytes;
  let uploadedType;
  await page.route('https://mp4-upload.local/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/test'){
      await route.fulfill({contentType:'text/html',body:[
        '<input id="video" type="file" accept="video/mp4,video/*">',
        '<div id="attachments"></div><script>',
        'document.querySelector("#video").onchange=async event=>{',
        ' const file=event.target.files[0];',
        ' await fetch("/alice/resource/prepare_upload",{method:"POST"});',
        ' await fetch("/upload/v1/reference",{method:"POST",body:file});',
        ' await fetch("/resource/pre_handle",{method:"POST"});',
        ' const player=document.createElement("video");',
        ' player.dataset.filename=file.name;',
        ' document.querySelector("#attachments").append(player);',
        '};</script>'
      ].join('')});
    }else{
      if(url.pathname==='/upload/v1/reference'){
        uploadedType=route.request().headers()['content-type'];
        uploadedBytes=route.request().postDataBuffer();
      }
      await route.fulfill({status:200,body:'OK'});
    }
  });
  await page.goto('https://mp4-upload.local/test');
  await uploadAudioReference(page,{
    kind:'audio',name:'角色台词',token:'@音频1',url:'/api/uploads/test.mp3'
  },()=>source,()=>{});
  assert.ok(uploadedBytes?.length>1000,'Converted MP4 must reach upload endpoint');
  assert.equal(uploadedBytes.subarray(4,8).toString('ascii'),'ftyp');
  assert.match(uploadedType||'',/video\/mp4/);
  const uploadedName=await page.locator('#attachments video').getAttribute('data-filename');
  assert.match(uploadedName,/\.mp4$/i);
  assert.ok(fs.existsSync(source),'Original MP3 must not be deleted or renamed');
  const tempAfter=fs.readdirSync(os.tmpdir()).filter(x=>x.startsWith('tapnow-audio-mp4-'));
  assert.deepEqual(tempAfter.filter(x=>!tempBefore.has(x)),[],
    'Temporary converted videos must be cleaned up after upload');
  console.log('PASS: actual MP3→H.264/AAC MP4, Doubao video picker, MP4 bytes uploaded, original preserved, temporary cleaned');
}finally{
  await browser?.close();
  fs.rmSync(folder,{recursive:true,force:true});
}
