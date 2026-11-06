// ChatGPT.com browser integration. Authentication remains in its own local
// Edge profile. Never replay or persist cookies/tokens from exported HAR files.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {browserLaunchOptions,nativeBrowserExecutable} from './chromium-binary.mjs';
import {projectImageReferences,localReferenceFile} from './reference-selection.mjs';
import {runChatGPTBrowser} from './chatgpt-runner.mjs';
import {setMuseProjectJob} from './muse-project.mjs';

const now=()=>new Date().toISOString();
const validId=id=>typeof id==='string'&&/^[0-9a-f-]{36}$/i.test(id);
function writeJson(file,data){
  const tmp=file+'.'+process.pid+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(data,null,2),{mode:0o600});
  fs.renameSync(tmp,file);
}

export function preserveChatGPTCompletedMedia(oldProject,incomingNodes){
  const previous=new Map((oldProject.nodes||[]).map(node=>[node.id,node]));
  return incomingNodes.map(node=>{
    const old=previous.get(node.id);
    if(!old||old.data?.kind!=='image'||old.data?.provider!=='chatgpt'||
      !old.data.jobId)return node;
    if(['queued','running'].includes(old.data.status)&&
      old.data.jobId!==node.data?.jobId)
      return {...node,data:{...node.data,
        jobId:old.data.jobId,status:old.data.status,
        progress:old.data.progress,jobMessage:old.data.jobMessage}};
    if(old.data.status==='done'&&old.data.mediaUrl&&
      old.data.jobId===node.data?.jobId)
      return {...node,data:{...node.data,
        status:'done',progress:100,demo:false,
        mediaUrl:old.data.mediaUrl,mediaWidth:old.data.mediaWidth,
        mediaHeight:old.data.mediaHeight,
        jobMessage:old.data.jobMessage}};
    return node;
  });
}

export function mountChatGPTRoutes(app,readProjects,writeProjects,{
  dataDir,uploadDir,
  runner=runChatGPTBrowser,
  launch=()=>chromium.launchPersistentContext(profileDir(),{
    headless:false,acceptDownloads:true,
    viewport:{width:1400,height:950},
    ...browserLaunchOptions(),
    args:['--no-first-run','--no-default-browser-check',
      '--disable-background-mode']
  }),
  loginLauncher=()=>spawn(nativeBrowserExecutable(),[
    '--user-data-dir='+profileDir(),
    '--new-window','--no-first-run','--no-default-browser-check',
    '--disable-background-mode','https://chatgpt.com/'
  ],{detached:true,stdio:'ignore',windowsHide:false}),
  enableBrowser=true,
  allowedHosts=['localhost:3701','127.0.0.1:3701']
}){
  const profileDir=()=>path.join(dataDir,'chatgpt-edge-profile');
  const jobsFile=path.join(dataDir,'chatgpt-image-jobs.json');
  fs.mkdirSync(dataDir,{recursive:true});
  fs.mkdirSync(uploadDir,{recursive:true});
  if(!fs.existsSync(jobsFile))writeJson(jobsFile,[]);
  const jobs=new Map();
  try{
    for(const job of JSON.parse(fs.readFileSync(jobsFile,'utf8'))){
      if(!job?.id)continue;
      if(['queued','starting','running'].includes(job.status))
        Object.assign(job,{status:'interrupted',progress:null,
          error:'ChatGPT 浏览器任务因服务重启中断，请重新生成',
          message:'ChatGPT 浏览器任务因服务重启中断'});
      jobs.set(job.id,job);
    }
  }catch{}
  let browser=null,loginProcess=null,queueTail=Promise.resolve();
  const active=new Set();
  const persist=(job,patch)=>{
    const changed=setMuseProjectJob(readProjects(),job,patch);
    if(changed.changed)writeProjects(changed.projects);
  };
  const update=(job,patch)=>{
    Object.assign(job,patch,{updatedAt:now()});
    writeJson(jobsFile,[...jobs.values()].slice(-250));
    if(patch.status){
      persist(job,{
        status:patch.status==='completed'?'done':
          ['error','needs-login','interrupted'].includes(patch.status)?'error':
          patch.status==='running'?'running':'queued',
        ...(typeof patch.progress==='number'?{progress:patch.progress}:{}),
        jobMessage:patch.message||job.message,
        ...(patch.mediaUrl?{
          mediaUrl:patch.mediaUrl,
          mediaWidth:patch.mediaWidth,mediaHeight:patch.mediaHeight,
          demo:false
        }:{})
      });
    }
  };
  const loginOpen=()=>loginProcess?.exitCode===null;
  const busy=()=>active.size>0||
    [...jobs.values()].some(j=>['queued','starting','running'].includes(j.status));
  const ensureBrowser=async()=>{
    if(!enableBrowser)throw new Error('ChatGPT 浏览器功能未启用');
    if(loginOpen())
      throw new Error('请先在独立 Edge 登录 ChatGPT，并关闭登录窗口后再生成');
    if(!browser){
      browser=await launch();
      browser.on?.('close',()=>{browser=null;});
    }
    const page=browser.pages().find(p=>!p.isClosed())||
      await browser.newPage();
    return page;
  };
  const execute=async(job)=>{
    active.add(job.id);
    try{
      update(job,{status:'starting',progress:null,
        message:'正在打开 ChatGPT 独立 Edge 浏览器'});
      const page=await ensureBrowser();
      const refs=job.references.map(ref=>({
        ...ref,file:localReferenceFile(uploadDir,ref.url)
      }));
      if(refs.some(ref=>!ref.file))
        throw new Error('ChatGPT 参考图片文件不存在，请重新上传');
      const result=await runner({
        page,job,outputDir:uploadDir,references:refs,
        onProgress:patch=>update(job,patch)
      });
      update(job,{status:'completed',progress:100,
        message:'ChatGPT 图片已保存并回填画布',
        mediaUrl:result.mediaUrl,
        mediaWidth:result.width,mediaHeight:result.height});
    }catch(err){
      const message=String(err?.message||err).slice(0,400);
      update(job,{status:/尚未登录|先.*登录/.test(message)
        ?'needs-login':'error',progress:null,message,error:message});
    }finally{
      active.delete(job.id);
      if(browser){
        const context=browser;browser=null;
        await context.close().catch(()=>{});
      }
    }
  };
  const enqueue=job=>{
    queueTail=queueTail.then(()=>execute(job)).catch(()=>{});
  };
  const originGuard=(req,res,next)=>{
    if(!allowedHosts.includes(req.headers.host))
      return res.status(403).json({error:'仅允许本地访问 ChatGPT 账号接口'});
    if(req.headers['sec-fetch-site']==='cross-site')
      return res.status(403).json({error:'拒绝跨站访问 ChatGPT 账号接口'});
    const origin=req.headers.origin;
    if(origin&&!['http://localhost:5173','http://127.0.0.1:5173',
      'http://127.0.0.1:3701'].includes(origin))
      return res.status(403).json({error:'ChatGPT 账号接口不允许跨站调用'});
    next();
  };
  app.use('/api/chatgpt',originGuard);
  app.get('/api/chatgpt/account',(_req,res)=>res.json({
    profileCreated:fs.existsSync(profileDir()),
    loginWindowOpen:!!loginOpen(),browserOpen:!!browser,
    jobsRunning:active.size
  }));
  app.post('/api/chatgpt/login',async(_req,res)=>{
    try{
      if(busy())return res.status(409).json({
        error:'请先等待 ChatGPT 生图任务结束后再打开登录窗口'});
      if(loginOpen())return res.json({ok:true,
        message:'ChatGPT 登录 Edge 已打开，请使用现有窗口'});
      if(browser){await browser.close();browser=null;}
      fs.mkdirSync(profileDir(),{recursive:true});
      const child=loginLauncher();
      await new Promise((resolve,reject)=>{
        child.once('spawn',resolve);child.once('error',reject);
      });
      child.unref?.();
      loginProcess=child;
      child.once('exit',()=>{if(loginProcess===child)loginProcess=null;});
      res.json({ok:true,
        message:'已打开 ChatGPT 独立 Edge，请手动登录并关闭该窗口，再回到画布生成'});
    }catch(err){res.status(400).json({error:String(err.message||err)})}
  });
  app.get('/api/chatgpt/jobs/:id',(req,res)=>{
    const job=jobs.get(req.params.id);
    if(!job)return res.status(404).json({error:'ChatGPT 任务不存在'});
    res.json(job);
  });
  app.post('/api/chatgpt/jobs',(req,res)=>{
    try{
      const {projectId,nodeId}=req.body||{};
      const project=readProjects().find(p=>p.id===projectId);
      const node=project?.nodes?.find(n=>n.id===nodeId);
      if(!node||node.data?.kind!=='image'||node.data.provider!=='chatgpt')
        throw new Error('请从 ChatGPT 图片节点提交生成任务');
      const prompt=String(req.body?.prompt||node.data.prompt||'').trim();
      if(!prompt||prompt.length>32000)
        throw new Error('请输入 1–32000 字符的 ChatGPT 生图提示词');
      const refs=projectImageReferences(project,nodeId,prompt,
        req.body?.references||[]);
      for(const ref of refs)
        if(!localReferenceFile(uploadDir,ref.url))
          throw new Error('请先上传引用的本地图片：'+ref.name);
      const job={
        id:crypto.randomUUID(),projectId,nodeId,kind:'image',
        prompt,references:refs,
        ratio:String(node.data.ratio||'2:3'),
        status:'queued',progress:null,
        message:'ChatGPT 生图任务已排队',
        createdAt:now(),updatedAt:now()
      };
      jobs.set(job.id,job);
      update(job,{status:'queued',progress:null,message:job.message});
      res.status(202).json(job);
      enqueue(job);
    }catch(err){res.status(400).json({error:String(err.message||err)})}
  });
  for(const job of jobs.values())
    if(job.status==='interrupted')
      persist(job,{status:'error',progress:0,jobMessage:job.message});
}
