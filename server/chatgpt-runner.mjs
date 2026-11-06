import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_IMAGE_BYTES=35*1024*1024;
const imageExt={
  'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp',
  'image/avif':'.avif'
};

/** Only read percentages rendered by the *current assistant response*.
 * The recorded chatgpt.com HAR contains no stream body: numeric progress is
 * only trustworthy when visible on the live page. Never synthesize it. */
export async function readChatGPTImageState(page){
  return page.evaluate(()=>{
    const sections=[...document.querySelectorAll(
      '[data-message-author-role="assistant"],article[data-testid^="conversation-turn"]'
    )].filter(el=>el.getAttribute('data-message-author-role')==='assistant'||
      el.querySelector('[data-message-author-role="assistant"]'));
    const region=sections.at(-1)||document.body;
    let progress=null;
    const bars=region.querySelectorAll('[role="progressbar"][aria-valuenow]');
    for(const bar of bars){
      const value=Number(bar.getAttribute('aria-valuenow'));
      if(Number.isInteger(value)&&value>=0&&value<=100)progress=value;
    }
    if(progress===null){
      for(const element of region.querySelectorAll(
        'span,small,div[aria-label],div[role="status"],button'
      )){
        if(element.children.length>2)continue;
        const value=element.textContent?.trim()||'';
        if(/^(?:[1-9]?\d|100)\s*%$/.test(value)){
          const rect=element.getBoundingClientRect();
          if(rect.width>0&&rect.height>0)
            progress=Number.parseInt(value,10);
        }
      }
    }
    const candidates=[...region.querySelectorAll('img')].filter(img=>{
      const box=img.getBoundingClientRect();
      return img.complete&&img.naturalWidth>=256&&img.naturalHeight>=256&&
        box.width>=100&&box.height>=85;
    });
    const img=candidates.at(-1)||null;
    const stop=!!document.querySelector(
      'button[data-testid="stop-button"],button[aria-label="Stop streaming"],'+
      'button[aria-label="停止生成"],button[aria-label="停止回答"]'
    );
    return {
      assistantCount:document.querySelectorAll(
        '[data-message-author-role="assistant"]'
      ).length,
      progress,image:img?{
      url:img.currentSrc||img.src,
      width:img.naturalWidth,height:img.naturalHeight
      }:null,stop
    };
  });
}

async function extractImageBytes(page,source){
  const url=source.url;
  if(url.startsWith('data:image/')){
    const match=/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(url);
    if(!match)throw new Error('ChatGPT 返回的图片数据格式错误');
    return {mime:match[1],bytes:Buffer.from(match[2],'base64')};
  }
  if(url.startsWith('blob:')){
    const data=await page.evaluate(async(imageUrl)=>{
      const response=await fetch(imageUrl);
      if(!response.ok)throw new Error('ChatGPT Blob 图片下载失败');
      const blob=await response.blob();
      return await new Promise((resolve,reject)=>{
        const reader=new FileReader();
        reader.onerror=()=>reject(new Error('读取生成图片失败'));
        reader.onload=()=>resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    },url);
    const match=/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(String(data));
    if(!match)throw new Error('ChatGPT Blob 图片内容异常');
    return {mime:match[1],bytes:Buffer.from(match[2],'base64')};
  }
  const target=new URL(url,'https://chatgpt.com');
  if(target.protocol!=='https:'||![
    'chatgpt.com','files.oaiusercontent.com','oaiusercontent.com'
  ].some(host=>target.hostname===host||
    target.hostname.endsWith('.'+host))){
    throw new Error('ChatGPT 图片来源不是可信的 ChatGPT 文件服务');
  }
  const response=await page.context().request.get(target.toString(),{
    timeout:60000,maxRedirects:3
  });
  if(!response.ok())throw new Error('ChatGPT 原图下载失败：HTTP '+response.status());
  const bytes=await response.body();
  return {mime:(response.headers()['content-type']||'').split(';')[0].toLowerCase(),bytes};
}

export async function saveChatGPTImage(page,image,outputDir){
  const {mime,bytes}=await extractImageBytes(page,image);
  if(bytes.length<64||bytes.length>MAX_IMAGE_BYTES)
    throw new Error('ChatGPT 返回的图片大小不正常');
  const isPng=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const isJpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  const isWebp=bytes.toString('ascii',0,4)==='RIFF'&&
    bytes.toString('ascii',8,12)==='WEBP';
  const isAvif=bytes.toString('ascii',4,8)==='ftyp'&&
    bytes.toString('ascii',8,16).includes('avif');
  const ext=isPng?'.png':isJpg?'.jpg':isWebp?'.webp':isAvif?'.avif':null;
  if(!ext||!(mime in imageExt||mime==='application/octet-stream'||mime===''))
    throw new Error('ChatGPT 返回的文件不是可识别的图片');
  const name=crypto.randomUUID()+ext;
  const dest=path.join(outputDir,name);
  fs.writeFileSync(dest,bytes,{flag:'wx'});
  return {mediaUrl:'/api/uploads/'+name,
    width:image.width,height:image.height};
}

const inputSelector='#prompt-textarea,[data-testid="composer-input"][contenteditable="true"],'+
  '[contenteditable="true"][role="textbox"],textarea[placeholder*="Message"],'+
  'textarea[placeholder*="消息"]';

export async function runChatGPTBrowser({
  page,job,outputDir,onProgress,
  navigate=true,intervalMs=500,timeoutMs=12*60*1000,
  references=[]
}){
  if(typeof job.prompt!=='string'||!job.prompt.trim()||job.prompt.length>32000)
    throw new Error('ChatGPT 图片提示词长度必须为 1–32000 字符');
  if(navigate){
    await page.goto('https://chatgpt.com/',{
      waitUntil:'domcontentloaded',timeout:45000
    });
  }
  const input=page.locator(inputSelector).first();
  if(!await input.waitFor({state:'visible',timeout:25000}).then(()=>true).catch(()=>false))
    throw new Error('ChatGPT 尚未登录，或未加载输入框。请先打开独立 Edge 手动登录');
  const baseline=await page.evaluate(()=>({
    assistantCount:document.querySelectorAll(
      '[data-message-author-role="assistant"]'
    ).length,
    imageUrls:[...document.querySelectorAll('img')]
      .map(img=>img.currentSrc||img.src)
  }));
  const existingImages=new Set(baseline.imageUrls);
  // The page never receives HAR cookies, tokens or authentication headers.
  if(references.length){
    const attach=page.locator('input[type="file"]').first();
    if(!await attach.count())
      throw new Error('当前 ChatGPT 页面未提供文件上传控件，无法引用画布图片');
    await attach.setInputFiles(references.map(ref=>ref.file));
    await page.waitForTimeout(1400);
  }
  const instructions='请直接生成一张图片，不要只输出画面描述。'+
    '画面比例 '+(job.ratio||'2:3')+'。';
  const prompt=job.prompt.trim().replace(/@图片(\d+)/g,(_,number)=>
    '已上传的参考图片 '+number);
  await input.fill(instructions+'\n'+prompt);
  const send=page.locator(
    'button[data-testid="send-button"],button[aria-label="Send prompt"],'+
    'button[aria-label="发送消息"],button[aria-label="发送"]'
  ).first();
  if(await send.isVisible().catch(()=>false)&&await send.isEnabled().catch(()=>false))
    await send.click();
  else await input.press('Enter');
  onProgress?.({status:'running',progress:null,message:'ChatGPT 已发送提示词，等待生图状态'});
  const began=Date.now();
  let seenProgress=null,stableImage=null,stableCount=0;
  while(Date.now()-began<timeoutMs){
    if(page.isClosed())throw new Error('ChatGPT 浏览器页面被关闭');
    const state=await readChatGPTImageState(page);
    // In an existing conversation, wait for a NEW assistant reply, not a
    // percentage or image left over from a prior completed generation.
    const isCurrentReply=state.assistantCount>baseline.assistantCount||
      (baseline.assistantCount===0&&state.assistantCount===0);
    if(isCurrentReply&&state.progress!==null&&state.progress!==seenProgress){
      // Exact UI percentage only. No timer-based estimations.
      seenProgress=state.progress;
      onProgress?.({status:'running',progress:state.progress,
        message:'ChatGPT 生图 '+state.progress+'%'});
    }
    if(isCurrentReply&&state.image&&
      !existingImages.has(state.image.url)&&!state.stop){
      if(stableImage===state.image.url)stableCount++;
      else{stableImage=state.image.url;stableCount=1;}
      if(stableCount>=2){
        const saved=await saveChatGPTImage(page,state.image,outputDir);
        onProgress?.({status:'completed',progress:100,
          message:'ChatGPT 图片已保存到本地画布'});
        return saved;
      }
    }else{stableImage=null;stableCount=0;}
    await page.waitForTimeout(intervalMs);
  }
  throw new Error('ChatGPT 生图等待超时，请在独立 Edge 中检查结果');
}
