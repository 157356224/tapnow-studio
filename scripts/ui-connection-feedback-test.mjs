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
    title:'Directional Connection Feedback Test '+Date.now(),
    nodes:[
      {id:'feedback-a',type:'studio',position:{x:100,y:120},data:{kind:'text',title:'A · Text',text:'脚本节点',prompt:'',status:'idle'}},
      {id:'feedback-b',type:'studio',position:{x:640,y:90},data:{kind:'image',title:'B · Image',prompt:'',status:'idle'}},
      {id:'feedback-c',type:'studio',position:{x:1140,y:110},data:{kind:'video',title:'C · Video',prompt:'',status:'idle'}}
    ],
    edges:[{id:'existing-a-b',source:'feedback-a',target:'feedback-b',sourceHandle:'out',targetHandle:'in'}],
    viewport:{x:0,y:0,zoom:1}
  })
}).then(r=>r.json());

const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1800,height:1000},deviceScaleFactor:1});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));

async function beginDrag(from, side, target, beforeMoveCheck) {
  const origin=page.locator('.react-flow__node[data-id="'+from+'"]');
  const destination=page.locator('.react-flow__node[data-id="'+target+'"] .tn-node-frame');
  await origin.locator('.tn-node-frame').hover();
  await page.waitForTimeout(280);
  const port=await origin.locator('.tn-port-'+side+' .tn-port-visual').boundingBox();
  const targetBox=await destination.boundingBox();
  assert.ok(port && targetBox);
  await page.mouse.move(port.x+port.width/2,port.y+port.height/2);
  await page.mouse.down();
  if(beforeMoveCheck){
    await page.mouse.move(port.x+port.width/2+(side==='out'?34:-34),
      port.y+port.height/2+6,{steps:7});
    await page.waitForTimeout(85);
    await beforeMoveCheck();
  }
  await page.mouse.move(targetBox.x+targetBox.width*.51,targetBox.y+targetBox.height*.49,{steps:32});
  await page.waitForTimeout(230);
  return page.locator('.react-flow__node[data-id="'+target+'"] .tn-node');
}
try {
  await page.goto('http://127.0.0.1:5173/',{waitUntil:'domcontentloaded'});
  await page.locator('.tn-project-pill button[title="切换画布"]').click();
  await page.locator('.project-list-item').filter({hasText:project.title})
    .locator('button').first().click();
  await page.locator('.react-flow__node[data-id="feedback-c"]').waitFor({timeout:16000});
  assert.equal(await page.locator('.react-flow__edge').count(),1);

  await page.locator('.react-flow__node[data-id="feedback-a"] .tn-node-frame').click();
  await page.locator('.tn-blue-flow-core').waitFor({state:'visible'});
  assert.equal(await page.locator('.tn-blue-flow-core').count(),1,
    'Selected node with an outgoing edge should show blue flowing light');
  assert.equal(await page.locator('.tn-blue-flow-core').evaluate(el=>getComputedStyle(el).animationName),'tn-blue-flow');
  assert.ok(await page.locator('.tn-blue-flow-halo').evaluate(el=>
    getComputedStyle(el).filter.includes('blur(9px)')),
    'Selected-edge blue light must be softly blurred, not a hard bright stroke');
  await page.waitForTimeout(750);
  await page.screenshot({path:path.join(output,'tapnow-selected-blue-flow.png'),fullPage:true});
  await page.mouse.click(1760,900);

  // Connecting from right: the destination fog-sweeps from left to right.
  const validLTR=await beginDrag('feedback-b','out','feedback-c');
  assert.ok(await validLTR.evaluate(el=>el.classList.contains('tn-drop-target')),'Valid destination should glow');
  assert.ok(await validLTR.evaluate(el=>el.classList.contains('tn-scan-ltr')),'Right source emits a left-to-right sweep');
  assert.equal(await validLTR.evaluate(el=>getComputedStyle(el,'::after').animationName),'tn-perimeter-scan');
  assert.equal(await validLTR.evaluate(el=>getComputedStyle(el,'::after').animationDirection),'normal');
  assert.ok((await validLTR.evaluate(el=>getComputedStyle(el,'::after').maskComposite)).split(',').every(s=>s.trim()==='exclude'),
    'Fog must only cover the perimeter, not the center of the node');
  await page.screenshot({path:path.join(output,'tapnow-sweep-left-to-right.png'),fullPage:true});
  await page.mouse.up();
  await page.waitForTimeout(180);
  assert.equal(await page.locator('.react-flow__edge').count(),2,'B to C link created');

  // Reverse direction C to B is disallowed; the destination darkens and blurs.
  const invalid=await beginDrag('feedback-c','out','feedback-b',async()=>{
    assert.ok(await page.locator('.react-flow__node[data-id="feedback-b"] .tn-node').evaluate(
      el=>el.classList.contains('tn-drop-invalid')),
      'Reverse-link candidate must be dark and blurred as soon as the wire starts, before hovering it');
  });
  assert.ok(await invalid.evaluate(el=>el.classList.contains('tn-drop-invalid')),'Reverse link should show forbidden state');
  const css=await invalid.evaluate(el=>({
    filter:getComputedStyle(el).filter,
    overlay:getComputedStyle(el.querySelector('.tn-node-frame'),'::after').backdropFilter
  }));
  assert.ok(css.filter.includes('blur(') && css.filter.includes('brightness('),'Forbidden state should blur and darken');
  await page.screenshot({path:path.join(output,'tapnow-reverse-link-blocked.png'),fullPage:true});
  await page.mouse.up();
  await page.waitForTimeout(180);
  assert.equal(await page.locator('.react-flow__edge').count(),2,'Forbidden reverse edge is not saved');

  // Connecting from LEFT handle: a right-to-left sweep on the destination.
  const validRTL=await beginDrag('feedback-c','in','feedback-a');
  assert.ok(await validRTL.evaluate(el=>el.classList.contains('tn-drop-target')));
  assert.ok(await validRTL.evaluate(el=>el.classList.contains('tn-scan-rtl')),'Left source emits right-to-left sweep');
  assert.equal(await validRTL.evaluate(el=>getComputedStyle(el,'::after').animationName),'tn-perimeter-scan');
  assert.equal(await validRTL.evaluate(el=>getComputedStyle(el,'::after').animationDirection),'reverse');
  await page.screenshot({path:path.join(output,'tapnow-sweep-right-to-left.png'),fullPage:true});
  await page.mouse.up();
  await page.waitForTimeout(1250);
  assert.equal(await page.locator('.react-flow__edge').count(),3,'A to C link created');
  assert.equal(await page.locator('.tn-drop-invalid,.tn-drop-target').count(),0,'All drop effects clear on pointer release');
  const saved=await fetch(api+'/api/projects/'+project.id).then(r=>r.json());
  assert.equal(saved.edges.length,3,'All valid connections persisted');
  assert.deepEqual(errors,[],'No JS runtime errors');
  console.log('PASS: left-to-right fog sweep, forbidden reverse dark blur and rejection, right-to-left sweep, cleanup and persistence');
} finally {
  await browser.close();
  await fetch(api+'/api/projects/'+project.id,{method:'DELETE'});
}
