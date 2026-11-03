import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';

/**
 * Build a genuine MP4 video with an H.264 picture track and AAC audio.
 * Merely renaming an MP3 to .mp4 does not create a valid video attachment.
 *
 * The uploaded video is temporary; the original audio node stays unchanged.
 */
export async function convertMp3ToMp4(source, options={}){
  if(path.extname(source).toLowerCase()!=='.mp3')
    throw new Error('只有 MP3 音频需要转换成 MP4');
  const binary=options.ffmpegPath||process.env.TAPNOW_FFMPEG_PATH||ffmpegStatic;
  if(!binary)throw new Error('未找到 FFmpeg，请重新安装项目依赖');
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'tapnow-audio-mp4-'));
  const filename=path.join(folder,path.basename(source).replace(/\.mp3$/i,'.mp4'));
  const cleanup=async()=>fs.rm(folder,{recursive:true,force:true});
  try{
    await new Promise((resolve,reject)=>{
      const child=spawn(binary,[
        '-y','-hide_banner','-loglevel','error',
        '-f','lavfi','-i','color=c=0x121923:s=320x180:r=1',
        '-i',source,
        '-map','0:v:0','-map','1:a:0',
        '-c:v','libx264','-preset','ultrafast',
        '-pix_fmt','yuv420p',
        '-c:a','aac','-b:a','160k',
        '-shortest','-movflags','+faststart',
        filename
      ],{windowsHide:true,stdio:['ignore','ignore','pipe']});
      let stderr='';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data',chunk=>{stderr=(stderr+chunk).slice(-2500);});
      child.once('error',reject);
      child.once('close',code=>{
        if(code===0)resolve();
        else reject(new Error('FFmpeg 转换失败（退出码 '+code+'）：'+stderr.trim()));
      });
    });
    const stat=await fs.stat(filename);
    if(stat.size<1000)throw new Error('FFmpeg 生成的 MP4 文件为空或不完整');
    return {filename,cleanup};
  }catch(error){
    await cleanup();
    throw error;
  }
}
