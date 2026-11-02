import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base='http://127.0.0.1';
const apiPort=3701;
const webPort=5173;
const apiUrl=base+':'+apiPort;
const webUrl=base+':'+webPort+'/';
const instanceId=crypto.createHash('sha256').update(
  process.platform==='win32'?projectDir.toLowerCase():projectDir
).digest('hex').slice(0,16);
const children=new Map();
let shuttingDown=false;

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function portListening(port){
  return await new Promise(resolve=>{
    const socket=net.connect({host:'127.0.0.1',port});
    let settled=false;
    const finish=answer=>{
      if(settled)return;
      settled=true;
      socket.destroy();
      resolve(answer);
    };
    socket.once('connect',()=>finish(true));
    socket.once('error',()=>finish(false));
    socket.setTimeout(800,()=>finish(false));
  });
}
async function apiHealth(){
  try{
    const reply=await fetch(apiUrl+'/api/health',{
      signal:AbortSignal.timeout(2500),
      headers:{Accept:'application/json'}
    });
    if(!reply.ok)return null;
    const data=await reply.json();
    return data?.ok===true&&
      data?.browserBridges?.includes('doubao-seedance-v2')?data:null;
  }catch{return null;}
}
async function validWeb(){
  try{
    const reply=await fetch(webUrl,{
      signal:AbortSignal.timeout(2500),
      headers:{Accept:'text/html'}
    });
    return reply.ok&&(await reply.text()).includes('<title>TapNow Studio');
  }catch{return false;}
}
async function waitReady(check,label,child){
  for(let i=0;i<75;i++){
    if(await check())return;
    if(child.exitCode!==null||child.signalCode!==null)
      throw new Error(label+' 进程提前退出（代码 '+child.exitCode+'）');
    await sleep(130);
  }
  throw new Error(label+' 启动超时，请检查上述报错与端口');
}
function startChild(label,args){
  const child=spawn(process.execPath,args,{
    cwd:projectDir,env:process.env,stdio:'inherit',windowsHide:false
  });
  children.set(label,child);
  child.once('exit',(code,signal)=>{
    children.delete(label);
    if(!shuttingDown){
      process.exitCode=1;
      console.error('[TapNow] '+label+' 意外结束（code '+code+', signal '+signal+
        '）。其他已运行服务不受影响。');
    }
  });
  child.once('error',err=>console.error('[TapNow] '+label+' 无法启动：'+err.message));
  return child;
}
async function shutdown(){
  if(shuttingDown)return;
  shuttingDown=true;
  console.log('\n[TapNow] 正在结束由本次启动器创建的进程…');
  for(const child of children.values()){
    try{child.kill('SIGTERM');}catch{}
  }
  // Never terminate pre-existing servers that were only reused.
}
process.on('SIGINT',()=>void shutdown());
process.on('SIGTERM',()=>void shutdown());

async function main(){
  const apiOccupied=await portListening(apiPort);
  if(apiOccupied){
    const health=await apiHealth();
    if(!health)throw new Error(
      '端口 3701 已被其他程序占用，且不是 TapNow API。请关闭该程序后重试。'
    );
    if(health.workspaceId&&health.workspaceId!==instanceId)
      throw new Error('端口 3701 上运行的是另一个 TapNow 项目。'+
        '请先关闭旧项目的启动窗口，再运行当前目录的 start.bat。');
    if(health.multiImageUploadRevision!=='v3-prompt-first')
      throw new Error('端口 3701 仍在运行旧版豆包多图上传服务。'+
        '请先关闭旧的 TapNow API 进程（node server/index.mjs），'+
        '然后重新运行 start.bat；不能直接复用旧进程。');
    if(health.videoModelRevision!=='mini-fast-v1')
      throw new Error('端口 3701 正在运行旧版视频模型服务，无法保证选用 Seedance 2.0 Mini。'+
        '请先关闭旧的 TapNow API 进程，再运行当前项目的 start.bat。');
    if(health.videoStartRevision!=='reply-prefix-v1')
      throw new Error('端口 3701 的旧版豆包 API 无法识别 Seedance 真正开工的回复。'+
        '请先关闭旧版 TapNow API，再重新运行 start.bat。');
    if(health.museBridgeRevision!=='quota-auto-v6-image-resolution')
      throw new Error('端口 3701 的 TapNow API 尚未接入 Muse 独立浏览器。'+
        '请先关闭旧服务，再运行当前项目的 start.bat。');
    if(health.referenceSelectionRevision!=='at-order-v2')
      throw new Error('端口 3701 仍在运行旧版图片引用逻辑，可能上传未 @ 的图片。'+
        '请先关闭旧服务再运行当前项目的 start.bat。');
    if(!health.workspaceId)
      console.warn('[TapNow] 已检测到旧版 API，无法识别其项目目录；'+
        '本次将复用。若数据不一致，请关闭旧版 API 后重新启动。');
    console.log('[TapNow] API 已在运行，复用端口 3701（不再重复启动）。');
  }else{
    console.log('[TapNow] 启动 API：'+apiUrl);
    const child=startChild('API',['server/index.mjs']);
    await waitReady(apiHealth,'API',child);
    console.log('[TapNow] API 已就绪');
  }
  const webOccupied=await portListening(webPort);
  if(webOccupied){
    if(!await validWeb())throw new Error(
      '端口 5173 已被其他网页程序占用。请先关闭该程序后重试。'
    );
    console.log('[TapNow] 画布已在运行，复用端口 5173。');
  }else{
    console.log('[TapNow] 启动画布：'+webUrl);
    const child=startChild('WEB',[
      'node_modules/vite/bin/vite.js','--host','127.0.0.1',
      '--port',String(webPort),'--strictPort'
    ]);
    await waitReady(validWeb,'WEB',child);
    console.log('[TapNow] 画布已就绪：'+webUrl);
  }
  if(children.size===0)
    console.log('[TapNow] 两项服务已运行，无需创建重复进程。');
  else
    console.log('[TapNow] 服务运行中。关闭此窗口仅停止本次启动的进程。');
}

main().catch(async error=>{
  console.error('\n[TapNow] 启动失败：'+error.message);
  await shutdown();
  process.exitCode=1;
});
