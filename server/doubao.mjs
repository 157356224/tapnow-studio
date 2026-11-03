// Doubao bridge. Each account logs in manually in its own persistent Edge
// profile. Never import, replay, or separately store authentication cookies.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {projectImageReferences} from './reference-selection.mjs';
import { chromium } from 'playwright';
import { runSeedanceBrowser } from './doubao-runner.mjs';
import { validateMediaReferences } from './doubao-protocol.mjs';
import { setProjectJob } from './doubao-project.mjs';
import {closeCompletedBrowser} from './browser-cleanup.mjs';
import {
  browserLaunchOptions,accountEngine,accountProfileDir,nativeBrowserExecutable
} from './chromium-binary.mjs';
import {requiresWebLogin,showWebLogin} from './doubao-session.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const dataDir=path.join(root,'data');
const uploadDir=path.join(root,'uploads');
const accountsFile=path.join(dataDir,'doubao-accounts.json');
const jobsFile=path.join(dataDir,'doubao-jobs.json');
const secretsDir=path.join(dataDir,'doubao-secrets');
const profilesDir=path.join(dataDir,'doubao-profiles');
for(const dir of [dataDir,uploadDir,secretsDir,profilesDir])fs.mkdirSync(dir,{recursive:true});
if(!fs.existsSync(accountsFile))fs.writeFileSync(accountsFile,'[]');
if(!fs.existsSync(jobsFile))fs.writeFileSync(jobsFile,'[]');
const readJSON=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function writeJSON(file,data){
  const tmp=file+'.'+process.pid+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(data,null,2),{mode:0o600});
  fs.renameSync(tmp,file);
}
const findAccount=id=>readJSON(accountsFile).find(a=>a.id===id);
// Keep hasCookie=false temporarily for older local clients; it no longer
// represents or controls browser sign-in.
const present=a=>({id:a.id,name:a.name,createdAt:a.createdAt,hasCookie:false,
  browserEngine:accountEngine(),profile:'isolated-chromium'});
const validId=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);

// Preserve existing account IDs and Edge profiles. Legacy encrypted Cookie
// files are left untouched for safety, but are never read or replayed.
const storedAccounts=readJSON(accountsFile);
if(storedAccounts.some(account=>account.browserEngine!=='edge'||
    Object.hasOwn(account,'networkMode'))){
  for(const account of storedAccounts){
    account.browserEngine='edge';
    delete account.networkMode;
  }
  writeJSON(accountsFile,storedAccounts);
}

function localReferenceFile(url){
  if(typeof url!=='string'||!url.startsWith('/api/uploads/'))return null;
  const filename=url.slice('/api/uploads/'.length);
  if(!/^[a-f0-9-]{36}\.[a-z0-9.]{1,12}$/i.test(filename))return null;
  const full=path.join(uploadDir,filename);
  return fs.existsSync(full)?full:null;
}

const browsers=new Map();
const browserStarts=new Map();
const nativeBrowsers=new Map();
const accountQueues=new Map();
const networkTraces=new Map();
function activeDoubaoPage(context){
  return context.pages().find(page=>{
    if(page.isClosed())return false;
    try{return /(^|\.)doubao\.com$/i.test(new URL(page.url()).hostname);}
    catch{return false;}
  });
}
function observeAccountRequests(id,context){
  const entries=[];
  networkTraces.set(id,entries);
  context.on('response',response=>{
    try{
      const request=response.request();
      if(!['xhr','fetch'].includes(request.resourceType()))return;
      const url=new URL(request.url());
      if(!/(^|\.)doubao\.com$/i.test(url.hostname))return;
      const pathOnly=url.pathname.split('/').map(part=>
        part.length>32&&/^[a-zA-Z0-9._-]+$/.test(part)?':id':part
      ).join('/');
      entries.push({
        time:new Date().toISOString(),
        host:url.hostname,route:pathOnly,method:request.method(),
        status:response.status()
      });
      if(entries.length>250)entries.shift();
    }catch{}
  });
}
const jobs=new Map(readJSON(jobsFile).map(job=>[
  job.id,['queued','starting','running'].includes(job.status)
    ? {...job,status:'interrupted',message:'本地服务重启，需重新提交任务'}:job
]));
const activeJobs=new Map();
let projectRead=null;
let projectWrite=null;
function persistProjectNode(job,patch){
  if(!projectRead||!projectWrite)return false;
  const current=projectRead();
  const result=setProjectJob(current,job,patch);
  if(result.changed)projectWrite(result.projects);
  return result.changed;
}
function updateJob(id,patch){
  const job=jobs.get(id);
  if(!job)return;
  jobs.set(id,{...job,...patch,updatedAt:new Date().toISOString()});
  writeJSON(jobsFile,[...jobs.values()].slice(-300));
}
async function launchAccountBrowser(id){
  const account=findAccount(id);
  if(!account)throw new Error('账号不存在');
  if(nativeBrowsers.has(id)){
    const native=nativeBrowsers.get(id);
    if(native.exitCode===null)
      throw new Error('该账号的原生 Edge 仍在运行。请先关闭原生 Edge 窗口，再从画布点击发送以恢复自动化');
    nativeBrowsers.delete(id);
  }
  if(browsers.has(id)){
    const context=browsers.get(id);
    let page=activeDoubaoPage(context);
    if(!page){
      page=await context.newPage();
      await page.goto('https://www.doubao.com/chat/',{
        waitUntil:'domcontentloaded',timeout:35000
      });
    }
    await page.bringToFront();
    return {context,page};
  }
  let context;
  try{
    context=await chromium.launchPersistentContext(accountProfileDir(profilesDir,account),{
      headless:false,viewport:{width:1440,height:900},acceptDownloads:true,
      ...browserLaunchOptions(),
      args:['--no-first-run','--no-default-browser-check']
    });
  }catch(err){
    const reason=String(err.message||err);
    if(/ProcessSingleton|profile.*in use|user data directory.*in use|SingletonLock/i.test(reason))
      throw new Error('该账号 Edge 配置正被另一个浏览器进程使用。请先关闭对应窗口，再点击“登录”打开；账号资料不会被删除。');
    throw new Error('系统 Microsoft Edge 启动失败，请检查 Edge 安装。'+reason.slice(0,170));
  }
  browsers.set(id,context);
  observeAccountRequests(id,context);
  context.on('close',()=>{if(browsers.get(id)===context)browsers.delete(id);});
  try{
    // Persistent Edge automatically restores its own session after manual
    // login. No Cookie injection or cross-profile session copying.
    const page=context.pages().find(x=>!x.isClosed())||await context.newPage();
    await page.goto('https://www.doubao.com/chat/',{waitUntil:'domcontentloaded',timeout:35000});
    await page.bringToFront();
    return {context,page};
  }catch(err){
    await context.close();
    throw err;
  }
}
function activeAccountJob(id){
  return [...jobs.values()].some(job=>job.accountId===id&&
    ['queued','starting','running'].includes(job.status));
}

async function openNativeBrowser(id){
  const account=findAccount(id);
  if(!account)throw new Error('账号不存在');
  if(activeAccountJob(id))
    throw new Error('该账号正在执行视频任务，请任务结束后再切换浏览器');
  if(browserStarts.has(id))await browserStarts.get(id).catch(()=>{});
  if(browsers.has(id))await browsers.get(id).close();
  const oldNative=nativeBrowsers.get(id);
  if(oldNative&&oldNative.exitCode===null)
    throw new Error('原生浏览器已在运行。请先关闭窗口，再切换浏览器类型');

  // Edge account profile is isolated from historic portable Chrome profiles.
  const executable=nativeBrowserExecutable();
  const folder=accountProfileDir(profilesDir,account);
  fs.mkdirSync(folder,{recursive:true});
  const args=[
    '--user-data-dir='+folder,
    '--new-window',
    '--no-first-run',
    '--no-default-browser-check',
    'https://www.doubao.com/chat/'
  ];
  // Native Edge launch: no Playwright/CDP/extension, no browser
  // fingerprint alteration and no CAPTCHA automation. Human completes login.
  const child=spawn(executable,args,{
    detached:true,stdio:'ignore',windowsHide:false
  });
  await new Promise((resolve,reject)=>{
    child.once('spawn',resolve);
    child.once('error',reject);
  });
  child.unref();
  nativeBrowsers.set(id,child);
  child.once('exit',()=>{if(nativeBrowsers.get(id)===child)nativeBrowsers.delete(id);});
  const all=readJSON(accountsFile);
  const entry=all.find(x=>x.id===id);
  entry.browserEngine='edge';
  writeJSON(accountsFile,all);
  return {ok:true,browserEngine:'edge',
    message:'已打开不受自动化控制的原生 Microsoft Edge（独立账号资料）。'+
      '请在这个窗口正常完成豆包登录及验证，结束后关闭该窗口，再在画布发送任务。'};
}
async function openBrowser(id){
  if(browserStarts.has(id))return await browserStarts.get(id);
  const promise=launchAccountBrowser(id).finally(()=>browserStarts.delete(id));
  browserStarts.set(id,promise);
  return await promise;
}

async function runJob(job){
  updateJob(job.id,{status:'starting',progress:3,
    message:'已定位浏览器账号，正在进入豆包视频生成'});
  const {page,context}=await openBrowser(job.accountId);
  if(!findAccount(job.accountId))throw new Error('账号已被删除');
  if(await requiresWebLogin(page)){
    await showWebLogin(page);
    const err=new Error('豆包账号尚未登录。已打开浏览器登录界面，请完成登录后重新发送。');
    err.loginRequired=true;
    throw err;
  }
  const result=await runSeedanceBrowser({
    page,job,localReferenceFile,outputDir:uploadDir,
    onProgress:(message,progress,phase)=>{
      // Submission, upload and confirmation are NOT evidence that a video
      // actually started. The frontend only enters running on the explicit
      // Seedance start-of-generation reply.
      const started=phase==='started'||jobs.get(job.id)?.status==='running';
      updateJob(job.id,{status:started?'running':'queued',message,progress});
      if(phase==='started')persistProjectNode(job,{
        status:'running',progress,jobMessage:message
      });
    }
  });
  updateJob(job.id,{
    status:'completed',progress:100,
    submittedModel:result.submittedModel,
    videoIds:result.videoIds,
    videoUrl:'/api/uploads/'+path.basename(result.filename),
    message:'已取得真实视频文件，并回填画布的视频节点'
  });
  persistProjectNode(job,{
    status:'done',progress:100,demo:false,
    mediaUrl:'/api/uploads/'+path.basename(result.filename),
    jobMessage:'真实视频已保存到当前节点'
  });
  await closeCompletedBrowser({accountId:job.accountId,context,browsers,
    hasPending:activeAccountJob,provider:'豆包'});
}
function startJob(job){
  if(activeJobs.has(job.id))return;
  // Launch/focus the selected account browser NOW, not after waiting behind
  // earlier long-running video jobs. This is also the login preflight.
  updateJob(job.id,{status:'starting',progress:1,
    message:'正在打开并唤起对应豆包账号浏览器'});
  const opening=openBrowser(job.accountId);
  // One account owns one active tab, so actual submissions remain sequential.
  // Different accounts keep independent queues and can operate concurrently.
  const previous=accountQueues.get(job.accountId)||Promise.resolve();
  const task=(async()=>{
    const {page}=await opening;
    if(await requiresWebLogin(page)){
      await showWebLogin(page);
      const message='豆包账号尚未登录。已打开浏览器登录界面，登录后重新点击视频节点发送。';
      updateJob(job.id,{status:'needs-login',progress:0,
        error:message,message});
      persistProjectNode(job,{status:'error',progress:0,jobMessage:message});
      return;
    }
    updateJob(job.id,{status:'queued',progress:0,
      message:'浏览器已打开，等待该账号前序视频任务结束'});
    await previous.catch(()=>undefined);
    await runJob(job);
  })().catch(e=>{
    const message=String(e?.message||e).slice(0,400);
    const needsLogin=!!e?.loginRequired;
    updateJob(job.id,{status:needsLogin?'needs-login':'needs-attention',
      progress:0,error:message,
      message:needsLogin
        ?'请在已打开的豆包浏览器完成登录'
        :'生成任务未完成：'+message});
    persistProjectNode(job,{
      status:'error',progress:0,
      jobMessage:message.slice(0,250)
    });
  }).finally(()=>activeJobs.delete(job.id));
  activeJobs.set(job.id,task);
  // Keep earlier work in the queue even when a later task immediately fails
  // its login preflight; that failure must not erase the previous task tail.
  accountQueues.set(job.accountId,
    Promise.allSettled([previous,task]).then(()=>undefined));
}
export function mountDoubaoRoutes(app,readProjects,writeProjects){
  projectRead=readProjects;
  projectWrite=writeProjects;
  // Restore node state for jobs interrupted by a backend restart, so a video
  // node cannot stay permanently "generating 10%" with no running worker.
  for(const job of jobs.values()){
    if(job.status==='interrupted'){
      const message='本地服务已重新启动，原视频任务已中断；请重新发送';
      updateJob(job.id,{status:'interrupted',progress:0,message,error:message});
      persistProjectNode(job,{status:'error',progress:0,jobMessage:message});
    }
  }
  app.get('/api/doubao/accounts',(_req,res)=>res.json(readJSON(accountsFile).map(present)));
  app.post('/api/doubao/accounts',(req,res)=>{
    try{
      const name=String(req.body.name||'豆包账号').trim().slice(0,60);
      if(!name)throw new Error('请输入账号备注');
      if(req.body.cookie!==undefined)
        throw new Error('已关闭 Cookie 导入。请创建账号并在独立 Edge 浏览器内手动登录');
      const id=crypto.randomUUID();
      const account={id,name,createdAt:new Date().toISOString(),hasCookie:false,browserEngine:'edge'};
      const all=readJSON(accountsFile);all.push(account);writeJSON(accountsFile,all);
        res.status(201).json(present(account));
    }catch(err){res.status(400).json({error:String(err.message||err)});}
  });
  app.post('/api/doubao/accounts/:id/open',async(req,res)=>{
    try{
      if(!validId(req.params.id))throw new Error('无效账号 ID');
      const {page}=await openBrowser(req.params.id);
      const loginRequired=await requiresWebLogin(page);
      if(loginRequired&&req.body?.showLogin)await showWebLogin(page);
      res.json({ok:true,loginRequired,
        message:loginRequired
          ?'账号尚未登录，浏览器已打开。请在豆包页面完成登录，再回到画布点击生成。'
          :'独立 Edge 已打开，请确认豆包的登录状态'});
    }catch(err){res.status(400).json({error:String(err.message||err)});}
  });
  app.post('/api/doubao/accounts/:id/native-login',async(req,res)=>{
    try{
      const id=req.params.id;
      if(!validId(id)||!findAccount(id))return res.status(404).json({error:'账号不存在'});
      if(req.body?.browserEngine&&req.body.browserEngine!=='edge')
        throw new Error('仅支持系统 Microsoft Edge');
      res.json(await openNativeBrowser(id));
    }catch(err){res.status(400).json({error:String(err.message||err)});}
  });
  app.get('/api/doubao/accounts/:id/status',async(req,res)=>{
    if(!validId(req.params.id)||!findAccount(req.params.id))
      return res.status(404).json({error:'账号不存在'});
    const context=browsers.get(req.params.id);
    const page=context&&activeDoubaoPage(context);
    const native=nativeBrowsers.get(req.params.id);
    const nativeBrowserOpen=!!native&&native.exitCode===null;
    if(!page)return res.json({browserOpen:false,loginRequired:null,nativeBrowserOpen});
    res.json({browserOpen:true,loginRequired:await requiresWebLogin(page),nativeBrowserOpen});
  });
  app.get('/api/doubao/accounts/:id/trace',(req,res)=>{
    if(!validId(req.params.id)||!findAccount(req.params.id))
      return res.status(404).json({error:'账号不存在'});
    // Redacted request metadata only. No Cookie, Authorization, query string,
    // request/response bodies, media URLs, or arbitrary CDP capture.
    res.json({accountId:req.params.id,capture:'XHR/Fetch metadata only',
      records:[...(networkTraces.get(req.params.id)||[])]});
  });
  app.delete('/api/doubao/accounts/:id',async(req,res)=>{
    const id=req.params.id;
    if(!validId(id)||!findAccount(id))return res.status(404).json({error:'账号不存在'});
    if(nativeBrowsers.get(id)?.exitCode===null)
      return res.status(409).json({error:'请先关闭该账号原生浏览器，再删除其资料'});
    if(browsers.has(id))await browsers.get(id).close();
    writeJSON(accountsFile,readJSON(accountsFile).filter(x=>x.id!==id));
    fs.rmSync(path.join(secretsDir,id+'.dpapi'),{force:true});
    fs.rmSync(path.join(profilesDir,id),{
      recursive:true,force:true,maxRetries:8,retryDelay:200
    });
    fs.rmSync(path.join(profilesDir,id+'-edge'),{
      recursive:true,force:true,maxRetries:8,retryDelay:200
    });
    networkTraces.delete(id);
    res.status(204).end();
  });
  app.get('/api/doubao/jobs/:id',(req,res)=>{
    const job=jobs.get(req.params.id);
    if(!job)return res.status(404).json({error:'任务不存在'});
    res.json(job);
  });
  app.post('/api/doubao/jobs',(req,res)=>{
    try{
      const {accountId,projectId,nodeId}=req.body||{};
      if(!validId(accountId)||!findAccount(accountId))throw new Error('请先添加豆包账号');
      const project=readProjects().find(x=>x.id===projectId);
      const node=project?.nodes?.find(n=>n.id===nodeId&&n.data?.kind==='video');
      if(!node)throw new Error('画布中没有该视频节点');
      const prompt=String(req.body.prompt||node.data.prompt||'').trim();
      if(!prompt||prompt.length>12000)throw new Error('请填写视频提示词');
      const references=projectImageReferences(project,nodeId,prompt,req.body.references||[]);
      validateMediaReferences(references);
      for(const ref of references)if(!localReferenceFile(ref.url))
        throw new Error('请先将参考素材上传到画布素材库：'+ref.name);
      const ratio=String(req.body.ratio||node.data.ratio||'16:9');
      const duration=String(req.body.duration||node.data.duration||'10s');
      if(!/^\d{1,2}:\d{1,2}$/.test(ratio))throw new Error('视频比例格式错误');
      const durationSeconds=Number.parseInt(duration,10);
      if(!/^\d{1,2}s$/.test(duration)||durationSeconds<4||durationSeconds>15)
        throw new Error('视频时长必须为 4–15 秒');
      const model=String(req.body.model||node.data.model||'Seedance 2.0 Mini');
      if(!['Seedance 2.0 Mini','Seedance 2.0 Fast'].includes(model))
        throw new Error('当前豆包浏览器仅支持 Seedance 2.0 Mini 和 Fast：'+model);
      const job={id:crypto.randomUUID(),accountId,projectId,nodeId,
        model,prompt,
        ratio,duration,
        references,status:'queued',progress:0,message:'排队启动浏览器',
        createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
      jobs.set(job.id,job);writeJSON(jobsFile,[...jobs.values()].slice(-300));
      persistProjectNode(job,{
        status:'queued',progress:0,
        jobMessage:'豆包任务已创建，准备打开独立 Edge'
      });
      res.status(202).json(job);
      startJob(job);
    }catch(err){res.status(400).json({error:String(err.message||err)});}
  });
}
