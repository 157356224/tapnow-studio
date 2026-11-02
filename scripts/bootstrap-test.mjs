import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {bootstrap,ensureDependencies,syncGit} from './bootstrap-core.mjs';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'tapnow-github-update-'));
const bare=path.join(temp,'remote.git');
const publisher=path.join(temp,'publisher');
const local=path.join(temp,'local');
const call=(cwd,args)=>{
  const res=spawnSync('git',args,{cwd,encoding:'utf8',timeout:20000});
  assert.equal(res.status,0,args.join(' ')+'\n'+res.stderr);
  return res.stdout.trim();
};
const quiet=()=>{};
const write=(root,name,content)=>{
  const file=path.join(root,name);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,content);
};
try{
  call(temp,['init','--bare',bare]);
  fs.mkdirSync(publisher,{recursive:true});
  call(publisher,['init','--initial-branch=main']);
  call(publisher,['config','user.name','Updater Test']);
  call(publisher,['config','user.email','updater-test@example.invalid']);
  write(publisher,'.gitignore','server/data/\nnode_modules/\n');
  write(publisher,'unchanged.txt','do-not-touch');
  write(publisher,'changed.txt','version-one');
  write(publisher,'package-lock.json','{"lockfileVersion":3,"packages":{}}');
  call(publisher,['add','.']);
  call(publisher,['commit','-m','Version one']);
  call(publisher,['remote','add','origin',bare]);
  call(publisher,['push','-u','origin','main']);
  call(temp,['clone','--branch','main',bare,local]);
  const untouched=fs.statSync(path.join(local,'unchanged.txt')).mtimeMs;
  write(local,'server/data/private.json','PRIVATE_LOCAL_DATA_STAYS');
  const first=syncGit({root:local,log:quiet});
  assert.equal(first.updated,false);
  assert.equal(first.skipped,'current');

  write(publisher,'changed.txt','version-two');
  call(publisher,['add','.']);
  call(publisher,['commit','-m','Change one file']);
  call(publisher,['push','origin','main']);
  const result=syncGit({root:local,log:quiet});
  assert.equal(result.updated,true);
  assert.deepEqual(result.files,['changed.txt']);
  assert.equal(fs.readFileSync(path.join(local,'changed.txt'),'utf8'),'version-two');
  assert.equal(fs.statSync(path.join(local,'unchanged.txt')).mtimeMs,untouched,
    'Unchanged tracked files must retain their modification timestamp');
  assert.equal(fs.readFileSync(path.join(local,'server/data/private.json'),'utf8'),
    'PRIVATE_LOCAL_DATA_STAYS');

  write(local,'changed.txt','my-uncommitted-local-work');
  write(publisher,'changed.txt','version-three');
  call(publisher,['add','.']);
  call(publisher,['commit','-m','Version three']);
  call(publisher,['push','origin','main']);
  const dirty=syncGit({root:local,log:quiet});
  assert.equal(dirty.skipped,'local-changes');
  assert.equal(fs.readFileSync(path.join(local,'changed.txt'),'utf8'),
    'my-uncommitted-local-work','Dirty files must never be overwritten');

  const moduleRoot=path.join(temp,'dependencies');
  fs.mkdirSync(moduleRoot);
  write(moduleRoot,'package-lock.json','{"name":"test","lockfileVersion":3}');
  let installs=0;
  const install=root=>{
    installs++;
    write(root,'node_modules/vite/bin/vite.js','installed dependency v'+installs);
  };
  assert.equal(ensureDependencies({root:moduleRoot,install,log:quiet}).installed,true);
  assert.equal(ensureDependencies({root:moduleRoot,install,log:quiet}).installed,false);
  assert.equal(installs,1,'Unchanged dependencies should not reinstall');
  write(moduleRoot,'package-lock.json','{"name":"test","lockfileVersion":3,"version":2}');
  assert.equal(ensureDependencies({root:moduleRoot,install,log:quiet}).installed,true);
  assert.equal(installs,2);
  assert.ok(!fs.existsSync(path.join(moduleRoot,'node_modules.tapnow-backup')));
  write(moduleRoot,'package-lock.json','{"name":"test","lockfileVersion":3,"version":3}');
  assert.throws(()=>ensureDependencies({
    root:moduleRoot,install:()=>{throw Error('simulated npm offline')},log:quiet
  }),/simulated npm offline/);
  assert.equal(fs.readFileSync(path.join(moduleRoot,
    'node_modules/vite/bin/vite.js'),'utf8'),'installed dependency v2',
  'Installation failure must restore existing downloaded libraries');

  // When new source has an un-installable dependency, restore the original
  // commit without erasing ignored account data.
  call(local,['checkout','--','changed.txt']);
  const oldHead=call(local,['rev-parse','HEAD']);
  write(publisher,'changed.txt','new source needing new dependencies');
  write(publisher,'package-lock.json','{"lockfileVersion":3,"packages":{"new":{}}}');
  call(publisher,['add','.']);
  call(publisher,['commit','-m','Change dependencies']);
  call(publisher,['push','origin','main']);
  assert.throws(()=>bootstrap({
    root:local,log:quiet,install:()=>{throw Error('offline dependencies')}
  }),/offline dependencies/);
  assert.equal(call(local,['rev-parse','HEAD']),oldHead,
    'Failed dependency update must roll back the source commit');
  assert.equal(fs.readFileSync(path.join(local,'server/data/private.json'),'utf8'),
    'PRIVATE_LOCAL_DATA_STAYS');
  console.log('PASS: Git fetch updates only changed tracked files; user data and dirty files survive; npm lock changes install once; failures roll back');
}finally{
  fs.rmSync(temp,{recursive:true,force:true,maxRetries:4,retryDelay:100});
}
