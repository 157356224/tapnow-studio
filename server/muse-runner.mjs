import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const allowKinds=new Set(['image','video']);
const imageResolutions=new Set(['1080p','2K','4K','8K']);
const maxVideoSeconds=10;
const sizeLimit=250*1024*1024;
const mimeExt={
  'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp',
  'image/avif':'.avif','video/mp4':'.mp4','video/webm':'.webm',
  'video/quicktime':'.mov'
};

export function buildMusePrompt(job){
  if(!allowKinds.has(job.kind))throw new Error('Muse 仅支持图片或视频生成');
  const prompt=String(job.prompt||'').trim();
  if(!prompt||prompt.length>12000)throw new Error('请输入 Muse 生成内容');
  const attached=Array.isArray(job.references)?job.references:[];
  const cleanPrompt=prompt.replace(/@图片(\d+)/g,(token)=>{
    const position=attached.findIndex(ref=>ref.token===token);
    if(position<0)throw new Error('参考图 '+token+' 尚未上传，请检查视频节点的 @ 引用');
    return '@图'+(position+1);
  });
  const ratio=String(job.ratio||'16:9');
  if(!/^\d{1,2}:\d{1,2}$/.test(ratio))throw new Error('画面比例格式错误');
  if(job.kind==='image'){
    const raw=String(job.resolution||'2K');
    const resolution=raw.toLowerCase()==='1080p'?'1080p':raw.toUpperCase();
    if(!imageResolutions.has(resolution))
      throw new Error('Muse 图片分辨率请选择 1080p、2K、4K 或 8K');
    return '请生成图片，图片画面比例 '+ratio+
      '，目标分辨率 '+resolution+'。\n'+cleanPrompt;
  }
  const seconds=Number.parseInt(job.duration,10);
  if(!/^\d{1,2}s$/.test(String(job.duration))||seconds<1||seconds>maxVideoSeconds)
    throw new Error('Muse 视频时长最多 10 秒，请选择 1–10 秒');
  return '请生成视频，时长 '+seconds+' 秒（不得超过 10 秒），视频画面比例 '+ratio+'。\n'+cleanPrompt;
}

// Muse exposes a stable test id on the "新旁聊" button. Never guess a plus
// based on its position/SVG; doing so risks posting to an existing thread.
export async function clickMuseNewConversation(page){
  await page.waitForSelector(
    'button[data-testid="hatch-chat-compose"]:visible,button[aria-label="新旁聊"]:visible',
    {state:'visible',timeout:12000}
  ).catch(()=>null);
  const selectors=[
    'button[data-testid="hatch-chat-compose"]',
    'button[aria-label="新旁聊"]'
  ];
  let button=null;
  for(const selector of selectors){
    const candidates=page.locator(selector);
    const count=Math.min(await candidates.count(),10);
    for(let i=0;i<count;i++){
      const candidate=candidates.nth(i);
      if(await candidate.isVisible().catch(()=>false)&&
          await candidate.isEnabled().catch(()=>false)){
        button=candidate;
        break;
      }
    }
    if(button)break;
  }
  if(!button){
    const err=new Error('未找到 Muse「旁聊」右侧的加号；本次未发送，避免复用旧会话');
    err.needsAttention=true;
    throw err;
  }
  await button.click({timeout:5000});
  // The new chat composer must be ready before we send the next job.
  await page.waitForSelector(
    'textarea[aria-label="消息"]:visible,textarea[placeholder="消息"]:visible,'+
    '[contenteditable="true"]:visible',
    {state:'visible',timeout:10000}
  ).catch(()=>null);
  const editor=await findMuseEditor(page);
  if(!editor){
    const err=new Error('点击「新旁聊」后未找到 Muse 输入框；本次未发送');
    err.needsAttention=true;
    throw err;
  }
  await editor.waitFor({state:'visible',timeout:5000});
  await page.waitForTimeout(250);
  return {clicked:true,source:'旁聊右侧加号'};
}

function sniffMuseMedia(buffer,declared=''){
  if(!buffer?.length)return '';
  const head=buffer.subarray(0,16);
  if(head.length>=8&&head.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))
    return 'image/png';
  if(head.length>=3&&head.subarray(0,3).equals(Buffer.from('ffd8ff','hex')))
    return 'image/jpeg';
  if(head.subarray(0,4).toString()==='RIFF'&&head.subarray(8,12).toString()==='WEBP')
    return 'image/webp';
  if(head.subarray(0,4).equals(Buffer.from('1a45dfa3','hex')))
    return 'video/webm';
  if(head.subarray(4,8).toString()==='ftyp'){
    const brand=head.subarray(8,12).toString();
    if(brand==='avif'||brand==='avis')return 'image/avif';
    if(brand==='qt  ')return 'video/quicktime';
    return 'video/mp4';
  }
  // Reject mislabeled HTML, JSON and arbitrary downloaded files.
  return '';
}

export async function findMuseEditor(page){
  const selectors=[
    'textarea[data-hatch-composer-prehydration-input="true"][aria-label="消息"]',
    'textarea[aria-label="消息"]',
    'textarea[placeholder="消息"]',
    '[contenteditable="true"][role="textbox"]',
    'textarea[placeholder]',
    'textarea',
    '[contenteditable="true"]'
  ];
  for(const selector of selectors){
    const all=page.locator(selector);
    const n=Math.min(await all.count(),30);
    for(let i=n-1;i>=0;i--){
      const e=all.nth(i);
      if(await e.isVisible().catch(()=>false)&&await e.isEnabled().catch(()=>false))return e;
    }
  }
  return null;
}

export async function uploadMuseReferences(page,references,localReferenceFile,onProgress){
  if(!references?.length)return;
  if(typeof localReferenceFile!=='function')throw new Error('Muse 未配置本地图片文件路径');
  const files=references.map(ref=>{
    const filename=localReferenceFile(ref.url);
    if(!filename||!fs.existsSync(filename))
      throw new Error('Muse 参考图不存在于本地素材库：'+ref.name);
    if(!/\.(png|jpg|jpeg|webp)$/i.test(filename))
      throw new Error('Muse 只支持 PNG、JPG、WebP 参考图：'+ref.name);
    if(fs.statSync(filename).size>30*1024*1024)
      throw new Error('单张 Muse 参考图超过 30MB：'+ref.name);
    return filename;
  });
  const editor=await findMuseEditor(page);
  if(!editor)throw new Error('Muse 消息输入框不存在，无法添加参考图片');
  // The real Muse composer has a visually hidden, multiple file input
  // alongside textarea[aria-label="消息"] in the same parent div.
  const near=editor.locator('xpath=ancestor::*[.//input[@type="file"]][1]')
    .locator('input[type="file"][multiple]');
  let input=await near.count()===1?near:page.locator('input[type="file"][multiple]');
  if(await input.count()!==1)
    throw new Error('未找到 Muse 消息框内唯一的多图上传控件；本次未提交，防止漏图');
  input=input.first();
  const before=await page.locator('img').count();
  onProgress('Muse 正在上传 '+files.length+' 张被 @ 引用的图片',15);
  await input.setInputFiles(files,{timeout:15000});
  // The site may clear the native input once it has transferred each file.
  // We need a visible preview before submitting any generation prompt.
  const deadline=Date.now()+60000;
  let confirmed=false;
  while(Date.now()<deadline){
    if(page.isClosed())throw new Error('Muse 浏览器已关闭，参考图上传中断');
    const state=await page.evaluate(({before,filenames})=>{
      const imgs=[...document.querySelectorAll('img')];
      const previews=imgs.length-before;
      const text=document.body.innerText||'';
      const named=filenames.filter(name=>text.includes(name)).length;
      const filesInput=[...document.querySelectorAll('input[type=file]')]
        .find(input=>input.multiple);
      const staged=filesInput?.files?.length||0;
      return {previews,named,staged};
    },{before,filenames:files.map(file=>path.basename(file))});
    if(state.previews>=files.length||state.named>=files.length){
      confirmed=true;break;
    }
    await page.waitForTimeout(450);
  }
  if(!confirmed)
    throw new Error('Muse 没有显示全部参考图片预览（'+files.length+
      ' 张）；本次停止发送，防止漏图生成。请检查浏览器中的上传控件');
  await page.waitForTimeout(650);
  onProgress('Muse 已显示 '+files.length+' 张参考图，准备发送提示词',20);
}

export async function sendMusePrompt(page,job){
  const editor=await findMuseEditor(page);
  if(!editor){
    const err=new Error('Muse 对话输入框不可用，请在独立 Edge 中完成登录后重试');
    err.loginRequired=true;
    throw err;
  }
  const prompt=buildMusePrompt(job);
  await editor.fill(prompt,{timeout:12000});
  const near=editor.locator('xpath=ancestor::*[self::form or contains(@class,"composer") or contains(@class,"input")][1]');
  const senders=[
    near.locator('button[type="submit"]'),
    page.getByRole('button',{name:/^发送$|^Send$|发送消息|Submit/i}),
    page.locator('button[type="submit"]')
  ];
  let submitted=false;
  for(const group of senders){
    const n=Math.min(await group.count(),30);
    for(let i=n-1;i>=0;i--){
      const button=group.nth(i);
      if(!await button.isVisible().catch(()=>false)||
          !await button.isEnabled().catch(()=>false))continue;
      await button.click({timeout:5000});
      submitted=true;break;
    }
    if(submitted)break;
  }
  if(!submitted){
    await editor.press('Enter',{timeout:5000});
  }
  // Submission is not success. Completion is confirmed only by a NEW media
  // element/download in the fresh chat after this action.
  return prompt;
}

// Never treat an arbitrary image in the Muse page as a generated output.
// The mobile-app promotion, sidebar covers and upload previews can all appear
// after the user submits a prompt. A new URL alone is not proof of generation.
const assistantMessageSelector=[
  '[data-message-author-role="assistant"]',
  '[data-message-role="assistant"]',
  '[data-role="assistant"]',
  '[data-author="assistant"]',
  '[data-sender="assistant"]',
  '[data-hatch-message-role="assistant"]',
  '[data-hatch-role="assistant"]',
  '[data-testid="assistant-message"]',
  '[data-testid*="assistant-message"]',
  '[data-testid*="message-assistant"]',
  '.assistant-message',
  '.message-assistant'
].join(',');

// Muse's current chat UI doesn't always provide a stable "assistant" role on
// the generated media card. Snapshot existing media *after* user reference
// previews have appeared but *before* prompt submission. Only media DOM nodes
// created for this generation can use the fallback path.
async function armMuseFreshMedia(page){
  await page.evaluate(()=>{
    const media=[...document.querySelectorAll('img,video')];
    window.__tapnowMuseFreshMedia={
      existing:new WeakSet(media),
      urls:new Set(media.map(el=>el.currentSrc||el.src).filter(Boolean))
    };
  });
}

async function clearMuseFreshMedia(page){
  await page.evaluate(()=>{delete window.__tapnowMuseFreshMedia;})
    .catch(()=>{});
}

function isMusePromotionalMedia(src){
  if(!src||typeof src!=='string')return true;
  try{
    const pathname=new URL(src,'https://muse.ai').pathname.toLowerCase();
    return /(?:^|\/)images\/landing\//.test(pathname)||
      /(?:^|\/)(?:hero-mobile|hero-desktop|app-download|marketing-banner)/.test(pathname)||
      /(?:^|\/)(?:marketing|promotion|onboarding)\//.test(pathname);
  }catch{return true;}
}

async function mediaCandidates(page,kind){
  return await page.evaluate(({kind,selector})=>{
    const accepted=kind==='video'?'video':'img';
    const userSelector=[
      '[data-message-author-role="user"]','[data-message-role="user"]',
      '[data-role="user"]','[data-author="user"]','[data-sender="user"]',
      '[data-testid="user-message"]','[data-hatch-role="user"]',
      '[data-hatch-message-role="user"]','.user-message'
    ].join(',');
    const composerSelector=[
      'form','[data-testid*="composer"]','[class*="composer"]'
    ].join(',');
    const editor=document.querySelector(
      'textarea[data-hatch-composer-prehydration-input],'+
      'textarea[aria-label="消息"],textarea[placeholder="消息"]');
    const editorBox=editor?.getBoundingClientRect();
    const fresh=window.__tapnowMuseFreshMedia;
    return [...document.querySelectorAll(accepted)].filter(el=>{
      const rect=el.getBoundingClientRect();
      // Muse may render a generated 2K/4K image initially as a compact
      // thumbnail; the original pixel size is verified below.
      if(rect.width<(kind==='image'?112:160)||
         rect.height<(kind==='image'?88:100))return false;
      // Reject UI, upload composer, promotion, onboarding and download-app
      // dialogs even if one of these happens to be inside a chat wrapper.
      if(el.closest('form,header,nav,aside,[role="dialog"],[aria-modal="true"],'+
        '[data-testid*="promo"],[data-testid*="onboarding"]'))return false;
      if(el.closest(userSelector))return false;
      if(kind==='image'&&!el.complete)return false;
      const assistant=Boolean(el.closest(selector));
      if(!assistant){
        // An old image or an upload preview whose CDN URL changes is never
        // a generated result. The snapshot is taken after uploads finish.
        if(!fresh||fresh.existing.has(el)||
          fresh.urls.has(el.currentSrc||el.src)||el.closest(composerSelector))
          return false;
        const inChatThread=Boolean(el.closest(
          '[data-testid*="chat-message"],[data-testid*="conversation"],'+
          '[data-testid*="message-list"],[class*="chat-messages"],'+
          '[class*="conversation"]'
        ));
        // Some Muse layouts use div-only chat markup. Limit their fresh
        // media to the conversation column above the message composer.
        const inComposerColumn=Boolean(editorBox&&
          rect.bottom<editorBox.top+90&&
          rect.left>=editorBox.left-250&&
          rect.right<=editorBox.right+350);
        if(!inChatThread&&!inComposerColumn)return false;
      }
      if(kind==='image')return el.complete&&el.naturalWidth>=256&&el.naturalHeight>=256;
      return !!(el.currentSrc||el.src);
    }).map(el=>({src:kind==='image'?el.currentSrc||el.src:el.currentSrc||el.src,
      area:el.getBoundingClientRect().width*el.getBoundingClientRect().height}));
  },{kind,selector:assistantMessageSelector}).then(list=>
    list.filter(item=>!isMusePromotionalMedia(item.src)));
}

async function captureUrl(page,src,kind){
  if(isMusePromotionalMedia(src))throw new Error('拒绝回传 Muse 宣传或非生成图片');
  if(src.startsWith('blob:')||src.startsWith('data:')){
    const result=await page.evaluate(async url=>{
      const response=await fetch(url);
      if(!response.ok)throw new Error('blob media unavailable');
      const blob=await response.blob();
      if(blob.size>50*1024*1024)throw new Error('blob media too large for inline capture');
      const bytes=new Uint8Array(await blob.arrayBuffer());
      // Chunk to avoid maximum call-stack length and huge JS arguments.
      let binary='';
      for(let i=0;i<bytes.length;i+=16384)
        binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
      return {base64:btoa(binary),mime:blob.type};
    },src);
    return {buffer:Buffer.from(result.base64,'base64'),mime:result.mime.split(';')[0]};
  }
  const url=new URL(src);
  if(!['https:','http:'].includes(url.protocol))throw new Error('不支持该媒体 URL');
  const response=await page.context().request.get(url.toString(),{timeout:60000});
  if(!response.ok())throw new Error('Muse 媒体下载失败（HTTP '+response.status()+'）');
  if(isMusePromotionalMedia(response.url()))
    throw new Error('拒绝下载跳转到 Muse 宣传图的链接');
  const mime=(response.headers()['content-type']||'').split(';')[0].toLowerCase();
  const contentLength=Number(response.headers()['content-length']||0);
  if(contentLength>sizeLimit)throw new Error('Muse 媒体超过本地 250 MB 上限');
  const buffer=await response.body();
  return {buffer,mime};
}

async function captureDownload(page,kind,candidateSources){
  // Only download from an assistant message that actually contains a media
  // result with a NEW URL. Never click an old assistant message, or a
  // site-wide "下载应用" / promotional button.
  if(!candidateSources.length)return null;
  const assistant=page.locator(assistantMessageSelector);
  const n=Math.min(await assistant.count(),60);
  for(let i=n-1;i>=0;i--){
    const message=assistant.nth(i);
    const matches=await message.evaluate((el,{sources,tag})=>
      [...el.querySelectorAll(tag)].some(media=>
        sources.includes(media.currentSrc||media.src)),
      {sources:candidateSources,tag:kind==='image'?'img':'video'}
    ).catch(()=>false);
    if(!matches)continue;
    const buttons=message.getByRole('button',{
      name:/^(?:下载|Download|下载图片|下载视频|下载原图|保存图片|保存视频|Save image|Save video|Export)$/i
    });
    const count=Math.min(await buttons.count(),12);
    for(let j=count-1;j>=0;j--){
      const candidate=buttons.nth(j);
      if(!await candidate.isVisible().catch(()=>false))continue;
      try{
        const [download]=await Promise.all([
          page.waitForEvent('download',{timeout:3500}),
          candidate.click({timeout:2500})
        ]);
        const temp=await download.path();
        if(!temp)continue;
        if(isMusePromotionalMedia(download.suggestedFilename()))continue;
        const buffer=fs.readFileSync(temp);
        const ext=path.extname(download.suggestedFilename()).toLowerCase();
        const mime=Object.entries(mimeExt).find(([,suffix])=>suffix===ext)?.[0]||'';
        if((kind==='image'&&mime.startsWith('image/'))||
            (kind==='video'&&mime.startsWith('video/')))return {buffer,mime};
      }catch{/* Keep waiting for a confirmed generated asset. */}
    }
  }
  return null;
}

export async function waitForMuseMedia(page,job,outputDir,onProgress,{
  timeoutMs=job.kind==='video'?25*60*1000:12*60*1000,
  baseline:prior
}={}){
  const baseline=new Set(prior||(await mediaCandidates(page,job.kind)).map(x=>x.src));
  const start=Date.now();
  let lastError='';
  let lastDownloadScan=0;
  while(Date.now()-start<timeoutMs){
    if(page.isClosed())throw new Error('Muse 浏览器已关闭，生成结果未取得');
    const candidates=(await mediaCandidates(page,job.kind))
      .filter(item=>item.src&&!baseline.has(item.src)&&
        !isMusePromotionalMedia(item.src))
      .sort((a,b)=>b.area-a.area);
    // Capture the generated image/video, not the existing profile avatar or
    // the prompt attachments. The conversation was reset just before send.
    for(const item of candidates){
      try{
        const result=await captureUrl(page,item.src,job.kind);
        if(!result.buffer?.length||result.buffer.length>sizeLimit)continue;
        const verifiedMime=sniffMuseMedia(result.buffer,result.mime);
        const expected=job.kind+'/';
        if(!verifiedMime.startsWith(expected))continue;
        const ext=mimeExt[verifiedMime];
        if(!ext)continue;
        fs.mkdirSync(outputDir,{recursive:true});
        const filename=crypto.randomUUID()+ext;
        fs.writeFileSync(path.join(outputDir,filename),result.buffer);
        return {mediaUrl:'/api/uploads/'+filename,mime:verifiedMime};
      }catch(err){lastError=String(err.message||err);}
    }
    if(candidates.length&&Date.now()-start>8000&&Date.now()-lastDownloadScan>12000){
      lastDownloadScan=Date.now();
      const downloaded=await captureDownload(page,job.kind,
        candidates.map(item=>item.src));
      if(downloaded?.buffer?.length&&downloaded.buffer.length<=sizeLimit){
        const verifiedMime=sniffMuseMedia(downloaded.buffer,downloaded.mime);
        if(!verifiedMime.startsWith(job.kind+'/'))continue;
        const ext=mimeExt[verifiedMime];
        if(ext){
          const filename=crypto.randomUUID()+ext;
          fs.mkdirSync(outputDir,{recursive:true});
          fs.writeFileSync(path.join(outputDir,filename),downloaded.buffer);
          return {mediaUrl:'/api/uploads/'+filename,mime:verifiedMime};
        }
      }
    }
    const elapsed=Math.round((Date.now()-start)/1000);
    if(elapsed%20<3)onProgress('Muse 正在生成，等待图片/视频出现在新会话',35);
    await page.waitForTimeout(1800);
  }
  throw new Error('Muse 已收到生成操作，但未能确认新会话中由助手生成的媒体；'+
    '已排除官网宣传图、下载应用弹窗及参考图，避免错误回传。'+
    (lastError?'（'+lastError.slice(0,120)+'）':'')+'浏览器保留供检查');
}

export async function runMuseBrowser({page,job,outputDir,onProgress,localReferenceFile}){
  buildMusePrompt(job);
  onProgress('正在新建 Muse 会话',8);
  // Must click the PLUS before every independent generation.
  await clickMuseNewConversation(page);
  onProgress('正在发送 Muse '+(job.kind==='video'?'视频':'图片')+'生成指令',18);
  await uploadMuseReferences(page,job.references||[],localReferenceFile,onProgress);
  // Uploaded reference thumbnails must NEVER be mistaken for a generated
  // output. Snapshot the chat media only after attachment previews exist.
  const baseline=(await mediaCandidates(page,job.kind)).map(x=>x.src);
  await armMuseFreshMedia(page);
  try{
    await sendMusePrompt(page,job);
    onProgress('Muse 已触发生成，等待媒体结果',30);
    return await waitForMuseMedia(page,job,outputDir,onProgress,{baseline});
  }finally{
    await clearMuseFreshMedia(page);
  }
}
