import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import express from 'express';

const MAX_MEDIA=250*1024*1024;
const FILE=/^\/api\/uploads\/([a-z0-9._-]+)$/i;
const ALLOWED_LOCAL_ORIGINS=new Set([
  'http://127.0.0.1:5173','http://localhost:5173',
  'http://127.0.0.1:3701'
]);
const isPrivateHost=host=>{
  if(['127.0.0.1','localhost'].includes(host))return true;
  if(!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host))return false;
  const n=host.split('.').map(Number);
  return n.every(x=>x>=0&&x<=255)&&
    (n[0]===10||(n[0]===172&&n[1]>=16&&n[1]<=31)||
      (n[0]===192&&n[1]===168));
};
export function validateRemoteHost(address){
  const url=new URL(/^https?:\/\//i.test(address)?address:'http://'+address);
  if(url.protocol!=='http:'||url.username||url.password||
     !isPrivateHost(url.hostname)||url.search||url.hash||url.pathname!=='/')
    throw new Error('只能连接局域网共享地址，例如 192.168.1.6:3702');
  url.port=url.port||'3702';
  return url.origin;
}

export function mountGuestLocalBridge(app,{
  read,write,uploadDir,
  // Tests use randomly assigned localhost ports; production stays on 3701/5173.
  extraLoopbackOrigins=[]
}){
  const sessions=new Map();
  const router=express.Router();
  const allowedOrigins=new Set([...ALLOWED_LOCAL_ORIGINS,...extraLoopbackOrigins]);
  const allowedHosts=new Set([...ALLOWED_LOCAL_ORIGINS,...extraLoopbackOrigins]
    .map(origin=>new URL(origin).host));
  const fail=(res,status,message)=>res.status(status).json({error:message});
  // No LAN page can directly instruct another user's local browser engine.
  router.use((req,res,next)=>{
    const host=req.headers.host||'';
    if(!allowedHosts.has(host)||
       req.headers['sec-fetch-site']==='cross-site'||
       (req.headers.origin&&!allowedOrigins.has(req.headers.origin)))
      return fail(res,403,'只允许用户本人本地 TapNow 页面访问生成桥接');
    next();
  });
  const request=async(session,route,init={})=>{
    const response=await fetch(session.origin+route,{
      ...init,headers:{...(init.headers||{}),cookie:session.cookie},
      signal:AbortSignal.timeout(30000)
    });
    return response;
  };
  const json=async(response,res)=>{
    const body=await response.text();
    res.status(response.status).type('json').send(body);
  };
  router.post('/connect',express.json({limit:'4kb'}),async(req,res)=>{
    try{
      const origin=validateRemoteHost(String(req.body?.address||''));
      const code=String(req.body?.code||'');
      if(!/^\d{5}$/.test(code))return fail(res,400,'需要5位加入码');
      const joined=await fetch(origin+'/api/share/join',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({code}),
        signal:AbortSignal.timeout(12000)
      });
      const detail=await joined.json();
      if(!joined.ok)return fail(res,joined.status,detail.error||'加入失败');
      const cookie=joined.headers.get('set-cookie')?.split(';')[0];
      if(detail.role!=='guest'||!cookie?.startsWith('tapnow_share='))
        throw new Error('共享主机未发放协作会话');
      const id=crypto.randomBytes(24).toString('hex');
      sessions.set(id,{origin,cookie,projectId:detail.projectId,
        label:detail.label,mirrors:new Set(),mirrorFiles:new Map()});
      res.json({sessionId:id,role:'guest',projectId:detail.projectId});
    }catch(error){fail(res,400,error.message);}
  });
  router.use('/:sessionId',(req,res,next)=>{
    const session=sessions.get(req.params.sessionId);
    if(!session)return fail(res,401,'本机协作会话已失效，请重新输入加入码');
    req.guestLocalSession=session;
    next();
  });
  const remote=(req,res,route,init)=>request(req.guestLocalSession,route,init)
    .then(response=>json(response,res))
    .catch(error=>fail(res,502,'共享主机连接失败：'+error.message));
  router.get('/:sessionId/share/info',(req,res)=>
    remote(req,res,'/api/share/info'));
  router.post('/:sessionId/share/:action',express.json({limit:'2mb'}),(req,res)=>{
    const action=req.params.action;
    if(!['patch','lock','leave'].includes(action))
      return fail(res,404,'未知共享操作');
    const session=req.guestLocalSession;
    request(session,'/api/share/'+action,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify(req.body||{})
    }).then(async response=>{
      await json(response,res);
      if(action==='leave'&&response.ok)sessions.delete(req.params.sessionId);
    }).catch(error=>fail(res,502,error.message));
  });
  router.get('/:sessionId/share/events',(req,res)=>{
    const session=req.guestLocalSession;
    const upstream=http.request(session.origin+
      '/api/share/events?clientId='+encodeURIComponent(req.query.clientId||''),{
      headers:{cookie:session.cookie,accept:'text/event-stream'}
    },response=>{
      res.writeHead(response.statusCode||502,{
        'Content-Type':response.headers['content-type']||'text/event-stream',
        'Cache-Control':'no-cache','Connection':'keep-alive'
      });
      response.pipe(res);
    });
    upstream.on('error',error=>{
      if(!res.headersSent)fail(res,502,error.message);
      else res.end();
    });
    res.on('close',()=>upstream.destroy());
    upstream.end();
  });
  router.get('/:sessionId/projects',(req,res)=>
    remote(req,res,'/api/projects'));
  router.get('/:sessionId/projects/:id',(req,res)=>{
    if(req.params.id!==req.guestLocalSession.projectId)
      return fail(res,403,'只能读取当前共享画布');
    remote(req,res,'/api/projects/'+encodeURIComponent(req.params.id));
  });
  router.get('/:sessionId/uploads/:file',async(req,res)=>{
    const filename=req.params.file;
    if(!/^[a-z0-9._-]+$/i.test(filename))return fail(res,400,'文件名无效');
    try{
      const response=await request(req.guestLocalSession,'/api/uploads/'+filename,{
        headers:req.headers.range?{range:req.headers.range}:{}
      });
      if(!response.ok)return fail(res,response.status,'共享素材不存在');
      res.status(response.status).type(response.headers.get('content-type')||
        'application/octet-stream');
      for(const header of ['content-range','accept-ranges','content-length']){
        const value=response.headers.get(header);
        if(value)res.setHeader(header,value);
      }
      if(response.body)await pipeline(Readable.fromWeb(response.body),res);
      else res.end();
    }catch(error){if(!res.headersSent)fail(res,502,error.message);else res.end();}
  });
  router.post('/:sessionId/videos/:action',express.json({limit:'1mb'}),(req,res)=>{
    if(!['extract-frame','extract-last-frame'].includes(req.params.action))
      return fail(res,404,'无效操作');
    remote(req,res,'/api/videos/'+req.params.action,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify(req.body||{})
    });
  });
  async function uploadToHost(session,url){
    const match=FILE.exec(url||'');
    if(!match)throw new Error('仅可发布本机生成的素材文件');
    const filepath=path.join(uploadDir,match[1]);
    if(!fs.existsSync(filepath))throw new Error('本地生成文件不存在');
    const file=fs.statSync(filepath);
    if(!file.isFile()||file.size>MAX_MEDIA)throw new Error('媒体文件过大');
    const extension=path.extname(filepath).slice(1).toLowerCase();
    const types={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',
      webp:'image/webp',mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime',
      mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg'};
    const form=new FormData();
    form.set('file',new Blob([fs.readFileSync(filepath)],{
      type:types[extension]||'application/octet-stream'}),path.basename(filepath));
    const response=await request(session,'/api/assets',{method:'POST',body:form});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'上传到共享主机失败');
    if(!FILE.test(result.url))throw new Error('共享主机返回了不安全的素材地址');
    return result;
  }
  router.post('/:sessionId/publish',express.json({limit:'2kb'}),async(req,res)=>{
    try{res.json(await uploadToHost(req.guestLocalSession,req.body?.mediaUrl));}
    catch(error){fail(res,502,error.message);}
  });
  router.post('/:sessionId/prepare',express.json({limit:'15mb'}),async(req,res)=>{
    const session=req.guestLocalSession;
    const snapshot=req.body;
    if(!Array.isArray(snapshot?.nodes)||
       !snapshot.nodes.some(node=>node.id===snapshot?.nodeId)||
       snapshot.nodes.length>500)
      return fail(res,400,'无效的共享画布任务快照');
    const projectId=crypto.randomUUID();
    const imported=new Map(),created=[];
    try{
      const nodes=structuredClone(snapshot.nodes);
      const requested=Array.isArray(snapshot.mediaNodeIds)
        ?new Set(snapshot.mediaNodeIds.filter(id=>typeof id==='string'))
        :new Set(nodes.map(node=>node.id));
      for(const node of nodes){
        if(!requested.has(node.id))continue;
        const media=node.data?.mediaUrl;
        const match=FILE.exec(media||'');
        if(!match)continue;
        if(!imported.has(media)){
          const response=await request(session,media);
          if(!response.ok||!response.body)
            throw new Error('下载共享参考素材失败：'+media);
          const ext=path.extname(match[1]).toLowerCase().slice(0,8);
          const name=crypto.randomUUID()+ext;
          const filepath=path.join(uploadDir,name);
          const declared=Number(response.headers.get('content-length'));
          if(declared>MAX_MEDIA)throw new Error('参考素材超出大小限制');
          let size=0;
          const output=fs.createWriteStream(filepath);
          created.push(filepath);
          const stream=Readable.fromWeb(response.body);
          stream.on('data',chunk=>{
            size+=chunk.length;
            if(size>MAX_MEDIA)stream.destroy(new Error('参考素材过大'));
          });
          await pipeline(stream,output);
          imported.set(media,'/api/uploads/'+name);
        }
        node.data.mediaUrl=imported.get(media);
      }
      const items=read();
      items.push({id:projectId,hiddenGuestJob:true,
        title:String(snapshot.title||'共享画布本机任务').slice(0,100),
        nodes,edges:Array.isArray(snapshot.edges)?snapshot.edges:[],
        groups:[],viewport:{x:0,y:0,zoom:1},
        createdAt:new Date().toISOString(),
        updatedAt:new Date().toISOString()});
      write(items);
      session.mirrors.add(projectId);
      session.mirrorFiles.set(projectId,created);
      res.json({projectId});
    }catch(error){
      for(const filepath of created)fs.rmSync(filepath,{force:true});
      fail(res,502,error.message);
    }
  });
  router.delete('/:sessionId/prepare/:projectId',(req,res)=>{
    const session=req.guestLocalSession,id=req.params.projectId;
    if(!session.mirrors.has(id))return fail(res,404,'本机临时项目不存在');
    write(read().filter(project=>project.id!==id));
    for(const filename of session.mirrorFiles.get(id)||[])
      fs.rmSync(filename,{force:true});
    session.mirrorFiles.delete(id);
    session.mirrors.delete(id);
    res.json({ok:true});
  });
  app.use('/api/remote',router);
  return {sessions};
}
