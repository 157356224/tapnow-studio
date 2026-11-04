// Isolated Muse Edge accounts: the user logs in in native Edge, automation
// inherits only the profile for that same Muse account. HAR auth data is never
// read, replayed or written.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {
  browserLaunchOptions,accountProfileDir,nativeBrowserExecutable
} from './chromium-binary.mjs';
import {
  buildMusePrompt,findMuseEditor,runMuseBrowser
} from './muse-runner.mjs';
import {setMuseProjectJob} from './muse-project.mjs';
import {closeCompletedBrowser} from './browser-cleanup.mjs';
import {scheduleAccountJob} from './account-queue.mjs';
import {
  MUSE_QUOTA_REFRESH_MS,fetchMuseQuotaInPage,combineMuseQuotas,
  chooseMuseAutoAccount
} from './muse-quota.mjs';
import {
  projectImageReferences,localReferenceFile
} from './reference-selection.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const dataDir=path.join(root,'data');
const uploadDir=path.join(root,'uploads');
const profilesDir=path.join(dataDir,'muse-profiles');
const accountsFile=path.join(dataDir,'muse-accounts.json');
const jobsFile=path.join(dataDir,'muse-jobs.json');
for(const dir of [dataDir,uploadDir,profilesDir])fs.mkdirSync(dir,{recursive:true});
for(const file of [accountsFile,jobsFile])if(!fs.existsSync(file))fs.writeFileSync(file,'[]');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const write=(file,value)=>{
  const temporary=file+'.'+process.pid+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(value,null,2),{mode:0o600});
  fs.renameSync(temporary,file);
};
const validId=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
const account=id=>read(accountsFile).find(x=>x.id===id);
const present=x=>({id:x.id,name:x.name,createdAt:x.createdAt,browserEngine:'edge'});
const profileDir=x=>accountProfileDir(profilesDir,x);
const browsers=new Map();
const starts=new Map();
const nativeBrowsers=new Map();
const queues=new Map();
const activeJobs=new Map();
const quotaStates=new Map();
const quotaTasks=new Map();
let quotaRefreshPromise=null;
let lastQuotaRefresh=0;
const jobs=new Map(read(jobsFile).map(job=>[
  job.id,['queued','starting','running'].includes(job.status)
    ?{...job,status:'interrupted',progress:0,error:'Muse 生成被服务重启中断，需要重新发送'}:job
]));
if([...jobs.values()].some(job=>job.status==='interrupted'))
  write(jobsFile,[...jobs.values()]);
let getProjects=null,setProjects=null;
const persist=(job,patch)=>{
  if(!getProjects||!setProjects)return;
  const result=setMuseProjectJob(getProjects(),job,patch);
  if(result.changed)setProjects(result.projects);
};
const updateJob=(id,patch)=>{
  const previous=jobs.get(id);
  if(!previous)return;
  jobs.set(id,{...previous,...patch,updatedAt:new Date().toISOString()});
  write(jobsFile,[...jobs.values()].slice(-300));
};
const active=id=>[...jobs.values()].some(job=>job.accountId===id&&
  ['queued','starting','running'].includes(job.status));
const activeMusePage=context=>context.pages().find(page=>{
  if(page.isClosed())return false;
  try{return /(^|\.)muse\.ai$/i.test(new URL(page.url()).hostname)}catch{return false}
});
async function automatedBrowser(id){
  if(quotaTasks.has(id))await quotaTasks.get(id).catch(()=>{});
  if(starts.has(id))return await starts.get(id);
  const promise=(async()=>{
    const selected=account(id);
    if(!selected)throw new Error('Muse 账号不存在');
    if(nativeBrowsers.get(id)?.exitCode===null)
      throw new Error('Muse 独立登录 Edge 仍在运行。请登录后关闭该窗口，再在画布发送生成任务');
    if(browsers.has(id)){
      const context=browsers.get(id);
      let page=activeMusePage(context);
      if(!page){
        page=await context.newPage();
        await page.goto('https://muse.ai/',{waitUntil:'domcontentloaded',timeout:40000});
      }
      await page.bringToFront();
      return {context,page};
    }
    let context;
    try{
      context=await chromium.launchPersistentContext(profileDir(selected),{
        headless:false,acceptDownloads:true,viewport:{width:1440,height:900},
        ...browserLaunchOptions(),
        args:['--no-first-run','--no-default-browser-check',
          '--disable-background-mode']
      });
    }catch(err){
      throw new Error('Muse Edge 独立资料无法启动，先关闭正在使用该账号资料的窗口：'+
        String(err.message||err).slice(0,140));
    }
    browsers.set(id,context);
    context.on('close',()=>{if(browsers.get(id)===context)browsers.delete(id);});
    try{
      const page=activeMusePage(context)||context.pages()[0]||await context.newPage();
      if(!/^https:\/\/muse\.ai\//.test(page.url()))
        await page.goto('https://muse.ai/',{waitUntil:'domcontentloaded',timeout:40000});
      await page.bringToFront();
      return {context,page};
    }catch(err){await context.close();throw err;}
  })().finally(()=>starts.delete(id));
  starts.set(id,promise);
  return await promise;
}

async function nativeLogin(id){
  const selected=account(id);
  if(!selected)throw new Error('Muse 账号不存在');
  if(active(id))throw new Error('该 Muse 账号正在生成，任务结束后再登录');
  if(quotaTasks.has(id))await quotaTasks.get(id).catch(()=>{});
  if(starts.has(id))await starts.get(id).catch(()=>{});
  if(browsers.has(id))await browsers.get(id).close();
  if(nativeBrowsers.get(id)?.exitCode===null)
    throw new Error('Muse 登录 Edge 已打开；请使用现有窗口登录后关闭');
  const folder=profileDir(selected);
  fs.mkdirSync(folder,{recursive:true});
  const child=spawn(nativeBrowserExecutable(),[
    '--user-data-dir='+folder,
    '--new-window','--no-first-run','--no-default-browser-check',
    '--disable-background-mode',
    'https://muse.ai/'
  ],{detached:true,stdio:'ignore',windowsHide:false});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  child.unref();
  nativeBrowsers.set(id,child);
  child.once('exit',()=>{if(nativeBrowsers.get(id)===child)nativeBrowsers.delete(id);});
  return {ok:true,browserEngine:'edge',
    message:'Muse 独立 Edge 已打开。请自行登录，完成后关闭这个窗口，再在画布点击生成。'};
}

async function awaitMuseComposer(page){
  // Edge's shell may be visible before its React composer has hydrated.
  await page.waitForLoadState('domcontentloaded',{timeout:12000}).catch(()=>{});
  await page.waitForTimeout(3000);
  let editor=await findMuseEditor(page);
  if(editor)return editor;
  await page.locator('textarea[aria-label="消息"],textarea[placeholder="消息"],'+
    '[contenteditable="true"][role="textbox"]').first()
    .waitFor({state:'visible',timeout:15000}).catch(()=>{});
  return await findMuseEditor(page);
}

async function readAccountQuota(id){
  const selected=account(id);
  if(!selected)throw new Error('账号已删除');
  if(nativeBrowsers.get(id)?.exitCode===null)
    throw new Error('独立 Edge 登录窗口未关闭，暂不能读取额度');
  if(starts.has(id))await starts.get(id).catch(()=>{});
  const existing=browsers.get(id);
  let page=existing&&activeMusePage(existing);
  let tempContext=null;
  try{
    if(!page&&existing){
      page=await existing.newPage();
      await page.goto('https://muse.ai/',{waitUntil:'domcontentloaded',timeout:30000});
    }
    if(!page){
      tempContext=await chromium.launchPersistentContext(profileDir(selected),{
        headless:true,acceptDownloads:false,
        viewport:{width:1100,height:800},
        ...browserLaunchOptions(),
        args:['--no-first-run','--no-default-browser-check','--disable-background-mode']
      });
      page=tempContext.pages()[0]||await tempContext.newPage();
      if(!/^https:\/\/muse\.ai\//.test(page.url()))
        await page.goto('https://muse.ai/',{waitUntil:'domcontentloaded',timeout:30000});
    }
    if(!await awaitMuseComposer(page))
      throw new Error('Muse 尚未登录，无法查询额度');
    return await fetchMuseQuotaInPage(page);
  }finally{
    if(tempContext)await tempContext.close().catch(()=>{});
  }
}

async function updateAccountQuota(id){
  // Do not touch the page/profile while this account is rendering a job.
  // Preserve the last known quota and retry after the job completes.
  if(active(id))return;
  if(quotaTasks.has(id))return await quotaTasks.get(id);
  const task=(async()=>{
    try{
      const data=await readAccountQuota(id);
      quotaStates.set(id,{...data,status:'ok',fetchedAt:Date.now()});
    }catch(err){
      quotaStates.set(id,{status:'error',
        error:String(err.message||err).slice(0,200),fetchedAt:Date.now()});
    }
  })().finally(()=>quotaTasks.delete(id));
  quotaTasks.set(id,task);
  await task;
}

async function refreshAllQuotas({force=false}={}){
  if(quotaRefreshPromise)return await quotaRefreshPromise;
  if(!force&&Date.now()-lastQuotaRefresh<MUSE_QUOTA_REFRESH_MS)return;
  quotaRefreshPromise=(async()=>{
    const accounts=read(accountsFile);
    // Limit simultaneous Chromium profiles to avoid a large launch spike.
    for(let index=0;index<accounts.length;index+=2)
      await Promise.all(accounts.slice(index,index+2).map(x=>updateAccountQuota(x.id)));
    const live=new Set(read(accountsFile).map(x=>x.id));
    for(const id of quotaStates.keys())if(!live.has(id))quotaStates.delete(id);
    lastQuotaRefresh=Date.now();
  })().finally(()=>{quotaRefreshPromise=null});
  await quotaRefreshPromise;
}

function quotaSummary(){
  return combineMuseQuotas(read(accountsFile),quotaStates);
}

async function execute(job){
  const {page,context}=await automatedBrowser(job.accountId);
  if(!account(job.accountId))throw new Error('Muse 账号已删除');
  if(!await awaitMuseComposer(page)){
    await page.bringToFront();
    const err=new Error('等待 Edge 加载至少 3 秒及输入框初始化后仍未就绪，请检查 Muse 是否已登录');
    err.loginRequired=true;
    throw err;
  }
  const result=await runMuseBrowser({
    page,job,outputDir:uploadDir,
    localReferenceFile:url=>localReferenceFile(uploadDir,url),
    onProgress:(message,progress)=>updateJob(job.id,{
      status:'running',message,progress
    })
  });
  updateJob(job.id,{status:'completed',progress:100,
    mediaUrl:result.mediaUrl,message:'Muse 生成文件已保存并回填画布'});
  persist(job,{status:'done',progress:100,demo:false,mediaUrl:result.mediaUrl,
    jobMessage:'Muse '+(job.kind==='video'?'视频':'图片')+'已生成'});
  await closeCompletedBrowser({accountId:job.accountId,context,browsers,
    hasPending:active,provider:'Muse'});
}

function startJob(job){
  if(activeJobs.has(job.id))return;
  const waiting=queues.has(job.accountId);
  updateJob(job.id,{status:waiting?'queued':'starting',
    message:waiting?'该 Muse 账号正在生成，等待同账号前序任务':
      '正在使用 '+(account(job.accountId)?.name||'Muse')+' 的独立 Edge',
    progress:waiting?0:2});
  // Different account profiles run concurrently; only tasks on the same
  // profile wait for that account's previous task to finish.
  const task=scheduleAccountJob(queues,job.accountId,()=>{
    updateJob(job.id,{status:'starting',progress:2,
      message:'正在使用 '+(account(job.accountId)?.name||'Muse')+' 的独立 Edge'});
    return execute(job);
  }).catch(err=>{
    const message=String(err.message||err);
    const needsLogin=!!err.loginRequired;
    updateJob(job.id,{status:needsLogin?'needs-login':'needs-attention',
      progress:0,error:message,message});
    persist(job,{status:'error',progress:0,jobMessage:message.slice(0,260)});
  }).finally(()=>activeJobs.delete(job.id));
  activeJobs.set(job.id,task);
}

export function mountMuseRoutes(app,readProjects,writeProjects){
  getProjects=readProjects;setProjects=writeProjects;
  // Maintain the minute cache even when the canvas tab is backgrounded.
  // Re-entrant refreshes reuse quotaRefreshPromise.
  const timer=setInterval(()=>void refreshAllQuotas().catch(()=>{}),
    MUSE_QUOTA_REFRESH_MS);
  timer.unref?.();
  for(const job of jobs.values()){
    if(job.status==='interrupted')
      persist(job,{status:'error',progress:0,
        jobMessage:'Muse 任务在服务重启时中断，请重新生成'});
  }
  app.get('/api/muse/accounts',(_req,res)=>res.json(read(accountsFile).map(present)));
  app.get('/api/muse/quotas',async(req,res)=>{
    try{
      // Return the latest cache immediately; scanning numerous Edge
      // profiles can take longer than a UI request. Clients poll while
      // refreshing rather than blocking the hover panel.
      void refreshAllQuotas({force:req.query.force==='1'}).catch(()=>{});
      res.json({...quotaSummary(),refreshedAt:lastQuotaRefresh,
        refreshIntervalMs:MUSE_QUOTA_REFRESH_MS,
        refreshing:!!quotaRefreshPromise});
    }catch(err){
      res.status(500).json({error:'Muse 额度同步失败：'+String(err.message||err)});
    }
  });
  app.post('/api/muse/accounts',(req,res)=>{
    try{
      if('cookie' in (req.body||{})||'token' in (req.body||{}))
        throw new Error('Muse 只支持独立 Edge 手动登录，不导入 Cookie/Token');
      const name=String(req.body?.name||'Muse 账号').trim().slice(0,60);
      if(!name)throw new Error('请输入账号备注');
      const created={id:crypto.randomUUID(),name,createdAt:new Date().toISOString()};
      const all=read(accountsFile);all.push(created);write(accountsFile,all);
      lastQuotaRefresh=0;
      res.status(201).json(present(created));
    }catch(err){res.status(400).json({error:String(err.message||err)})}
  });
  app.post('/api/muse/accounts/:id/native-login',async(req,res)=>{
    try{
      if(!validId(req.params.id)||!account(req.params.id))
        return res.status(404).json({error:'Muse 账号不存在'});
      res.json(await nativeLogin(req.params.id));
    }catch(err){res.status(400).json({error:String(err.message||err)})}
  });
  app.get('/api/muse/accounts/:id/status',async(req,res)=>{
    if(!validId(req.params.id)||!account(req.params.id))
      return res.status(404).json({error:'Muse 账号不存在'});
    const context=browsers.get(req.params.id);
    const page=context&&activeMusePage(context);
    res.json({browserOpen:!!page,nativeBrowserOpen:nativeBrowsers.get(req.params.id)?.exitCode===null,
      loginRequired:page?!await findMuseEditor(page):null});
  });
  app.delete('/api/muse/accounts/:id',async(req,res)=>{
    const id=req.params.id;
    if(!validId(id)||!account(id))return res.status(404).json({error:'Muse 账号不存在'});
    if(active(id)||nativeBrowsers.get(id)?.exitCode===null)
      return res.status(409).json({error:'请先完成生成并关闭 Muse 原生 Edge 窗口'});
    if(browsers.has(id))await browsers.get(id).close();
    const selected=account(id);
    write(accountsFile,read(accountsFile).filter(x=>x.id!==id));
    quotaStates.delete(id);
    lastQuotaRefresh=0;
    fs.rmSync(profileDir(selected),{recursive:true,force:true,maxRetries:5,retryDelay:200});
    res.status(204).end();
  });
  app.get('/api/muse/jobs/:id',(req,res)=>{
    const job=jobs.get(req.params.id);
    if(!job)return res.status(404).json({error:'Muse 任务不存在'});
    res.json(job);
  });
  app.post('/api/muse/jobs',(req,res)=>{
    try{
      const {projectId,nodeId}=req.body||{};
      let {accountId}=req.body||{};
      let allocationVerified=null;
      if(!accountId||accountId==='auto'){
        const all=read(accountsFile);
        if(!all.length)throw new Error('请先添加 Muse 账号并完成独立 Edge 登录');
        // Never await quota scans (which may open Edge profiles) on the job
        // submission path: accepting a second job must not wait on the first
        // account's browser or a minutes-long background quota refresh.
        const ready=all.filter(x=>nativeBrowsers.get(x.id)?.exitCode!==null);
        const busy=new Set(ready.filter(x=>
          active(x.id)||queues.has(x.id)).map(x=>x.id));
        const queueDepths=new Map(ready.map(x=>{
          const count=[...jobs.values()].filter(job=>
            job.accountId===x.id&&
            ['queued','starting','running'].includes(job.status)).length;
          return [x.id,Math.max(count,queues.has(x.id)?1:0)];
        }));
        const lastUsed=new Map();
        for(const job of jobs.values())
          lastUsed.set(job.accountId,Math.max(lastUsed.get(job.accountId)||0,
            Date.parse(job.createdAt)||0));
        const best=chooseMuseAutoAccount(ready,quotaStates,{
          busyIds:busy,lastUsed,queueDepths
        });
        if(!best)
          throw new Error('没有已确认剩余额度大于 0 且已关闭登录窗口的 Muse 账号；请查看左侧 Muse 额度并检查登录状态');
        accountId=best.id;
        allocationVerified=best.verified;
      }
      if(!validId(accountId)||!account(accountId))
        throw new Error('Muse 账号不存在，请刷新账户列表');
      const project=readProjects().find(x=>x.id===projectId);
      const node=project?.nodes?.find(n=>n.id===nodeId);
      if(!node||!['image','video'].includes(node.data?.kind))
        throw new Error('Muse 仅接收画布上的图片/视频节点');
      const kind=node.data.kind;
      if(node.data.provider!=='muse'||req.body?.provider&&req.body.provider!=='muse')
        throw new Error('请先将节点生成方式切换为 Muse');
      const prompt=String(req.body?.prompt||node.data.prompt||'').trim();
      const references=projectImageReferences(
        project,nodeId,prompt,req.body?.references||[]
      );
      for(const ref of references){
        if(!localReferenceFile(uploadDir,ref.url))
          throw new Error('请先把 @ 引用的图片上传到本地素材库：'+ref.name);
      }
      const job={id:crypto.randomUUID(),projectId,nodeId,accountId,kind,
        allocationVerified,
        prompt,references,
        ratio:String(req.body?.ratio||node.data.ratio||'16:9'),
        resolution:kind==='image'
          ?String(req.body?.resolution||node.data.resolution||'2K')
          :undefined,
        duration:String(req.body?.duration||node.data.duration||'5s'),
        status:'queued',progress:0,
        message:'已分配 '+(account(accountId)?.name||'Muse')+
          (allocationVerified===false?'（额度暂不可读）':'')+
          (active(accountId)?'，该账号繁忙，已加入队列':'，准备并行启动独立 Edge'),
        createdAt:new Date().toISOString(),
        updatedAt:new Date().toISOString()};
      buildMusePrompt(job);
      jobs.set(job.id,job);write(jobsFile,[...jobs.values()].slice(-300));
      persist(job,{status:'queued',progress:0,jobMessage:'Muse 任务已排队，准备新建旁聊会话'});
      res.status(202).json(job);
      startJob(job);
    }catch(err){res.status(400).json({error:String(err.message||err)})}
  });
}
