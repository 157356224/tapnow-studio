import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const base=process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5173/';
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:2060,height:1100}});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
const now=new Date().toISOString();
const project={
  id:'test-image-intrinsic-size',title:'Image intrinsic sizing regression',
  updatedAt:now,viewport:{x:45,y:125,zoom:.85},edges:[],
  nodes:[
    {id:'uploaded',type:'studio',position:{x:40,y:90},
      data:{kind:'image',title:'Manual upload',status:'idle',
        ratio:'2:3',prompt:''}},
    {id:'generated',type:'studio',position:{x:630,y:90},
      data:{kind:'image',title:'Muse result',status:'idle',
        provider:'muse',ratio:'2:3',prompt:'Wide cinema landscape'}},
    {id:'legacy',type:'studio',position:{x:1270,y:90},
      data:{kind:'image',title:'Previous image replaced',status:'done',
        ratio:'1:1',mediaWidth:1024,mediaHeight:1024,
        mediaUrl:'/api/uploads/portrait.png',prompt:''}},
    {id:'empty',type:'studio',position:{x:1680,y:90},
      data:{kind:'image',title:'Empty 9:16',status:'idle',ratio:'9:16',prompt:''}}
  ]
};
// Generate real PNG files of deliberately different intrinsic dimensions.
await page.goto('about:blank');
const samples=await page.evaluate(()=>{
  const create=(width,height,color)=>{
    const canvas=document.createElement('canvas');
    canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d');
    context.fillStyle=color;
    context.fillRect(0,0,width,height);
    return canvas.toDataURL('image/png').split(',')[1];
  };
  return {
    uploaded:create(640,480,'#4f7a9d'),
    generated:create(1200,600,'#a27f55'),
    portrait:create(800,1200,'#5e9b66')
  };
});
const pngs=Object.fromEntries(Object.entries(samples)
  .map(([key,value])=>[key,Buffer.from(value,'base64')]));
let uploadedCount=0;
let jobsSubmitted=0;
let jobsPolled=0;
await page.route('**/api/projects**',async route=>{
  const request=route.request();
  if(request.method()==='PUT'){
    const value=request.postDataJSON();
    project.nodes=value.nodes;
    project.edges=value.edges;
    project.updatedAt=new Date().toISOString();
    return route.fulfill({status:200,contentType:'application/json',
      body:JSON.stringify({id:project.id,updatedAt:project.updatedAt})});
  }
  const pathname=new URL(request.url()).pathname;
  return route.fulfill({status:200,contentType:'application/json',
    body:JSON.stringify(pathname==='/api/projects'
      ?[{id:project.id,title:project.title,updatedAt:project.updatedAt}]
      :project)});
});
await page.route('**/api/assets',async route=>{
  uploadedCount++;
  return route.fulfill({status:201,contentType:'application/json',
    body:JSON.stringify({url:uploadedCount===1
      ?'/api/uploads/uploaded.png':'/api/uploads/portrait.png',
      name:'user-upload.png'})});
});
for(const [name,key] of [
  ['uploaded','uploaded'],['result','generated'],['portrait','portrait']
]){
  await page.route('**/api/uploads/'+name+'.png',route=>route.fulfill({
    status:200,contentType:'image/png',body:pngs[key]
  }));
}
await page.route('**/api/muse/accounts',route=>route.fulfill({
  status:200,contentType:'application/json',
  body:JSON.stringify([{id:'muse-test',name:'Muse test'}])
}));
await page.route('**/api/doubao/accounts',route=>route.fulfill({
  status:200,contentType:'application/json',body:'[]'
}));
await page.route('**/api/health',route=>route.fulfill({
  status:200,contentType:'application/json',
  body:JSON.stringify({museBridgeRevision:'quota-auto-v6-image-resolution',
    museMediaRevision:'fresh-chat-media-v2'})
}));
await page.route('**/api/muse/quotas**',route=>route.fulfill({
  status:200,contentType:'application/json',
  body:JSON.stringify({totalAccounts:0,knownAccounts:0,unknownAccounts:0,
    totalCapacity:0,measuredCapacity:0,totalUsed:0,totalRemaining:0,
    rows:[],refreshedAt:Date.now(),refreshIntervalMs:60000})
}));
await page.route('**/api/muse/jobs**',route=>{
  if(route.request().method()==='POST'){
    jobsSubmitted++;
    return route.fulfill({status:202,contentType:'application/json',
      body:JSON.stringify({id:'muse-image-job',status:'queued',message:'Queued'})});
  }
  jobsPolled++;
  return route.fulfill({status:200,contentType:'application/json',
    body:JSON.stringify({id:'muse-image-job',status:'completed',
      mediaUrl:'/api/uploads/result.png'})});
});
const node=id=>page.locator('.react-flow__node[data-id="'+id+'"]');
const dimensions=async id=>node(id).locator('.tn-node-frame').evaluate(element=>{
  const box=element.getBoundingClientRect();
  const scale=element.closest('.tn-node').getBoundingClientRect().width/
    element.closest('.tn-node').offsetWidth;
  return {width:box.width/scale,height:box.height/scale};
});
const assertRatio=async (id,expected)=>{
  await page.waitForFunction(({id,ratio})=>{
    const element=document.querySelector('.react-flow__node[data-id="'+id+'"] .tn-node-frame');
    const box=element?.getBoundingClientRect();
    return !!box&&Math.abs(box.width/box.height-ratio)<.016;
  },{id,ratio:expected},{timeout:12000});
  const size=await dimensions(id);
  assert.ok(Math.abs(size.width/size.height-expected)<.02,
    id+' frame must match image aspect ratio: '+JSON.stringify(size));
  assert.ok(size.width<=545&&size.height<=535,
    'Large image must be scaled to a manageable on-canvas frame');
  return size;
};
try{
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await node('generated').waitFor({state:'visible'});
  await page.waitForTimeout(450);
  const empty=await assertRatio('empty',9/16);
  assert.ok(empty.height>400,'Empty node keeps the requested 9:16 frame');

  // Existing projects may have old square dimensions saved even though their
  // actual image was replaced; onLoad must repair the metadata and the frame.
  await assertRatio('legacy',2/3);
  assert.equal(project.nodes.find(x=>x.id==='legacy').data.ratio,'1:1',
    'Sizing from actual media must not change the next-generation ratio');

  // Manually imported 640x480 image should change a default 2:3 card to 4:3.
  await node('uploaded').locator('input[type=file]').setInputFiles({
    name:'uploaded.png',mimeType:'image/png',buffer:pngs.uploaded
  });
  await assertRatio('uploaded',4/3);
  assert.equal(uploadedCount,1);

  // Actual Muse job callback returns 1200x600 despite 2:3 generation setting.
  await node('generated').locator('.tn-node-frame').click();
  await page.locator('.floating-compose').getByTitle('使用 Muse 生成图片')
    .click();
  await node('generated').locator('img.tn-media').waitFor({
    state:'attached',timeout:15000
  });
  await assertRatio('generated',2);
  assert.equal(jobsSubmitted,1);
  assert.ok(jobsPolled>=1);

  // Replacing an already-generated image with a portrait upload must also
  // resize the same node instead of keeping the old dimensions.
  await node('generated').locator('input[type=file]').setInputFiles({
    name:'portrait.png',mimeType:'image/png',buffer:pngs.portrait
  });
  await assertRatio('generated',2/3);
  assert.equal(uploadedCount,2);

  await page.waitForTimeout(1500);
  const data=id=>project.nodes.find(node=>node.id===id).data;
  assert.equal(data('uploaded').mediaWidth,640);
  assert.equal(data('uploaded').mediaHeight,480);
  assert.equal(data('legacy').mediaWidth,800);
  assert.equal(data('legacy').mediaHeight,1200);
  assert.equal(data('generated').mediaWidth,800);
  assert.equal(data('generated').mediaHeight,1200);
  assert.equal(data('generated').ratio,'2:3',
    'Intrinsic preview dimensions must not modify generation preferences');

  await page.reload({waitUntil:'domcontentloaded'});
  for(const [id,ratio] of [['uploaded',4/3],['generated',2/3],
    ['legacy',2/3],['empty',9/16]])await assertRatio(id,ratio);
  assert.deepEqual(errors,[],'No browser runtime errors during resize');
  console.log('PASS: manual upload 4:3, returned Muse 2:1, replacement 2:3, stale metadata repaired, empty ratio preserved and dimensions persisted across reload');
}finally{
  await browser.close();
}
