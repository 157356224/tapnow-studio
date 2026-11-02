import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const url=process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5174/';
const now=new Date().toISOString();
const node=(id,kind,x,y,extra={})=>({
  id,type:'studio',position:{x,y},
  data:{kind,title:id,ratio:'16:9',status:'idle',text:id,prompt:id,...extra}
});
const project={
  id:'test-performance-fan-out',title:'Multi-edge drag and generation paint',
  updatedAt:now,viewport:{x:35,y:30,zoom:.75},
  nodes:[
    node('hub','text',90,330),
    ...Array.from({length:8},(_,i)=>node('target-'+i,'text',
      580+(i%2)*470,90+Math.floor(i/2)*230)),
    node('gen-image','image',50,40,{status:'running',provider:'muse'}),
    node('gen-video','video',1500,35,{status:'running',provider:'doubao'}),
    node('gen-image-2','image',1500,600,{status:'running',provider:'muse'}),
    node('generated','image',1020,900,{
      status:'done',provider:'muse',mediaUrl:'/api/uploads/test-generated.png'
    })
  ],
  edges:Array.from({length:8},(_,i)=>({
    id:'fan-'+i,source:'hub',target:'target-'+i,
    sourceHandle:'out',targetHandle:'in'
  }))
};
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1920,height:1040},
  reducedMotion:'no-preference'});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
try{
  await page.route('**/api/projects**',route=>{
    const req=route.request();
    const data=req.method()==='PUT'?{id:project.id,updatedAt:now}:
      new URL(req.url()).pathname==='/api/projects'
        ?[{id:project.id,title:project.title,updatedAt:now}]:project;
    return route.fulfill({status:200,contentType:'application/json',
      body:JSON.stringify(data)});
  });
  for(const target of ['doubao/accounts','muse/accounts']){
    await page.route('**/api/'+target,route=>route.fulfill({
      status:200,contentType:'application/json',body:'[]'
    }));
  }
  await page.route('**/api/muse/quotas**',route=>route.fulfill({
    status:200,contentType:'application/json',
    body:JSON.stringify({totalAccounts:0,knownAccounts:0,
      unknownAccounts:0,totalUsed:0,totalRemaining:0,rows:[]})
  }));
  await page.route('**/api/uploads/test-generated.png',route=>
    route.fulfill({status:200,contentType:'image/png',
      body:Buffer.from('generated media test bytes')}));
  await page.goto(url,{waitUntil:'domcontentloaded'});
  const hub=page.locator('.react-flow__node[data-id="hub"]');
  await hub.waitFor({state:'visible',timeout:12000});
  await hub.locator('.tn-node-frame').click();
  await page.waitForFunction(()=>document.querySelectorAll(
    '.tn-blue-flow-droplet').length>=20,null,{timeout:10000});
  const activeEdges=await page.locator('.tn-blue-flow').count();
  assert.ok(activeEdges>=5,'Test needs multiple simultaneously animated edges');
  await page.waitForFunction(()=>[...document.querySelectorAll(
    '.tn-generating-canvas')].every(el=>el.dataset.renderer),null,{timeout:8000});
  const canvasCount=await page.locator('.tn-generating-canvas').count();
  assert.ok(canvasCount>=2,'Multiple generation surfaces must render concurrently');
  assert.equal(await page.locator('.tn-generating-dot').count(),0,
    'Generating nodes must not animate hundreds of individual DOM elements');

  const trackFrames=async action=>{
    await page.evaluate(()=>{
      window.__perfFrames=[];window.__perfActive=true;
      const next=t=>{
        if(!window.__perfActive)return;
        window.__perfFrames.push(t);
        requestAnimationFrame(next);
      };
      requestAnimationFrame(next);
    });
    await action();
    const times=await page.evaluate(()=>{
      window.__perfActive=false;
      return window.__perfFrames;
    });
    const intervals=times.slice(1).map((time,i)=>time-times[i])
      .filter(value=>value>0).sort((a,b)=>a-b);
    const percentile=p=>intervals[Math.floor((intervals.length-1)*p)]||0;
    return {frames:times.length,p50:percentile(.5),p95:percentile(.95)};
  };
  const caption=hub.locator('.tn-node-caption');
  const before=await hub.boundingBox();
  const handle=await caption.boundingBox();
  assert.ok(handle&&before);
  const drag=await trackFrames(async()=>{
    await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);
    await page.mouse.down();
    await page.mouse.move(handle.x+handle.width/2+220,
      handle.y+handle.height/2+110,{steps:55});
    await page.mouse.up();
  });
  const after=await hub.boundingBox();
  assert.ok(after.x-before.x>30,'Node must move while 8 wires remain animated');
  assert.ok(drag.frames>12,'Node drag must receive regular animation frames');
  assert.ok(drag.p95<125,'Severe frame stalls under fan-out drag: '+JSON.stringify(drag));
  console.log('MULTI_EDGE_DRAG '+JSON.stringify({activeEdges,...drag}));

  const pan=await trackFrames(async()=>{
    await page.mouse.move(1880,960);
    await page.mouse.down();
    await page.mouse.move(1740,870,{steps:50});
    await page.mouse.up();
  });
  assert.ok(pan.frames>10,'Canvas pan must continue receiving frames');
  assert.ok(pan.p95<125,'Severe frame stalls while generating: '+JSON.stringify(pan));
  console.log('CANVAS_PAN '+JSON.stringify({canvasCount,...pan}));

  // Toolbar download is the final icon to the right of the delete button.
  const generated=page.locator('.react-flow__node[data-id="generated"]');
  await generated.locator('.tn-node-frame').click();
  const toolbar=page.locator('.tn-toolbar:visible');
  const downloadButton=toolbar.getByRole('link',{name:'下载生成素材'});
  await downloadButton.waitFor({state:'visible',timeout:8000});
  assert.equal(await toolbar.locator('button[title="删除节点"] + a[download]').count(),1);
  assert.equal(await downloadButton.getAttribute('download'),'generated.png');
  const downloadEvent=page.waitForEvent('download',{timeout:8000});
  await downloadButton.click();
  const result=await downloadEvent;
  assert.equal(result.suggestedFilename(),'generated.png');
  assert.deepEqual(errors,[]);
  console.log('PASS: rightmost generated-media download, multi-edge fan-out drag, canvas panning while offscreen worker generates');
}finally{await browser.close();}
