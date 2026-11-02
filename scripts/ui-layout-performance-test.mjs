import {chromium} from 'playwright';
import assert from 'node:assert/strict';

const api='http://127.0.0.1:3701';
const filler=Array.from({length:160},(_,i)=>({
  id:'offscreen-'+i,type:'studio',
  position:{x:2800+(i%12)*530,y:120+Math.floor(i/12)*500},
  data:{kind:i%3===0?'video':i%3===1?'image':'text',
    title:'Background '+i,prompt:'',text:'A quiet scene',status:'idle'}
}));
const project=await fetch(api+'/api/projects',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({
    title:'TEMP_Aspect_Performance_'+Date.now(),
    nodes:[
      {id:'ratio-43',type:'studio',position:{x:80,y:120},
        data:{kind:'image',title:'Picture 4:3',prompt:'',status:'idle'}},
      {id:'ratio-34',type:'studio',position:{x:580,y:120},
        data:{kind:'image',title:'Picture 3:4',prompt:'',status:'idle'}},
      {id:'ratio-video',type:'studio',position:{x:1080,y:120},
        data:{kind:'video',title:'Video',prompt:'A reference',status:'idle'}}
      ,...filler],
    edges:[{id:'ratio-edge',source:'ratio-43',target:'ratio-video',
      sourceHandle:'out',targetHandle:'in'}],
    viewport:{x:60,y:70,zoom:1}
  })
}).then(r=>r.json());
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1850,height:1020},deviceScaleFactor:1});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto('http://127.0.0.1:5173/',{waitUntil:'domcontentloaded'});
  await page.locator('.tn-project-pill button[title="切换画布"]').click();
  await page.locator('.project-list-item').filter({hasText:project.title})
    .locator('button').first().click();
  await page.locator('[data-id="ratio-video"] .tn-node-frame').waitFor();
  await page.waitForTimeout(540);
  const rendered=await page.locator('.react-flow__node').count();
  assert.ok(rendered<20,
    'Only visible nodes should be rendered when a workflow has 163 nodes; actual '+rendered);

  const generated=await page.evaluate(()=>{
    const make=(width,height,colour)=>{
      const c=document.createElement('canvas');
      c.width=width;c.height=height;
      const g=c.getContext('2d');
      g.fillStyle=colour;g.fillRect(0,0,width,height);
      g.fillStyle='white';g.fillRect(width*.3,height*.3,width*.4,height*.4);
      return c.toDataURL('image/png').split(',')[1];
    };
    return {wide:make(400,300,'#578fab'),portrait:make(300,400,'#b98d61')};
  });
  await page.locator('[data-id="ratio-43"] input[type=file]').setInputFiles({
    name:'four-three.png',mimeType:'image/png',buffer:Buffer.from(generated.wide,'base64')
  });
  await page.locator('[data-id="ratio-34"] input[type=file]').setInputFiles({
    name:'three-four.png',mimeType:'image/png',buffer:Buffer.from(generated.portrait,'base64')
  });
  await page.waitForFunction(()=>{
    const img1=document.querySelector('[data-id="ratio-43"] .tn-media');
    const img2=document.querySelector('[data-id="ratio-34"] .tn-media');
    return img1?.naturalWidth===400&&img2?.naturalWidth===300;
  },null,{timeout:12000});
  await page.waitForTimeout(400);
  const shapes=await page.evaluate(()=>{
    return ['ratio-43','ratio-34'].map(id=>{
      const node=document.querySelector('[data-id="'+id+'"]');
      const rect=node.querySelector('.tn-node-frame').getBoundingClientRect();
      const media=node.querySelector('.tn-media');
      return {id,w:rect.width,h:rect.height,
        mediaFit:getComputedStyle(media).objectFit,
        natural:node.querySelector('.tn-node').classList.contains('tn-image-natural')};
    });
  });
  assert.ok(shapes.every(s=>s.natural&&s.mediaFit==='contain'));
  assert.ok(Math.abs(shapes[0].w/shapes[0].h-4/3)<.025,
    '4:3 upload is presented in a genuine 4:3 frame');
  assert.ok(Math.abs(shapes[1].w/shapes[1].h-3/4)<.025,
    '3:4 upload is presented in a genuine 3:4 frame');
  await page.waitForTimeout(1300); // wait for the debounced project persistence
  const saved=await fetch(api+'/api/projects/'+project.id).then(r=>r.json());
  assert.equal(saved.nodes.find(n=>n.id==='ratio-43').data.mediaWidth,400);
  assert.equal(saved.nodes.find(n=>n.id==='ratio-34').data.mediaHeight,400);

  await page.locator('[data-id="ratio-video"] .tn-node-frame').click();
  const settings=page.locator('.tn-video-settings');
  await page.locator('.tn-video-settings-toggle').click();
  await settings.waitFor({state:'visible'});
  assert.equal(await settings.evaluate(el=>getComputedStyle(el).animationName),'tn-settings-open');
  await page.mouse.click(1800,900);
  await page.waitForTimeout(40);
  assert.ok(await settings.evaluate(el=>el.classList.contains('tn-settings-closing')),
    'Video settings close with a reverse animation');
  await settings.waitFor({state:'detached',timeout:1300});

  await page.locator('[data-id="ratio-video"] .tn-node-frame').click();
  await page.waitForTimeout(500); // composer entrance completes after refocusing
  await page.locator('.tn-ref-attach-add').click();
  const gallery=page.locator('.tn-ref-gallery');
  await gallery.waitFor({state:'visible'});
  await page.waitForTimeout(330); // capture the settled opaque charcoal palette
  const palette=await gallery.evaluate(el=>{
    const row=el.querySelector('.tn-ref-gallery-item');
    return {popup:getComputedStyle(el).backgroundColor,
      row:getComputedStyle(row).backgroundColor,
      text:getComputedStyle(row).color};
  });
  assert.ok(palette.popup!=='rgb(255, 255, 255)'&&
    palette.row!=='rgb(255, 255, 255)','Reference picker uses dark charcoal, never white');
  await page.screenshot({path:'../tapnow-ref-gallery-charcoal.png',fullPage:true});
  await page.mouse.click(1800,900);

  await page.locator('[data-id="ratio-43"] .tn-node-frame').click();
  const flow=page.locator('[data-id="ratio-video"] .tn-flow-target');
  await flow.waitFor({state:'visible'});
  const layer=await page.evaluate(()=>{
    const layers=document.querySelector('.react-flow');
    return {
      edges:getComputedStyle(layers.querySelector('.react-flow__edges')).zIndex,
      nodes:getComputedStyle(layers.querySelector('.react-flow__nodes')).zIndex,
      perimeter:getComputedStyle(document.querySelector('[data-id="ratio-video"] .tn-node-frame'),'::before').animationName
    };
  });
  assert.ok(Number(layer.edges)<Number(layer.nodes),
    'Edges must paint behind node cards');
  assert.equal(layer.perimeter,'tn-flow-rim',
    'Blue pulse arriving at connected target continues along the card rim');
  await page.waitForTimeout(480); // previous node's composer has finished exiting
  await page.screenshot({path:'../tapnow-flow-node-perimeter.png',fullPage:true});

  const n=page.locator('[data-id="ratio-43"] .tn-node-frame');
  const before=await n.boundingBox();
  await page.mouse.move(before.x+before.width*.5,before.y+before.height*.56);
  await page.mouse.down();
  await page.mouse.move(before.x+before.width*.5+110,before.y+before.height*.56+48,{steps:35});
  await page.mouse.up();
  const after=await n.boundingBox();
  assert.ok(after.x-before.x>55,'Dragging must remain responsive with 160 offscreen nodes');
  assert.deepEqual(errors,[]);
  console.log('PASS: original image ratios '+shapes.map(s=>s.w+'x'+s.h).join(', ')+
    ', dark reference picker, settings enter/exit, blue rim, edge layering, 163-node drag');
}finally{
  await browser.close();
  await fetch(api+'/api/projects/'+project.id,{method:'DELETE'});
}
