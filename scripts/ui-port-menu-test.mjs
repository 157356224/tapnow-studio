import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const api='http://127.0.0.1:3701';
const project=await fetch(api+'/api/projects',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({
    title:'TEMP_Port_Menu_'+Date.now(),
    nodes:[
      {id:'port-origin',type:'studio',position:{x:240,y:135},
        data:{kind:'text',title:'Origin',text:'Double click to edit',status:'idle',prompt:''}},
      {id:'port-other',type:'studio',position:{x:1150,y:125},
        data:{kind:'image',title:'Image',status:'idle',prompt:''}}
    ],edges:[],viewport:{x:0,y:0,zoom:1}
  })
}).then(r=>r.json());
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1750,height:1000}});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
const origin=page.locator('[data-id="port-origin"]');
const popup=page.locator('.tn-node-add-popover');
async function portPosition(side){
  await origin.locator('.tn-node-frame').hover();
  await page.waitForTimeout(260);
  const box=await origin.locator('.tn-port-'+side+' .tn-port-visual').boundingBox();
  assert.ok(box,'Port ring should exist');
  return {x:box.x+box.width/2,y:box.y+box.height/2};
}
async function checkMenu(){
  await popup.waitFor({state:'visible',timeout:2000});
  assert.equal(await popup.locator('.popover-tools button').count(),3);
  assert.deepEqual(await popup.locator('.popover-tools strong').allTextContents(),
    ['文本生成','图片生成','视频生成']);
  assert.equal(await popup.getByText('音频生成').count(),0);
  assert.equal(await popup.locator('.popover-upload,.popover-search').count(),0);
}
try{
  await page.goto('http://127.0.0.1:5173/',{waitUntil:'domcontentloaded'});
  await page.locator('.tn-project-pill button[title="切换画布"]').click();
  await page.locator('.project-list-item').filter({hasText:project.title})
    .locator('button').first().click();
  await origin.waitFor();
  await page.waitForTimeout(500);

  const ring=await portPosition('out');
  await page.mouse.click(ring.x,ring.y);
  await checkMenu();
  assert.equal(await page.locator('.react-flow__node').count(),2,
    'Clicking + must not immediately create a node');
  await page.screenshot({path:path.join(root,'..','tapnow-connector-three-menu.png')});
  await popup.getByRole('button',{name:/图片生成/}).click();
  assert.equal(await page.locator('.react-flow__node').count(),3);
  assert.equal(await page.locator('.react-flow__edge').count(),1);

  const drag=await portPosition('out');
  await page.mouse.move(drag.x,drag.y);
  await page.mouse.down();
  await page.mouse.move(735,765,{steps:22});
  await page.mouse.up();
  await checkMenu();
  assert.equal(await page.locator('.react-flow__node').count(),3,
    'Dropping connection on blank space must only open node menu');
  await popup.getByRole('button',{name:/视频生成/}).click();
  assert.equal(await page.locator('.react-flow__node').count(),4);
  assert.equal(await page.locator('.react-flow__edge').count(),2);

  const left=await portPosition('in');
  await page.mouse.click(left.x,left.y);
  await checkMenu();
  await popup.getByRole('button',{name:/文本生成/}).click();
  await page.waitForTimeout(2600); // moving the viewport resets the autosave debounce
  const saved=await fetch(api+'/api/projects/'+project.id).then(r=>r.json());
  assert.equal(saved.nodes.length,5,'All created nodes must be persisted');
  assert.equal(saved.edges.length,3,'Left and right nodes must connect to the source');
  const newNode=saved.nodes.find(n=>n.id!== 'port-origin'&&n.id!=='port-other'&&
    saved.edges.some(e=>e.source===n.id&&e.target==='port-origin'));
  assert.ok(newNode);
  await page.locator('.react-flow__node[data-id="'+newNode.id+'"]').waitFor({state:'visible',timeout:1300});
  assert.deepEqual(errors,[]);
  console.log('PASS: left/right + opens three-item chooser, drag-to-blank opens chooser, create-and-connect');
}finally{
  await browser.close();
  await fetch(api+'/api/projects/'+project.id,{method:'DELETE'});
}
