import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const api='http://127.0.0.1:3701';
const response=await fetch(api+'/api/projects',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({
    title:'TEMP_UI_IME_INTERACTIONS_'+Date.now(),
    nodes:[
      {id:'ime-text',type:'studio',position:{x:70,y:80},
        data:{kind:'text',title:'文本',text:'',prompt:'',status:'idle'}},
      {id:'ime-photo',type:'studio',position:{x:470,y:100},
        data:{kind:'image',title:'图片1',mediaUrl:
          'https://images.unsplash.com/photo-1531366936337-7c912a4589a7?w=250',status:'idle'}},
      {id:'ime-video',type:'studio',position:{x:840,y:100},
        data:{kind:'video',title:'视频',prompt:'',duration:'5s',ratio:'16:9',status:'idle'}}
    ],edges:[],viewport:{x:50,y:90,zoom:0.83}
  })
}).then(r=>r.json());
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1710,height:1000}});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
const video=page.locator('.react-flow__node[data-id="ime-video"]');
try{
  await page.goto('http://127.0.0.1:5173/');
  await page.locator('.tn-project-pill button[title="切换画布"]').click();
  await page.locator('.project-list-item').filter({hasText:response.title})
    .locator('button').first().click();
  await video.waitFor({state:'visible',timeout:15000});
  assert.equal(await page.locator('.floating-compose').count(),0,
    'Loaded nodes must not show floating editors until clicked');
  assert.equal(await page.locator('.tn-credits,.tn-token,.tn-mic,.tn-times').count(),0,
    'Unused credits, microphone and generation multiplier controls must be absent');

  const initial=await video.locator('.tn-node-frame').boundingBox();
  await page.mouse.move(initial.x+initial.width/2,initial.y+initial.height/2);
  await page.mouse.down();
  await page.mouse.move(initial.x+initial.width/2+75,initial.y+initial.height/2+27,{steps:8});
  await page.mouse.up();
  await page.waitForTimeout(120);
  assert.equal(await page.locator('.floating-compose').count(),0,
    'Dragging a node must never reveal the prompt box');

  await video.locator('.tn-node-frame').click();
  await page.locator('.floating-compose').waitFor({state:'visible',timeout:4500});
  await page.mouse.move(300,865);
  await page.mouse.down();
  await page.mouse.move(1550,75,{steps:15});
  await page.mouse.up();
  await page.waitForTimeout(180);
  assert.equal(await page.locator('.floating-compose').count(),0,
    'Marquee-selecting nodes must never reveal the prompt box');

  // React Flow's multi-selection rectangle captures clicks until the group is
  // deselected; click empty canvas before the next individual node edit.
  await page.mouse.click(1630,895);
  await video.locator('.tn-node-frame').click();
  const editor=page.locator('.floating-compose .tn-compose-editor');
  await editor.waitFor({state:'visible'});
  await editor.focus();
  assert.equal(await editor.evaluate(el=>getComputedStyle(el).outlineStyle),'none',
    'Prompt editor must not draw the purple keyboard focus outline');
  await editor.evaluate(el=>{
    el.focus();
    el.dispatchEvent(new CompositionEvent('compositionstart',
      {data:'nihao',bubbles:true}));
    el.textContent='nihao';
    el.dispatchEvent(new InputEvent('input',{
      data:'nihao',inputType:'insertCompositionText',bubbles:true,isComposing:true
    }));
  });
  const pending=await (await fetch(api+'/api/projects/'+response.id)).json();
  assert.notEqual(pending.nodes.find(n=>n.id==='ime-video').data.prompt,'nihao',
    'Pinyin in progress should never be persisted to the workflow');
  await editor.evaluate(el=>{
    el.textContent='你好，镜头向前推进';
    el.dispatchEvent(new CompositionEvent('compositionend',{
      data:'你好',bubbles:true
    }));
  });
  await page.waitForTimeout(1150);
  assert.match(await editor.innerText(),/你好，镜头向前推进/);
  const after=await (await fetch(api+'/api/projects/'+response.id)).json();
  assert.match(after.nodes.find(n=>n.id==='ime-video').data.prompt,/你好/,
    'Committed Chinese characters should persist');
  assert.equal(await page.locator('.tn-node').count(),3,
    'IME events must not accidentally delete nodes');
  assert.equal(await page.locator('.tn-ref-attachment').count(),0,
    'Unconnected images must not create thumbnails; connected images do, even without @');
  assert.ok(await page.locator('.tn-ref-attach-add').isDisabled());
  await editor.focus();
  await page.keyboard.type('正常打字');
  assert.equal(await page.locator('.tn-ref-gallery').count(),0,
    'Ordinary text entry must not open image reference search');
  await page.keyboard.type('@');
  assert.equal(await page.locator('.tn-ref-gallery').count(),0,
    'Typing @ with no connected image cannot open the reference gallery');

  await page.mouse.click(1610,940);
  const text=page.locator('.react-flow__node[data-id="ime-text"] .tn-node-text');
  await text.dblclick();
  await text.evaluate(el=>{
    el.dispatchEvent(new CompositionEvent('compositionstart',{data:'ni',bubbles:true}));
    el.value='ni';el.dispatchEvent(new InputEvent('input',{bubbles:true,
      data:'ni',inputType:'insertCompositionText',isComposing:true}));
    el.value='你好';el.dispatchEvent(new CompositionEvent('compositionend',{
      data:'你好',bubbles:true
    }));
  });
  await page.waitForTimeout(1150);
  const completed=await (await fetch(api+'/api/projects/'+response.id)).json();
  assert.equal(completed.nodes.find(n=>n.id==='ime-text').data.text,'你好',
    'Text node must also preserve committed Chinese IME output');

  await page.screenshot({path:'../tapnow-refined-interactions.png',fullPage:true});
  assert.deepEqual(errors,[],'No runtime JS errors');
  console.log('PASS: drag/marquee keep editor hidden, Chinese IME commits, no unconnected image references or unsolicited popup');
}finally{
  await browser.close();
  await fetch(api+'/api/projects/'+response.id,{method:'DELETE'});
}
