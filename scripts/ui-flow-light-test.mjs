import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';

const url=process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5173/';
const project={
  id:'test-flow-droplet',title:'TEST blue-flow droplet',
  updatedAt:new Date().toISOString(),
  nodes:[
    {id:'flow-source',type:'studio',position:{x:180,y:100},
      data:{kind:'text',title:'Source',status:'idle',text:'Light source'}},
    {id:'flow-target',type:'studio',position:{x:1390,y:530},
      data:{kind:'image',title:'Target',ratio:'1:1',status:'idle',prompt:''}}
  ],
  edges:[{id:'flow-edge',source:'flow-source',target:'flow-target',
    sourceHandle:'out',targetHandle:'in'}],
  viewport:{x:70,y:50,zoom:.85}
};

const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({
  viewport:{width:1900,height:1020},reducedMotion:'no-preference'
});
const pageErrors=[];
page.on('pageerror',error=>pageErrors.push(error.message));
try{
  await page.route('**/api/projects**',async route=>{
    const request=route.request();
    if(request.method()==='PUT'){
      await route.fulfill({status:200,contentType:'application/json',
        body:JSON.stringify({id:project.id,updatedAt:new Date().toISOString()})});
    }else{
      const pathname=new URL(request.url()).pathname;
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
  await page.goto(url,{waitUntil:'domcontentloaded'});
  const source=page.locator('.react-flow__node[data-id="flow-source"]');
  await source.waitFor({state:'visible',timeout:15000});
  await source.locator('.tn-node-frame').click();
  const flow=page.locator('.react-flow__edge').filter({
    has:page.locator('.tn-blue-flow-droplet')
  });
  await flow.waitFor({state:'visible',timeout:8000});
  const droplets=flow.locator('.tn-blue-flow-droplet');
  assert.equal(await droplets.count(),5,'Restore five separate moving lights on each edge');
  await page.waitForFunction(()=>
    [...document.querySelectorAll('.tn-blue-flow-droplet')].every(el=>
      !!el.querySelector('.tn-blue-flow-body')?.getAttribute('d')),
    null,{timeout:7000});
  const longLine=await flow.locator('.tn-blue-flow').evaluate(el=>({
    count:Number(el.getAttribute('data-active-lights')),
    tail:Number(el.getAttribute('data-effective-tail')),
    length:el.querySelector('.tn-blue-flow-track').getTotalLength()
  }));
  assert.ok(longLine.length>950,'Test fixture needs a long curve with room for five droplets');
  assert.equal(longLine.count,5,'Long connections retain five flowing lights');
  assert.equal(await flow.locator('.tn-blue-flow linearGradient').count(),5,
    'Every curved ribbon needs a gradient aligned to its own moving head and tail');
  const stops=await flow.locator('.tn-blue-flow linearGradient').first().locator('stop')
    .evaluateAll(elements=>elements.map(el=>Number.parseFloat(el.getAttribute('stop-opacity'))));
  assert.deepEqual(stops,[0,.08,.3,.67,.96,1],
    'Each droplet must fade smoothly from a transparent tail to an opaque head');
  const values=await droplets.evaluateAll(elements=>elements.map(el=>{
    const shapes=[...el.querySelectorAll('path')];
    return {
      head:Number(el.getAttribute('data-head-distance')),
      tail:Number(el.getAttribute('data-tail-distance')),
      shapes:shapes.length,
      geometry:shapes.map(x=>x.getAttribute('d')),
      fills:shapes.map(x=>getComputedStyle(x).fill),
      dash:shapes.map(x=>getComputedStyle(x).strokeDasharray)
    };
  }));
  for(const item of values){
    assert.equal(item.shapes,2,'One solid shape and its blurred duplicate glow');
    assert.equal(item.geometry[0],item.geometry[1],
      'Glow must use the same silhouette, with no visible segmented joints');
    assert.match(item.geometry[0],/^M [\d.-]+ [\d.-]+ Q /,
      'Each droplet must have a continuous smoothed ribbon following the curve');
    assert.match(item.fills[1],/url\(/,'Each light must use the continuous gradient');
    assert.ok(item.head>0&&item.head>=item.tail,'Five phase-shifted droplets must be positioned');
    assert.ok(item.head-item.tail<=166,'Droplet tail length must remain around 165px');
  }
  const positions=new Set(values.map(v=>Math.round(v.head/15)));
  assert.ok(positions.size>=4,'Most of the five lights must be simultaneously spread across the wire');
  const minGap=longLine.length/longLine.count;
  assert.ok(longLine.tail<minGap*.75,
    'Even on long lines the luminous tails must leave a visible gap');
  const alignment=await flow.evaluate(el=>{
    const track=el.querySelector('.tn-blue-flow-track');
    const length=track.getTotalLength();
    const values=[...el.querySelectorAll('.tn-blue-flow-droplet')].map((droplet,index)=>{
      const head=Number(droplet.getAttribute('data-head-distance'));
      const tail=Number(droplet.getAttribute('data-tail-distance'));
      const gradient=el.querySelectorAll('linearGradient')[index];
      const tailPoint=track.getPointAtLength(tail);
      const headPoint=track.getPointAtLength(head);
      const gradTail={x:Number(gradient.getAttribute('x1')),y:Number(gradient.getAttribute('y1'))};
      const gradHead={x:Number(gradient.getAttribute('x2')),y:Number(gradient.getAttribute('y2'))};
      const d=droplet.querySelector('.tn-blue-flow-body').getAttribute('d');
      const first=d.match(/^M ([-\d.]+) ([-\d.]+)/);
      const start={x:Number(first?.[1]),y:Number(first?.[2])};
      const midPoint=track.getPointAtLength((head+tail)/2);
      const vx=headPoint.x-tailPoint.x,vy=headPoint.y-tailPoint.y;
      const distanceFromChord=Math.abs(vx*(tailPoint.y-midPoint.y)-
        vy*(tailPoint.x-midPoint.x))/(Math.hypot(vx,vy)||1);
      return {
        tailError:Math.hypot(gradTail.x-tailPoint.x,gradTail.y-tailPoint.y),
        headError:Math.hypot(gradHead.x-headPoint.x,gradHead.y-headPoint.y),
        ribbonStartError:Math.hypot(start.x-tailPoint.x,start.y-tailPoint.y),
        bend:distanceFromChord
      };
    });
    return {length,values};
  });
  for(const item of alignment.values){
    assert.ok(item.headError<2&&item.tailError<2,
      'Gradient endpoints must be anchored to the actual curved wire');
    assert.ok(item.ribbonStartError<4,
      'The long tail must begin ON the curved wire, not on a tangent line');
  }
  assert.ok(alignment.values.some(v=>v.bend>2),
    'Test fixture must exercise a visibly curved portion of the wire');
  const mist=await flow.locator('.tn-blue-flow-aura').first()
    .evaluate(el=>({filter:getComputedStyle(el).filter,
      opacity:Number.parseFloat(getComputedStyle(el).opacity)}));
  assert.match(mist.filter,/blur\(7px\)/,
    'The longer light must have subtle mist-like diffusion');
  assert.ok(mist.opacity>0&&mist.opacity<.5,
    'Mist glow should remain soft rather than becoming a solid blur');
  const before=values[0].head;
  await page.waitForTimeout(180);
  const after=await droplets.first().evaluate(el=>Number(el.dataset.headDistance));
  assert.ok(typeof after==='number'&&Math.abs(after-before)>3,
    'A droplet must move visibly, not just exist in DOM');
  if(process.env.TAPNOW_FLOW_SCREENSHOT){
    const target=path.resolve(process.env.TAPNOW_FLOW_SCREENSHOT);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    await page.screenshot({path:target,animations:'allow'});
    console.log('FLOW_VISUAL_CHECK='+target);
  }

  // An actual React Flow node drag used to reset the animation on every
  // position update. Assert the animation phase keeps advancing WHILE mouse
  // is held and the path is continuously being reshaped.
  const targetNode=page.locator('.react-flow__node[data-id="flow-target"]');
  const caption=targetNode.locator('.tn-node-caption');
  const initialBox=await targetNode.boundingBox();
  const captionBox=await caption.boundingBox();
  assert.ok(initialBox&&captionBox);
  const sx=captionBox.x+Math.min(captionBox.width/2,60);
  const sy=captionBox.y+captionBox.height/2;
  await page.mouse.move(sx,sy);
  await page.mouse.down();
  const progress=[];
  for(let j=1;j<=12;j++){
    await page.mouse.move(sx-800*j/12,sy-240*j/12,{steps:2});
    await page.waitForTimeout(65);
    const state=await flow.locator('.tn-blue-flow').evaluate(el=>({
      count:Number(el.dataset.activeLights),
      tail:Number(el.dataset.effectiveTail),
      length:el.querySelector('.tn-blue-flow-track').getTotalLength(),
      phase:Number(el.querySelector('.tn-blue-flow-droplet')?.getAttribute('data-phase')),
      visible:[...el.querySelectorAll('.tn-blue-flow-droplet')]
        .filter(shape=>shape.getAttribute('visibility')!=='hidden')
        .map(shape=>({
          head:Number(shape.dataset.headDistance),
          tail:Number(shape.dataset.tailDistance)
        }))
    }));
    progress.push(state);
  }
  const heldBox=await targetNode.boundingBox();
  assert.ok(heldBox&&heldBox.x<initialBox.x-300,
    'React Flow node must actually move while the mouse button is held');
  assert.ok(progress.at(-1).length<progress[0].length-200,
    'Dragging must continuously reshape the wire, not freeze its old geometry');
  for(let j=1;j<progress.length;j++){
    const delta=(progress[j].phase-progress[j-1].phase+1)%1;
    assert.ok(delta>.012&&delta<.25,
      'Animation must keep advancing during every node drag update, no phase reset: '+delta);
  }
  const shortLine=progress.at(-1);
  assert.ok(shortLine.count<longLine.count,
    'Close nodes must automatically show fewer lights instead of five overlapping tails');
  assert.ok(shortLine.tail<=shortLine.length/shortLine.count*.73,
    'Short wire tails must shrink enough to preserve gaps');
  const shortHeads=shortLine.visible.map(item=>item.head).sort((a,b)=>a-b);
  for(let j=1;j<shortHeads.length;j++)
    assert.ok(shortHeads[j]-shortHeads[j-1]>=shortLine.tail-2,
      'Adjacent droplets must not merge on a short wire');
  if(process.env.TAPNOW_FLOW_SCREENSHOT){
    const output=path.resolve(process.env.TAPNOW_FLOW_SCREENSHOT);
    const ext=path.extname(output);
    const shortOutput=output.slice(0,-ext.length)+'-short'+ext;
    await page.screenshot({path:shortOutput,animations:'allow'});
    console.log('FLOW_SHORT_VISUAL_CHECK='+shortOutput);
  }
  await page.mouse.up();
  const afterDragPhase=await flow.locator('.tn-blue-flow-droplet').first()
    .evaluate(el=>Number(el.dataset.phase));
  assert.ok(Number.isFinite(afterDragPhase),'Light animation must continue after mouse release');
  assert.ok(await flow.locator('path.react-flow__edge-path').count()>=1,
    'Solid base connection remains underneath the effect');
  assert.deepEqual(pageErrors,[],'No JavaScript errors');
  console.log('PASS: five curved droplets on long connections; adaptive spacing/tail count on close nodes; phase-continuous flowing light while dragging and after release');
}finally{
  await browser.close();
}
