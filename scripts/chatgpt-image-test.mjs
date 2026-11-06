import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import express from 'express';
import {chromium} from 'playwright';
import ffmpeg from 'ffmpeg-static';
import {runChatGPTBrowser} from '../server/chatgpt-runner.mjs';
import {mountChatGPTRoutes,preserveChatGPTCompletedMedia} from '../server/chatgpt.mjs';

const folder=fs.mkdtempSync(path.join(os.tmpdir(),'tapnow-chatgpt-image-'));
const uploadDir=path.join(folder,'uploads'),dataDir=path.join(folder,'data');
fs.mkdirSync(uploadDir);fs.mkdirSync(dataDir);
const fixture=path.join(folder,'generated.png');
const render=spawnSync(ffmpeg,[
  '-y','-hide_banner','-loglevel','error','-f','lavfi','-i',
  'color=c=blue:s=512x512:d=0.2','-frames:v','1',fixture
],{encoding:'utf8'});
assert.equal(render.status,0,render.stderr);
const png=fs.readFileSync(fixture);
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage();
try{
  const oldIllustration='data:image/svg+xml,'+encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">'+
    '<rect width="512" height="512" fill="red"/></svg>');
  await page.setContent('<div id="prompt-textarea" role="textbox" contenteditable="true"></div>'+
    '<button data-testid="send-button">发送</button>'+
    '<p>其他普通内容有 70%（不可当成生图进度）</p>'+
    '<section data-message-author-role="assistant"><span>95%</span>'+
    '<img style="width:512px;height:512px" src="'+oldIllustration+'"></section>');
  await page.evaluate(source=>{
    document.querySelector('button[data-testid="send-button"]')
      .addEventListener('click',()=>{
        const section=document.createElement('section');
        section.setAttribute('data-message-author-role','assistant');
        section.innerHTML='<span id="progress">17%</span>'+
          '<button data-testid="stop-button">停止</button>';
        document.body.appendChild(section);
        setTimeout(()=>{section.querySelector('#progress').textContent='70%';},220);
        setTimeout(()=>{
          section.querySelector('#progress').remove();
          section.querySelector('[data-testid="stop-button"]').remove();
          const img=new Image();img.alt='新生成图片';
          img.style.width='512px';img.style.height='512px';
          img.src=source;section.appendChild(img);
        },530);
      });
  },'data:image/png;base64,'+png.toString('base64'));
  const progress=[];
  const result=await runChatGPTBrowser({
    page,job:{prompt:'一只猫的角色设定图',ratio:'16:9'},
    outputDir:uploadDir,navigate:false,intervalMs:45,
    timeoutMs:5000,onProgress:state=>progress.push(state)
  });
  assert.ok(progress.some(item=>item.progress===17));
  assert.ok(progress.some(item=>item.progress===70));
  assert.ok(!progress.some(item=>item.progress===95),
    'Never report stale progress from a previous assistant message');
  assert.ok(progress.every(item=>item.progress===null||
    [17,70,100].includes(item.progress)));
  assert.equal(progress.at(-1).progress,100);
  assert.equal(result.width,512);assert.equal(result.height,512);
  assert.deepEqual(fs.readFileSync(path.join(uploadDir,
    path.basename(result.mediaUrl))),png);
  assert.match(await page.locator('#prompt-textarea').innerText(),
    /请直接生成一张图片/);
  console.log('PASS: ChatGPT prompt + true DOM 17% / 70% + original PNG download');
}finally{await browser.close();}

const project={
  id:crypto.randomUUID(),title:'ChatGPT integration',nodes:[{
    id:'image-node',type:'studio',position:{x:10,y:20},
    data:{kind:'image',provider:'chatgpt',title:'图片',
      prompt:'一只猫',status:'idle'}
  }],edges:[],updatedAt:new Date().toISOString()
};
let projects=[project];
const app=express();app.use(express.json());
const hosts=['127.0.0.1:3701'];
const fakeContext={pages:()=>[{isClosed:()=>false}],on:()=>{},close:async()=>{}};
let launchedProfile=null;
let nativeChild=null;
mountChatGPTRoutes(app,()=>projects,items=>{projects=items;},{
  dataDir,uploadDir,allowedHosts:hosts,
  launch:async account=>{
    assert.ok(account?.id);
    return fakeContext;
  },
  loginLauncher:account=>{
    launchedProfile=path.join(dataDir,'chatgpt-profiles',account.id+'-edge');
    const child=new EventEmitter();
    child.exitCode=null;
    child.unref=()=>{};
    nativeChild=child;
    process.nextTick(()=>child.emit('spawn'));
    return child;
  },
  runner:async({job,outputDir,onProgress})=>{
    assert.equal(job.prompt,'一只猫');
    assert.equal(outputDir,uploadDir);
    onProgress({status:'running',progress:null,message:'生成中'});
    onProgress({status:'running',progress:70,message:'ChatGPT 生图 70%'});
    const filename=crypto.randomUUID()+'.png';
    fs.writeFileSync(path.join(uploadDir,filename),png);
    return {mediaUrl:'/api/uploads/'+filename,width:512,height:512};
  }
});
const server=await new Promise(resolve=>{
  const s=app.listen(0,'127.0.0.1',()=>resolve(s));
});
hosts.push('127.0.0.1:'+server.address().port);
const root='http://127.0.0.1:'+server.address().port;
const api=async(url,init={})=>{
  const response=await fetch(root+url,{
    headers:{'Content-Type':'application/json'},...init
  });
  return {status:response.status,body:await response.json()};
};
try{
  const added=await api('/api/chatgpt/accounts',{
    method:'POST',body:JSON.stringify({name:'测试 ChatGPT 01'})
  });
  assert.equal(added.status,201,JSON.stringify(added.body));
  assert.equal(added.body.name,'测试 ChatGPT 01');
  assert.equal((await api('/api/chatgpt/accounts')).body.length,1);
  const opened=await api('/api/chatgpt/accounts/'+added.body.id+'/native-login',{
    method:'POST',body:JSON.stringify({browserEngine:'edge'})
  });
  assert.equal(opened.status,200,JSON.stringify(opened.body));
  assert.ok(fs.existsSync(launchedProfile),
    'Creating account and clicking Login must prepare a real isolated Edge profile');
  assert.equal((await api('/api/chatgpt/accounts')).body[0].nativeBrowserOpen,true);
  nativeChild.exitCode=0;
  nativeChild.emit('exit',0);
  assert.equal((await api('/api/chatgpt/accounts')).body[0].nativeBrowserOpen,false);
  const second=await api('/api/chatgpt/accounts',{
    method:'POST',body:JSON.stringify({name:'测试 ChatGPT 02'})
  });
  assert.equal(second.status,201);
  assert.notEqual(second.body.id,added.body.id);
  const accepted=await api('/api/chatgpt/jobs',{
    method:'POST',body:JSON.stringify({
      projectId:project.id,nodeId:'image-node',
      accountId:added.body.id,references:[]
    })
  });
  assert.equal(accepted.status,202,JSON.stringify(accepted.body));
  let final;
  for(let i=0;i<100;i++){
    await new Promise(resolve=>setTimeout(resolve,15));
    final=(await api('/api/chatgpt/jobs/'+accepted.body.id)).body;
    if(final.status==='completed')break;
  }
  assert.equal(final.status,'completed',JSON.stringify(final));
  assert.equal(final.accountId,added.body.id);
  assert.equal(final.progress,100);
  assert.equal(projects[0].nodes[0].data.mediaUrl,final.mediaUrl);
  assert.equal(projects[0].nodes[0].data.status,'done');
  const stale=projects[0].nodes.map(node=>({
    ...node,data:{...node.data,mediaUrl:'',status:'running'}
  }));
  assert.equal(preserveChatGPTCompletedMedia(projects[0],stale)[0].
    data.mediaUrl,final.mediaUrl,'Autosave must preserve generated media');
  const invalid=await api('/api/chatgpt/jobs',{
    method:'POST',body:JSON.stringify({
      projectId:project.id,nodeId:'invalid-node',references:[]
    })
  });
  assert.equal(invalid.status,400);
  const removed=await api('/api/chatgpt/accounts/'+second.body.id,{
    method:'DELETE'
  });
  assert.equal(removed.status,200);
  assert.equal((await api('/api/chatgpt/accounts')).body.length,1);
  assert.ok(!fs.existsSync(path.join(dataDir,'chatgpt-profiles',
    second.body.id+'-edge')));
  console.log('PASS: create 2 named ChatGPT Edge accounts, native login launch, profile isolation, account choice, delete');
  console.log('PASS: ChatGPT job API, real progress persistence, image canvas backfill, stale autosave protection');
}finally{
  await new Promise(resolve=>server.close(resolve));
  fs.rmSync(folder,{recursive:true,force:true});
}
