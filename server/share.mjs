import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {snapshotCanvas,applyCanvasPatch} from '../src/share-sync.mjs';

const LEASE_MS=20000;
const MAX_ATTEMPTS=6;
const now=()=>Date.now();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const csrfSafe=req=>{
  if(req.headers['sec-fetch-site']==='cross-site')return false;
  const origin=req.headers.origin;
  if(!origin)return true;
  try{
    const u=new URL(origin);
    return u.protocol==='http:'&&u.host===req.headers.host;
  }catch{return false;}
};
const privateIPv4=address=>{
  const ip=address?.replace(/^::ffff:/,'');
  if(ip==='127.0.0.1'||ip==='::1')return true;
  if(!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip||''))return false;
  const parts=ip.split('.').map(Number);
  if(parts.some(part=>part>255))return false;
  return parts[0]===10||(parts[0]===192&&parts[1]===168)||
    (parts[0]===172&&parts[1]>=16&&parts[1]<=31);
};
const addresses=()=>[...new Set(Object.values(os.networkInterfaces()).flat()
  .filter(entry=>entry?.family==='IPv4'&&!entry.internal&&privateIPv4(entry.address))
  .map(entry=>entry.address))];

async function ensureGuestBundle(projectDir){
  const target=path.join(projectDir,'dist','index.html');
  // dist/ is gitignored, so pulling a source fix does not update it. Rebuild
  // before each new share to avoid serving an obsolete LAN guest bundle.
  for(const args of [
    [path.join(projectDir,'node_modules','typescript','bin','tsc'),'-b'],
    [path.join(projectDir,'node_modules','vite','bin','vite.js'),'build']
  ]){
    await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,args,{
        cwd:projectDir,windowsHide:true,stdio:['ignore','pipe','pipe']
      });
      let errorText='';
      child.stderr.on('data',buffer=>{
        errorText=(errorText+buffer.toString()).slice(-2000);
      });
      child.stdout.resume();
      child.once('error',reject);
      child.once('close',code=>code===0?resolve():
        reject(new Error('共享页面编译失败：'+errorText.trim())));
    });
  }
  if(!fs.existsSync(target))throw new Error('共享页面未生成');
}

export function mountShareRoutes(app,{
  read,write,root,uploadDir,lanPort=3702,upstreamPort=3701
}){
  let active=null;
  let lanServer=null;
  let pollTimer=null;
  const attempts=new Map();
  const sharedPort=()=>lanServer?.address()?.port||lanPort;
  const urls=()=>addresses().map(ip=>'http://'+ip+':'+sharedPort()+'/');
  const fail=(res,status,message)=>res.status(status).json({error:message});
  const findProject=()=>read().find(item=>item.id===active?.projectId);
  const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';')
    .map(item=>item.trim().split('=')).filter(parts=>parts.length===2));
  const owner=req=>({id:String(req.query.clientId||req.body?.clientId||'host').slice(0,100),
    label:'用户1（主机）',role:'host'});
  function participant(req){
    if(!active)return null;
    const token=cookies(req).tapnow_share;
    return token?active.guests.get(token)||null:null;
  }
  function cleanLocks(){
    if(!active)return false;
    let changed=false;
    for(const [id,lock] of active.locks){
      if(lock.expires<=now()){
        active.locks.delete(id);
        changed=true;
      }
    }
    return changed;
  }
  function online(){
    if(!active)return [];
    return [{id:active.ownerId,label:'用户1（主机）',role:'host'},
      ...[...active.guests.values()]
        .filter(({id})=>(active.connections.get(id)||0)>0)
        .map(({id,label})=>({id,label,role:'guest'}))];
  }
  function state(){
    return {
      type:'state',revision:active.revision,
      project:findProject(),
      locks:[...active.locks.entries()].map(([nodeId,lock])=>({
        nodeId,clientId:lock.clientId,label:lock.label
      })),
      online:online()
    };
  }
  function writeEvent(res,payload){
    if(res.destroyed||res.writableEnded)return;
    try{res.write('data: '+JSON.stringify(payload)+'\n\n');}catch{}
  }
  function broadcast(){
    if(!active)return;
    const payload=state();
    for(const res of active.listeners)writeEvent(res,payload);
  }
  function touchJobsFromDisk(){
    if(!active)return;
    const current=findProject();
    if(!current){void stop();return;}
    const incoming=snapshotCanvas(current);
    if(!same(active.last, incoming)){
      active.last=incoming;
      active.revision++;
      broadcast();
    }else if(cleanLocks())broadcast();
  }
  function updatePatch(patch,who,res){
    if(!active)return fail(res,409,'画布尚未共享');
    if(!patch||typeof patch!=='object'||Array.isArray(patch))
      return fail(res,400,'无效同步消息');
    const items=read();
    const index=items.findIndex(item=>item.id===active.projectId);
    if(index<0)return fail(res,404,'画布不存在');
    cleanLocks();
    const old=items[index];
    const merged=applyCanvasPatch(old,patch,{
      locks:active.locks,clientId:who.id
    });
    // Never accept arbitrary paths or credentials from a collaboration patch.
    for(const node of merged.nodes){
      if(typeof node.id!=='string'||typeof node.data?.kind!=='string')
        return fail(res,400,'节点数据格式错误');
    }
    if(!same(snapshotCanvas(old),merged)){
      items[index]={...old,...merged,updatedAt:new Date().toISOString()};
      write(items);
      active.last=snapshotCanvas(items[index]);
      active.revision++;
      broadcast();
    }
    res.json({revision:active.revision,project:items[index]});
  }
  function handleLock(req,res,who){
    if(!active)return fail(res,409,'画布未共享');
    const nodeId=String(req.body?.nodeId||'');
    if(!nodeId||nodeId.length>200||!findProject()?.nodes.some(n=>n.id===nodeId))
      return fail(res,404,'节点不存在');
    const action=req.body?.action||'acquire';
    cleanLocks();
    const existing=active.locks.get(nodeId);
    if(action==='release'){
      if(existing?.clientId===who.id)active.locks.delete(nodeId);
    }else if(existing&&existing.clientId!==who.id){
      return fail(res,423,existing.label+' 正在使用这个节点');
    }else{
      active.locks.set(nodeId,{
        clientId:who.id,label:who.label,expires:now()+LEASE_MS
      });
    }
    broadcast();
    res.json({ok:true,locks:state().locks});
  }
  function handleEvents(req,res,who){
    if(!active)return fail(res,409,'画布未共享');
    res.writeHead(200,{
      'Content-Type':'text/event-stream; charset=utf-8',
      'Cache-Control':'no-cache, no-transform',
      Connection:'keep-alive',
      'X-Accel-Buffering':'no'
    });
    active.listeners.add(res);
    active.connections.set(who.id,(active.connections.get(who.id)||0)+1);
    writeEvent(res,state());
    broadcast();
    const heartbeat=setInterval(()=>{
      if(!res.writableEnded)res.write(': heartbeat\n\n');
    },10000);
    req.on('close',()=>{
      clearInterval(heartbeat);
      if(active){
        active.listeners.delete(res);
        const remaining=(active.connections.get(who.id)||1)-1;
        if(remaining>0)active.connections.set(who.id,remaining);
        else active.connections.delete(who.id);
        broadcast();
      }
    });
  }
  async function stop(){
    if(!active)return;
    for(const res of active.listeners){
      writeEvent(res,{type:'stopped'});
      res.end();
    }
    active=null;
    if(pollTimer){clearInterval(pollTimer);pollTimer=null;}
    if(lanServer){
      const server=lanServer;
      lanServer=null;
      const completion=new Promise(resolve=>server.close(resolve));
      server.closeAllConnections?.();
      await completion;
    }
  }
  function hostOnly(req,res,next){
    // Vite serves the host UI on :5173 and proxies /api to loopback :3701.
    // Keep the strict same-origin check on the LAN guest server; only this
    // loopback host route may accept these two exact development origins.
    const fromHostUI=['http://127.0.0.1:5173','http://localhost:5173']
      .includes(req.headers.origin)&&
      req.headers['sec-fetch-site']!=='cross-site';
    if(!csrfSafe(req)&&!fromHostUI)
      return fail(res,403,'不允许跨站更改共享设置');
    next();
  }
  const host=express.Router();
  host.get('/info',(_req,res)=>res.json(active
    ?{role:'host',projectId:active.projectId,code:active.code,links:urls(),
      revision:active.revision}
    :{role:'none'}));
  host.post('/start',async(req,res)=>{
    const projectId=String(req.body?.projectId||'');
    if(!read().some(p=>p.id===projectId))return fail(res,404,'画布不存在');
    if(active&&active.projectId===projectId){
      return res.json({role:'host',projectId,code:active.code,links:urls()});
    }
    if(active)await stop();
    try{await ensureGuestBundle(path.join(root,'..'));}
    catch(error){return fail(res,409,error.message);}
    const code=String(crypto.randomInt(10000,100000));
    active={
      projectId,code,ownerId:String(req.body?.clientId||'host').slice(0,100),
      revision:1,last:snapshotCanvas(read().find(p=>p.id===projectId)),
      guests:new Map(),listeners:new Set(),locks:new Map(),
      connections:new Map(),nextGuest:2,
      allowedJobs:new Set()
    };
    try{
      lanServer=await new Promise((resolve,reject)=>{
        const server=lanApp.listen(lanPort,'0.0.0.0',()=>resolve(server));
        server.once('error',reject);
      });
    }catch(error){
      active=null;
      return fail(res,500,'共享端口 '+lanPort+' 无法启动：'+error.message);
    }
    pollTimer=setInterval(touchJobsFromDisk,500);
    pollTimer.unref?.();
    res.json({role:'host',projectId,code,links:urls()});
  });
  host.post('/stop',async(_req,res)=>{
    await stop();
    res.json({role:'none'});
  });
  host.post('/patch',(req,res)=>updatePatch(req.body?.patch,owner(req),res));
  host.post('/lock',(req,res)=>handleLock(req,res,owner(req)));
  host.get('/events',(req,res)=>handleEvents(req,res,owner(req)));
  app.use('/api/share',hostOnly,host);

  const lanApp=express();
  lanApp.disable('x-powered-by');
  // Deny cross-origin mutations, including DNS-rebinding hostnames.
  lanApp.use((req,res,next)=>{
    if(!privateIPv4(req.socket.remoteAddress))
      return fail(res,403,'仅允许局域网内访问');
    const host=String(req.headers.host||'').split(':')[0];
    if(!['localhost','127.0.0.1',...addresses()].includes(host))
      return fail(res,403,'局域网访问地址不正确');
    if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!csrfSafe(req))
      return fail(res,403,'拒绝跨站写入');
    next();
  });
  lanApp.get('/api/share/info',(req,res)=>{
    const who=participant(req);
    res.json(who?{role:'guest',projectId:active.projectId,label:who.label,
      clientId:who.id,revision:active.revision}:{role:'join'});
  });
  const gate=express.json({limit:'2mb'});
  lanApp.post('/api/share/join',gate,(req,res)=>{
    if(!active)return fail(res,409,'当前没有共享画布');
    const ip=req.ip||req.socket.remoteAddress||'unknown';
    const track=attempts.get(ip)||{at:now(),count:0};
    if(now()-track.at>60000){track.at=now();track.count=0;}
    track.count++;
    attempts.set(ip,track);
    if(track.count>MAX_ATTEMPTS)return fail(res,429,'尝试过于频繁，请一分钟后重试');
    const code=String(req.body?.code||'');
    if(!/^\d{5}$/.test(code)||code!==active.code)
      return fail(res,403,'加入码错误');
    const token=crypto.randomBytes(24).toString('hex');
    const who={
      id:crypto.randomUUID(),label:'用户'+active.nextGuest++,role:'guest'
    };
    active.guests.set(token,who);
    res.cookie('tapnow_share',token,{
      httpOnly:true,sameSite:'strict',path:'/'
    });
    res.json({role:'guest',projectId:active.projectId,label:who.label,
      clientId:who.id});
    broadcast();
  });
  lanApp.use('/api/share',(req,res,next)=>{
    if(!participant(req))return fail(res,401,'请先输入5位加入码');
    next();
  });
  lanApp.post('/api/share/patch',gate,(req,res)=>
    updatePatch(req.body?.patch,participant(req),res));
  lanApp.post('/api/share/lock',gate,(req,res)=>
    handleLock(req,res,participant(req)));
  lanApp.get('/api/share/events',(req,res)=>handleEvents(req,res,participant(req)));
  lanApp.post('/api/share/leave',(req,res)=>{
    const who=participant(req);
    if(who){
      for(const [id,lock] of active.locks)if(lock.clientId===who.id)active.locks.delete(id);
      active.guests.delete(cookies(req).tapnow_share);
      broadcast();
    }
    res.clearCookie('tapnow_share',{path:'/'});
    res.json({role:'join'});
  });
  lanApp.use('/api/share',(_req,res)=>fail(res,404,'不存在的共享接口'));

  function requireGuest(req,res,next){
    if(!participant(req))return fail(res,401,'请先输入5位加入码');
    next();
  }
  lanApp.get('/api/projects',requireGuest,(_req,res)=>{
    const project=findProject();
    if(!project)return fail(res,404,'画布不存在');
    res.json([{id:project.id,title:project.title,updatedAt:project.updatedAt}]);
  });
  lanApp.get('/api/projects/:id',requireGuest,(req,res)=>{
    const project=findProject();
    if(!project||req.params.id!==project.id)return fail(res,404,'画布不存在');
    res.json(project);
  });
  lanApp.all('/api/projects/:id',requireGuest,(_req,res)=>
    fail(res,409,'共享画布需通过实时同步接口保存'));

  // Only allow the collaboration APIs and generation/media calls. Account
  // management, cookies, passwords, independent browser controls and ALL
  // other loopback endpoints remain unavailable over the LAN.
  const canProxy=req=>{
    const url=new URL(req.originalUrl,'http://localhost');
    const p=url.pathname,m=req.method;
    if(m==='GET'&&/^\/api\/uploads\/[a-z0-9._-]+$/i.test(p))return true;
    if(m==='POST'&&p==='/api/assets')return true;
    if(m==='GET'&&p==='/api/health')return true;
    if(m==='GET'&&p==='/api/h3/config')return true;
    if(m==='POST'&&p==='/api/workflow/plan')return true;
    if(m==='POST'&&/^\/api\/videos\/extract-(?:frame|last-frame)$/.test(p))return true;
    if(m==='GET'&&/^\/api\/(?:doubao|muse|chatgpt)\/accounts$/.test(p))return true;
    if(m==='GET'&&p==='/api/muse/quotas')return true;
    if(m==='POST'&&/^\/api\/(?:doubao|muse|h3|chatgpt)\/jobs$/.test(p))return true;
    if(m==='GET'&&/^\/api\/(?:doubao|muse|h3|chatgpt)\/jobs\/[a-z0-9-]+$/.test(p))
      return active.allowedJobs.has(p.split('/').at(-1));
    return false;
  };
  function proxy(req,res){
    if(!canProxy(req))return fail(res,403,'此接口不对协作者开放');
    const pathname=new URL(req.originalUrl,'http://localhost').pathname;
    if(req.method==='POST'&&/\/jobs$/.test(pathname)){
      // Stream the request only for the project that was explicitly shared.
      // Guest requests cannot launch jobs on any other host project.
      return gate(req,res,()=>{
        if(req.body?.projectId!==active.projectId||
           !findProject()?.nodes.some(node=>node.id===req.body?.nodeId))
          return fail(res,403,'只能在当前共享画布生成');
        forward(req,res,Buffer.from(JSON.stringify(req.body)));
      });
    }
    if(req.method==='GET'&&/\/accounts$/.test(pathname)){
      // Never return any cookie values or account credentials.
      return fetch('http://127.0.0.1:'+upstreamPort+req.originalUrl)
        .then(async response=>{
          const items=await response.json();
          if(!response.ok)return res.status(response.status).json({error:items.error});
          res.json((Array.isArray(items)?items:[]).map(item=>({
            id:item.id,name:item.name,nativeBrowserOpen:!!item.nativeBrowserOpen,
            hasCookie:!!item.hasCookie
          })));
        }).catch(error=>fail(res,502,error.message));
    }
    if(req.method==='GET'&&pathname==='/api/h3/config')
      return fetch('http://127.0.0.1:'+upstreamPort+req.originalUrl)
        .then(async response=>{
          const config=await response.json();
          res.status(response.status).json({configured:!!config.configured});
        }).catch(error=>fail(res,502,error.message));
    forward(req,res);
  }
  function forward(req,res,body){
    const headers={...req.headers,
      host:'127.0.0.1:'+upstreamPort
    };
    for(const key of ['origin','referer','cookie','connection','transfer-encoding',
      'sec-fetch-site','content-length'])delete headers[key];
    if(body)headers['content-length']=String(body.length);
    else if(req.headers['content-length'])
      headers['content-length']=req.headers['content-length'];
    const upstream=http.request({
      host:'127.0.0.1',port:upstreamPort,
      path:req.originalUrl,method:req.method,headers
    },response=>{
      const isJob=req.method==='POST'&&/\/jobs$/.test(
        new URL(req.originalUrl,'http://localhost').pathname);
      if(!isJob){
        res.writeHead(response.statusCode||502,response.headers);
        response.pipe(res);return;
      }
      const chunks=[];
      response.on('data',chunk=>chunks.push(chunk));
      response.on('end',()=>{
        const buffer=Buffer.concat(chunks);
        if((response.statusCode||500)<300){
          try{
            const job=JSON.parse(buffer.toString('utf8'));
            if(typeof job.id==='string')active?.allowedJobs.add(job.id);
          }catch{}
        }
        res.status(response.statusCode||502);
        res.setHeader('Content-Type','application/json');
        res.end(buffer);
      });
    });
    upstream.on('error',error=>{
      if(!res.headersSent)fail(res,502,'主机 API 暂时不可用：'+error.message);
      else res.end();
    });
    if(body)upstream.end(body);
    else req.pipe(upstream);
  }
  lanApp.use('/api',requireGuest,proxy);
  const dist=path.join(root,'..','dist');
  lanApp.use(express.static(dist,{index:false,setHeaders:(res,file)=>{
    if(file.endsWith('.html'))res.setHeader('Cache-Control','no-store');
  }}));
  lanApp.get('/{*path}',(_req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.sendFile(path.join(dist,'index.html'));
  });
  return {info:()=>({active:!!active,projectId:active?.projectId,port:sharedPort()}),
    stop};
}
