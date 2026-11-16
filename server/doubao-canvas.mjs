// Independent single-generation jobs for the anonymous Doubao Canvas API.
// Never uses or exposes accounts belonging to another TapNow collaborator.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DoubaoCanvasClient} from './doubao-canvas-client.mjs';
import {projectMediaReferences,localReferenceFile} from './reference-selection.mjs';
import {setProjectJob} from './doubao-project.mjs';

export const CANVAS_RATIOS=['9:16','16:9','1:1','4:3','3:4','21:9'];
export const CANVAS_DURATIONS=[4,5,8,10,15];

function parseJobInput(body,read,uploadDir){
  if(!body||typeof body.projectId!=='string'||typeof body.nodeId!=='string')
    throw new Error('缺少画布或视频节点');
  const project=read().find(item=>item.id===body.projectId);
  const node=project?.nodes?.find(item=>item.id===body.nodeId);
  if(!node||node.data?.kind!=='video'||node.data?.provider!=='doubao-canvas')
    throw new Error('豆包画布视频节点不存在');
  const prompt=String(body.prompt||'').trim();
  if(!prompt||prompt.length>20000)throw new Error('请填写有效的视频提示词');
  const duration=Number.parseInt(String(body.duration),10);
  if(!CANVAS_DURATIONS.includes(duration)||String(body.duration)!==duration+'s')
    throw new Error('豆包画布时长仅支持 4、5、8、10、15 秒');
  const ratio=String(body.ratio||'');
  if(!CANVAS_RATIOS.includes(ratio))throw new Error('不支持的豆包画布视频比例');
  const references=projectMediaReferences(project,body.nodeId,prompt,body.references);
  if(references.length>10)throw new Error('最多支持 10 张参考图片');
  if(references.some(ref=>ref.kind!=='image'))
    throw new Error('豆包画布单次生成仅支持图片参考，不支持音频引用');
  const files=references.map(ref=>{
    const filename=localReferenceFile(uploadDir,ref.url);
    if(!filename)throw new Error(ref.token+' 图片未保存在本机，请重新上传');
    return filename;
  });
  // The editor numbers all connected images. The Canvas API only numbers
  // uploaded images, so remap sparse/repeated @图片N references to the actual
  // {{ref:N}} placeholders used by the selected attachments.
  const slots=new Map(references.map((ref,index)=>[ref.token,index+1]));
  const canvasPrompt=prompt.replace(/@图片\d+/g,token=>
    '{{ref:'+slots.get(token)+'}}');
  return {projectId:project.id,nodeId:node.id,prompt:canvasPrompt,
    duration,ratio,files};
}

export function mountDoubaoCanvasRoutes(app,read,write,{
  dataDir,uploadDir,clientFactory=options=>new DoubaoCanvasClient(options)
}){
  fs.mkdirSync(dataDir,{recursive:true});
  fs.mkdirSync(uploadDir,{recursive:true});
  const filename=path.join(dataDir,'doubao-canvas-jobs.json');
  const original=fs.existsSync(filename)
    ?JSON.parse(fs.readFileSync(filename,'utf8')):[];
  const jobs=new Map(original.map(job=>[job.id,
    ['queued','running','starting'].includes(job.status)
      ?{...job,status:'interrupted',message:'本机服务已重启，请重新提交'}
      :job]));
  const active=new Map();
  const persist=()=>{
    const temp=filename+'.'+process.pid+'.tmp';
    fs.writeFileSync(temp,JSON.stringify([...jobs.values()].slice(-300),null,2));
    fs.renameSync(temp,filename);
  };
  persist();
  const projectPatch=(job,patch)=>{
    const updated=setProjectJob(read(),job,patch);
    if(updated.changed)write(updated.projects);
  };
  const update=(id,patch)=>{
    const current=jobs.get(id);
    if(!current)return;
    const at=new Date().toISOString();
    const steps=Array.isArray(current.steps)?[...current.steps]:[];
    if(patch.message&&patch.message!==steps.at(-1)?.message)
      steps.push({at,message:patch.message,progress:patch.progress??current.progress});
    const next={...current,...patch,steps:steps.slice(-100),updatedAt:at};
    jobs.set(id,next);
    persist();
    if(patch.status==='running'||patch.status==='queued'){
      projectPatch(next,{status:patch.status,progress:next.progress,
        jobMessage:next.message,jobLogs:next.steps.map(step=>step.message)});
    }else if(patch.status==='completed'){
      projectPatch(next,{status:'done',progress:100,mediaUrl:next.videoUrl,
        jobMessage:next.message,jobLogs:next.steps.map(step=>step.message),
        demo:false});
    }else if(patch.status==='interrupted'||patch.status==='failed'){
      projectPatch(next,{status:'error',progress:0,jobMessage:next.message,
        jobLogs:next.steps.map(step=>step.message)});
    }
  };
  app.get('/api/doubao-canvas/jobs/:id',(req,res)=>{
    const job=jobs.get(req.params.id);
    if(!job)return res.status(404).json({error:'任务不存在'});
    res.json(job);
  });
  app.post('/api/doubao-canvas/jobs/:id/cancel',(req,res)=>{
    const job=jobs.get(req.params.id);
    if(!job)return res.status(404).json({error:'任务不存在'});
    if(['running','queued','starting'].includes(job.status)){
      active.get(job.id)?.abort();
      update(job.id,{status:'interrupted',message:'用户已停止豆包画布任务'});
    }
    res.json(jobs.get(job.id));
  });
  app.post('/api/doubao-canvas/jobs',(req,res)=>{
    let task;
    try{task=parseJobInput(req.body,read,uploadDir);}
    catch(error){return res.status(400).json({error:error.message});}
    const id=crypto.randomUUID();
    const job={
      id,projectId:task.projectId,nodeId:task.nodeId,
      model:'seedance_v2.0',status:'queued',progress:0,
      message:'豆包画布任务排队中',createdAt:new Date().toISOString(),
      updatedAt:new Date().toISOString(),
      steps:[{at:new Date().toISOString(),message:'豆包画布任务排队中',progress:0}]
    };
    jobs.set(id,job);
    persist();
    projectPatch(job,{jobId:id,status:'queued',progress:0,
      jobMessage:job.message,jobLogs:[job.message]});
    const controller=new AbortController();
    active.set(id,controller);
    res.status(201).json(job);
    void (async()=>{
      try{
        update(id,{status:'running',progress:3,message:'启动豆包画布单次生成'});
        const client=clientFactory({
          signal:controller.signal,
          onStage:(message,progress)=>{
            if(controller.signal.aborted)return;
            update(id,{status:'running',message,progress});
          }
        });
        const videoUrl=await client.generateOnce({
          prompt:task.prompt,images:task.files,duration:task.duration,
          ratio:task.ratio,uploadDir
        });
        if(!controller.signal.aborted)
          update(id,{status:'completed',progress:100,
            message:'豆包画布视频已保存到本机画布',videoUrl});
      }catch(error){
        if(controller.signal.aborted){
          update(id,{status:'interrupted',progress:0,
            message:'用户已停止豆包画布任务'});
        }else{
          update(id,{status:'failed',progress:0,
            message:error?.message||'豆包画布生成失败',
            error:error?.message||'豆包画布生成失败'});
        }
      }finally{
        active.delete(id);
      }
    })();
  });
  return {jobs,active};
}
