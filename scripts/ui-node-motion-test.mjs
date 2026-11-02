import {chromium} from 'playwright';
import assert from 'node:assert/strict';

const api='http://127.0.0.1:3701';
const many=Array.from({length:110},(_,i)=>'第'+(i+1)+'行：长篇剧情和画面生成提示词，用来验证内部滚动。').join('\n');
const project=await fetch(api+'/api/projects',{
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({
    title:'TEMP_Node_Motion_'+Date.now(),
    nodes:[
      {id:'motion-text',type:'studio',position:{x:100,y:80},data:{kind:'text',title:'Text',text:many,prompt:'',status:'idle'}},
      {id:'motion-image',type:'studio',position:{x:510,y:80},data:{kind:'image',title:'Image',prompt:many,status:'idle'}},
      {id:'motion-video',type:'studio',position:{x:950,y:80},data:{kind:'video',title:'Video',ratio:'16:9',prompt:many,status:'idle'}}
    ],
    edges:[],
    viewport:{x:45,y:55,zoom:1}
  })
}).then(r=>r.json());
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1820,height:1040},deviceScaleFactor:1});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto('http://127.0.0.1:5173/',{waitUntil:'domcontentloaded'});
  await page.locator('.tn-project-pill button[title="切换画布"]').click();
  await page.locator('.project-list-item').filter({hasText:project.title}).locator('button').first().click();
  const text=page.locator('.react-flow__node[data-id="motion-text"]');
  const image=page.locator('.react-flow__node[data-id="motion-image"]');
  const video=page.locator('.react-flow__node[data-id="motion-video"]');
  await video.waitFor({state:'visible'});
  await page.waitForTimeout(520);
  const textScroll=await text.locator('.tn-node-text').evaluate(el=>({
    scroll:el.scrollHeight,client:el.clientHeight,overflow:getComputedStyle(el).overflowY,
    parent:el.closest('.tn-node-frame').getBoundingClientRect().height
  }));
  assert.ok(textScroll.scroll>textScroll.client+200&&textScroll.client<=290&&
    textScroll.overflow==='auto'&&textScroll.parent<300,
    'Text node must scroll long content without stretching its card');
  await text.locator('.tn-node-text').evaluate(el=>{el.scrollTop=240;});
  assert.ok((await text.locator('.tn-node-text').evaluate(el=>el.scrollTop))>180);

  await image.locator('.tn-node-frame').click();
  const imagePrompt=page.locator('.floating-compose textarea.tn-compose-prompt');
  await imagePrompt.waitFor({state:'visible'});
  const imageScroll=await imagePrompt.evaluate(el=>({
    scroll:el.scrollHeight,client:el.clientHeight,overflow:getComputedStyle(el).overflowY
  }));
  assert.ok(imageScroll.scroll>imageScroll.client+200&&imageScroll.client<=130&&imageScroll.overflow==='auto',
    'Image generation textarea must have an internal scroll region');

  await video.locator('.tn-node-frame').click();
  const videoPrompt=page.locator('.floating-compose .tn-compose-editor');
  await videoPrompt.waitFor({state:'visible'});
  const videoScroll=await videoPrompt.evaluate(el=>({
    scroll:el.scrollHeight,client:el.clientHeight,overflow:getComputedStyle(el).overflowY
  }));
  assert.ok(videoScroll.scroll>videoScroll.client+200&&videoScroll.client<=130&&videoScroll.overflow==='auto',
    'Video contenteditable prompt must scroll internally');
  await page.waitForTimeout(780); // prior image composer's exit animation finishes
  assert.equal(await page.locator('.floating-compose .tn-compose-label').count(),0,
    'Remove redundant video generation text in the upper right');

  await page.locator('.react-flow__pane').dblclick({position:{x:660,y:690}});
  await page.locator('.popover-tools button').filter({hasText:'文本'}).click();
  await page.locator('.tn-text').count().then(n=>assert.equal(n,2));
  // Node class is directly created on mount and scales via CSS, independently
  // of the React Flow position transform on its parent.
  const growing=page.locator('.tn-text').last();
  assert.equal(await growing.evaluate(el=>getComputedStyle(el).animationName),'tn-node-grow');
  await page.waitForTimeout(530);
  const freshNode=page.locator('.tn-text').last();
  // Click the non-editable caption: focusing the readonly textarea would
  // intentionally prevent the global Delete shortcut from firing.
  await freshNode.locator('.tn-node-caption').click();
  const freshId=await freshNode.evaluate(el=>el.closest('.react-flow__node')?.getAttribute('data-id'));
  assert.ok(freshId,'Fresh text node has a React Flow data-id');
  assert.ok(await freshNode.evaluate(el=>el.closest('.react-flow__node')?.classList.contains('selected')),
    'The new node is selected for Delete');
  await page.keyboard.press('Delete');
  const exiting=page.locator('.react-flow__node[data-id="'+freshId+'"] .tn-node-exiting');
  await exiting.waitFor({state:'visible',timeout:650});
  assert.equal(await exiting.evaluate(el=>getComputedStyle(el).animationName),'tn-node-shrink');
  await exiting.waitFor({state:'detached',timeout:1100});
  assert.equal(await page.locator('.tn-text').count(),1);
  assert.deepEqual(errors,[],'No browser errors during node animation');
  console.log('PASS: text/image/video internal scrolling, no video top label, node grow on add, reverse shrink on delete');
}finally{
  await browser.close();
  await fetch(api+'/api/projects/'+project.id,{method:'DELETE'});
}
