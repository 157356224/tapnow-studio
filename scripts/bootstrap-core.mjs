import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

function git(root,args,{timeout=90000}={}){
  const result=spawnSync('git',args,{
    cwd:root,encoding:'utf8',timeout,windowsHide:true,
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'}
  });
  return {
    ok:result.status===0,
    status:result.status,
    output:(result.stdout||'').trim(),
    error:(result.stderr||result.error?.message||'').trim()
  };
}

// Git downloads only new objects. Fast-forward merge updates only files whose
// contents changed, leaving untouched files (and all ignored local data) alone.
export function syncGit({root,runGit=git,log=console.log}){
  if(process.env.TAPNOW_SKIP_UPDATE==='1'){
    log('[TapNow Update] 已按 TAPNOW_SKIP_UPDATE=1 跳过联网检查');
    return {updated:false,skipped:'disabled'};
  }
  if(!runGit(root,['rev-parse','--is-inside-work-tree']).ok)
    return {updated:false,skipped:'not-a-git-repo'};
  const branch=runGit(root,['symbolic-ref','--quiet','--short','HEAD']);
  const remote=runGit(root,['remote','get-url','origin']);
  if(!branch.ok||!remote.ok)return {updated:false,skipped:'no-upstream'};
  const dirty=runGit(root,['status','--porcelain','--untracked-files=no']);
  if(!dirty.ok)return {updated:false,skipped:'status-error'};
  if(dirty.output){
    log('[TapNow Update] 本地存在已跟踪文件的修改，跳过自动更新以保护本地改动');
    return {updated:false,skipped:'local-changes'};
  }
  log('[TapNow Update] 正在检查 origin/'+branch.output+' ...');
  const fetched=runGit(root,['fetch','--quiet','--no-tags','origin',branch.output],{timeout:120000});
  if(!fetched.ok){
    log('[TapNow Update] GitHub 暂时不可达或尚未授权，继续使用本地版本：'+
      (fetched.error||'fetch failed').slice(0,180));
    return {updated:false,skipped:'fetch-failed'};
  }
  const old=runGit(root,['rev-parse','HEAD']);
  const latest=runGit(root,['rev-parse','FETCH_HEAD']);
  if(!old.ok||!latest.ok)return {updated:false,skipped:'revision-error'};
  if(old.output===latest.output){
    log('[TapNow Update] 已是最新版本，没有改动任何源码文件');
    return {updated:false,skipped:'current'};
  }
  if(!runGit(root,['merge-base','--is-ancestor',old.output,latest.output]).ok){
    log('[TapNow Update] 本地与远程历史存在分叉，未覆盖本地提交');
    return {updated:false,skipped:'diverged'};
  }
  const names=runGit(root,['diff','--name-only',old.output,latest.output]);
  const files=names.ok?names.output.split(/\r?\n/).filter(Boolean):[];
  const merged=runGit(root,['merge','--ff-only',latest.output]);
  if(!merged.ok){
    log('[TapNow Update] 合并未成功，保持现有文件：'+
      (merged.error||'merge failed').slice(0,180));
    return {updated:false,skipped:'merge-failed'};
  }
  log('[TapNow Update] 已更新 '+files.length+' 个发生变化的文件'+
    (files.length?'：'+files.slice(0,12).join('、'):''));
  return {updated:true,oldHead:old.output,newHead:latest.output,files};
}

export function dependencyFingerprint(root){
  const lock=path.join(root,'package-lock.json');
  if(!fs.existsSync(lock))
    throw new Error('找不到 package-lock.json，拒绝安装未经锁定的依赖');
  const sum=crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex');
  return [sum,process.platform,process.arch,process.versions.node.split('.')[0]].join(':');
}

function installNpm(root){
  const windows=process.platform==='win32';
  const executable=windows?(process.env.ComSpec||'cmd.exe'):'npm';
  const args=windows?['/d','/s','/c','npm ci --no-audit --no-fund']:
    ['ci','--no-audit','--no-fund'];
  const result=spawnSync(executable,args,{
    cwd:root,stdio:'inherit',windowsHide:false,timeout:600000
  });
  if(result.status!==0)throw new Error('npm ci 失败（code '+result.status+
    '）：'+(result.error?.message||'请检查 npm 网络连接'));
}

export function ensureDependencies({
  root,install=installNpm,log=console.log
}){
  const modules=path.join(root,'node_modules');
  const backup=path.join(root,'node_modules.tapnow-backup');
  const vite=path.join(modules,'vite','bin','vite.js');
  const marker=path.join(modules,'.tapnow-install.sha256');
  const fingerprint=dependencyFingerprint(root);
  if(fs.existsSync(vite)&&fs.existsSync(marker)&&
    fs.readFileSync(marker,'utf8').trim()===fingerprint){
    log('[TapNow Update] 依赖未变化，无需重新下载');
    return {installed:false};
  }
  if(fs.existsSync(backup))
    throw new Error('检测到未清理的依赖备份：'+backup+
      '；为避免覆盖已有数据，已停止安装');
  log('[TapNow Update] 首次安装或依赖清单变化，按 package-lock.json 安装 npm 库');
  let saved=false;
  if(fs.existsSync(modules)){
    fs.renameSync(modules,backup);
    saved=true;
  }
  try{
    install(root);
    if(!fs.existsSync(vite))throw new Error('安装结束后仍未找到 vite');
    fs.writeFileSync(marker,fingerprint+'\n','utf8');
    if(saved)fs.rmSync(backup,{recursive:true,force:true,maxRetries:3,retryDelay:200});
    log('[TapNow Update] 依赖安装完成');
    return {installed:true};
  }catch(error){
    // Atomic rename preserves prior modules when a new install fails.
    if(fs.existsSync(modules))fs.rmSync(modules,{
      recursive:true,force:true,maxRetries:3,retryDelay:200
    });
    if(saved&&fs.existsSync(backup))fs.renameSync(backup,modules);
    throw error;
  }
}

export function bootstrap({root,runGit=git,install=installNpm,log=console.log}){
  const updated=syncGit({root,runGit,log});
  try{
    const dependencies=ensureDependencies({root,install,log});
    return {updated,dependencies};
  }catch(err){
    if(updated.updated&&updated.oldHead){
      const rollback=runGit(root,['reset','--hard',updated.oldHead]);
      log('[TapNow Update] 依赖失败，源码回滚'+
        (rollback.ok?'完成':'失败，请手动检查：'+rollback.error));
    }
    throw err;
  }
}
