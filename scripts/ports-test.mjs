import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {getPortOwners,listeningPids,releasePorts} from './ports-core.mjs';

const sample=[
  '  TCP    0.0.0.0:3701     0.0.0.0:0      LISTENING      1200',
  '  TCP    [::]:5173        [::]:0         LISTENING      1200',
  '  TCP    127.0.0.1:55000 127.0.0.1:3701 ESTABLISHED    3000',
  '  TCP    0.0.0.0:3702     0.0.0.0:0      LISTENING      4500'
].join('\r\n');
const owners=listeningPids(sample);
assert.deepEqual([...owners.get(1200)],[3701,5173]);
assert.deepEqual([...owners.get(4500)],[3702]);
assert.equal(owners.has(3000),false);

if(process.platform==='win32'){
  // Kill only a listener created for this test, never unrelated machine PIDs.
  const child=spawn(process.execPath,['-e',
    "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port));"
  ],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let port;
  try{
    let output='';
    for await(const chunk of child.stdout){
      output+=chunk.toString();
      if(output.includes('\n')){port=Number(output.trim());break;}
    }
    assert.ok(Number.isInteger(port)&&port>1024);
    const found=getPortOwners({ports:[port]});
    assert.ok(found.get(child.pid)?.has(port),
      'netstat must identify the real listener PID');
    const stopped=await releasePorts({ports:[port],log:()=>{}});
    assert.deepEqual(stopped,[child.pid]);
    assert.equal(getPortOwners({ports:[port]}).size,0);
    console.log('PASS: Windows netstat identifies listener, taskkill releases test port');
  }finally{
    if(child.exitCode===null)child.kill();
    await Promise.race([once(child,'exit').catch(()=>{}),
      new Promise(resolve=>setTimeout(resolve,2000))]);
  }
}
console.log('PASS: only configured TCP listening PIDs are selected');
