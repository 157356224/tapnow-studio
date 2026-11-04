import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';

// Only operate on a local uploaded/generated video. Never fetch arbitrary
// URLs or let a user-provided mediaUrl become a filesystem path.
export function localVideoFilename(mediaUrl){
  if(typeof mediaUrl!=='string')return null;
  const match=/^\/api\/uploads\/([a-z0-9][a-z0-9._-]{0,150}\.(?:mp4|mov|webm|ogg|m4v))$/i.exec(mediaUrl);
  return match?.[1]||null;
}

async function runFfmpeg(binary,args){
  await new Promise((resolve,reject)=>{
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),120000);
    let stderr='';
    let settled=false;
    const done=(error)=>{
      if(settled)return;
      settled=true;
      clearTimeout(timeout);
      if(error)reject(error);else resolve();
    };
    let child;
    try{
      child=spawn(binary,args,{
        windowsHide:true,signal:controller.signal,
        stdio:['ignore','ignore','pipe']
      });
    }catch(error){done(error);return;}
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data',chunk=>{
      stderr=(stderr+chunk).slice(-2800);
    });
    child.once('error',error=>done(error.name==='AbortError'
      ?new Error('视频尾帧提取超时'):error));
    child.once('close',code=>done(code===0?null:
      new Error('FFmpeg 尾帧解码失败：'+(stderr.trim()||'退出码 '+code))));
  });
}

/** Save the last *decoded* frame, not the first frame near the video end. */
export async function extractVideoLastFrame(mediaUrl,{
  uploadDir,ffmpegPath=process.env.TAPNOW_FFMPEG_PATH||ffmpegStatic
}={}){
  const filename=localVideoFilename(mediaUrl);
  if(!filename)throw new Error('请先生成或上传本地视频，再提取尾帧');
  if(!uploadDir)throw new Error('缺少素材存储目录');
  if(!ffmpegPath)throw new Error('未找到 FFmpeg，请重新安装项目依赖');

  const source=path.join(uploadDir,filename);
  let stat;
  try{stat=await fs.stat(source);}
  catch{throw new Error('原始视频文件不存在，请重新上传或生成');}
  if(!stat.isFile()||stat.size===0)
    throw new Error('原始视频文件为空或不可读取');

  const outputName=crypto.randomUUID()+'.png';
  const destination=path.join(uploadDir,outputName);
  const args=(nearEnd)=>[
    '-y','-hide_banner','-loglevel','error',
    ...(nearEnd?['-sseof','-10']:[]),
    '-i',source,'-map','0:v:0','-an','-sn',
    '-fps_mode','passthrough','-f','image2','-update','1',destination
  ];
  try{
    // Limit normal videos to decoding their final 10 seconds. Seek can fail
    // for shorter clips or unusual containers, so retry with a full decode.
    try{
      await runFfmpeg(ffmpegPath,args(true));
      await fs.stat(destination);
    }catch(error){
      if(error instanceof Error&&/超时/.test(error.message))throw error;
      await fs.rm(destination,{force:true});
      await runFfmpeg(ffmpegPath,args(false));
    }
    const image=await fs.readFile(destination);
    const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
    if(image.length<24||!image.subarray(0,8).equals(pngSignature))
      throw new Error('视频没有可用的尾帧画面');
    const width=image.readUInt32BE(16),height=image.readUInt32BE(20);
    if(!width||!height)throw new Error('无法获取尾帧尺寸');
    return {
      url:'/api/uploads/'+outputName,
      name:path.parse(filename).name+'-尾帧.png',
      width,height
    };
  }catch(error){
    await fs.rm(destination,{force:true}).catch(()=>{});
    throw error;
  }
}
