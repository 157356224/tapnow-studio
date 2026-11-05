import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createWriteStream} from 'node:fs';
import {projectMediaReferences} from './reference-selection.mjs';
import {setProjectJob} from './doubao-project.mjs';

export const H3_MODELS=['h3-video','h3-video-flex','h3-video-frames'];
export const H3_RESOLUTIONS=['480p','720p','768p','960p','1080p'];
export const H3_RATIOS=['16:9','9:16','21:9','4:3','1:1','3:4'];
const MAX_DOWNLOAD=350*1024*1024;
const MAX_REFERENCE=64*1024*1024;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const safeFile=url=>typeof url==='string'?
  /^\/api\/uploads\/([a-f0-9-]{36}\.(?:png|jpg|jpeg|webp|mp3|wav|m4a|ogg|flac|webm|mp4|mov))$/i.exec(url)?.[1]:null;
const mimeFor=ext=>({
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.webp':'image/webp','.mp3':'audio/mpeg','.wav':'audio/wav',
  '.m4a':'audio/mp4','.ogg':'audio/ogg','.flac':'audio/flac',
  '.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime'
})[ext.toLowerCase()];

export function validateH3Parameters(model,duration,resolution,ratio){
  if(!H3_MODELS.includes(model))throw new Error('请选择 H3 Video、H3 Video Flex 或 H3 Frames');
  if(!Number.isInteger(duration)||duration<4||
    duration>(model==='h3-video'?30:15))
    throw new Error(model==='h3-video'?'H3 Video 时长必须为 4–30 秒':'该 H3 模型时长必须为 4–15 秒');
  if(!H3_RESOLUTIONS.includes(resolution))
    throw new Error('H3 分辨率必须为 480p、720p、768p、960p 或 1080p');
  if(!H3_RATIOS.includes(ratio))throw new Error('H3 不支持该视频画幅比例');
  if(resolution==='720p'&&!['16:9','9:16'].includes(ratio))
    throw new Error('H3 的 720p 仅支持 16:9 和 9:16');
  if(['960p','1080p'].includes(resolution)&&duration>15)
    throw new Error('H3 的 960p/1080p 视频最长 15 秒');
  if(resolution==='768p'&&ratio==='21:9'&&duration>20)
    throw new Error('H3 的 768p 21:9 最长 20 秒');
  if(model==='h3-video'&&resolution==='1080p'&&ratio==='21:9'&&duration>10)
    throw new Error('H3 Video 的 1080p 21:9 最长 10 秒');
  if(model==='h3-video-flex'&&resolution==='1080p'&&ratio==='21:9'&&duration>10)
    throw new Error('H3 Flex 的 1080p 21:9 最长 10 秒');
  return {duration,resolution,aspect_ratio:ratio};
}

// Never guess a flat rate: the Yuanbo /models endpoint returns model-specific
// credits per second, a minimum charge and separate prompt optimization cost.
export function estimateH3Credits(models,{
  model,duration,resolution,ratio,optimizePrompt=false
}){
  validateH3Parameters(model,duration,resolution,ratio);
  const entry=Array.isArray(models)?models.find(item=>item.id===model):null;
  const pricing=entry?.pricing;
  const rate=pricing?.perSecond?.find(item=>item.resolution===resolution)?.credits;
  const minimum=Number(pricing?.minimumCredits);
  if(typeof rate!=='number'||!Number.isFinite(rate)||rate<0||
    !Number.isFinite(minimum)||minimum<0)
    throw new Error('元铂AI未提供该模型和分辨率的当前积分单价');
  if(pricing?.perOutput?.length)
    throw new Error('此模型存在额外按输出计费的价格，暂无法准确估价');
  const optimization=optimizePrompt?Number(pricing?.promptOptimizationCredits):0;
  if(!Number.isFinite(optimization)||optimization<0)
    throw new Error('元铂AI未提供提示词优化的准确积分价格');
  const videoCredits=Math.round(Math.max(minimum,duration*rate)*1000)/1000;
  const credits=Math.round((videoCredits+optimization)*1000)/1000;
  return {
    model,duration,resolution,videoCredits,
    optimizationCredits:optimization,
    credits,yuan:Math.round(credits*100)/10000,
    estimated:true,source:'yuanbo-models'
  };
}

export function buildH3Generation({model,prompt,parameters,inputs=[],optimizePrompt=false,note=''}){
  const {duration,resolution,aspect_ratio}=validateH3Parameters(
    model,parameters.duration,parameters.resolution,parameters.aspect_ratio);
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>12000)
    throw new Error('H3 视频提示词必须为 1–12000 字符');
  const imageCount=inputs.filter(ref=>ref.role==='reference_image').length;
  const audioCount=inputs.filter(ref=>ref.role==='reference_audio').length;
  const videoCount=inputs.filter(ref=>ref.role==='reference_video').length;
  const first=inputs.filter(ref=>ref.role==='first_frame').length;
  const last=inputs.filter(ref=>ref.role==='last_frame').length;
  if(model==='h3-video-frames'){
    if(first>1||last>1||first+last<1||first+last!==inputs.length)
      throw new Error('H3 Frames 必须选择首帧或尾帧，不能混入其他参考素材');
  }else if(first||last||imageCount>9||audioCount>3||videoCount>3||
    imageCount+audioCount+videoCount!==inputs.length){
    throw new Error('H3 最多支持 9 图、3 段音频、3 段视频参考素材');
  }
  if(inputs.some(ref=>!ref.asset_id||typeof ref.asset_id!=='string'))
    throw new Error('参考素材尚未上传到 H3');
  return {
    model,prompt:prompt.trim(),
    ...(model==='h3-video-frames'?{mode:'frames_to_video'}:{}),
    ...(inputs.length?{inputs}:{}),
    parameters:{duration,resolution,aspect_ratio},
    ...(optimizePrompt?{optimize_prompt:true}:{}),
    ...(note?{note:String(note).slice(0,80)}:{})
  };
}

async function fetchJson(fetchImpl,url,{method='GET',token,body,idempotencyKey,timeoutMs=30000}={}){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const res=await fetchImpl(url,{
      method,signal:controller.signal,
      headers:{
        Authorization:'Bearer '+token,Accept:'application/json',
        ...(body!==undefined?{'Content-Type':'application/json'}:{}),
        ...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})
      },
      ...(body!==undefined?{body:JSON.stringify(body)}:{})
    });
    const raw=(await res.text()).slice(0,400000);
    let data;
    try{data=JSON.parse(raw);}catch{data={message:raw.slice(0,350)};}
    if(!res.ok)throw new Error('元铂AI HTTP '+res.status+': '+
      String(data?.error?.message||data?.error?.code||data?.message||'请求失败').slice(0,400));
    return data;
  }catch(error){
    if(error?.name==='AbortError')throw new Error('元铂AI API 请求超时');
    throw error;
  }finally{clearTimeout(timer);}
}

export function mountH3Routes(app,readProjects,writeProjects,{
  dataDir,uploadDir,baseUrl='https://yuanbo.jj.link/api/open/v1',
  fetchImpl=globalThis.fetch,pollMs=5000,wait=sleep,
  allowedHosts=['127.0.0.1:3701','localhost:3701']
}){
  const configPath=path.join(dataDir,'yuanbo-h3-config.json');
  const jobsPath=path.join(dataDir,'yuanbo-h3-jobs.json');
  const jobs=new Map();
  try{
    const existing=JSON.parse(fs.readFileSync(jobsPath,'utf8'));
    for(const job of existing)if(job?.id)jobs.set(job.id,job);
  }catch{}
  const inFlight=new Set();
  let modelCache=null;
  let modelCacheKey='';
  let modelCacheUntil=0;
  let modelRequest=null;
  const configuredKey=()=>{
    const env=process.env.YUANBO_API_KEY?.trim();
    if(env)return env;
    try{return JSON.parse(fs.readFileSync(configPath,'utf8')).apiKey||'';}
    catch{return '';}
  };
  const writeJobs=()=>{
    const items=[...jobs.values()].slice(-300);
    const tmp=jobsPath+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify(items,null,2),{mode:0o600});
    fs.renameSync(tmp,jobsPath);
  };
  const writeProject=(job,patch)=>{
    const result=setProjectJob(readProjects(),job,patch);
    if(result.changed)writeProjects(result.projects);
  };
  const updateJob=(job,patch)=>{
    Object.assign(job,patch,{updatedAt:new Date().toISOString()});
    writeJobs();
    const state=job.status==='completed'?'done':
      ['failed','interrupted'].includes(job.status)?'error':
      job.status==='running'?'running':'queued';
    writeProject(job,{
      status:state,progress:job.progress||0,jobMessage:job.message||'',
      ...(job.status==='completed'?{mediaUrl:job.videoUrl,demo:false}:{}),
      ...(job.status==='failed'?{progress:0}:{})
    });
  };
  const api=(url,opts={})=>fetchJson(fetchImpl,baseUrl+url,{
    ...opts,token:configuredKey()
  });
  const getModels=async()=>{
    const key=configuredKey();
    if(!key)throw new Error('请先配置元铂AI API Key');
    if(modelCache&&modelCacheKey===key&&Date.now()<modelCacheUntil)
      return modelCache;
    if(modelRequest&&modelCacheKey===key)return modelRequest;
    modelCacheKey=key;
    modelRequest=api('/models').then(remote=>{
      const models=remote?.data||remote?.models||remote;
      if(!Array.isArray(models))throw new Error('元铂AI模型价格返回格式不正确');
      modelCache=models;modelCacheUntil=Date.now()+60000;
      return models;
    }).finally(()=>{modelRequest=null;});
    return modelRequest;
  };
  const localAsset=ref=>{
    const filename=safeFile(ref.url);
    if(!filename)throw new Error('H3 参考素材必须是画布中的本地上传文件：'+ref.name);
    const filenamePath=path.join(uploadDir,filename);
    if(!fs.existsSync(filenamePath))throw new Error('H3 本地参考素材文件不存在：'+ref.name);
    const mime=mimeFor(path.extname(filename));
    if(!mime)throw new Error('H3 不支持此参考素材类型：'+ref.name);
    const bytes=fs.readFileSync(filenamePath);
    if(!bytes.length||bytes.length>MAX_REFERENCE)throw new Error('参考素材大小超出限制：'+ref.name);
    if(ref.role==='first_frame'||ref.role==='last_frame'){
      if(!mime.startsWith('image/')||bytes.length>24*1024*1024)
        throw new Error('H3 首尾帧必须为 24MiB 内的 PNG/JPEG/WebP');
    }
    return {filename,bytes,mime};
  };
  const uploadAsset=async(ref)=>{
    const {filename,bytes,mime}=localAsset(ref);
    const sha256=crypto.createHash('sha256').update(bytes).digest('hex');
    const allocation=await api('/uploads',{method:'POST',body:{
      filename,content_type:mime,byte_length:bytes.length,sha256
    }});
    const id=allocation.asset_id;
    if(!id)throw new Error('H3 上传接口没有返回 asset_id');
    if(allocation.reused&&allocation.state==='READY')return {asset_id:id,role:ref.role};
    const signed=allocation.upload;
    if(!signed?.url||!/^https:\/\//i.test(signed.url))
      throw new Error('H3 上传接口没有返回 HTTPS 文件上传地址');
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),120000);
    try{
      const put=await fetchImpl(signed.url,{
        method:'PUT',headers:signed.headers||{},body:bytes,signal:controller.signal
      });
      if(!put.ok)throw new Error('H3 参考素材上传失败：HTTP '+put.status);
    }finally{clearTimeout(timer);}
    await api('/uploads/'+encodeURIComponent(id)+'/complete',{method:'POST'});
    return {asset_id:id,role:ref.role};
  };
  const download=async(output)=>{
    const url=output?.download_url;
    if(!url||!/^https:\/\//i.test(url))throw new Error('H3 已完成但未返回视频 HTTPS 下载地址');
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),180000);
    const name=crypto.randomUUID()+'.mp4';
    const tmp=path.join(uploadDir,name+'.partial');
    const target=path.join(uploadDir,name);
    try{
      const res=await fetchImpl(url,{signal:controller.signal});
      if(!res.ok||!res.body)throw new Error('H3 视频下载失败：HTTP '+res.status);
      const expected=Number(output.byte_length||res.headers.get('content-length')||0);
      if(expected>MAX_DOWNLOAD)throw new Error('H3 视频文件超过本地保存上限');
      let bytes=0;
      const limiter=new Transform({transform(chunk,_enc,callback){
        bytes+=chunk.length;
        callback(bytes>MAX_DOWNLOAD?new Error('H3 视频文件超过本地保存上限'):null,chunk);
      }});
      await pipeline(Readable.fromWeb(res.body),limiter,createWriteStream(tmp));
      if(bytes<1||(expected&&bytes!==expected))
        throw new Error('H3 视频文件下载不完整');
      fs.renameSync(tmp,target);
      return '/api/uploads/'+name;
    }finally{
      clearTimeout(timeout);
      try{fs.rmSync(tmp,{force:true});}catch{}
    }
  };
  const run=async job=>{
    if(inFlight.has(job.id))return;
    inFlight.add(job.id);
    try{
      if(!job.remoteId){
        updateJob(job,{status:'starting',progress:3,message:'H3 正在上传参考素材'});
        const inputs=[];
        for(const ref of job.references){
          inputs.push(await uploadAsset(ref));
        }
        const body=buildH3Generation({
          model:job.model,prompt:job.prompt,parameters:job.parameters,
          inputs,optimizePrompt:job.optimizePrompt,note:job.note
        });
        updateJob(job,{message:'H3 正在创建生成任务'});
        const remote=await api('/generations',{
          method:'POST',body,idempotencyKey:job.idempotencyKey
        });
        if(!remote?.id)throw new Error('H3 创建任务未返回生成 ID');
        updateJob(job,{remoteId:remote.id,status:'running',progress:8,
          message:'H3 已提交至元铂AI，正在生成'});
      }
      for(let count=0;count<1200;count++){
        const state=await api('/generations/'+encodeURIComponent(job.remoteId));
        const status=state?.status;
        if(status==='succeeded'){
          const output=state.outputs?.find(item=>item.media_type==='video')||
            state.outputs?.[0];
          updateJob(job,{status:'running',progress:96,message:'H3 已生成，正在保存视频'});
          const videoUrl=await download(output);
          updateJob(job,{status:'completed',progress:100,videoUrl,
            message:'H3 生成完成，视频已保存到本地画布'});
          return;
        }
        if(['failed','cancelled'].includes(status)){
          const error=String(state?.error?.message||state?.error?.code||
            '生成任务失败');
          throw new Error('H3 '+status+'：'+error);
        }
        const progress=Math.min(90,Math.max(job.progress||9,
          status==='finalizing'?88:status==='generating'?20:9));
        updateJob(job,{status:'running',progress,
          message:'H3 '+({
            queued:'排队中',confirming:'确认中',delayed:'等待资源',
            generating:'生成中',finalizing:'正在合成',cancelling:'处理取消申请'
          }[status]||'生成中')});
        await wait(count<18?pollMs:Math.min(15000,pollMs*2));
      }
      throw new Error('H3 状态轮询超时，请到元铂AI网站检查任务');
    }catch(error){
      updateJob(job,{status:'failed',progress:0,
        message:String(error?.message||error).slice(0,400)});
    }finally{inFlight.delete(job.id);}
  };

  const originGuard=(req,res,next)=>{
    const host=req.headers.host||'';
    if(!allowedHosts.includes(host))
      return res.status(403).json({error:'H3 配置和任务仅允许本机访问'});
    if(req.headers['sec-fetch-site']==='cross-site')
      return res.status(403).json({error:'不允许跨站访问 H3 接口'});
    const origin=req.headers.origin;
    if(origin&&!['http://127.0.0.1:5173','http://localhost:5173',
      'http://127.0.0.1:3701'].includes(origin))
      return res.status(403).json({error:'不允许跨站操作 H3 API'});
    next();
  };
  app.use('/api/h3',originGuard);
  app.get('/api/h3/config',(_req,res)=>{
    const key=configuredKey();
    res.json({configured:!!key,masked:key?'••••'+key.slice(-4):''});
  });
  app.put('/api/h3/config',(req,res)=>{
    const value=req.body?.apiKey;
    if(typeof value!=='string'||value.trim().length<8||
      value.trim().length>400||/[\s\r\n]/.test(value.trim()))
      return res.status(400).json({error:'请输入有效的元铂AI API Key'});
    const key=value.trim();
    const temp=configPath+'.tmp';
    fs.writeFileSync(temp,JSON.stringify({apiKey:key}),{mode:0o600});
    fs.renameSync(temp,configPath);
    modelCache=null;modelCacheUntil=0;modelCacheKey='';
    res.json({configured:true,masked:'••••'+key.slice(-4)});
  });
  app.delete('/api/h3/config',(_req,res)=>{
    fs.rmSync(configPath,{force:true});
    modelCache=null;modelCacheUntil=0;modelCacheKey='';
    const key=configuredKey();
    res.json({configured:!!key,masked:key?'••••'+key.slice(-4):''});
  });
  app.get('/api/h3/models',async(_req,res)=>{
    try{
      res.json({models:await getModels()});
    }catch(error){res.status(502).json({error:String(error.message||error)});}
  });
  app.get('/api/h3/estimate',async(req,res)=>{
    const model=String(req.query.model||'');
    const duration=Number(req.query.duration);
    const resolution=String(req.query.resolution||'');
    const ratio=String(req.query.ratio||'');
    const optimizePrompt=req.query.optimizePrompt==='true';
    try{
      validateH3Parameters(model,duration,resolution,ratio);
    }catch(error){
      return res.status(400).json({error:String(error.message||error)});
    }
    try{
      const models=await getModels();
      res.json(estimateH3Credits(models,{
        model,duration,resolution,ratio,optimizePrompt
      }));
    }catch(error){
      const message=String(error.message||error);
      res.status(/请先配置/.test(message)?400:502)
        .json({error:message});
    }
  });
  app.get('/api/h3/jobs/:id',(req,res)=>{
    const job=jobs.get(req.params.id);
    if(!job)return res.status(404).json({error:'H3 任务不存在'});
    res.json(job);
  });
  app.post('/api/h3/jobs',(req,res)=>{
    try{
      if(!configuredKey())throw new Error('请先设置元铂AI API Key');
      const {projectId,nodeId}=req.body||{};
      const project=readProjects().find(item=>item.id===projectId);
      const node=project?.nodes?.find(item=>item.id===nodeId);
      if(!node||node.data?.kind!=='video'||node.data?.provider!=='h3')
        throw new Error('必须从 H3 视频节点提交任务');
      const model=String(node.data.model||'h3-video');
      const prompt=String(req.body?.prompt||node.data.prompt||'').trim();
      const ratio=String(req.body?.ratio||node.data.ratio||'16:9');
      const resolution=String(req.body?.resolution||node.data.resolution||'768p').toLowerCase();
      const duration=Number.parseInt(String(req.body?.duration||node.data.duration||'6s'),10);
      const parameters=validateH3Parameters(model,duration,resolution,ratio);
      const selected=[];
      if(model==='h3-video-frames'){
        if(/@(?:图片|音频)\d+/.test(prompt))
          throw new Error('H3 Frames 首尾帧无需使用 @图片 标记，请在首尾帧选项中选择图片节点');
        if(Array.isArray(req.body?.references)&&req.body.references.length)
          throw new Error('H3 Frames 不能同时使用普通参考素材');
        const connected=new Set((project.edges||[]).filter(edge=>edge.target===nodeId)
          .map(edge=>edge.source));
        for(const [role,key] of [['first_frame','h3FirstFrameId'],['last_frame','h3LastFrameId']]){
          const frameId=node.data[key];
          if(!frameId)continue;
          if(!connected.has(frameId))
            throw new Error('H3 '+(role==='first_frame'?'首帧':'尾帧')+'必须连接到当前视频节点');
          const frame=project.nodes.find(item=>item.id===frameId);
          if(frame?.data?.kind!=='image'||!frame.data.mediaUrl)
            throw new Error('所选首尾帧节点没有图片素材');
          selected.push({name:frame.data.title,url:frame.data.mediaUrl,role});
        }
        if(!selected.length)throw new Error('H3 Frames 至少选择一张首帧或尾帧图片');
      }else{
        const references=projectMediaReferences(
          project,nodeId,prompt,req.body?.references||[]);
        for(const ref of references)
          selected.push({...ref,role:ref.kind==='audio'?'reference_audio':'reference_image'});
      }
      buildH3Generation({model,prompt,parameters,
        inputs:selected.map(ref=>({asset_id:'pending',role:ref.role}))});
      const job={
        id:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),
        projectId,nodeId,model,prompt,parameters,references:selected,
        optimizePrompt:!!node.data.h3OptimizePrompt,
        note:String(node.data.title||'H3 Video').slice(0,80),
        status:'queued',progress:0,message:'H3 已创建任务，等待上传素材',
        createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
      };
      jobs.set(job.id,job);
      updateJob(job,{status:'queued'});
      res.status(202).json(job);
      void run(job);
    }catch(error){
      res.status(400).json({error:String(error.message||error)});
    }
  });
  for(const job of jobs.values()){
    if(['completed','failed','interrupted'].includes(job.status))continue;
    if(job.remoteId){
      void run(job);
    }else{
      updateJob(job,{status:'interrupted',progress:0,
        message:'服务重启时任务尚未确认提交；请检查元铂AI后台后再重试'});
    }
  }
}
