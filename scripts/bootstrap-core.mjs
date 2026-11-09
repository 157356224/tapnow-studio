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

function preserveUntrackedCollisions({root,latest,runGit,log}){
  const remoteFiles=runGit(root,['ls-tree','-r','--name-only','-z',latest]);
  const untracked=runGit(root,['ls-files','--others','--exclude-standard','-z']);
  if(!remoteFiles.ok||!untracked.ok)
    throw new Error('检查未跟踪文件更新冲突失败');
  const targetFiles=new Set(remoteFiles.output.split('\0').filter(Boolean));
  const privateFiles=untracked.output.split('\0').filter(Boolean);
  const conflictPaths=[];
  for(const file of privateFiles){
    const conflict=[...targetFiles].find(target=>
      target===file||target.startsWith(file+'/')||file.startsWith(target+'/'));
    if(!conflict)continue;
    const source=targetFiles.has(conflict)&&file.startsWith(conflict+'/')
      ?conflict:file;
    if(!conflictPaths.some(existing=>
      source===existing||source.startsWith(existing+'/')))
      conflictPaths.push(source);
  }
  if(!conflictPaths.length)return null;
  const stamp=new Date().toISOString().replace(/[^\d]/g,'')+'-'+
    crypto.randomBytes(4).toString('hex');
  const backup=path.join(root,'server','data','tapnow-update-backups',stamp);
  for(const relative of conflictPaths){
    const source=path.resolve(root,relative);
    if(!source.startsWith(path.resolve(root)+path.sep)||
       relative.startsWith('server/data/'))
      throw new Error('更新冲突涉及受保护的本地路径：'+relative);
    if(!fs.existsSync(source))continue;
    const target=path.resolve(backup,relative);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.renameSync(source,target);
    log('[TapNow Update] 已保留与新版文件同名的本地文件：'+relative);
  }
  log('[TapNow Update] 本地同名文件备份目录：'+backup);
  return backup;
}

// Pull the actual remote branch even when local tracked files have edits.
// User edits live in Git stash, and non-fast-forward commits get a backup
// branch before resetting the *tracked source* to the GitHub revision.
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
  log('[TapNow Update] 正在检查 origin/'+branch.output+' ...');
  const ref='refs/remotes/origin/'+branch.output;
  // Explicit refspec updates the remote-tracking branch instead of relying
  // on an old FETCH_HEAD or stale origin/main from a previous launch.
  const fetchArgs=['fetch','--no-tags','--prune','origin',
    '+refs/heads/'+branch.output+':'+ref];
  let fetched=runGit(root,fetchArgs,{timeout:120000});
  if(!fetched.ok){
    log('[TapNow Update] 首次 GitHub 请求失败，重试一次：'+
      (fetched.error||'fetch failed').slice(0,180));
    fetched=runGit(root,fetchArgs,{timeout:120000});
  }
  if(!fetched.ok){
    log('[TapNow Update] GitHub 检查失败，并非已经是最新版；继续使用本地版本：'+
      (fetched.error||'fetch failed').slice(0,180));
    return {updated:false,skipped:'fetch-failed'};
  }
  const old=runGit(root,['rev-parse','HEAD']);
  const latest=runGit(root,['rev-parse',ref]);
  if(!old.ok||!latest.ok)return {updated:false,skipped:'revision-error'};
  const dirty=runGit(root,['status','--porcelain','--untracked-files=no']);
  if(!dirty.ok)throw new Error('读取本地工作区状态失败：'+dirty.error);
  log('[TapNow Update] 本地 '+old.output.slice(0,12)+
    ' / GitHub '+latest.output.slice(0,12));
  if(old.output===latest.output&&!dirty.output){
    log('[TapNow Update] GitHub 已确认相同提交，无须更新源码');
    return {updated:false,skipped:'current'};
  }
  let backupStash=null;
  if(dirty.output){
    const stamp=new Date().toISOString().replace(/[^\d]/g,'');
    const saved=runGit(root,['stash','push','-m',
      'TapNow auto-update '+stamp+' before '+old.output.slice(0,12)]);
    if(!saved.ok)throw new Error('自动备份本地已跟踪文件失败：'+saved.error);
    const check=runGit(root,['status','--porcelain','--untracked-files=no']);
    if(!check.ok||check.output)
      throw new Error('本地改动未成功备份；GitHub 更新已停止');
    const stash=runGit(root,['rev-parse','refs/stash']);
    backupStash=stash.ok?stash.output:null;
    log('[TapNow Update] 本地改动已保存到 Git stash'+
      (backupStash?' '+backupStash.slice(0,12):'')+'（可用 git stash list 查看）');
  }
  const names=runGit(root,['diff','--name-only',old.output,latest.output]);
  const files=names.ok?names.output.split(/\r?\n/).filter(Boolean):[];
  const backupUntracked=old.output!==latest.output
    ?preserveUntrackedCollisions({root,latest:latest.output,runGit,log}):null;
  let backupBranch=null;
  if(old.output!==latest.output){
    const ff=runGit(root,['merge-base','--is-ancestor',old.output,latest.output]);
    if(ff.ok){
      const merged=runGit(root,['merge','--ff-only',latest.output]);
      if(!merged.ok)
        throw new Error('GitHub 快进更新失败：'+merged.error+
          '；本地备份保存在 Git stash 中');
    }else{
      backupBranch='tapnow-backup/'+new Date().toISOString()
        .replace(/[^\d]/g,'')+'-'+crypto.randomBytes(3).toString('hex');
      const saved=runGit(root,['branch',backupBranch,old.output]);
      if(!saved.ok)throw new Error('保存旧提交备份分支失败：'+saved.error);
      const reset=runGit(root,['reset','--hard',latest.output]);
      if(!reset.ok)throw new Error('切换到 GitHub 版本失败：'+reset.error);
      log('[TapNow Update] 已备份本地分叉提交到 '+backupBranch);
    }
  }
  const confirmed=runGit(root,['rev-parse','HEAD']);
  if(!confirmed.ok||confirmed.output!==latest.output)
    throw new Error('更新后版本验证失败，本地 HEAD 未匹配 GitHub');
  log('[TapNow Update] 已同步 GitHub '+latest.output.slice(0,12)+
    '，变更 '+files.length+' 个文件'+
    (files.length?'：'+files.slice(0,12).join('、'):''));
  return {updated:true,oldHead:old.output,newHead:latest.output,files,
    backupStash,backupBranch,backupUntracked};
}

export function dependencyFingerprint(root){
  const lock=path.join(root,'package-lock.json');
  if(!fs.existsSync(lock))
    throw new Error('找不到 package-lock.json，拒绝安装未经锁定的依赖');
  const sum=crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex');
  return [sum,process.platform,process.arch,process.versions.node.split('.')[0]].join(':');
}

function previousDependenciesReady(root){
  const modules=path.join(root,'node_modules');
  const vite=path.join(modules,'vite','bin','vite.js');
  const marker=path.join(modules,'.tapnow-install.sha256');
  return fs.existsSync(vite)&&fs.existsSync(marker)&&
    fs.readFileSync(marker,'utf8').trim()===dependencyFingerprint(root);
}

// If npm or the launcher was interrupted after atomically moving
// node_modules -> node_modules.tapnow-backup, restore the previous installed
// dependencies before another install attempt. Keep any partially installed
// directory under a unique name so no existing files are overwritten.
function recoverInterruptedDependencies({root,modules,backup,log}){
  if(!fs.existsSync(backup))return;
  const viable=dir=>fs.existsSync(path.join(dir,'vite','bin','vite.js'));
  const marked=dir=>viable(dir)&&
    fs.existsSync(path.join(dir,'.tapnow-install.sha256'));
  const hasModules=fs.existsSync(modules);
  if(!viable(backup)&&(!hasModules||!viable(modules)))
    throw new Error('检测到不完整的依赖备份：'+backup+
      '；保留全部目录，需手动检查 node_modules 与备份内容');

  if(!hasModules){
    fs.renameSync(backup,modules);
    log('[TapNow Update] 检测到上次安装中断，已将旧依赖备份恢复为 node_modules');
    return;
  }

  // A completed current install takes priority. The old backup is renamed,
  // never deleted, and will not block a future dependency update.
  const keepCurrent=marked(modules)||!viable(backup);
  const preserved=path.join(root,
    'node_modules.tapnow-preserved-'+Date.now()+'-'+
    crypto.randomBytes(4).toString('hex'));
  if(keepCurrent){
    fs.renameSync(backup,preserved);
    log('[TapNow Update] 已保留上次残留的依赖备份：'+preserved);
    return;
  }

  const partial=path.join(root,
    'node_modules.tapnow-incomplete-'+Date.now()+'-'+
    crypto.randomBytes(4).toString('hex'));
  fs.renameSync(modules,partial);
  try{
    fs.renameSync(backup,modules);
  }catch(error){
    // Restore the pre-recovery state when the second rename fails.
    fs.renameSync(partial,modules);
    throw error;
  }
  log('[TapNow Update] 已恢复上次安装中断前的依赖；保留未完成安装目录：'+partial);
}

// Keep mirror settings local to this npm child process: don't change the
// user's global npm configuration or commit a project .npmrc that could
// collide with an existing untracked file on an older installation.
const DEFAULT_NPM_MIRROR='https://registry.npmmirror.com/';
const DEFAULT_FFMPEG_MIRROR='https://cdn.npmmirror.com/binaries/ffmpeg-static';
export function npmInstallEnvironment(base=process.env){
  const env={...base};
  const setDefault=(name,value)=>{
    const existing=Object.keys(env).find(key=>key.toLowerCase()===name.toLowerCase());
    if(existing){
      if(!env[existing])env[existing]=value;
    }else env[name]=value;
  };
  setDefault('npm_config_registry',DEFAULT_NPM_MIRROR);
  // package-lock.json includes registry.npmjs.org tarball URLs. In npm,
  // "npmjs" replaces that default host with npm_config_registry.
  setDefault('npm_config_replace_registry_host','npmjs');
  setDefault('FFMPEG_BINARIES_URL',DEFAULT_FFMPEG_MIRROR);
  // Show progress from ffmpeg-static's binary download instead of
  // appearing stuck on npm's spinner while its install script runs.
  setDefault('npm_config_foreground_scripts','true');
  return env;
}

function installNpm(root){
  const windows=process.platform==='win32';
  const executable=windows?(process.env.ComSpec||'cmd.exe'):'npm';
  const args=windows?['/d','/s','/c','npm ci --no-audit --no-fund']:
    ['ci','--no-audit','--no-fund'];
  const env=npmInstallEnvironment();
  const configured=name=>Object.entries(env).find(([key])=>
    key.toLowerCase()===name.toLowerCase())?.[1];
  const safeHost=url=>{
    try{return new URL(url).origin;}catch{return '[自定义源]';}
  };
  console.log('[TapNow Update] npm 下载源：'+safeHost(configured('npm_config_registry')));
  console.log('[TapNow Update] FFmpeg 二进制镜像：'+safeHost(configured('FFMPEG_BINARIES_URL')));
  const result=spawnSync(executable,args,{
    cwd:root,stdio:'inherit',windowsHide:false,timeout:600000,env
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
  recoverInterruptedDependencies({root,modules,backup,log});
  if(fs.existsSync(vite)&&fs.existsSync(marker)&&
    fs.readFileSync(marker,'utf8').trim()===fingerprint){
    log('[TapNow Update] 依赖未变化，无需重新下载');
    return {installed:false};
  }
  if(fs.existsSync(backup))
    throw new Error('无法自动恢复残留的依赖备份：'+backup);
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
      // If old dependencies were restored by ensureDependencies and match
      // the old lockfile after Git rollback, the existing local version can
      // still run even when the new update cannot install offline.
      if(rollback.ok&&previousDependenciesReady(root)){
        log('[TapNow Update] 新版本依赖安装失败：'+err.message);
        log('[TapNow Update] 旧依赖完整，继续启动上次可用版本；账号和生成文件保持不变');
        return {updated:{updated:false,skipped:'dependency-rollback'},
          dependencies:{installed:false,usingPrevious:true}};
      }
    }
    throw err;
  }
}
