import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const base=process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5173/';
const textNode=(id,x,y)=>({
  id,type:'studio',position:{x,y},
  data:{kind:'text',title:'Text '+id,status:'idle',text:'Node '+id}
});
const project={
  id:'test-scissors',title:'Edge scissors integration',
  updatedAt:new Date().toISOString(),
  viewport:{x:100,y:45,zoom:.82},
  nodes:[
    textNode('a',90,90),textNode('b',790,90),
    textNode('c',90,490),textNode('d',790,490)
  ],
  edges:[
    {id:'edge-upper',source:'a',target:'b',sourceHandle:'out',targetHandle:'in'},
    {id:'edge-lower',source:'c',target:'d',sourceHandle:'out',targetHandle:'in'}
  ]
};

const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1620,height:960}});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
try{
  await page.route('**/api/projects**',async route=>{
    const request=route.request();
    const pathname=new URL(request.url()).pathname;
    if(request.method()==='PUT'){
      const body=request.postDataJSON();
      project.edges=body.edges;
      project.nodes=body.nodes;
      await route.fulfill({status:200,contentType:'application/json',
        body:JSON.stringify({id:project.id,updatedAt:new Date().toISOString()})});
    }else{
      await route.fulfill({status:200,contentType:'application/json',
        body:JSON.stringify(pathname==='/api/projects'
          ?[{id:project.id,title:project.title,updatedAt:project.updatedAt}]
          :project)});
    }
  });
  await page.route('**/api/doubao/accounts',route=>route.fulfill({
    status:200,contentType:'application/json',body:'[]'
  }));
  await page.route('**/api/muse/accounts',route=>route.fulfill({
    status:200,contentType:'application/json',body:'[]'
  }));
  await page.route('**/api/muse/quotas**',route=>route.fulfill({
    status:200,contentType:'application/json',
    body:JSON.stringify({totalAccounts:0,knownAccounts:0,unknownAccounts:0,
      totalCapacity:0,measuredCapacity:0,totalUsed:0,totalRemaining:0,
      rows:[],refreshedAt:Date.now(),refreshIntervalMs:60000})
  }));
  await page.goto(base,{waitUntil:'domcontentloaded'});
  const getEdge=id=>page.locator(`.react-flow__edge[data-id="${id}"]`);
  await getEdge('edge-upper').waitFor({state:'attached',timeout:15000});
  await getEdge('edge-lower').waitFor({state:'attached'});
  await page.waitForTimeout(650); // Restored canvas viewport animation settles.

  const midpoint=async id=>getEdge(id).locator('.react-flow__edge-interaction')
    .evaluate(path=>{
      const p=path.getPointAtLength(path.getTotalLength()/2);
      const ctm=path.getScreenCTM();
      if(!ctm)throw new Error('Edge screen transform not available');
      const screen=p.matrixTransform(ctm);
      return {x:screen.x,y:screen.y};
    });
  const upper=await midpoint('edge-upper');
  const lower=await midpoint('edge-lower');
  await page.mouse.move(upper.x,upper.y);
  assert.equal(await page.evaluate(({x,y})=>
    document.elementFromPoint(x,y)?.closest('.react-flow__edge')?.getAttribute('data-id'),
    upper),'edge-upper','Pointer must hit the upper wire');

  // Key is ignored in text inputs and Ctrl+C still uses its normal shortcut.
  const title=page.getByRole('textbox',{name:'画布名称'});
  await title.focus();
  await page.keyboard.down('c');
  assert.equal(await page.locator('.tn-cut-mode').count(),0,
    'Typing C inside an input must never turn on scissors');
  await page.keyboard.up('c');
  await title.blur();
  await page.keyboard.down('Control');
  await page.keyboard.down('c');
  assert.equal(await page.locator('.tn-cut-mode').count(),0,
    'Ctrl+C must not activate edge cutting');
  await page.keyboard.up('c');
  await page.keyboard.up('Control');

  await page.mouse.move(upper.x,upper.y);
  await page.keyboard.down('c');
  await page.locator('.tn-edge-cut-cursor').waitFor({state:'visible',timeout:3000});
  assert.equal(await page.locator('.tn-cut-mode').count(),1);
  assert.equal(await page.locator('.tn-edge-cut-cursor').getAttribute('aria-label'),
    '剪断连接线');
  const scissorsBox=await page.locator('.tn-edge-cut-cursor').boundingBox();
  assert.ok(scissorsBox);
  assert.ok(Math.abs(scissorsBox.x+scissorsBox.width/2-upper.x)<4 &&
    Math.abs(scissorsBox.y+scissorsBox.height/2-upper.y)<4,
    'Scissors must follow the pointer on the wire');
  await page.mouse.click(upper.x,upper.y,{button:'left'});
  await getEdge('edge-upper').waitFor({state:'detached',timeout:4000});
  assert.equal(await getEdge('edge-lower').count(),1,
    'Only the clicked connection is removed');
  assert.equal(await page.locator('.tn-edge-cut-cursor').count(),0,
    'Scissors disappear when there is no edge under the pointer');
  await page.keyboard.up('c');
  assert.equal(await page.locator('.tn-cut-mode').count(),0,
    'Releasing C immediately restores the normal canvas');

  // Cutting must create an undo snapshot, rather than permanently destroying
  // the relation between the two nodes.
  await page.keyboard.press('Control+z');
  await getEdge('edge-upper').waitFor({state:'attached',timeout:4000});
  assert.equal(await getEdge('edge-lower').count(),1);

  // Without C, clicking the wire only selects it and does not cut it.
  await page.mouse.click(lower.x,lower.y,{button:'left'});
  assert.equal(await getEdge('edge-lower').count(),1);
  assert.equal(await page.locator('.tn-edge-cut-cursor').count(),0);

  // Move C+scissors between two separate wires without a re-key.
  await page.keyboard.down('c');
  await page.mouse.move(lower.x,lower.y);
  await page.locator('.tn-edge-cut-cursor').waitFor({state:'visible'});
  await page.mouse.move(upper.x,upper.y);
  assert.equal(await page.locator('.tn-edge-cut-cursor').count(),1);
  await page.keyboard.up('c');
  assert.equal(await page.locator('.tn-edge-cut-cursor').count(),0);

  // Selected nodes show animated blueflow edges instead of default Bezier
  // edges; scissors must be able to hit and cut those as well.
  await page.locator('.react-flow__node[data-id="a"] .tn-node-caption').click();
  await getEdge('edge-upper').locator('.tn-blue-flow').waitFor({state:'attached'});
  const glowingSpot=await midpoint('edge-upper');
  await page.mouse.move(glowingSpot.x,glowingSpot.y);
  await page.keyboard.down('c');
  await page.locator('.tn-edge-cut-cursor').waitFor({state:'visible'});
  await page.mouse.click(glowingSpot.x,glowingSpot.y);
  await getEdge('edge-upper').waitFor({state:'detached',timeout:4000});
  await page.keyboard.up('c');
  assert.equal(await getEdge('edge-lower').count(),1,
    'Cutting animated blueflow must leave unrelated connections intact');
  await page.keyboard.press('Control+z');
  await getEdge('edge-upper').waitFor({state:'attached',timeout:4000});
  assert.deepEqual(errors,[],'No JavaScript runtime errors');
  console.log('PASS: C+hover scissors cuts default and animated blueflow edges, restores by undo, keyup exits, normal clicks/Ctrl+C/typing safe');
}finally{
  await browser.close();
}
