import assert from 'node:assert/strict';
import {chromium} from 'playwright';

// Mock the API without touching real projects or creating a real AI job.
const url=process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5173/';
const now=new Date().toISOString();
const videoUrl='/api/uploads/local-completed.mp4';
const outputUrl='/api/uploads/extracted-tail.png';
const project={
  id:'last-frame-ui-regression',title:'Last frame button test',updatedAt:now,
  viewport:{x:120,y:110,zoom:.9},
  nodes:[
    {id:'video-source',type:'studio',position:{x:110,y:80},data:{
      kind:'video',title:'我的视频',prompt:'',mediaUrl:videoUrl,
      status:'done',provider:'doubao',ratio:'16:9'
    }},
    {id:'empty-video',type:'studio',position:{x:160,y:650},data:{
      kind:'video',title:'未生成视频',prompt:'',status:'idle',ratio:'16:9'
    }}
  ],
  edges:[]
};
let requests=0;
const persisted=[];
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1840,height:1080}});
page.setDefaultTimeout(10000);
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
const send=(route,data,status=200)=>route.fulfill({
  status,contentType:'application/json',body:JSON.stringify(data)
});
try{
  await page.route('**/api/**',async route=>{
    const req=route.request(),pathname=new URL(req.url()).pathname;
    if(pathname==='/api/projects')
      return send(route,[{id:project.id,title:project.title,updatedAt:now}]);
    if(pathname==='/api/projects/'+project.id){
      if(req.method()==='PUT'){
        const body=req.postDataJSON();
        project.nodes=body.nodes;project.edges=body.edges;
        persisted.push(structuredClone(body));
        return send(route,{id:project.id,updatedAt:now});
      }
      return send(route,project);
    }
    if(pathname==='/api/videos/extract-last-frame'){
      requests++;
      assert.equal(req.method(),'POST');
      assert.deepEqual(req.postDataJSON(),{mediaUrl:videoUrl});
      await new Promise(resolve=>setTimeout(resolve,450));
      return send(route,{
        url:outputUrl,name:'local-completed-尾帧.png',width:96,height:54
      },201);
    }
    if(pathname==='/api/muse/quotas')
      return send(route,{totalAccounts:0,knownAccounts:0,unknownAccounts:0,
        totalCapacity:0,totalUsed:0,totalRemaining:0,rows:[],refreshing:false});
    if(pathname==='/api/uploads/extracted-tail.png')
      return route.fulfill({status:404,body:'image not required for this test'});
    if(pathname==='/api/uploads/local-completed.mp4')
      return route.fulfill({status:200,contentType:'video/mp4',body:''});
    return send(route,[]);
  });
  await page.goto(url,{waitUntil:'domcontentloaded'});
  const source=page.locator('.react-flow__node[data-id="video-source"]');
  const empty=page.locator('.react-flow__node[data-id="empty-video"]');
  await empty.waitFor({state:'visible',timeout:15000});
  await page.waitForTimeout(450);

  await empty.locator('.tn-node-caption').click();
  assert.equal(await empty.getByRole('button',{name:'一键提取视频尾帧到画布'}).count(),0,
    'Cannot extract from an empty video node');

  await source.locator('.tn-node-caption').click();
  const extract=page.getByRole('button',{name:'一键提取视频尾帧到画布'});
  await extract.waitFor({state:'visible'});
  await extract.click();
  assert.equal(await extract.isDisabled(),true,
    'Extract button must disable during FFmpeg processing');
  await page.waitForFunction(()=>
    document.querySelectorAll('.react-flow__node').length===3,null,{timeout:6500});
  assert.equal(requests,1,'One click makes one extraction request');
  const sourceNode=project.nodes.find(node=>node.id==='video-source');
  assert.equal(sourceNode?.data.mediaUrl,videoUrl,'Video media must remain unchanged');

  // Auto-save runs after its debounce, independently of the extraction request.
  await page.waitForFunction(()=>document.querySelectorAll(
    '.react-flow__node[data-id]').length===3);
  await page.waitForTimeout(1550);
  const stored=project.nodes.find(node=>node.data.mediaUrl===outputUrl);
  assert.ok(stored,'Extracted tail must be persisted to the canvas');
  assert.equal(stored.data.kind,'image');
  assert.equal(stored.data.status,'done');
  assert.equal(stored.data.demo,false);
  assert.equal(stored.data.mediaWidth,96);
  assert.equal(stored.data.mediaHeight,54);
  assert.match(stored.data.title,/尾帧/);
  assert.ok(stored.position.x>sourceNode.position.x+500,
    'Extracted image node must appear to the right of the source video');
  assert.ok(project.edges.some(edge=>edge.source==='video-source'&&
    edge.target===stored.id&&edge.sourceHandle==='out'&&edge.targetHandle==='in'),
    'Source video and new image must be connected');
  assert.equal(await page.locator('.react-flow__node[data-id="'+stored.id+'"] img')
    .getAttribute('src'),outputUrl);
  assert.ok(persisted.length>0,'Canvas changes must autosave');
  assert.deepEqual(errors,[],'No browser exceptions during frame extraction');
  console.log('PASS: video-node extraction button creates/persists a linked image node, preserves the original video, and hides on empty nodes');
}finally{
  await browser.close();
}
