import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {releasePorts} from './ports-core.mjs';

const projectDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base='http://127.0.0.1';
const apiPort=3701;
const webPort=5173;
const apiUrl=base+':'+apiPort;
const webUrl=base+':'+webPort+'/';
const children=new Map();
let shuttingDown=false;

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
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
}
process.on('SIGINT',()=>void shutdown());
process.on('SIGTERM',()=>void shutdown());

async function main(){
  // A service can appear after the pre-update cleanup. Never reuse an
  // outdated API or Vite instance after GitHub updated the source.
  await releasePorts();
  console.log('[TapNow] 启动 API：'+apiUrl);
  const api=startChild('API',['server/index.mjs']);
  await waitReady(apiHealth,'API',api);
  console.log('[TapNow] API 已就绪');
  console.log('[TapNow] 启动画布：'+webUrl);
  const web=startChild('WEB',[
    'node_modules/vite/bin/vite.js','--host','127.0.0.1',
    '--port',String(webPort),'--strictPort'
  ]);
  await waitReady(validWeb,'WEB',web);
  console.log('[TapNow] 画布已就绪：'+webUrl);
  console.log('[TapNow] 两项服务均使用最新源码启动。关闭本窗口可停止本次进程。');
}

main().catch(async error=>{
  console.error('\n[TapNow] 启动失败：'+error.message);
  await shutdown();
  process.exitCode=1;
});
