import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.resolve(root,'..');
const api='http://127.0.0.1:3701';
const project=await fetch(api+'/api/projects',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({
    title:'Magnet UI Test '+Date.now(),
    nodes:[
      {id:'magnet-text',type:'studio',position:{x:120,y:120},data:{kind:'text',title:'Text',text:'测试文本节点可直接拖动',prompt:'',status:'idle'}},
      {id:'magnet-image',type:'studio',position:{x:780,y:80},data:{kind:'image',title:'Image',prompt:'',status:'idle'}}
    ],
    edges:[],viewport:{x:150,y:120,zoom:1}
  })
}).then(r=>r.json());
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
try {
  await page.goto('http://127.0.0.1:5173/',{waitUntil:'domcontentloaded'});
  await page.locator('.tn-project-pill button[title="切换画布"]').click();
  await page.locator('.project-list-item').filter({hasText:project.title})
    .locator('button').first().click();
  await page.locator('.tn-text').waitFor({timeout:16000});
  await page.locator('.tn-image').waitFor({timeout:16000});
  await page.waitForTimeout(510); // complete node's initial scale-in before testing pointer drag
  const text=page.locator('.tn-text');
  const body=text.locator('.tn-node-text');
  const pos=await body.boundingBox();
  assert.ok(pos);
  // Drag the text node from the CENTER of its card (not the title strip).
  const initial=await text.boundingBox();
  await page.mouse.move(pos.x+pos.width*.56,pos.y+pos.height*.58);
  await page.mouse.down();
  await page.mouse.move(pos.x+pos.width*.56+92,pos.y+pos.height*.58+36,{steps:12});
  await page.mouse.up();
  await page.waitForTimeout(300);
  const moved=await text.boundingBox();
  assert.ok(moved.x-initial.x>35, 'Text node should move from card interior');
  assert.ok(moved.y-initial.y>15, 'Text node should move vertically from card interior');

  // Hover near either edge: two circles appear with transparent centers.
  await text.locator('.tn-node-frame').hover();
  await page.waitForTimeout(340);
  const visual=text.locator('.tn-port-out .tn-port-visual');
  const visible=await visual.evaluate(el=>({
    opacity:Number(getComputedStyle(el.closest('.tn-port')).opacity),
    bg:getComputedStyle(el).backgroundColor,
    transform:getComputedStyle(el).transform
  }));
  assert.ok(visible.opacity>.95,'Circular plus must be visible on hover');
  assert.ok(visible.bg==='rgba(0, 0, 0, 0)'||visible.bg==='transparent','Plus circle has no black fill');
  const cardRect=await text.locator('.tn-node-frame').boundingBox();
  await page.mouse.move(cardRect.x+cardRect.width-7,cardRect.y+cardRect.height*.68,{steps:8});
  await page.waitForTimeout(100);
  const inside=await text.evaluate(el=>({
    y:el.querySelector('.tn-port-out .tn-port-visual').style.translate,
    near:el.classList.contains('tn-near-right')
  }));
  assert.ok(inside.y===''||inside.y==='0px 0px','Plus must remain stationary when pointer is INSIDE the card');
  assert.equal(inside.near,false,'Inside cursor must not trigger exterior magnet');
  await page.mouse.move(cardRect.x+cardRect.width+50,cardRect.y+cardRect.height*.68,{steps:8});
  await page.waitForTimeout(130);
  const follow=await text.evaluate(el=>el.querySelector('.tn-port-out .tn-port-visual').style.translate);
  assert.ok(follow!==''&&follow!=='0px 0px','Plus magnet must follow pointer 50px OUTSIDE right edge');
  assert.equal(await text.evaluate(el=>el.classList.contains('tn-near-right')),true);
  const speed=await visual.evaluate(el=>getComputedStyle(el).transitionDuration);
  assert.equal(speed,'0s','Cursor tracking must not have any CSS transition lag');
  const animation=await visual.locator('.tn-port-disc').evaluate(el=>getComputedStyle(el).transitionDuration);
  assert.ok(animation.includes('0.2s'),'The inner disc should ease out promptly without a prolonged ghost trail');
  // A rapid cursor movement should reposition the ring within a single
  // rendering frame, without a delayed CSS transition catching up.
  const outsideX=cardRect.x+cardRect.width+47;
  await page.mouse.move(outsideX,cardRect.y+cardRect.height*.31);
  await page.waitForTimeout(35);
  const upper=await visual.boundingBox();
  await page.mouse.move(outsideX,cardRect.y+cardRect.height*.68);
  await page.waitForTimeout(35);
  const lower=await visual.boundingBox();
  assert.ok(lower.y-upper.y>cardRect.height*.2,
    'Magnet must track cursor movements within the narrower screenshot rectangle');
  // Constrain horizontal following to the new screenshot red rectangle.
  const rightY=cardRect.y+cardRect.height*.52;
  await page.mouse.move(cardRect.x+cardRect.width+50,rightY);
  await page.waitForTimeout(40);
  const innerX=await visual.boundingBox();
  await page.mouse.move(cardRect.x+cardRect.width+84,rightY);
  await page.waitForTimeout(40);
  const outerX=await visual.boundingBox();
  assert.ok(outerX.x-innerX.x>25,
    'Magnet circle must track the cursor horizontally inside the red rectangle');
  assert.equal(await text.evaluate(el=>el.classList.contains('tn-near-right')),true,
    'Right magnet remains active inside the allowed rectangle');
  await page.mouse.move(cardRect.x+cardRect.width-2,rightY);
  await page.waitForTimeout(310);
  assert.ok(['0px','0px 0px'].includes(await visual.evaluate(el=>el.style.translate)),
    'At the node border the magnet must spring back to its original popped-out location');
  const placement=await text.evaluate(el=>({
    nodeStack:getComputedStyle(el.querySelector('.tn-node-frame')).zIndex,
    portStack:getComputedStyle(el.querySelector('.tn-port')).zIndex
  }));
  assert.ok(Number(placement.nodeStack)>Number(placement.portStack),'The circle should emerge from BEHIND the card');
  const other=page.locator('.tn-image');
  const otherBox=await other.locator('.tn-node-frame').boundingBox();
  assert.ok(otherBox);
  await page.mouse.move(otherBox.x+otherBox.width+49,otherBox.y+otherBox.height*.65,{steps:8});
  await page.waitForTimeout(180);
  assert.equal(await other.evaluate(el=>el.classList.contains('tn-near-right')),true,
    'An UNSELECTED node should reveal its plus 50px before reaching its edge');
  assert.ok((await other.locator('.tn-port-out').evaluate(el=>Number(getComputedStyle(el).opacity)))>.9);
  await page.mouse.move(otherBox.x+otherBox.width+83,otherBox.y+otherBox.height*.52,{steps:5});
  assert.equal(await other.evaluate(el=>el.classList.contains('tn-near-right')),true,
    'Magnetic range must remain active at 83px past the edge');
  await page.mouse.move(otherBox.x+otherBox.width+112,otherBox.y+otherBox.height*.52,{steps:5});
  assert.equal(await other.evaluate(el=>el.classList.contains('tn-near-right')),false,
    'Magnetic range must stop outside the marked 100px exterior rectangle');
  await page.mouse.move(cardRect.x+cardRect.width+47,rightY);
  await page.waitForTimeout(100);
  await page.screenshot({path:path.join(output,'tapnow-magnet-hover.png'),fullPage:true});

  // Initiate connection from the visible ring and finish at the center of a
  // destination node, not at a target "+" or React Flow handle.
  const sourcePort=await visual.boundingBox();
  const targetRect=await page.locator('.tn-image .tn-node-frame').boundingBox();
  assert.ok(sourcePort&&targetRect);
  await page.mouse.move(sourcePort.x+sourcePort.width/2,sourcePort.y+sourcePort.height/2);
  await page.mouse.down();
  await page.mouse.move(targetRect.x+targetRect.width*.55,targetRect.y+targetRect.height*.58,{steps:22});
  await page.mouse.up();
  await page.waitForTimeout(430);
  assert.equal(await page.locator('.react-flow__edge').count(),1,'Dropping line on any point of node should connect');
  const saved=await fetch(api+'/api/projects/'+project.id).then(r=>r.json());
  assert.equal(saved.nodes.length,2);
  await page.screenshot({path:path.join(output,'tapnow-magnet-connected.png'),fullPage:true});
  assert.deepEqual(errors,[],'Browser JavaScript errors');
  console.log('PASS: text card body drag, transparent hover rings, cursor-following magnet, drag-to-node-body connection');
} finally {
  await browser.close();
  await fetch(api+'/api/projects/'+project.id,{method:'DELETE'});
}
