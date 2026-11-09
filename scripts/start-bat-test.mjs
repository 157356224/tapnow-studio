import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

if(process.platform!=='win32'){
  console.log('SKIP: start.bat integration test requires Windows');
  process.exit(0);
}
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'tapnow-bat-'));
const file=path.join(temp,'start.bat');
const trace=path.join(temp,'trace.txt');
const fakeNode=[
  '@echo off',
  'echo %*>>"%TAPNOW_BAT_TRACE%"',
  'if /I "%~1"=="scripts/stop-ports.mjs" if defined TAPNOW_FAIL_PORTS exit /b 8',
  'if /I "%~1"=="scripts/bootstrap.mjs" if defined TAPNOW_FAIL_UPDATE exit /b 9',
  'exit /b 0',
  ''
].join('\r\n');
function run({failUpdate=false,failPorts=false}={}){
  fs.writeFileSync(trace,'');
  const env={...process.env,TAPNOW_BAT_TRACE:trace};
  const pathKey=Object.keys(env).find(key=>key.toLowerCase()==='path')||'Path';
  env[pathKey]=temp+path.delimiter+(env[pathKey]||'');
  if(failUpdate)env.TAPNOW_FAIL_UPDATE='1';
  else delete env.TAPNOW_FAIL_UPDATE;
  if(failPorts)env.TAPNOW_FAIL_PORTS='1';
  else delete env.TAPNOW_FAIL_PORTS;
  const result=spawnSync('cmd.exe',['/d','/c','call start.bat <nul'],{
    cwd:temp,encoding:'utf8',env,timeout:15000,windowsHide:true
  });
  if(result.error)throw result.error;
  const calls=fs.readFileSync(trace,'utf8').trim().split(/\r?\n/);
  return {code:result.status,calls,stderr:result.stderr,stdout:result.stdout};
}
try{
  fs.copyFileSync(path.join(project,'start.bat'),file);
  fs.writeFileSync(path.join(temp,'node.cmd'),fakeNode);
  fs.writeFileSync(path.join(temp,'npm.cmd'),'@echo off\r\nexit /b 0\r\n');
  const normal=run();
  assert.equal(normal.code,0,normal.stderr+'\n'+normal.stdout);
  assert.deepEqual(normal.calls,[
    'scripts/stop-ports.mjs',
    'scripts/bootstrap.mjs',
    'scripts/launch.mjs'
  ]);
  const blocked=run({failUpdate:true});
  assert.equal(blocked.code,1,blocked.stderr+'\n'+blocked.stdout);
  assert.deepEqual(blocked.calls,[
    'scripts/stop-ports.mjs','scripts/bootstrap.mjs'
  ],'A failed GitHub update must not launch a new server');
  const portBlocked=run({failPorts:true});
  assert.equal(portBlocked.code,1);
  assert.deepEqual(portBlocked.calls,['scripts/stop-ports.mjs']);
  console.log('PASS: start.bat stops old ports, updates, then launches; failures abort');
}finally{
  fs.rmSync(temp,{recursive:true,force:true});
}
