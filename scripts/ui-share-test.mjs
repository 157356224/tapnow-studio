import assert from 'node:assert/strict';
import express from 'express';
import {chromium} from 'playwright';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mountShareRoutes} from '../server/share.mjs';

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
const app=express();
app.use(express.json({limit:'15mb'}));
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
const shared=mountShareRoutes(app,{
  read,write,root,uploadDir:path.join(root,'uploads'),lanPort:0
});
const dist=path.join(root,'..','dist');
app.use(express.static(dist,{index:false}));
app.get('/{*path}',(_req,res)=>res.sendFile(path.join(dist,'index.html')));
const server=await new Promise(resolve=>{
  const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));
});
let browser;
try{
  browser=await chromium.launch({channel:'msedge',headless:true});
  const host=await browser.newPage({viewport:{width:1680,height:1000}});
  const guest=await browser.newPage({viewport:{width:1680,height:1000}});
  const errors=[];
  for(const page of [host,guest]){
    page.on('pageerror',error=>errors.push(error.message));
    page.setDefaultTimeout(15000);
  }
  await host.goto('http://127.0.0.1:'+server.address().port+'/',{
    waitUntil:'domcontentloaded'
  });
  await host.locator('.react-flow__node[data-id="a"]').waitFor();
  await host.getByRole('button',{name:'局域网共享画布'}).click();
  await host.getByRole('button',{name:'开启共享画布'}).click();
  await host.getByTestId('share-code').waitFor();
  const code=(await host.getByTestId('share-code').innerText()).trim();
  assert.match(code,/^\d{5}$/);
  await guest.goto('http://127.0.0.1:'+shared.info().port+'/',{
    waitUntil:'domcontentloaded'
  });
  await guest.getByRole('textbox',{name:'5位加入码'}).fill(code);
  await guest.getByRole('button',{name:'加入画布'}).click();
  await guest.locator('.react-flow__node[data-id="a"]').waitFor();
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
  assert.deepEqual(errors,[]);
  console.log('PASS: two browsers join, two-way lock ownership, live drag, both sides add nodes, shared colored frames');
}finally{
  await shared.stop().catch(()=>{});
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
