import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import multer from 'multer';
import {chromium} from 'playwright';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mountShareRoutes} from '../server/share.mjs';
import {mountGuestLocalBridge} from '../server/guest-local-bridge.mjs';
import {diffCanvas,snapshotCanvas} from '../src/share-sync.mjs';

const node=(id,name,x,y)=>({
  id,type:'studio',position:{x,y},
  data:{kind:'text',title:name,text:'',prompt:'',status:'idle'}
});
let projects=[{
  id:'ui-team-canvas',title:'协作画布',
  nodes:[node('a','节点A',90,100),node('b','节点B',480,340)],
  edges:[],groups:[],groupColorCursor:0,
  viewport:{x:155,y:105,zoom:1},
  createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
}];
const read=()=>structuredClone(projects);
const write=value=>{projects=structuredClone(value);};
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','server');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'tapnow-guest-ui-'));
const hostUploads=path.join(scratch,'host');
const localUploads=path.join(scratch,'guest');
fs.mkdirSync(hostUploads,{recursive:true});
fs.mkdirSync(localUploads,{recursive:true});
fs.writeFileSync(path.join(localUploads,'guest-produced.png'),Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64'));
fs.writeFileSync(path.join(localUploads,'guest-produced.mp4'),
  Buffer.from('Simulated local video output'));
const app=express();
app.use(express.json({limit:'15mb'}));
app.post('/api/assets',multer({dest:hostUploads}).single('file'),(req,res)=>{
  const file=crypto.randomUUID()+path.extname(req.file.originalname);
  fs.renameSync(req.file.path,path.join(hostUploads,file));
  res.status(201).json({url:'/api/uploads/'+file,name:req.file.originalname});
});
app.use('/api/uploads',express.static(hostUploads));
app.get('/api/projects',(_req,res)=>res.json(projects.map(p=>({
  id:p.id,title:p.title,updatedAt:p.updatedAt
}))));
app.get('/api/projects/:id',(req,res)=>{
  const found=projects.find(p=>p.id===req.params.id);
  if(!found)return res.status(404).json({error:'Unknown project'});
  res.json(found);
});
app.put('/api/projects/:id',(req,res)=>{
  const found=projects.find(p=>p.id===req.params.id);
  if(!found)return res.status(404).json({error:'Unknown project'});
  Object.assign(found,req.body,{updatedAt:new Date().toISOString()});
  res.json({id:found.id,updatedAt:found.updatedAt});
});
for(const provider of ['doubao','chatgpt','muse']){
  app.get('/api/'+provider+'/accounts',(_req,res)=>res.json([]));
}
app.get('/api/muse/quotas',(_req,res)=>res.json({
  rows:[],totalAccounts:0,knownAccounts:0,unknownAccounts:0,
  totalCapacity:0,measuredCapacity:0,totalUsed:0,totalRemaining:0
}));
app.get('/api/health',(_req,res)=>res.json({ok:true}));
const server=await new Promise(resolve=>{
  const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));
});
const shared=mountShareRoutes(app,{
  read,write,root,uploadDir:hostUploads,lanPort:0,
  upstreamPort:server.address().port
});
const dist=path.join(root,'..','dist');
const indexFile=path.join(dist,'index.html');
let originalIndex=null;
app.use(express.static(dist,{index:false}));
app.get('/{*path}',(_req,res)=>res.sendFile(path.join(dist,'index.html')));
// User2 has an independent local TapNow page/API; only share state comes
// from the host. It must NOT send generation calls to the host service.
const localApp=express();
localApp.use(express.json({limit:'15mb'}));
const localServer=await new Promise(resolve=>{
  const instance=localApp.listen(0,'127.0.0.1',()=>resolve(instance));
});
const localOrigin='http://127.0.0.1:'+localServer.address().port;
let localProjects=[{
  id:'guest-personal',title:'用户2本机画布',
  nodes:[],edges:[],groups:[],groupColorCursor:0,
  viewport:{x:0,y:0,zoom:1},createdAt:new Date().toISOString(),
  updatedAt:new Date().toISOString()
}];
mountGuestLocalBridge(localApp,{
  read:()=>structuredClone(localProjects),
  write:value=>{localProjects=structuredClone(value);},
  uploadDir:localUploads,extraLoopbackOrigins:[localOrigin]
});
localApp.get('/api/share/info',(_req,res)=>res.json({role:'none'}));
localApp.get('/api/projects',(_req,res)=>res.json(localProjects.map(p=>({
  id:p.id,title:p.title,updatedAt:p.updatedAt
}))));
localApp.get('/api/projects/:id',(req,res)=>{
  const p=localProjects.find(item=>item.id===req.params.id);
  if(!p)return res.status(404).json({error:'Not found'});
  res.json(p);
});
localApp.get('/api/chatgpt/accounts',(_req,res)=>res.json([]));
localApp.get('/api/doubao/accounts',(_req,res)=>res.json([
  {id:'user2-doubao',name:'用户2的豆包',nativeBrowserOpen:false}
]));
localApp.get('/api/muse/accounts',(_req,res)=>res.json([
  {id:'user2-account',name:'用户2的Muse',nativeBrowserOpen:false}
]));
localApp.get('/api/health',(_req,res)=>res.json({
  museBridgeRevision:'quota-auto-v6-image-resolution',
  museMediaRevision:'fresh-chat-media-v2',audioReferenceRevision:'mixed-media-v1',
  multiImageUploadRevision:'v3-prompt-first',
  videoModelRevision:'mini-fast-v1',videoStartRevision:'reply-prefix-v1',
  videoDownloadRevision:'completed-card-v1',referenceSelectionRevision:'at-order-v2',
  audioMp4Revision:'mp3-to-mp4-v1'
}));
let localMuseJobs=0;
let localDoubaoJobs=0;
localApp.post('/api/muse/jobs',(req,res)=>{
  assert.equal(req.body.accountId,'user2-account');
  assert.ok(localProjects.some(p=>p.id===req.body.projectId&&p.hiddenGuestJob));
  localMuseJobs++;
  res.status(201).json({id:'user2-job',status:'queued',message:'本机任务'});
});
localApp.get('/api/muse/jobs/user2-job',(_req,res)=>res.json({
  id:'user2-job',status:'completed',progress:100,
  mediaUrl:'/api/uploads/guest-produced.png',message:'本机生成完成'
}));
localApp.post('/api/doubao/jobs',(req,res)=>{
  assert.equal(req.body.accountId,'user2-doubao');
  assert.ok(localProjects.some(p=>p.id===req.body.projectId&&p.hiddenGuestJob));
  localDoubaoJobs++;
  res.status(201).json({id:'user2-video',status:'queued',message:'本机视频任务'});
});
localApp.get('/api/doubao/jobs/user2-video',(_req,res)=>res.json({
  id:'user2-video',status:'completed',progress:100,
  videoUrl:'/api/uploads/guest-produced.mp4',message:'本机视频完成'
}));
localApp.get('/api/muse/quotas',(_req,res)=>res.json({
  rows:[],totalAccounts:0,knownAccounts:0,unknownAccounts:0,
  totalCapacity:0,measuredCapacity:0,totalUsed:0,totalRemaining:0
}));
localApp.use(express.static(dist,{index:false}));
localApp.get('/{*path}',(_req,res)=>res.sendFile(path.join(dist,'index.html')));
let browser;
try{
  browser=await chromium.launch({channel:'msedge',headless:true});
  const host=await browser.newPage({viewport:{width:1680,height:1000}});
  const guestEntry=await browser.newPage({viewport:{width:1680,height:1000}});
  const errors=[];
  for(const page of [host,guestEntry]){
    page.on('pageerror',error=>errors.push(error.message));
    page.setDefaultTimeout(15000);
  }
  await host.goto('http://127.0.0.1:'+server.address().port+'/',{
    waitUntil:'domcontentloaded'
  });
  try{
    await host.locator('.react-flow__node[data-id="a"]').waitFor();
  }catch(error){
    const state=await host.evaluate(()=>({
      text:document.body.innerText.slice(0,650),
      resources:[...document.scripts].map(script=>script.src),
      hash:location.hash
    }));
    throw new Error('Host canvas failed to load: '+JSON.stringify({
      state,errors,cause:error.message
    }));
  }
  // Simulate a previous Git revision's compiled page still in dist/.
  // Starting a share must replace it even though index.html already exists.
  originalIndex=fs.readFileSync(indexFile,'utf8');
  const obsoleteIndex=originalIndex.replace(
    /index-[A-Za-z0-9_-]+\.js/,'index-obsolete-bundle.js');
  assert.notEqual(obsoleteIndex,originalIndex);
  fs.writeFileSync(indexFile,obsoleteIndex);
  await host.getByRole('button',{name:'局域网共享画布'}).click();
  await host.getByRole('button',{name:'开启共享画布'}).click();
  await host.getByTestId('share-code').waitFor();
  assert.doesNotMatch(fs.readFileSync(indexFile,'utf8'),/index-obsolete-bundle\.js/,
    'guest must not receive the stale bundle from dist/');
  originalIndex=null;
  const code=(await host.getByTestId('share-code').innerText()).trim();
  assert.match(code,/^\d{5}$/);
  await guestEntry.goto(localOrigin+'/',{
    waitUntil:'domcontentloaded'
  });
  await guestEntry.getByRole('button',{name:'加入别人的画布'}).click();
  await guestEntry.getByRole('textbox',{name:'主机局域网地址'})
    .fill('127.0.0.1:'+shared.info().port);
  await guestEntry.getByRole('textbox',{name:'加入别人的画布加入码'})
    .fill(code);
  const nextPage=guestEntry.context().waitForEvent('page');
  await guestEntry.getByRole('button',{name:'连接并加入'}).click();
  const guest=await nextPage;
  guest.on('pageerror',error=>errors.push(error.message));
  guest.setDefaultTimeout(15000);
  await guest.locator('.react-flow__node[data-id="a"]').waitFor();
  assert.match(new URL(guest.url()).hash,/^#remote=[0-9a-f]{48}$/,
    'guest must remain on own local API with a private bridge session');
  assert.equal(new URL(guest.url()).origin,localOrigin);
  await host.getByRole('button',{name:'关闭共享设置'}).click();

  // Host locks node A by opening its editor, guest sees and cannot drag it.
  await host.locator('.react-flow__node[data-id="a"] .tn-node-frame').click();
  await guest.locator('.react-flow__node[data-id="a"]')
    .getByTestId('shared-node-locked').waitFor();
  assert.match(await guest.getByTestId('shared-node-locked').innerText(),/用户1/);

  // Deselect to release the lease and drag; guest must see the new coordinates.
  await host.mouse.click(1450,800);
  await guest.locator('.react-flow__node[data-id="a"]')
    .getByTestId('shared-node-locked').waitFor({state:'hidden'});
  const a=host.locator('.react-flow__node[data-id="a"]');
  const origin=await a.boundingBox();
  const header=await a.locator('.tn-node-caption').boundingBox();
  assert.ok(origin&&header);
  const grabX=header.x+header.width/2,grabY=header.y+header.height/2;
  await host.mouse.move(grabX,grabY);
  await host.mouse.down();
  await host.mouse.move(grabX+110,grabY+75,{steps:10});
  await host.mouse.up();
  for(let attempt=0;attempt<80&&
    projects[0].nodes.find(n=>n.id==='a').position.x<=160;attempt++)
    await new Promise(resolve=>setTimeout(resolve,100));
  const sharedX=projects[0].nodes.find(n=>n.id==='a').position.x;
  assert.ok(sharedX>160,
    'host drag must persist in shared project');
  const guestA=guest.locator('.react-flow__node[data-id="a"]');
  // Screen coordinates differ while each user's viewport is loading and are
  // intentionally independent. Compare the node's React Flow canvas X instead.
  await guest.waitForFunction(expectedX=>{
    const element=document.querySelector('.react-flow__node[data-id="a"]');
    const style=element?.getAttribute('style')||'';
    const match=style.match(/translate\(([-\d.]+)px/);
    return !!match&&Math.abs(Number(match[1])-expectedX)<2;
  },sharedX,{timeout:12000});
  assert.ok(await guestA.isVisible());

  // Guest creates a node; host must receive it without reloading.
  await guest.locator('button[title="图文节点"]').click();
  await guest.waitForTimeout(500);
  await host.waitForFunction(()=>{
    return document.querySelectorAll('.react-flow__node').length>=3;
  });
  assert.equal(projects[0].nodes.length,3);
  // Host-created nodes must appear at the guest without reloading too.
  await host.locator('button[title="图文节点"]').click();
  await guest.waitForFunction(()=>
    document.querySelectorAll('.react-flow__node').length>=4);
  assert.equal(projects[0].nodes.length,4);

  // The previous colored-frame feature is also part of the shared model.
  await host.locator('aside.canvas-tools button[aria-label="创建彩色分组"]').click();
  await guest.getByTestId('canvas-group').first().waitFor();
  assert.equal(projects[0].groups.length,1);

  // Lock ownership must work symmetrically.
  await host.mouse.click(1550,860);
  await guest.locator('.react-flow__node[data-id="b"] .tn-node-frame').click();
  await host.locator('.react-flow__node[data-id="b"]')
    .getByTestId('shared-node-locked').waitFor();
  assert.match(await host.getByTestId('shared-node-locked').innerText(),/用户2/);
  await guest.mouse.click(1550,860);
  await host.locator('.react-flow__node[data-id="b"]')
    .getByTestId('shared-node-locked').waitFor({state:'hidden'});
  // User2 chooses a local account on a shared image node. Neither the chosen
  // account ID nor the generation request is allowed to reach User1's API.
  const beforeImage=snapshotCanvas(read()[0]);
  const imageCanvas=structuredClone(beforeImage);
  imageCanvas.nodes.push({
    id:'guest-image',type:'studio',position:{x:660,y:95},
    data:{kind:'image',title:'协作者生图',provider:'muse',
      museAccountId:'host-account-id',prompt:'sunrise',status:'idle'}
  });
  const injected=await fetch('http://127.0.0.1:'+server.address().port+
    '/api/share/patch',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({clientId:'host',patch:diffCanvas(beforeImage,imageCanvas)})
  });
  assert.equal(injected.status,200);
  const imageNode=guest.locator('.react-flow__node[data-id="guest-image"]');
  await imageNode.waitFor();
  await imageNode.locator('.tn-node-frame').click();
  // React Flow renders the composer inside a portal, not as a DOM child
  // of the node; target the visible toolbar in the guest's page.
  await guest.getByRole('combobox',{name:'Muse 生成账号'})
    .selectOption('user2-account');
  assert.equal(read()[0].nodes.find(n=>n.id==='guest-image').data.museAccountId,
    'host-account-id','User2 account selection must not overwrite User1 data');
  await guest.locator('button.tn-submit:visible').click();
  for(let attempt=0;attempt<100&&
    !read()[0].nodes.find(n=>n.id==='guest-image').data.mediaUrl;attempt++)
    await new Promise(resolve=>setTimeout(resolve,150));
  const generated=read()[0].nodes.find(n=>n.id==='guest-image');
  if(!generated.data.mediaUrl){
    const guestState=await guest.evaluate(()=>({
      body:document.body.innerText.slice(-1800),
      status:[...document.querySelectorAll('.tn-job-caption,.tn-queued,.tn-node-error')]
        .map(x=>x.textContent?.slice(0,220))
    }));
    console.error('GUEST GENERATION DIAGNOSTICS',JSON.stringify({
      localMuseJobs,localProjects:localProjects.map(p=>({
        id:p.id,hidden:p.hiddenGuestJob,nodes:p.nodes.length
      })),
      sharedNode:generated.data,guestState,errors
    }));
  }
  assert.match(generated.data.mediaUrl||'',/^\/api\/uploads\/[0-9a-f-]+\.png$/);
  assert.equal(generated.data.museAccountId,'host-account-id');
  assert.equal(localMuseJobs,1,'User2 must create a job on their own API');
  // Verify Seedance video follows the same local-only account and media path.
  const beforeVideo=snapshotCanvas(read()[0]);
  const videoCanvas=structuredClone(beforeVideo);
  videoCanvas.nodes.push({
    id:'guest-video',type:'studio',position:{x:1000,y:95},
    data:{kind:'video',title:'协作者视频',provider:'doubao',
      model:'Seedance 2.0 Mini',accountId:'host-doubao-id',
      prompt:'local video',duration:'5s',status:'idle'}
  });
  const videoInjected=await fetch('http://127.0.0.1:'+
    server.address().port+'/api/share/patch',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({clientId:'host',patch:diffCanvas(beforeVideo,videoCanvas)})
  });
  assert.equal(videoInjected.status,200);
  const videoNode=guest.locator('.react-flow__node[data-id="guest-video"]');
  await videoNode.waitFor();
  await videoNode.locator('.tn-node-frame').click();
  await guest.getByRole('combobox',{name:'视频生成账号'})
    .selectOption('user2-doubao');
  assert.equal(read()[0].nodes.find(n=>n.id==='guest-video').data.accountId,
    'host-doubao-id','Guest Doubao choice must not affect host account');
  await guest.getByRole('button',{name:'使用选定豆包账号生成视频'}).click();
  for(let attempt=0;attempt<100&&
    !read()[0].nodes.find(n=>n.id==='guest-video').data.mediaUrl;attempt++)
    await new Promise(resolve=>setTimeout(resolve,150));
  const generatedVideo=read()[0].nodes.find(n=>n.id==='guest-video');
  assert.match(generatedVideo.data.mediaUrl||'',
    /^\/api\/uploads\/[0-9a-f-]+\.mp4$/,JSON.stringify(generatedVideo.data));
  assert.equal(generatedVideo.data.accountId,'host-doubao-id');
  assert.equal(localDoubaoJobs,1,'User2 video must use their local API');
  // LAN HTTP is not a secure context (unlike localhost). Verify the actual
  // network guest can boot without crypto.randomUUID().
  const links=await host.evaluate(async()=>
    (await (await fetch('/api/share/info')).json()).links||[]);
  const lanLink=links.find(url=>url.includes('192.168.'))||links[0];
  if(lanLink){
    const lanGuest=await browser.newPage({viewport:{width:1680,height:1000}});
    lanGuest.on('pageerror',error=>errors.push(error.message));
    const navigation=await lanGuest.goto(lanLink+'#join='+code,
      {waitUntil:'domcontentloaded'});
    assert.match(navigation.headers()['cache-control']||'',/no-store/);
    assert.doesNotMatch(await lanGuest.content(),/index-obsolete-bundle\.js/);
    assert.equal(await lanGuest.evaluate(()=>window.isSecureContext),false);
    assert.equal(await lanGuest.evaluate(()=>typeof crypto.randomUUID),'undefined');
    try{
      await lanGuest.locator('.react-flow__node[data-id="a"]')
        .waitFor({timeout:8000});
    }catch(error){
      throw new Error('LAN guest did not render: '+errors.join(' | ')+
        '; '+error.message);
    }
    await lanGuest.close();
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: local guest Muse image + Doubao video generation, own accounts, host media, live sync and locks');
}finally{
  // Do not leave a deliberately broken HTML file if the assertion fails.
  if(originalIndex&&fs.existsSync(indexFile)&&
     fs.readFileSync(indexFile,'utf8').includes('index-obsolete-bundle.js'))
    fs.writeFileSync(indexFile,originalIndex);
  await shared.stop().catch(()=>{});
  await browser?.close();
  await new Promise(resolve=>localServer.close(resolve));
  await new Promise(resolve=>server.close(resolve));
  fs.rmSync(scratch,{recursive:true,force:true,maxRetries:4,retryDelay:100});
}
