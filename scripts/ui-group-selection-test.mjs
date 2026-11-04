import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const project={
  id:'group-controls-regression',title:'Group control regression',
  updatedAt:new Date().toISOString(),
  viewport:{x:150,y:90,zoom:1},
  nodes:[
    {id:'a',type:'studio',position:{x:90,y:95},
      data:{kind:'image',title:'Source A',status:'idle',prompt:''}},
    {id:'b',type:'studio',position:{x:440,y:310},
      data:{kind:'image',title:'Source B',status:'idle',prompt:''}},
    {id:'v',type:'studio',position:{x:960,y:175},
      data:{kind:'video',title:'Target Video',status:'idle',prompt:''}}
  ],
  edges:[]
};
const saved=[];
const address=process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5173/';
let browser;
try{
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1910,height:1050}});
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(12000);
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{
    if(message.type()==='error')console.log('Browser console:',message.text().slice(0,200));
  });
  await page.route('**/api/**',async route=>{
    const request=route.request(),pathname=new URL(request.url()).pathname;
    const json=data=>route.fulfill({
      status:200,contentType:'application/json',body:JSON.stringify(data)
    });
    if(pathname==='/api/projects')
      return json([{id:project.id,title:project.title,updatedAt:project.updatedAt}]);
    if(pathname==='/api/projects/'+project.id){
      if(request.method()==='PUT'){
        const payload=request.postDataJSON();
        project.nodes=payload.nodes;project.edges=payload.edges;
        saved.push(structuredClone(payload));
        return json({id:project.id,updatedAt:new Date().toISOString()});
      }
      return json(project);
    }
    if(pathname==='/api/doubao/accounts'||pathname==='/api/muse/accounts')
      return json([]);
    if(pathname==='/api/muse/quotas')return json({
      totalAccounts:0,knownAccounts:0,unknownAccounts:0,
      totalCapacity:0,measuredCapacity:0,totalUsed:0,totalRemaining:0,rows:[]
    });
    if(pathname==='/api/health')return json({});
    return json([]);
  });
  console.log('UI group: open '+address);
  await page.goto(address,{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(1200);
  console.log('UI group: DOM status',await page.locator('.app-shell').count(),
    'nodes',await page.locator('.react-flow__node').count(),
    'errors',errors.slice(0,3));
  const a=page.locator('.react-flow__node[data-id="a"]');
  const b=page.locator('.react-flow__node[data-id="b"]');
  const target=page.locator('.react-flow__node[data-id="v"]');
  await target.waitFor({state:'visible',timeout:18000});
  console.log('UI group: target appeared');
  await page.waitForTimeout(520);
  // Dragging a single node near another node must show Photoshop-style
  // alignment guides and snap its position before mouseup.
  const originA=await a.boundingBox(),originB=await b.boundingBox();
  const captionB=await b.locator('.tn-node-caption').boundingBox();
  assert.ok(originA&&originB&&captionB);
  const grab={x:captionB.x+captionB.width/2,y:captionB.y+captionB.height/2};
  const delta={x:originA.x-originB.x+4,y:originA.y-originB.y+4};
  await page.mouse.move(grab.x,grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x+delta.x,grab.y+delta.y,{steps:22});
  // React Flow's pointer-down drag threshold can add a small initial offset.
  // Calibrate against actual rendered positions before asserting the snap.
  const near=await b.boundingBox();
  assert.ok(near);
  await page.mouse.move(
    grab.x+delta.x+originA.x-near.x+3,
    grab.y+delta.y+originA.y-near.y+3,{steps:6});
  await page.waitForTimeout(110);
  console.log('UI smart-guide drag geometry',JSON.stringify({
    a:originA,b:originB,moved:await b.boundingBox(),
    dragging:await b.getAttribute('class'),
    guides:await page.locator('.tn-smart-guide').count()
  }));
  assert.ok(await page.locator('[data-testid="smart-guide-vertical"]').count()>0,
    'Moving node near other node left edge must show vertical smart guide');
  assert.ok(await page.locator('[data-testid="smart-guide-horizontal"]').count()>0,
    'Moving node near other node top edge must show horizontal smart guide');
  const snappedB=await b.boundingBox();
  assert.ok(snappedB&&Math.abs(snappedB.x-originA.x)<3&&
    Math.abs(snappedB.y-originA.y)<3,
  'Dragging near edge must magnetically snap the node to the reference bounds');
  await page.mouse.up();
  await page.waitForTimeout(120);
  assert.equal(await page.locator('.tn-smart-guide').count(),0,
    'Guides must disappear immediately after releasing the drag');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(160);
  const undoB=await b.boundingBox();
  assert.ok(undoB&&Math.abs(undoB.x-originB.x)<4,
    'Ctrl+Z restores the original position after magnetic drag');
  const select=async()=>{
    await a.locator('.tn-node-caption').click();
    await b.locator('.tn-node-caption').click({modifiers:['Shift']});
    await page.locator('.tn-group-port').waitFor({
      state:'visible',timeout:3000
    });
    assert.equal(await page.locator('.react-flow__node.selected').count(),2);
  };
  await select();
  console.log('UI group: selected two nodes');
  const plus=page.getByRole('button',{name:'连接所选节点'});
  assert.equal(await page.locator('.tn-selection-align-toolbar').count(),0,
    'Multi-node alignment toolbar must not exist in selection mode');
  await plus.waitFor({state:'visible'});
  const individualPortState=await page.locator('.react-flow__node .tn-port')
    .evaluateAll(elements=>elements.map(el=>({
      visibility:getComputedStyle(el).visibility,
      events:getComputedStyle(el).pointerEvents
    })));
  assert.ok(individualPortState.length>=6&&individualPortState.every(p=>
    p.visibility==='hidden'&&p.events==='none'),
  'During multi-selection, all individual left/right + controls must be hidden');
  // Selection plus is placed beyond the right edge of the combined bounding
  // rectangle rather than on the last selected node.
  const group=await page.locator('[data-testid="node-selection-group"]').boundingBox();
  const port=await plus.boundingBox();
  assert.ok(group&&port&&port.x>group.x+group.width,
    'Group + should appear to the right of the selected nodes');
  await page.getByTitle('缩小').click();
  await page.waitForTimeout(330);
  const zoomedPort=await plus.boundingBox();
  assert.ok(zoomedPort&&Math.abs(zoomedPort.width-34)<3,
    'Group + must stay approximately 34 screen pixels across canvas zoom levels');
  // Drag right group + into the middle of the video card. All selected
  // sources must connect, including a drop that misses the tiny target handle.
  const plusBox=await plus.boundingBox(),videoBox=await target.locator('.tn-node-frame').boundingBox();
  assert.ok(plusBox&&videoBox);
  const start={x:plusBox.x+plusBox.width/2,y:plusBox.y+plusBox.height/2};
  const finish={x:videoBox.x+videoBox.width*.48,y:videoBox.y+videoBox.height*.6};
  await page.mouse.move(start.x,start.y);
  await page.mouse.down();
  await page.mouse.move(finish.x,finish.y,{steps:18});
  await page.mouse.up();
  console.log('UI group: dropped group port on target');
  await page.waitForFunction(()=>document.querySelectorAll('.react-flow__edge').length===2,
    null,{timeout:4500});
  await page.waitForTimeout(1200);
  assert.deepEqual(project.edges.map(edge=>edge.source).sort(),['a','b'],
    'Fan-out drag must persist both connections');
  assert.ok(project.edges.every(edge=>edge.target==='v'&&
    edge.sourceHandle==='out'&&edge.targetHandle==='in'),
    'New edges must use the regular node connection handles');
  // Repeating the same fan-out cannot duplicate the connections.
  if(await plus.isVisible().catch(()=>false)){
    const again=await plus.boundingBox();
    if(again){
      await page.mouse.move(again.x+again.width/2,again.y+again.height/2);
      await page.mouse.down();
      await page.mouse.move(finish.x,finish.y,{steps:10});
      await page.mouse.up();
    }
  }
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.react-flow__edge').count(),2,
    'Duplicate group connections must be rejected');
  // Clicking the group + (without moving) uses the same add-node picker as
  // the regular source port; the new node receives ALL selected sources.
  if(!await plus.isVisible().catch(()=>false))await select();
  await plus.click();
  await page.locator('.add-popover').waitFor({state:'visible'});
  await page.locator('.add-popover .popover-tools button')
    .filter({hasText:'文本'}).first().click();
  await page.waitForFunction(()=>document.querySelectorAll('.react-flow__edge').length===4,
    null,{timeout:4000});
  await page.waitForTimeout(1150);
  const textNodes=project.nodes.filter(node=>node.data.kind==='text');
  assert.equal(textNodes.length,1,'Group + must add one, not multiple, new nodes');
  assert.equal(project.edges.filter(edge=>edge.target===textNodes[0].id).length,2,
    'Both selected sources should connect to the newly created node');
  assert.deepEqual(errors,[],errors.join(' | '));
  assert.ok(saved.length>0,'Group changes must persist to project storage');
  console.log('PASS: drag smart guides and snapping/undo, no selection toolbar or individual +, group-only + fan-out and persistence');
}finally{
  await browser?.close();
}
