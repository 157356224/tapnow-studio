import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.resolve(root,'..');
const base='http://127.0.0.1:3701';
const post=(url,body)=>fetch(base+url,{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
}).then(r=>r.json());
const project=await post('/api/projects',{
  title:'Reference UI Test '+Date.now(),nodes:[],edges:[],viewport:{x:0,y:0,zoom:1}
});
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
const issues=[];
page.on('pageerror',e=>issues.push(e.message));
const shot=(name)=>page.screenshot({path:path.join(output,name),fullPage:true});
try {
  await page.goto('http://127.0.0.1:5173/',{waitUntil:'domcontentloaded'});
  await page.locator('.tn-project-pill button[title="切换画布"]').click();
  await page.locator('.project-list-item').filter({hasText:project.title})
    .locator('button').first().click();
  await page.locator('.tn-empty-start').waitFor({timeout:16000});
  await shot('tapnow-reference-blank.png');
  assert.equal(await page.locator('.tn-node').count(),0);
  const pane=page.locator('.react-flow__pane');
  await pane.dblclick({position:{x:780,y:400}});
  await page.locator('.add-popover').waitFor();
  await page.mouse.click(840,320,{button:'right'});
  assert.equal(await page.locator('.add-popover').count(),0,'Right click cancels add menu');
  await pane.dblclick({position:{x:470,y:335}});
  await page.locator('.popover-tools button').filter({hasText:'文本'}).click();
  await page.locator('.tn-text').waitFor();
  assert.equal(await page.locator('.tn-node').count(),1);
  await page.locator('.tn-text .tn-node-text').dblclick();
  await page.locator('.tn-text .tn-node-text').fill('场景一：光影流动，镜头向前推进。');
  const textPort=page.locator('.tn-text .tn-port-out');
  await page.locator('.tn-text .tn-node-frame').hover();
  await page.waitForTimeout(160);
  const opacity=await textPort.evaluate(el=>parseFloat(getComputedStyle(el).opacity));
  assert.ok(opacity>.8,'Hover port is visible');
  await textPort.click();
  await page.locator('.tn-image').waitFor();
  const imagePort=page.locator('.tn-image .tn-port-out');
  await page.locator('.tn-image .tn-node-frame').hover();
  await imagePort.click();
  await page.locator('.tn-video').waitFor();
  assert.equal(await page.locator('.tn-node').count(),3);
  assert.equal(await page.locator('.react-flow__edge').count(),2);
  assert.equal(await page.locator('.react-flow__edge path').first().getAttribute('d').then(x=>x?.includes('C')),true,'Connections use cubic Bezier paths');
  await page.locator('.bottom-left-controls button[title="适应画布"]').click();
  await page.waitForTimeout(550);
  await shot('tapnow-reference-nodes.png');
  await page.locator('.tn-image .tn-node-frame').click();
  await page.locator('.tn-toolbar').waitFor();
  await page.locator('.floating-compose').waitFor();
  await shot('tapnow-reference-selected.png');
  await page.locator('.tn-compose-prompt').fill('Cinematic portrait, soft lighting, 2:3.');
  await page.locator('.tn-compose-footer button[title="选择模型"]').click();
  assert.ok(await page.locator('.tn-dropdown button').count()>1,'Model menu open');
  await page.locator('.tn-dropdown button').first().click();
  await page.waitForTimeout(1400);
  const saved=await (await fetch(base+'/api/projects/'+project.id)).json();
  assert.equal(saved.nodes.length,3,'Project persists three nodes');
  assert.equal(saved.edges.length,2,'Project persists two edges');
  assert.deepEqual(issues,[],'No JavaScript runtime errors');
  console.log('PASS: blank canvas, double-click create, right-click cancel, left/right hover ports, 3 node types, Bezier edges, selection tools, prompt composer, save');
  console.log('Screenshots in '+output);
} finally {
  await browser.close();
  await fetch(base+'/api/projects/'+project.id,{method:'DELETE'});
}
