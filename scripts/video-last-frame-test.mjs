import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import {extractVideoLastFrame,localVideoFilename} from '../server/video-last-frame.mjs';

assert.equal(localVideoFilename('/api/uploads/1234-5678.mp4'),'1234-5678.mp4');
for(const invalid of [
  'https://example.com/a.mp4','file:///C:/secret.mp4',
  '/api/uploads/../private.mp4','/api/uploads/%2e%2e%2fsecret.mp4',
  '/api/uploads/a.png','/api/uploads/a.mp4?x=1',null
])assert.equal(localVideoFilename(invalid),null,'Reject unsafe media source '+invalid);

const folder=fs.mkdtempSync(path.join(os.tmpdir(),'tapnow-tail-frame-'));
try{
  const filename=crypto.randomUUID()+'.mp4';
  const source=path.join(folder,filename);
  const input=[
    '-y','-hide_banner','-loglevel','error',
    '-f','lavfi','-i','color=c=blue:s=96x54:r=5:d=2',
    '-f','lavfi','-i','color=c=red:s=96x54:r=5:d=1',
    '-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map','[v]','-c:v','libx264','-pix_fmt','yuv420p',source
  ];
  const generated=spawnSync(ffmpegPath,input,{encoding:'utf8'});
  assert.equal(generated.status,0,'Could not create synthetic video: '+generated.stderr);
  const frame=await extractVideoLastFrame('/api/uploads/'+filename,{uploadDir:folder});
  assert.match(frame.url,/^\/api\/uploads\/[a-f\d-]+\.png$/);
  assert.equal(frame.width,96);
  assert.equal(frame.height,54);
  const png=path.join(folder,path.basename(frame.url));
  assert.ok(fs.statSync(png).size>200,'Must save a real PNG file');

  // Pixel check matters: grabbing an early keyframe near the end instead of
  // the final decoded frame would return BLUE, whereas the tail is RED.
  const sample=spawnSync(ffmpegPath,[
    '-hide_banner','-loglevel','error','-i',png,
    '-vf','scale=1:1','-frames:v','1',
    '-pix_fmt','rgb24','-f','rawvideo','pipe:1'
  ],{encoding:null});
  assert.equal(sample.status,0,String(sample.stderr));
  const rgb=sample.stdout.subarray(0,3);
  assert.ok(rgb[0]>190&&rgb[1]<80&&rgb[2]<80,
    'Last frame must be RED, not the BLUE starting frames: '+rgb.toString('hex'));
  assert.ok(fs.existsSync(source),'Extraction must never modify/remove the source video');

  // Exercise fast seeking on videos longer than the 10-second tail window.
  const longerName=crypto.randomUUID()+'.mp4';
  const longerSource=path.join(folder,longerName);
  const longer=spawnSync(ffmpegPath,[
    '-y','-hide_banner','-loglevel','error',
    '-f','lavfi','-i','color=c=blue:s=64x36:r=2:d=11',
    '-f','lavfi','-i','color=c=red:s=64x36:r=2:d=1',
    '-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map','[v]','-c:v','libx264','-pix_fmt','yuv420p',longerSource
  ],{encoding:'utf8'});
  assert.equal(longer.status,0,'Could not generate long video: '+longer.stderr);
  const lastLong=await extractVideoLastFrame('/api/uploads/'+longerName,{
    uploadDir:folder
  });
  assert.equal(lastLong.width,64);
  assert.equal(lastLong.height,36);
  const sampledLong=spawnSync(ffmpegPath,[
    '-hide_banner','-loglevel','error',
    '-i',path.join(folder,path.basename(lastLong.url)),
    '-vf','scale=1:1','-frames:v','1',
    '-pix_fmt','rgb24','-f','rawvideo','pipe:1'
  ],{encoding:null});
  assert.equal(sampledLong.status,0,String(sampledLong.stderr));
  assert.ok(sampledLong.stdout[0]>190&&sampledLong.stdout[1]<80&&
    sampledLong.stdout[2]<80,'Seeked tail of 12-second video must be the RED final frame');

  await assert.rejects(extractVideoLastFrame('/api/uploads/no-such-file.mp4',{
    uploadDir:folder
  }),/不存在/);
  const broken=crypto.randomUUID()+'.mp4';
  fs.writeFileSync(path.join(folder,broken),'not a video');
  const before=new Set(fs.readdirSync(folder).filter(name=>name.endsWith('.png')));
  await assert.rejects(extractVideoLastFrame('/api/uploads/'+broken,{
    uploadDir:folder
  }),/FFmpeg|没有可用/);
  const after=new Set(fs.readdirSync(folder).filter(name=>name.endsWith('.png')));
  assert.deepEqual(after,before,'Failed extraction cleans incomplete PNG outputs');
  console.log('PASS: FFmpeg true last frame on short and 12s long videos (red pixel), PNG dimensions, local-only paths, failed-output cleanup');
}finally{
  fs.rmSync(folder,{recursive:true,force:true});
}
