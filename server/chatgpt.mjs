// ChatGPT.com browser integration. Authentication remains in its own local
// Edge profile. Never replay or persist cookies/tokens from exported HAR files.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {browserLaunchOptions,nativeBrowserExecutable,accountProfileDir} from './chromium-binary.mjs';
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
  launch=null,
  loginLauncher=null,
  enableBrowser=true,
  allowedHosts=['localhost:3701','127.0.0.1:3701']
}){
  const profilesDir=path.join(dataDir,'chatgpt-profiles');
  const accountsFile=path.join(dataDir,'chatgpt-accounts.json');
  const legacyProfileDir=path.join(dataDir,'chatgpt-edge-profile');
  const profileDir=account=>account.legacyProfile
    ?legacyProfileDir:accountProfileDir(profilesDir,account);
  const startAutomation=launch||((account)=>
    chromium.launchPersistentContext(profileDir(account),{
      headless:false,acceptDownloads:true,
      viewport:{width:1400,height:950},
      ...browserLaunchOptions(),
      args:['--no-first-run','--no-default-browser-check',
        '--disable-background-mode']
    }));
  const startNativeLogin=loginLauncher||((account)=>
    spawn(nativeBrowserExecutable(),[
      '--user-data-dir='+profileDir(account),
      '--new-window','--no-first-run','--no-default-browser-check',
      '--disable-background-mode','https://chatgpt.com/'
    ],{detached:true,stdio:'ignore',windowsHide:false}));
  const jobsFile=path.join(dataDir,'chatgpt-image-jobs.json');
  fs.mkdirSync(dataDir,{recursive:true});
  fs.mkdirSync(uploadDir,{recursive:true});
  fs.mkdirSync(profilesDir,{recursive:true});
  if(!fs.existsSync(accountsFile))writeJson(accountsFile,[]);
  if(!fs.existsSync(jobsFile))writeJson(jobsFile,[]);
  const accounts=()=>JSON.parse(fs.readFileSync(accountsFile,'utf8'));
  const findAccount=id=>accounts().find(account=>account.id===id);
  const nativeBrowsers=new Map();
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
  let browser=null,browserAccountId=null,queueTail=Promise.resolve();
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
  const loginOpen=id=>{
    const child=nativeBrowsers.get(id);
    return !!child&&child.exitCode===null;
  };
  const accountPublic=account=>({
    id:account.id,name:account.name,createdAt:account.createdAt,
    browserEngine:'edge',profileCreated:fs.existsSync(profileDir(account)),
    nativeBrowserOpen:loginOpen(account.id)
  });
  const busy=()=>active.size>0||
    [...jobs.values()].some(j=>['queued','starting','running'].includes(j.status));
  const ensureBrowser=async(accountId)=>{
    if(!enableBrowser)throw new Error('ChatGPT 浏览器功能未启用');
    const account=findAccount(accountId);
    if(!account)throw new Error('ChatGPT 账号不存在，请重新添加');
    if(loginOpen(accountId))
      throw new Error('请先在独立 Edge 登录 ChatGPT，并关闭登录窗口后再生成');
    if(browser&&browserAccountId!==accountId){
      await browser.close();
      browser=null;browserAccountId=null;
    }
    if(!browser){
      browser=await startAutomation(account);
      browserAccountId=accountId;
      browser.on?.('close',()=>{
        browser=null;browserAccountId=null;
      });
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
      const page=await ensureBrowser(job.accountId);
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
        const context=browser;browser=null;browserAccountId=null;
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
  app.get('/api/chatgpt/accounts',(_req,res)=>
    res.json(accounts().map(accountPublic)));
  const openLogin=async(account)=>{
    if(busy())throw new Error('请等待 ChatGPT 生图任务结束后再打开登录浏览器');
    if(loginOpen(account.id))
      return {ok:true,message:'该 ChatGPT 账号的 Edge 登录窗口已打开'};
    if(browser){
      await browser.close();
      browser=null;browserAccountId=null;
    }
    fs.mkdirSync(profileDir(account),{recursive:true});
    const child=startNativeLogin(account);
    await new Promise((resolve,reject)=>{
      child.once('spawn',resolve);
      child.once('error',reject);
    });
    child.unref?.();
    nativeBrowsers.set(account.id,child);
    child.once('exit',()=>{
      if(nativeBrowsers.get(account.id)===child)
        nativeBrowsers.delete(account.id);
    });
    return {ok:true,browserEngine:'edge',
      message:'已打开 '+account.name+' 的独立 Microsoft Edge。请在 ChatGPT 网页手动登录，完成后关闭窗口。'};
  };
  app.post('/api/chatgpt/accounts', (req,res)=>{
    try{
      const name=String(req.body?.name||'').trim();
      if(!name||name.length>60)throw new Error('请输入 1–60 字的账号备注');
      const existing=accounts();
      const account={id:crypto.randomUUID(),name,createdAt:now(),
        browserEngine:'edge',
        // Reuse the pre-existing single-account profile on the first migration.
        ...(existing.length===0&&fs.existsSync(legacyProfileDir)
          ?{legacyProfile:true}:{})};
      existing.push(account);writeJson(accountsFile,existing);
      res.status(201).json(accountPublic(account));
    }catch(error){res.status(400).json({error:String(error.message||error)})}
  });
  app.post('/api/chatgpt/accounts/:id/native-login',async(req,res)=>{
    try{
      const account=validId(req.params.id)&&findAccount(req.params.id);
      if(!account)return res.status(404).json({error:'ChatGPT 账号不存在'});
      res.json(await openLogin(account));
    }catch(error){res.status(400).json({error:String(error.message||error)})}
  });
  app.delete('/api/chatgpt/accounts/:id',async(req,res)=>{
    try{
      const account=validId(req.params.id)&&findAccount(req.params.id);
      if(!account)return res.status(404).json({error:'ChatGPT 账号不存在'});
      if(loginOpen(account.id)||active.has(account.id)||
        [...jobs.values()].some(job=>job.accountId===account.id&&
          ['queued','starting','running'].includes(job.status)))
        return res.status(409).json({error:'请先关闭该账号登录窗口并完成生成任务'});
      if(browser&&browserAccountId===account.id){
        await browser.close();
        browser=null;browserAccountId=null;
      }
      writeJson(accountsFile,accounts().filter(item=>item.id!==account.id));
      fs.rmSync(profileDir(account),{recursive:true,force:true});
      res.json({ok:true});
    }catch(error){res.status(400).json({error:String(error.message||error)})}
  });
  app.get('/api/chatgpt/account',(_req,res)=>res.json({
    profileCreated:accounts().length>0,
    loginWindowOpen:accounts().some(item=>loginOpen(item.id)),
    browserOpen:!!browser,jobsRunning:active.size,
    accountCount:accounts().length
  }));
  app.post('/api/chatgpt/login',async(req,res)=>{
    try{
      const list=accounts();
      const account=list.find(item=>item.id===req.body?.accountId)||list[0];
      if(!account)throw new Error('请先添加 ChatGPT 浏览器账号');
      res.json(await openLogin(account));
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
      const all=accounts();
      if(!all.length)throw new Error('请先创建 ChatGPT 独立浏览器账号');
      const preferred=req.body?.accountId||node.data.chatgptAccountId||'auto';
      const account=preferred==='auto'
        ?all.find(item=>!loginOpen(item.id))||all[0]
        :all.find(item=>item.id===preferred);
      if(!account)throw new Error('指定的 ChatGPT 浏览器账号不存在');
      const refs=projectImageReferences(project,nodeId,prompt,
        req.body?.references||[]);
      for(const ref of refs)
        if(!localReferenceFile(uploadDir,ref.url))
          throw new Error('请先上传引用的本地图片：'+ref.name);
      const job={
        id:crypto.randomUUID(),projectId,nodeId,kind:'image',
        accountId:account.id,prompt,references:refs,
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
