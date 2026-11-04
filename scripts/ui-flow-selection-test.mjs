import assert from 'node:assert/strict';
import {chromium} from 'playwright';

// Independent of drag geometry: verify that marquee/Shift multi-selection
// unmounts droplet animators while keeping the ordinary wire visible.
const url=process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5173/';
const now=new Date().toISOString();
const project={
  id:'test-flow-selection',title:'Flow selection animation regression',
  updatedAt:now,viewport:{x:90,y:75,zoom:1},
  nodes:[
    {id:'flow-one',type:'studio',position:{x:130,y:130},
      data:{kind:'text',title:'First',text:'Source',status:'idle'}},
    {id:'flow-two',type:'studio',position:{x:660,y:180},
      data:{kind:'text',title:'Second',text:'Target',status:'idle'}}
  ],
  edges:[{id:'flow-link',source:'flow-one',target:'flow-two',
    sourceHandle:'out',targetHandle:'in'}]
};
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage({
    viewport:{width:1580,height:940},reducedMotion:'no-preference'
  });
  page.setDefaultTimeout(8500);
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const respond=(route,body)=>route.fulfill({
    status:200,contentType:'application/json',body:JSON.stringify(body)
  });
  await page.route('**/api/**',route=>{
    const request=route.request();
    const pathname=new URL(request.url()).pathname;
    if(pathname==='/api/projects')
      return respond(route,[{id:project.id,title:project.title,updatedAt:now}]);
    if(pathname==='/api/projects/'+project.id)
      return respond(route,request.method()==='PUT'
        ?{id:project.id,updatedAt:now}:project);
    if(pathname==='/api/muse/quotas')
      return respond(route,{totalAccounts:0,knownAccounts:0,unknownAccounts:0,
        totalUsed:0,totalRemaining:0,rows:[],refreshing:false});
    return respond(route,[]);
  });
  await page.goto(url,{waitUntil:'domcontentloaded'});
  const first=page.locator('.react-flow__node[data-id="flow-one"]');
  const second=page.locator('.react-flow__node[data-id="flow-two"]');
  await second.waitFor({state:'visible',timeout:12000});
  await page.waitForTimeout(350);
  await first.locator('.tn-node-caption').click();
  await page.waitForFunction(()=>
    document.querySelectorAll('.tn-blue-flow-droplet').length===5);
  assert.equal(await page.locator('.react-flow__node.selected').count(),1);

  await second.locator('.tn-node-caption').click({modifiers:['Shift']});
  await page.waitForFunction(()=>
    document.querySelectorAll('.react-flow__node.selected').length===2);
  await page.waitForFunction(()=>
    document.querySelectorAll('.tn-blue-flow-droplet').length===0);
  assert.equal(await page.locator('.tn-blue-flow').count(),0,
    'Two selected nodes must not have any active flow animation');
  assert.equal(await page.locator('.react-flow__edge-path').count(),1,
    'Multi-select keeps the underlying static connection line');

  await second.locator('.tn-node-caption').click({modifiers:['Shift']});
  await page.waitForFunction(()=>
    document.querySelectorAll('.react-flow__node.selected').length===1);
  await page.waitForFunction(()=>
    document.querySelectorAll('.tn-blue-flow-droplet').length===5);

  // During a marquee gesture, a single node can be selected temporarily
  // before the rectangle reaches the second one. Do not start the animator
  // for that intermediate one-node selection.
  const firstBox=await first.boundingBox();
  const secondBox=await second.boundingBox();
  assert.ok(firstBox&&secondBox);
  const start={x:firstBox.x-30,y:firstBox.y-30};
  const oneNodeEnd={
    x:firstBox.x+firstBox.width+28,
    y:firstBox.y+firstBox.height+28
  };
  const bothEnd={
    x:secondBox.x+secondBox.width+28,
    y:Math.max(oneNodeEnd.y,secondBox.y+secondBox.height+28)
  };
  await page.mouse.move(start.x,start.y);
  await page.mouse.down();
  await page.mouse.move(oneNodeEnd.x,oneNodeEnd.y,{steps:10});
  assert.equal(await page.locator('.tn-blue-flow').count(),0,
    'No droplet animation while drawing a selection rectangle over one node');
  await page.mouse.move(bothEnd.x,bothEnd.y,{steps:10});
  assert.equal(await page.locator('.tn-blue-flow').count(),0,
    'No droplet animation while the marquee expands to several nodes');
  await page.mouse.up();
  await page.waitForFunction(()=>
    document.querySelectorAll('.react-flow__node.selected').length===2);
  assert.equal(await page.locator('.tn-blue-flow').count(),0,
    'Completed two-node marquee must remain static');

  // The selection bounding rectangle intercepts clicks on its constituent
  // nodes; click empty canvas first to clear the marquee.
  const pane=await page.locator('.react-flow__pane').boundingBox();
  assert.ok(pane);
  await page.mouse.click(pane.x+pane.width-70,pane.y+pane.height-70);
  await page.waitForFunction(()=>
    document.querySelectorAll('.react-flow__node.selected').length===0);
  await first.locator('.tn-node-caption').click();
  await page.waitForFunction(()=>
    document.querySelectorAll('.react-flow__node.selected').length===1);
  await page.waitForFunction(()=>
    document.querySelectorAll('.tn-blue-flow-droplet').length===5);
  assert.deepEqual(errors,[]);
  console.log('PASS: single selection animates; Shift and marquee selection stop droplet rendering (including during marquee); static wires remain; single selection resumes');
}finally{
  await browser.close();
}
