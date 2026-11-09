import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  bootstrap,dependencyFingerprint,ensureDependencies,npmInstallEnvironment,syncGit
} from './bootstrap-core.mjs';

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
  write(local,'changed.txt','local edit on current commit');
  const sameCommitDirty=syncGit({root:local,log:quiet});
  assert.equal(sameCommitDirty.updated,true);
  assert.equal(sameCommitDirty.oldHead,sameCommitDirty.newHead);
  assert.ok(sameCommitDirty.backupStash);
  assert.equal(fs.readFileSync(path.join(local,'changed.txt'),'utf8'),'version-one');

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
  assert.equal(dirty.updated,true);
  assert.equal(dirty.newHead,call(local,['rev-parse','HEAD']));
  assert.ok(dirty.backupStash,'Dirty tracked files must be backed up');
  assert.equal(fs.readFileSync(path.join(local,'changed.txt'),'utf8'),
    'version-three','Dirty tracked files must not block GitHub updates');
  const stashPatch=call(local,['show',dirty.backupStash+':changed.txt']);
  assert.equal(stashPatch,'my-uncommitted-local-work',
    'Previous local edits must remain recoverable from the saved stash');
  assert.equal(fs.readFileSync(path.join(local,'server/data/private.json'),'utf8'),
    'PRIVATE_LOCAL_DATA_STAYS');

  // A local-only commit should not permanently block the published main.
  write(local,'changed.txt','local committed experiment');
  call(local,['config','user.name','Updater Test']);
  call(local,['config','user.email','updater-test@example.invalid']);
  call(local,['add','changed.txt']);
  call(local,['commit','-m','Local experiment']);
  const localCommit=call(local,['rev-parse','HEAD']);
  write(publisher,'changed.txt','version-four');
  call(publisher,['add','.']);
  call(publisher,['commit','-m','Version four']);
  call(publisher,['push','origin','main']);
  const diverged=syncGit({root:local,log:quiet});
  assert.equal(diverged.updated,true);
  assert.ok(diverged.backupBranch);
  assert.equal(call(local,['rev-parse',diverged.backupBranch]),localCommit);
  assert.equal(fs.readFileSync(path.join(local,'changed.txt'),'utf8'),'version-four');

  // A future tracked file must not erase an existing user's untracked file.
  write(local,'newfeature.txt','my private untracked version');
  write(publisher,'newfeature.txt','published release version');
  call(publisher,['add','.']);
  call(publisher,['commit','-m','Publish a new file']);
  call(publisher,['push','origin','main']);
  const collision=syncGit({root:local,log:quiet});
  assert.equal(collision.updated,true);
  assert.ok(collision.backupUntracked);
  assert.equal(fs.readFileSync(path.join(local,'newfeature.txt'),'utf8'),
    'published release version');
  assert.equal(fs.readFileSync(path.join(collision.backupUntracked,
    'newfeature.txt'),'utf8'),'my private untracked version');

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

  // Interrupted update: the old dependencies were moved to backup, and
  // npm was interrupted before a new node_modules was fully installed.
  const interrupted=path.join(temp,'interrupted');
  fs.mkdirSync(interrupted);
  write(interrupted,'package-lock.json','{"name":"old-client","lockfileVersion":3}');
  write(interrupted,'node_modules.tapnow-backup/vite/bin/vite.js','old vite');
  write(interrupted,'node_modules.tapnow-backup/.tapnow-install.sha256',
    dependencyFingerprint(interrupted)+'\n');
  write(interrupted,'server/data/account.json','KEEP_PRIVATE_ACCOUNT_DATA');
  assert.equal(ensureDependencies({
    root:interrupted,install:()=>{throw Error('must not reinstall')},log:quiet
  }).installed,false);
  assert.equal(fs.readFileSync(path.join(interrupted,
    'node_modules/vite/bin/vite.js'),'utf8'),'old vite');
  assert.ok(!fs.existsSync(path.join(interrupted,'node_modules.tapnow-backup')));
  assert.equal(fs.readFileSync(path.join(interrupted,
    'server/data/account.json'),'utf8'),'KEEP_PRIVATE_ACCOUNT_DATA');

  // A failed npm ci may leave partial new files and a valid old backup.
  // Restore the old install, retain the partial directory for inspection.
  const partial=path.join(temp,'partial');
  fs.mkdirSync(partial);
  write(partial,'package-lock.json','{"name":"partial","lockfileVersion":3}');
  write(partial,'node_modules/some-package/partial.js','PARTIAL_DATA');
  write(partial,'node_modules.tapnow-backup/vite/bin/vite.js','old vite');
  write(partial,'node_modules.tapnow-backup/.tapnow-install.sha256',
    dependencyFingerprint(partial)+'\n');
  assert.equal(ensureDependencies({
    root:partial,install:()=>{throw Error('must not reinstall')},log:quiet
  }).installed,false);
  assert.equal(fs.readFileSync(path.join(partial,
    'node_modules/vite/bin/vite.js'),'utf8'),'old vite');
  const preservedPartial=fs.readdirSync(partial)
    .filter(name=>name.startsWith('node_modules.tapnow-incomplete-'));
  assert.equal(preservedPartial.length,1);
  assert.equal(fs.readFileSync(path.join(partial,
    preservedPartial[0],'some-package/partial.js'),'utf8'),'PARTIAL_DATA');

  // If the current install is already complete, do not overwrite it with
  // a leftover old backup. Preserve the backup under another unique name.
  const completed=path.join(temp,'completed');
  fs.mkdirSync(completed);
  write(completed,'package-lock.json','{"name":"completed","lockfileVersion":3}');
  write(completed,'node_modules/vite/bin/vite.js','new vite');
  write(completed,'node_modules/.tapnow-install.sha256',
    dependencyFingerprint(completed)+'\n');
  write(completed,'node_modules.tapnow-backup/vite/bin/vite.js','old vite');
  assert.equal(ensureDependencies({
    root:completed,install:()=>{throw Error('must not reinstall')},log:quiet
  }).installed,false);
  assert.equal(fs.readFileSync(path.join(completed,
    'node_modules/vite/bin/vite.js'),'utf8'),'new vite');
  assert.equal(fs.readdirSync(completed)
    .filter(name=>name.startsWith('node_modules.tapnow-preserved-')).length,1);

  // Missing/broken old and current libraries still fail closed, without
  // deleting either directory or any user-owned files.
  const broken=path.join(temp,'broken');
  fs.mkdirSync(broken);
  write(broken,'package-lock.json','{"name":"broken","lockfileVersion":3}');
  write(broken,'node_modules.tapnow-backup/keep.txt','DO_NOT_DELETE');
  assert.throws(()=>ensureDependencies({root:broken,log:quiet}),
    /不完整的依赖备份/);
  assert.equal(fs.readFileSync(path.join(broken,
    'node_modules.tapnow-backup/keep.txt'),'utf8'),'DO_NOT_DELETE');

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

  // If a previous version has a complete installed library set, a failed
  // update must roll back and launch that version rather than leaving the
  // user unable to start the application.
  write(local,'node_modules/vite/bin/vite.js','working old client');
  write(local,'node_modules/.tapnow-install.sha256',
    dependencyFingerprint(local)+'\n');
  const fallback=bootstrap({
    root:local,log:quiet,install:()=>{throw Error('npm network temporarily offline')}
  });
  assert.equal(fallback.updated.skipped,'dependency-rollback');
  assert.equal(fallback.dependencies.usingPrevious,true);
  assert.equal(call(local,['rev-parse','HEAD']),oldHead);
  assert.equal(fs.readFileSync(path.join(local,
    'node_modules/vite/bin/vite.js'),'utf8'),'working old client');
  assert.equal(fs.readFileSync(path.join(local,'server/data/private.json'),'utf8'),
    'PRIVATE_LOCAL_DATA_STAYS','Offline fallback must not modify account data');

  // Only the npm subprocess gets the faster Chinese mirrors. Keep the
  // original machine environment and project files untouched.
  const originalEnv={EXAMPLE_SETTING:'keep'};
  const installEnv=npmInstallEnvironment(originalEnv);
  assert.deepEqual(originalEnv,{EXAMPLE_SETTING:'keep'});
  assert.equal(installEnv.npm_config_registry,'https://registry.npmmirror.com/');
  assert.equal(installEnv.npm_config_replace_registry_host,'npmjs');
  assert.equal(installEnv.FFMPEG_BINARIES_URL,
    'https://cdn.npmmirror.com/binaries/ffmpeg-static');
  assert.equal(installEnv.npm_config_foreground_scripts,'true');

  // Explicit environment variables (including Windows uppercase names)
  // must take precedence over TapNow's default mirror values.
  const customEnv=npmInstallEnvironment({
    NPM_CONFIG_REGISTRY:'https://registry.npmjs.org/',
    NPM_CONFIG_REPLACE_REGISTRY_HOST:'never',
    FFMPEG_BINARIES_URL:'https://example.com/ffmpeg-binaries',
    NPM_CONFIG_FOREGROUND_SCRIPTS:'false'
  });
  assert.equal(customEnv.NPM_CONFIG_REGISTRY,'https://registry.npmjs.org/');
  assert.equal(customEnv.NPM_CONFIG_REPLACE_REGISTRY_HOST,'never');
  assert.equal(customEnv.FFMPEG_BINARIES_URL,'https://example.com/ffmpeg-binaries');
  assert.equal(customEnv.NPM_CONFIG_FOREGROUND_SCRIPTS,'false');
  assert.equal(Object.keys(customEnv).filter(name=>
    name.toLowerCase()==='npm_config_registry').length,1);

  console.log('PASS: updater preserves project data, recovers dependencies, restores offline fallback, and configures npm/FFmpeg mirrors with user overrides');
}finally{
  fs.rmSync(temp,{recursive:true,force:true,maxRetries:4,retryDelay:100});
}
