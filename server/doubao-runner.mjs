import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {convertMp3ToMp4} from './mp3-to-mp4.mjs';
import {
  findVideoIds,getSignedVideoDownload,inspectVideoSubmission,
  parseSseEvents,validateImageReferences,validateMediaReferences,validateObservedSubmission
} from './doubao-protocol.mjs';
import {
  selectSeedanceModel,clickFirstVisible,clickVisibleOption,ensureVideoGenerationMode
} from './doubao-controls.mjs';
import {setVideoDuration} from './doubao-duration.mjs';
import {findSendButton,submitAndObserve} from './doubao-submit.mjs';
import {
  hasVideoConfirmationInResponse,inspectVideoStartReply,assertVideoStartReply,
  watchNewVideoConfirmation
} from './doubao-confirmation.mjs';
import {
  watchNewVideoCompletion,revealVideoDownloadControl,
  findVideoDownloadControl,openFreshVideoPreview
} from './doubao-completed-video.mjs';

const doubaoPath=(request,pathPart)=>{
  try{return new URL(request.url()).pathname===pathPart}catch{return false;}
};
const visible=async locator=>{
  const count=Math.min(await locator.count(),25);
  for(let i=0;i<count;i++)
    if(await locator.nth(i).isVisible().catch(()=>false))return true;
  return false;
};

async function clickOption(page,names){
  return clickVisibleOption(page,names);
}

async function expandMenu(page,patterns){
  return clickFirstVisible(page,patterns);
}

async function setOption(page,description,patterns,optionNames){
  // The current video composer shows a combined control, e.g.
  // "自动 · 10s" (ratio + duration). Older layouts had separate controls.
  const combined=/(?:自动|\d{1,2}:\d{1,2})\s*[·•]\s*\d+\s*(?:s|秒)/i;
  const clicked=await expandMenu(page,[...patterns,combined]);
  if(!clicked)throw new Error('找不到豆包 '+description+' 设置入口（也未找到「自动 · 10s」参数菜单）');
  if(!await clickOption(page,optionNames))
    throw new Error('豆包网页未提供选项：'+optionNames[0]);
}

export async function configureVideo(page,job){
  // Explicitly activate video mode from the generic composer if needed.
  // A visible "视频生成" label alone never proves the mode is active.
  await ensureVideoGenerationMode(page);
  await selectSeedanceModel(page,job.model||'Seedance 2.0 Mini');

  await setOption(page,'画面比例',[/画面比例|宽高比|比例/,/^\d+:\d+$/],[job.ratio]);
  await setVideoDuration(page,job.duration);
}

function observeImageUpload(page){
  const prepared=[],stored=[],handled=[];
  const listener=response=>{
    if(response.request().method()!=='POST')return;
    let pathname;
    try{pathname=new URL(response.url()).pathname;}catch{return;}
    if(pathname==='/alice/resource/prepare_upload')prepared.push(response);
    if(pathname.includes('/upload/v1/'))stored.push(response);
    if(pathname.includes('/resource/pre_handle'))handled.push(response);
  };
  page.on('response',listener);
  return {prepared,stored,handled,close:()=>page.off('response',listener)};
}
async function waitForNewResponse(page,items,previous=0,timeout=15000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    if(items.length>previous)return items.at(-1);
    await page.waitForTimeout(120);
  }
  return null;
}
async function imageInputs(page){
  const inputs=page.locator('input[type="file"]');
  const candidates=await inputs.evaluateAll(elements=>elements.map((el,index)=>({
    index,accept:(el.getAttribute('accept')||'').toLowerCase(),
    disabled:el.disabled
  })));
  return candidates.filter(x=>!x.disabled).map(x=>({
    ...x,score:/image\/|\.png|\.jpe?g|\.webp/.test(x.accept)?100:
      /^(video|audio)\//.test(x.accept)?-1:10
  })).filter(x=>x.score>=0).sort((a,b)=>b.score-a.score||b.index-a.index)
    .map(x=>inputs.nth(x.index));
}
export async function uploadReference(page,ref,localReferenceFile,onProgress){
  const filename=localReferenceFile(ref.url);
  if(!filename)throw new Error('图片节点不是本地上传素材：'+ref.name);
  const ext=path.extname(filename).toLowerCase();
  if(!['.jpg','.jpeg','.png','.webp'].includes(ext))
    throw new Error('参考图片仅支持 PNG、JPG、WebP：'+ref.name);
  const monitor=observeImageUpload(page);
  const previousImages=await page.locator('img').count();
  try{
    let inputs=await imageInputs(page);
    let selected=false;
    if(!inputs.length){
      const chooser=page.waitForEvent('filechooser',{timeout:3000}).catch(()=>null);
      if(!await expandMenu(page,[/上传|添加参考|参考素材|图片/]))
        throw new Error('豆包没有参考图片上传入口');
      const fileChooser=await chooser;
      if(fileChooser){await fileChooser.setFiles(filename);selected=true;}
      else inputs=await imageInputs(page);
    }
    if(!selected){
      if(!inputs.length)throw new Error('图片选择控件不存在');
      for(const input of inputs){
        const before=monitor.prepared.length+monitor.stored.length;
        // Clearing via setInputFiles([]) dispatches a real empty change event.
        // Doubao's React picker can interpret that event as removing/replacing
        // an earlier attached reference. Clear only the native input value.
        await input.evaluate(element=>{element.value='';});
        await input.setInputFiles(filename);
        selected=true;
        const deadline=Date.now()+8000;
        while(Date.now()<deadline &&
          monitor.prepared.length+monitor.stored.length===before)
          await page.waitForTimeout(120);
        if(monitor.prepared.length+monitor.stored.length>before)break;
      }
    }
    if(!selected)throw new Error('未触发图片选择');
    if(!monitor.prepared.length&&!monitor.stored.length)
      throw new Error('豆包没有启动本张参考图片的上传；请检查当前文件选择控件是否有效');
    const prepared=monitor.prepared.at(-1);
    if(prepared&&!prepared.ok())
      throw new Error('豆包拒绝图片上传授权（HTTP '+prepared.status()+'）');
    if(prepared)onProgress('图片上传授权完成，等待文件上传',22);
    const uploaded=await waitForNewResponse(page,monitor.stored,0,75000);
    if(!uploaded||!uploaded.ok())
      throw new Error('豆包未确认文件上传完成'+
        (uploaded?'（HTTP '+uploaded.status()+'）':'')+'，已停止提交');
    // A successful storage transfer is NOT proof that the composer attached
    // the reference. The UI may still be processing the previous file.
    // Wait for either the corresponding processing response or the new
    // thumbnail before touching the next reference.
    const attachmentDeadline=Date.now()+18000;
    let attached=false;
    while(Date.now()<attachmentDeadline){
      const handled=monitor.handled.find(response=>response.ok());
      const newThumbnail=await page.locator('img').count()>previousImages;
      if(handled||newThumbnail){attached=true;break;}
      const failed=monitor.handled.find(response=>!response.ok());
      if(failed)throw new Error('豆包处理参考图片失败（HTTP '+failed.status()+'）');
      await page.waitForTimeout(180);
    }
    if(!attached)throw new Error(
      '参考图片已上传到存储，但豆包未显示新增缩略图，也未确认图片处理；已停止，防止漏图生成'
    );
    await page.waitForTimeout(350);
  }finally{monitor.close();}
}

// Audio has a different picker and acknowledgement path from the image cards.
// Never fall back to an image-only input; otherwise Playwright can set files
// without the website actually creating a usable audio attachment.
export async function uploadAudioReference(page,ref,localReferenceFile,onProgress=()=>{}){
  const filename=localReferenceFile(ref.url);
  if(!filename||!fs.existsSync(filename))throw new Error('参考音频不在本地素材库：'+ref.name);
  if(!/\.(mp3|wav|m4a|ogg|aac|flac|webm)$/i.test(filename))
    throw new Error('参考音频需为 MP3、WAV、M4A、OGG、AAC、FLAC 或 WebM：'+ref.name);
  if(path.extname(filename).toLowerCase()==='.mp3')
    return uploadMp3AsMp4(page,ref,filename,onProgress);
  const monitor=observeImageUpload(page);
  const beforeAudio=await page.locator('audio').count();
  const previousName=await page.getByText(path.basename(filename),{exact:false}).count();
  try{
    const findAudioPicker=async()=>{
      const fields=page.locator('input[type="file"]');
      const available=await fields.evaluateAll(elements=>elements.map((el,index)=>({
        index,accept:(el.getAttribute('accept')||'').toLowerCase(),disabled:el.disabled
      })));
      const matched=available.filter(x=>!x.disabled&&
        /audio\/|\.mp3|\.wav|\.m4a|\.ogg|\.aac|\.flac/.test(x.accept));
      return matched.length?fields.nth(matched[0].index):null;
    };
    let input=await findAudioPicker();
    let chosen=false;
    if(!input){
      const chooserPromise=page.waitForEvent('filechooser',{timeout:3000}).catch(()=>null);
      const clicked=await expandMenu(page,[/上传音频|添加音频|音频文件|添加附件|上传文件|本地文件/]);
      const chooser=clicked?await chooserPromise:null;
      if(chooser){
        const accept=await chooser.element().getAttribute('accept')||'';
        if(accept&&/image\//i.test(accept)&&!/audio\//i.test(accept))
          throw new Error('豆包上传入口只接受图片，不支持该参考音频');
        await chooser.setFiles(filename);chosen=true;
      }else input=await findAudioPicker();
    }
    if(!chosen){
      if(!input)throw new Error('豆包当前视频输入框没有参考音频上传控件');
      await input.setInputFiles(filename,{timeout:15000});
    }
    onProgress('已选择参考音频，等待豆包确认附件',22);
    const uploaded=await waitForNewResponse(page,monitor.stored,0,30000);
    if(!uploaded||!uploaded.ok())throw new Error('豆包没有确认音频文件上传完成');
    const deadline=Date.now()+18000;
    while(Date.now()<deadline){
      const handled=monitor.handled.find(response=>response.ok());
      const displayed=await page.locator('audio').count()>beforeAudio||
        await page.getByText(path.basename(filename),{exact:false}).count()>previousName;
      if(handled||displayed)return;
      const failed=monitor.handled.find(response=>!response.ok());
      if(failed)throw new Error('豆包未接受参考音频（HTTP '+failed.status()+'）');
      await page.waitForTimeout(180);
    }
    throw new Error('音频文件已传输，但豆包未显示或确认该音频附件；生成已停止');
  }finally{monitor.close();}
}

/** Convert only the outgoing MP3 attachment; original canvas media is unchanged. */
export async function uploadMp3AsMp4(page,ref,source,onProgress=()=>{}){
  onProgress('正在将参考音频转换为带音轨的 MP4 视频：'+ref.name,13);
  const converted=await convertMp3ToMp4(source);
  const monitor=observeImageUpload(page);
  try{
    const previousVideos=await page.locator('video').count();
    const previousImages=await page.locator('img').count();
    const uploadedFilename=path.basename(converted.filename);
    const previousName=await page.getByText(uploadedFilename,{exact:false}).count();
    const inputs=page.locator('input[type="file"]');
    const findVideoPicker=async()=>{
      const available=await inputs.evaluateAll(elements=>elements.map((el,index)=>({
        index,accept:(el.getAttribute('accept')||'').toLowerCase(),disabled:el.disabled
      })));
      const matches=available.filter(entry=>!entry.disabled&&(
        /video\/|\.mp4|\.mov|\.webm/.test(entry.accept)||!entry.accept
      )).sort((a,b)=>Number(/video\/|\.mp4/.test(b.accept))-
        Number(/video\/|\.mp4/.test(a.accept)));
      return matches.length?inputs.nth(matches[0].index):null;
    };
    let picker=await findVideoPicker();
    let picked=false;
    if(!picker){
      const chooserPromise=page.waitForEvent('filechooser',{timeout:3000}).catch(()=>null);
      const clicked=await expandMenu(page,[/上传视频|本地视频|添加视频|上传素材|上传文件|本地文件/]);
      const chooser=clicked?await chooserPromise:null;
      if(chooser){
        const accept=(await chooser.element().getAttribute('accept')||'').toLowerCase();
        if(accept&&!(/video\/|\.mp4|\.mov|\.webm/.test(accept)))
          throw new Error('豆包当前上传入口不接受 MP4 视频：'+accept);
        await chooser.setFiles(converted.filename);
        picked=true;
      }else picker=await findVideoPicker();
    }
    if(!picked){
      if(!picker)throw new Error('豆包当前视频生成输入框没有 MP4 视频上传控件');
      // Do not dispatch an empty React change event that might remove prior references.
      await picker.evaluate(element=>{element.value='';});
      await picker.setInputFiles(converted.filename,{timeout:15000});
    }
    onProgress('MP3 已转换为 MP4，正在上传视频附件：'+ref.name,20);
    const uploaded=await waitForNewResponse(page,monitor.stored,0,75000);
    if(!uploaded||!uploaded.ok())
      throw new Error('豆包没有确认 MP4 视频上传'+
        (uploaded?'（HTTP '+uploaded.status()+'）':''));
    const deadline=Date.now()+18000;
    while(Date.now()<deadline){
      const failed=monitor.handled.find(response=>!response.ok());
      if(failed)throw new Error('豆包处理 MP4 视频失败（HTTP '+failed.status()+'）');
      const handled=monitor.handled.some(response=>response.ok());
      const visibleAttachment=await page.locator('video').count()>previousVideos||
        await page.locator('img').count()>previousImages||
        await page.getByText(uploadedFilename,{exact:false}).count()>previousName;
      if(handled||visibleAttachment){
        onProgress('豆包已接收 MP4 视频（内含原始 MP3 音轨）：'+ref.name,26);
        return;
      }
      await page.waitForTimeout(180);
    }
    throw new Error('MP4 已上传到存储，但豆包未确认附件；停止生成以免丢失音轨');
  }finally{
    monitor.close();
    await converted.cleanup();
  }
}

// The Doubao rich-text composer can split text into paragraphs, add invisible
// zero-width characters and render @图N as a non-editable mention widget.
// Inspect *visible editor content* rather than comparing raw textContent with
// the source string. Do not accept a missing or partially written prompt.
const normalizePromptText=text=>String(text||'')
  .normalize('NFKC')
  .replace(/[\u200B-\u200D\u2060\uFEFF]/g,'')
  .replace(/\s+/g,'')
  .trim();

async function promptIsVisibleInEditor(editor,prompt){
  const expected=normalizePromptText(prompt);
  if(!expected)return false;
  return editor.evaluate((element,expectedText)=>{
    const normalize=text=>String(text||'')
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g,'')
      .replace(/\s+/g,'')
      .trim();
    const values=[];
    if('value' in element)values.push(element.value);
    values.push(element.innerText||'',element.textContent||'');
    // Mention widgets can show 图1 while their accessible label is @图1.
    // Include only text explicitly represented by the live editor DOM.
    const snapshot=element.cloneNode(true);
    for(const mention of snapshot.querySelectorAll(
      '[data-type="mention"],[data-mention],[data-mention-id],'+
      '[contenteditable="false"][aria-label]')){
      const label=mention.getAttribute('aria-label')||
        mention.getAttribute('data-label')||
        mention.getAttribute('data-mention')||'';
      if(/^@?图\d+$/.test(label.trim()))
        mention.textContent=label.startsWith('@')?label:'@'+label;
    }
    values.push(snapshot.textContent||'');
    return values.some(value=>normalize(value).includes(expectedText));
  },expected).catch(()=>false);
}

export async function fillVideoPrompt(page,prompt){
  if(!normalizePromptText(prompt))
    throw new Error('视频提示词为空，不能发送');
  const editors=page.locator('[contenteditable="true"],textarea');
  const count=await editors.count();
  let editor=null;
  for(let i=count-1;i>=0;i--){
    const candidate=editors.nth(i);
    if(await candidate.isVisible().catch(()=>false)&&
       await candidate.isEnabled().catch(()=>false)){
      editor=candidate;break;
    }
  }
  if(!editor)throw new Error('豆包视频提示词输入框不存在');
  await editor.fill(prompt);
  // React/ProseMirror may transform the editor shortly after the input event.
  // Check twice on separate ticks, not against a stale synchronous DOM value.
  const deadline=Date.now()+3000;
  let consecutive=0;
  do{
    await page.waitForTimeout(120);
    if(await promptIsVisibleInEditor(editor,prompt)){
      if(++consecutive>=2)return editor;
    }else consecutive=0;
  }while(Date.now()<deadline);
  throw new Error('视频提示词未完整保留在豆包输入框，已停止发送（请检查网页是否重置或转换了输入内容）');
}

function responseObserver(page,expectedModel){
  const videoIds=new Set();
  const completedVideoIds=new Set();
  const videoDownloads=new Map();
  const sseEvents=[];
  let sent=false;
  let confirmationRequested=false;
  let generationStarted=false;
  const chatReplies=new Map();
  let lastChatReply=null;
  let lastUpdateAt=0;
  const callback=async response=>{
    if(!sent)return;
    const url=new URL(response.url());
    if(url.hostname!=='www.doubao.com')return;
    if(response.status()<200||response.status()>=300)return;
    if(![
      '/chat/completion','/im/chain/single','/samantha/video/get_play_info',
      '/creativity/resource/get_without_watermark'
    ].includes(url.pathname))return;
    try{
      if(url.pathname==='/chat/completion'){
        const text=await response.text();
        sseEvents.push(...parseSseEvents(text).map(x=>x.event));
        for(const id of findVideoIds(text))videoIds.add(id);
        if(hasVideoConfirmationInResponse(text))confirmationRequested=true;
        const reply=inspectVideoStartReply(text,expectedModel);
        if(reply.started)generationStarted=true;
        chatReplies.set(response.request(),reply);
        lastChatReply={request:response.request(),...reply};
        if(chatReplies.size>12)chatReplies.delete(chatReplies.keys().next().value);
      }else{
        const data=await response.json();
        const ids=findVideoIds(data);
        for(const id of ids)videoIds.add(id);
        if(url.pathname==='/samantha/video/get_play_info'){
          const requestedId=JSON.parse(response.request().postData()||'{}').vid;
          // The play-info endpoint identifies the video being opened even
          // when the IM-chain payload does not expose a video_id field.
          // This makes the newly opened completed card recoverable without
          // requiring the user to click a hidden Download button.
          if(typeof requestedId==='string'&&/^v[a-z0-9]{20,45}$/i.test(requestedId)){
            completedVideoIds.add(requestedId);
            videoIds.add(requestedId);
          }
        }
        if(url.pathname==='/creativity/resource/get_without_watermark'){
          const request=JSON.parse(response.request().postData()||'{}');
          for(const id of request.vid||[]){
            const url=getSignedVideoDownload(data,id);
            if(url)videoDownloads.set(id,url);
          }
        }
      }
      lastUpdateAt=Date.now();
    }catch{/* Unknown response formats are not an excuse to mark job done. */}
  };
  page.on('response',callback);
  return {
    start(){sent=true;},
    markSubmitted(){
      // Discard old-conversation media loaded during the menu/asset setup.
      videoIds.clear();
      completedVideoIds.clear();
      videoDownloads.clear();
      sseEvents.length=0;
      confirmationRequested=false;
      generationStarted=false;
      chatReplies.clear();
      lastChatReply=null;
    },
    stop(){page.off('response',callback);},
    get videoIds(){return [...videoIds];},
    get completedIds(){return [...completedVideoIds];},
    get downloads(){return new Map(videoDownloads);},
    get sseEventTypes(){return [...new Set(sseEvents)];},
    get lastUpdateAt(){return lastUpdateAt;},
    get confirmationRequested(){return confirmationRequested;},
    get generationStarted(){return generationStarted;},
    get lastChatReply(){return lastChatReply;},
    replyFor(request){return chatReplies.get(request)||null;}
  };
}

function validateVideoFile(filename){
  const stat=fs.statSync(filename);
  if(stat.size<1024)throw new Error('视频文件过小');
  const fd=fs.openSync(filename,'r');
  const buf=Buffer.alloc(12);
  try{fs.readSync(fd,buf,0,12,0);}
  finally{fs.closeSync(fd);}
  const isMp4=buf.toString('ascii',4,8)==='ftyp';
  const isWebm=buf.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  if(!isMp4&&!isWebm)throw new Error('下载的文件不是有效 MP4/WebM 容器');
}

export async function saveBrowserDownload(page,button,outputDir,{timeout=10000}={}){
  // Always attach a rejection handler before clicking. Otherwise a failed
  // click leaves a 15 s Playwright timeout which can terminate Node.js as an
  // unhandled rejection, even though the original click error was handled.
  const wait=page.waitForEvent('download',{timeout})
    .then(download=>({download}),error=>({error}));
  await button.click({timeout:6000});
  const observed=await wait;
  if(observed.error)throw new Error(
    '已点击视频下载按钮，但未收到下载事件：'+
      String(observed.error?.message||observed.error).slice(0,150)
  );
  const download=observed.download;
  const ext=path.extname(download.suggestedFilename()).toLowerCase()==='.webm'
    ?'.webm':'.mp4';
  const filename=path.join(outputDir,crypto.randomUUID()+ext);
  try{
    await download.saveAs(filename);
    validateVideoFile(filename);
    return filename;
  }catch(e){
    fs.rmSync(filename,{force:true});
    throw e;
  }
}

async function saveSignedDownload(url,outputDir){
  // Signed URLs may expire. Never persist them; only save final video bytes.
  const file=path.join(outputDir,crypto.randomUUID()+'.mp4');
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),120000);
  try{
    const reply=await fetch(url,{signal:ctrl.signal,redirect:'follow'});
    if(!reply.ok||!reply.body)throw new Error('豆包媒体下载 HTTP '+reply.status);
    const final=new URL(reply.url);
    if(final.protocol!=='https:'||
      !/(\.|^)(doubao\.com|snssdk\.com|bytedance\.com|byteimg\.com)$/.test(final.hostname))
      throw new Error('媒体重定向目的地不在允许域名内');
    await pipeline(Readable.fromWeb(reply.body),fs.createWriteStream(file,{flags:'wx'}));
    validateVideoFile(file);
    return file;
  }catch(err){
    fs.rmSync(file,{force:true});
    throw err;
  }finally{clearTimeout(timer);}
}

async function saveSignedDownloadWithBrowserFallback(page,url,outputDir){
  try{return await saveSignedDownload(url,outputDir);}
  catch(primaryError){
    // The browser can have a proxy or authenticated session that Node fetch
    // does not use. Playwright's request context shares this browser's cookies.
    const parsed=new URL(url);
    if(parsed.protocol!=='https:'||
      !/(\.|^)(doubao\.com|snssdk\.com|bytedance\.com|byteimg\.com)$/.test(parsed.hostname))
      throw primaryError;
    const response=await page.context().request.get(url,{
      timeout:120000,failOnStatusCode:false
    }).catch(()=>null);
    if(!response?.ok())throw primaryError;
    const final=new URL(response.url());
    if(final.protocol!=='https:'||
      !/(\.|^)(doubao\.com|snssdk\.com|bytedance\.com|byteimg\.com)$/.test(final.hostname))
      throw primaryError;
    const file=path.join(outputDir,crypto.randomUUID()+'.mp4');
    try{
      fs.writeFileSync(file,await response.body(),{flag:'wx'});
      validateVideoFile(file);
      return file;
    }catch{
      fs.rmSync(file,{force:true});
      throw primaryError;
    }
  }
}

export async function requestCurrentVideoDownloadLink(page,videoId){
  // Request the same *download* endpoint seen when a user presses Doubao's
  // download action, in the active account page context. Cookies stay inside
  // Edge; no HAR token, signature or session is replayed or persisted.
  if(!/^v[a-z0-9]{20,45}$/i.test(videoId))return null;
  if(new URL(page.url()).hostname!=='www.doubao.com')return null;
  const data=await page.evaluate(async vid=>{
    try{
      const reply=await fetch('/creativity/resource/get_without_watermark',{
        method:'POST',credentials:'same-origin',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({vid:[vid]})
      });
      return reply.ok?await reply.json():null;
    }catch{return null;}
  },videoId).catch(()=>null);
  return data?getSignedVideoDownload(data,videoId):null;
}

// The canvas's @图片N refers to a connected image's stable order. Only
// mentioned images are uploaded, so Doubao's actual attached-image slot may
// differ from its canvas index. Label the prompt using the upload slot.
export function doubaoAttachmentPrompt(prompt,references){
  return String(prompt||'').replace(/@(图片|音频)(\d+)/g,(token,kind)=>{
    const ref=references.find(item=>item.token===token);
    if(!ref)throw new Error('豆包参考素材 '+token+' 未包含在本次上传列表');
    // Keep the operator's surrounding prompt unchanged. The uploaded MP3
    // is already converted to MP4; only expose its new filename in text.
    if(kind==='音频')return String(ref.name||token).replace(/\.mp3$/i,'.mp4');
    return '@图'+(references.filter(item=>item.kind!=='audio').indexOf(ref)+1);
  });
}

// Upload each image before filling the text. This guarantees that a failed
// upload is reported as an attachment problem, and a composer remount caused
// by image insertion cannot wipe out an already-entered video prompt.
export async function prepareVideoReferencesAndPrompt({
  page,job,localReferenceFile,onProgress=()=>{}
}){
  validateMediaReferences(job.references);
  const textForDoubao=doubaoAttachmentPrompt(job.prompt,job.references);
  for(const [index,ref] of job.references.entries()){
    onProgress('上传参考'+(ref.kind==='audio'?'音频':'图片')+' '+(index+1)+'/'+job.references.length+'：'+ref.name,17);
    try{
      if(ref.kind==='audio')await uploadAudioReference(page,ref,localReferenceFile,onProgress);
      else await uploadReference(page,ref,localReferenceFile,onProgress);
    }catch(error){
      throw new Error('第 '+(index+1)+'/'+job.references.length+
        (ref.kind==='audio'?' 个参考音频上传未完成：':' 张参考图上传未完成：')+
        String(error.message||error));
    }
    onProgress('参考素材已确认 '+(index+1)+'/'+job.references.length,
      17+Math.round((index+1)/job.references.length*12));
  }
  onProgress('参考图片就绪，正在填写视频提示词',30);
  const editor=await fillVideoPrompt(page,textForDoubao);
  // Escape only dismisses mention/completion popovers; verify again if the
  // site changes the rich-text editor while closing a popup.
  await editor.press('Escape').catch(()=>{});
  if(!await promptIsVisibleInEditor(editor,textForDoubao))
    throw new Error('关闭输入提示后豆包清空了视频提示词，已停止发送');
  return editor;
}

export async function sendVideoConfirmation(page,onProgress=()=>{}){
  onProgress('豆包要求确认生成参数，正在自动回复「确认」',37);
  // Do not reapply video settings or re-upload reference images. This is a
  // second plain message in the same conversation, not a new video job.
  const editor=await fillVideoPrompt(page,'确认');
  await editor.press('Escape').catch(()=>{});
  const button=await findSendButton(page,editor);
  const request=await submitAndObserve(page,button);
  const ack=await request.response();
  if(!ack||!ack.ok())
    throw new Error('豆包已要求视频参数确认，但「确认」消息提交失败');
  onProgress('已向豆包回复「确认」，正在核验视频是否开始生成',40);
  return request;
}

export async function runSeedanceBrowser({
  page,job,localReferenceFile,outputDir,onProgress
}){
  const expectedModel=job.model||'Seedance 2.0 Mini';
  const watcher=responseObserver(page,expectedModel);
  let confirmationMonitor=null;
  let completionMonitor=null;
  try{
    onProgress('选择 '+(job.model||'Seedance 2.0 Mini')+'、画面比例和时长',10);
    await configureVideo(page,job);
    const editor=await prepareVideoReferencesAndPrompt({
      page,job,localReferenceFile,onProgress
    });
    // Model/ration/duration verification is made against the *actual* POST
    // observed after the UI sends it. No hard-coded HAR session request.
    const send=await findSendButton(page,editor);
    const baselineCount=await page.getByRole('button',{name:/^下载(?:视频)?$/}).count();
    confirmationMonitor=await watchNewVideoConfirmation(page,expectedModel);
    completionMonitor=await watchNewVideoCompletion(page);
    watcher.markSubmitted();
    watcher.start();
    const request=await submitAndObserve(page,send);
    const actual=inspectVideoSubmission(request.postData()||'');
    validateObservedSubmission(actual,job);
    const ack=await request.response();
    if(!ack||!ack.ok())throw new Error('豆包提交视频任务失败');
    onProgress('豆包已接收请求，等待确认是否真正开始生成视频',35);

    const deadline=Date.now()+35*60*1000;
    const initialAcknowledgementDeadline=Date.now()+90000;
    let confirmationSent=false;
    let confirmationRequest=null;
    let confirmationAt=0;
    let videoStarted=false;
    let completionObservedAt=0;
    let lastDownloadAttempt=0;
    let viewerOpened=false;
    const attemptedSigned=new Set();
    while(Date.now()<deadline){
      if(!videoStarted&&
        (watcher.generationStarted||await confirmationMonitor.started())){
        videoStarted=true;
        onProgress('视频已开始生成（'+expectedModel+'）',45,'started');
      }
      if(!confirmationSent&&
        !videoStarted&&
        (watcher.confirmationRequested||await confirmationMonitor.requested())){
        // Only one confirmation per generation job, even if Doubao repeats the
        // same assistant prompt in SSE and the visible chat simultaneously.
        confirmationSent=true;
        confirmationRequest=await sendVideoConfirmation(page,onProgress);
        confirmationAt=Date.now();
      }
      if(!videoStarted&&confirmationSent){
        const confirmationReply=watcher.replyFor(confirmationRequest);
        assertVideoStartReply(confirmationReply,expectedModel,{afterConfirmation:true});
        if(Date.now()-confirmationAt>45000)
          throw new Error('视频未开始生成：发送「确认」后 45 秒内未收到「本次使用 '+expectedModel+' 生成」的开工回复');
      }else if(!videoStarted&&!confirmationSent){
        const initialReply=watcher.replyFor(request);
        if(!watcher.confirmationRequested&&
          !await confirmationMonitor.requested())
          assertVideoStartReply(initialReply,expectedModel);
        if(Date.now()>initialAcknowledgementDeadline)
          throw new Error('视频未开始生成：未收到「本次使用 '+expectedModel+' 生成」或明确的确认请求');
      }
      if(!videoStarted){
        await page.waitForTimeout(500);
        continue;
      }
      const newVideoCompleted=await completionMonitor.completed();
      if(newVideoCompleted&&!completionObservedAt){
        completionObservedAt=Date.now();
        onProgress('豆包已生成视频，正在获取素材并回传画布',82);
      }
      // The finished video card (as pictured in Doubao chat) often has no
      // role=button named 下载 at all until hovered or opened.
      if(newVideoCompleted&&Date.now()-lastDownloadAttempt>=3500){
        lastDownloadAttempt=Date.now();
        const {card,control}=await revealVideoDownloadControl(page);
        if(control){
          try{
            const filename=await saveBrowserDownload(page,control,outputDir);
            return {filename,videoIds:watcher.videoIds,
              submittedModel:actual.model,sseEventTypes:watcher.sseEventTypes};
          }catch{/* Some controls open a menu rather than downloading. */}
        }
        if(card){
          // Only click an actual newly opened menu item. Clicking the same
          // Download icon a second time can CLOSE its popup.
          const menuItem=page.getByRole('menuitem',{name:/下载|无水印|download/i}).last();
          const dialogAction=page.getByRole('dialog')
            .getByRole('button',{name:/下载|无水印|download/i}).last();
          const menu=await visible(menuItem)?menuItem:
            await visible(dialogAction)?dialogAction:
            !control?await findVideoDownloadControl(page,card):null;
          if(menu){
            try{
              const filename=await saveBrowserDownload(page,menu,outputDir);
              return {filename,videoIds:watcher.videoIds,
                submittedModel:actual.model,sseEventTypes:watcher.sseEventTypes};
            }catch{/* Try preview / media link. */}
          }
          if(!viewerOpened){
            viewerOpened=true;
            await openFreshVideoPreview(card);
          }
          const opened=await findVideoDownloadControl(page,card);
          if(opened){
            try{
              const filename=await saveBrowserDownload(page,opened,outputDir);
              return {filename,videoIds:watcher.videoIds,
                submittedModel:actual.model,sseEventTypes:watcher.sseEventTypes};
            }catch{/* Keep waiting and retrying until a real file is saved. */}
          }
        }
      }
      // A play-info response for a *freshly opened* video supplies its ID.
      // Never blindly request a download for an ID from a chat history list,
      // because that could return an old unrelated video.
      if(newVideoCompleted&&watcher.completedIds.length){
        for(const vid of watcher.completedIds){
          if(!watcher.videoIds.includes(vid)||attemptedSigned.has(vid))continue;
          attemptedSigned.add(vid);
          const url=watcher.downloads.get(vid)||
            await requestCurrentVideoDownloadLink(page,vid);
          if(!url)continue;
          try{
            const filename=await saveSignedDownloadWithBrowserFallback(
              page,url,outputDir);
            return {filename,videoIds:[vid],
              submittedModel:actual.model,sseEventTypes:watcher.sseEventTypes};
          }catch{/* The card's Download UI can still become available later. */}
        }
      }
      const downloadButtons=page.getByRole('button',{name:/^下载(?:视频)?$/});
      const fresh=await downloadButtons.count();
      if(fresh>baselineCount&&watcher.videoIds.length){
        onProgress('新视频已出现，正在从豆包下载',85);
        try{
          const filename=await saveBrowserDownload(page,downloadButtons.last(),outputDir);
          return {
            filename,videoIds:watcher.videoIds,
            submittedModel:actual.model,sseEventTypes:watcher.sseEventTypes
          };
        }catch(err){
          // Some UI variants open a secondary menu, not a download event.
          const menu=page.getByRole('menuitem',{name:/下载|无水印/}).last();
          if(await visible(menu)){
            const filename=await saveBrowserDownload(page,menu,outputDir);
            return {
              filename,videoIds:watcher.videoIds,
              submittedModel:actual.model,sseEventTypes:watcher.sseEventTypes
            };
          }
          // Another UI variant requests a signed MP4 resource rather than
          // firing Chromium's download event.
          for(const [vid,url] of watcher.downloads){
            if(watcher.videoIds.includes(vid)){
              const filename=await saveSignedDownload(url,outputDir);
              return {filename,videoIds:[vid],
                submittedModel:actual.model,sseEventTypes:watcher.sseEventTypes};
            }
          }
          throw err;
        }
      }
      // A signed result is accepted only if the same new video ID was observed
      // in the fresh conversation/response stream, not from existing history.
      for(const [vid,url] of watcher.downloads){
        if(watcher.videoIds.includes(vid)){
          onProgress('已验证视频 ID，正在保存 MP4',88);
          const filename=await saveSignedDownloadWithBrowserFallback(page,url,outputDir);
          return {
            filename,videoIds:[vid],
            submittedModel:actual.model,sseEventTypes:watcher.sseEventTypes
          };
        }
      }
      if(completionObservedAt&&Date.now()-completionObservedAt>120000)
        throw new Error('豆包已显示「你的视频生成好了」，但 2 分钟内无法下载真实 MP4；请在账号浏览器检查视频卡片的下载操作');
      await page.waitForTimeout(1800);
    }
    throw new Error('视频已开始生成，但未在超时窗口内识别到本次视频下载结果；浏览器保留供检查');
  }finally{
    watcher.stop();
    if(confirmationMonitor)await confirmationMonitor.stop();
    if(completionMonitor)await completionMonitor.stop();
  }
}
