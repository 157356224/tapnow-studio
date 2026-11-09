import {spawnSync} from 'node:child_process';

export const TAPNOW_PORTS=[3701,3702,5173];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Match only TCP LISTEN sockets, not outgoing connections whose *remote*
// port happens to equal a TapNow service port.
export function listeningPids(output,ports=TAPNOW_PORTS){
  const wanted=new Set(ports.map(Number));
  const owners=new Map();
  for(const line of output.split(/\r?\n/)){
    const fields=line.trim().split(/\s+/);
    if(fields.length!==5||fields[0].toUpperCase()!=='TCP')continue;
    if(!/^(LISTENING|LISTEN|侦听|监听)$/i.test(fields[3]))continue;
    const local=fields[1].match(/:(\d+)$/);
    const port=Number(local?.[1]);
    const pid=Number(fields[4]);
    if(!wanted.has(port)||!Number.isSafeInteger(pid)||pid<=4)continue;
    if(!owners.has(pid))owners.set(pid,new Set());
    owners.get(pid).add(port);
  }
  return owners;
}

export function getPortOwners({ports=TAPNOW_PORTS,run=spawnSync}={}){
  if(process.platform!=='win32')
    throw new Error('自动端口清理目前只支持 Windows start.bat');
  const result=run('netstat',['-ano','-p','tcp'],{
    encoding:'utf8',windowsHide:true,timeout:10000
  });
  if(result.error||result.status!==0)
    throw new Error('netstat 端口检测失败：'+
      (result.error?.message||result.stderr||'exit '+result.status));
  return listeningPids(result.stdout||'',ports);
}

export async function releasePorts({
  ports=TAPNOW_PORTS,run=spawnSync,log=console.log,
  check=()=>getPortOwners({ports,run}),wait=delay,maxChecks=30
}={}){
  const killed=[];
  const terminated=new Set();
  for(let i=0;i<maxChecks;i++){
    const owners=check();
    if(owners.size===0){
      if(killed.length===0)log('[TapNow] '+ports.join('/')+' 端口无需清理');
      return killed;
    }
    for(const [pid,usedPorts] of owners){
      if(pid===process.pid||pid<=4)
        throw new Error('端口由受保护进程占用，PID '+pid);
      if(terminated.has(pid))continue;
      log('[TapNow] 正在结束占用端口 '+[...usedPorts].join(',')+
        ' 的旧进程 PID '+pid);
      const result=run('taskkill',['/PID',String(pid),'/T','/F'],{
        encoding:'utf8',windowsHide:true,timeout:12000
      });
      if(result.error||result.status!==0){
        // The process might already have exited during the scan.
        if(check().has(pid))
          throw new Error('结束端口进程 PID '+pid+' 失败：'+
            (result.error?.message||result.stderr||result.stdout||result.status));
      }
      killed.push(pid);
      terminated.add(pid);
    }
    await wait(200);
  }
  throw new Error('旧服务未释放端口：'+[...check().values()]
    .flatMap(ports=>[...ports]).join(','));
}
