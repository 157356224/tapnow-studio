import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const root='http://127.0.0.1:3701';
const accounts=await fetch(root+'/api/doubao/accounts').then(r=>r.json());
const project=await fetch(root+'/api/projects',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({
    title:'TEMP_Doubao_Integration_UI',
    nodes:[
      {id:'doubao-photo',type:'studio',position:{x:100,y:170},
        data:{kind:'image',title:'图像素材',mediaUrl:'https://images.unsplash.com/photo-1531366936337-7c912a4589a7?w=800',prompt:'',status:'idle'}},
      {id:'doubao-audio',type:'studio',position:{x:100,y:640},
        data:{kind:'audio',title:'音频参考(当前禁用)',mediaUrl:'/api/uploads/test-audio.mp3',prompt:'',status:'idle'}},
      {id:'doubao-video-ref',type:'studio',position:{x:1110,y:640},
        data:{kind:'video',title:'视频参考(当前禁用)',mediaUrl:'/api/uploads/test-ref.mp4',prompt:'',status:'done'}},
      {id:'doubao-video',type:'studio',position:{x:700,y:120},
        data:{kind:'video',title:'视频生成',model:'Seedance 2.0 Fast',ratio:'16:9',duration:'5s',prompt:'@图片1',status:'idle'}}
    ],
    edges:[{id:'doubao-linked',source:'doubao-photo',target:'doubao-video'}],
    viewport:{x:50,y:90,zoom:1}
  })
}).then(r=>r.json());
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1560,height:1000}});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto('http://127.0.0.1:5173',{waitUntil:'domcontentloaded'});
  await page.locator('.tn-project-pill button[title="切换画布"]').click();
  await page.locator('.project-list-item').filter({hasText:'TEMP_Doubao_Integration_UI'})
    .locator('button').first().click();
  await page.locator('.react-flow__node[data-id="doubao-video"] .tn-video').waitFor({timeout:16000});
  await page.locator('.react-flow__node[data-id="doubao-video"] .tn-node-frame').click();
  console.log('DEBUG: nodes=',await page.locator('.tn-node').count(),
    'selected=',await page.locator('.tn-selected').count(),
    'toolbar=',await page.locator('.floating-compose').count(),
    'panel=',await page.locator('.right-panel').count());
  await page.screenshot({path:'../tapnow-doubao-interface.png',fullPage:true});
  const accountSelect=page.locator('.floating-compose select[aria-label="视频生成账号"]');
  await accountSelect.waitFor({state:'visible'});
  assert.ok((await page.locator('.floating-compose .tn-combobox>button').first().innerText()).includes('Seedance 2.0 Fast'));
  await page.locator('.floating-compose .tn-video-settings-toggle').click();
  assert.equal(await page.locator('.tn-video-ratios button').count(),6);
  assert.equal(await page.locator('.tn-video-durations button').count(),12);
  await page.locator('.tn-video-durations button').filter({hasText:'7s'}).click();
  assert.match(await page.locator('.tn-video-settings-toggle').innerText(),/7s/);
  const video=page.locator('.react-flow__node[data-id="doubao-video"] .tn-video');
  const previousWidth=await video.evaluate(el=>el.getBoundingClientRect().width);
  await page.locator('.tn-video-ratios button').filter({hasText:'9:16'}).click();
  await page.waitForTimeout(750);
  const nextWidth=await video.evaluate(el=>el.getBoundingClientRect().width);
  assert.ok(nextWidth<previousWidth-150,'Vertical video node should resize smoothly');
  await page.locator('.tn-video-settings-toggle').click();
  await page.locator('.tn-video-settings-toggle').click();
  assert.ok(await page.locator('.tn-video-settings').isVisible());
  await page.waitForTimeout(760);
  await page.screenshot({path:'../tapnow-video-settings-refined.png',fullPage:true});
  await page.locator('.tn-compose-editor').click({position:{x:12,y:20}});
  await page.waitForTimeout(270); // settings popover plays its reverse exit animation
  assert.equal(await page.locator('.tn-video-settings').count(),0,
    'Clicking outside the video settings popover must dismiss it');
  assert.match(await page.locator('.tn-ref-attachment-count').innerText(),/已连接1张 · 已引用1张/,
    'The tray must show connected and actually referenced images separately');
  const refThumb=page.locator('.tn-ref-attachment').first();
  const addRef=page.locator('.floating-compose .tn-ref-attach-add');
  const imgBox=await refThumb.boundingBox();
  const addBox=await addRef.boundingBox();
  assert.ok(imgBox&&addBox&&imgBox.x+imgBox.width<addBox.x,
    'Connected image thumbnails must appear to the left of the + button');
  assert.equal(await refThumb.evaluate(el=>getComputedStyle(el).borderTopWidth),'0px',
    'Reference images must not have black borders or cards');
  assert.equal(await page.locator('.tn-compose-top .tn-compose-square').count(),0,
    'Remove the redundant reference image + icon from the video composer');
  await page.locator('.tn-ref-attachment').first().hover();
  assert.equal(await page.locator('.tn-ref-hover-preview').count(),1);
  assert.equal(await page.locator('.tn-ref-hover-preview').evaluate(el=>getComputedStyle(el).animationName),
    'tn-ref-preview-enter','Attached-image hover preview should animate softly');
  assert.equal(await page.locator('.tn-ref-editor-preview').count(),0,
    'Attachment hover should not create two overlapping large previews');
  await page.waitForTimeout(350);
  await page.screenshot({path:'../tapnow-single-image-preview.png',fullPage:true});
  const thumb=await page.locator('.tn-ref-attachment').first().boundingBox();
  assert.ok(thumb.width>=31&&thumb.width<=33&&thumb.height>=36&&thumb.height<=39,
    'Attached image thumbnail must be a compact borderless portrait rectangle');
  await page.locator('.floating-compose .tn-ref-attach-add').click();
  assert.equal(await page.locator('.tn-ref-gallery-search input').getAttribute('placeholder'),'搜索');
  assert.ok((await page.locator('.tn-ref-gallery-heading').innerText()).includes('已连接节点'));
  await page.screenshot({path:'../tapnow-ref-gallery-refined.png',fullPage:true});
  assert.equal(await page.locator('.floating-compose .tn-ref-gallery-item').count(),1,
    'Only uploaded image-node references are offered');
  assert.ok(!(await page.locator('.floating-compose .tn-ref-gallery').innerText()).includes('音频'));
  assert.ok(!(await page.locator('.floating-compose .tn-ref-gallery').innerText()).includes('视频'));
  const search=page.locator('.tn-ref-gallery-search input');
  await search.fill('unmatched image');
  assert.equal(await page.locator('.tn-ref-gallery-item').count(),0);
  await search.fill('');
  await page.waitForTimeout(300);
  await page.screenshot({path:'../tapnow-ref-gallery-refined.png',fullPage:true});
  const option=page.locator('.floating-compose .tn-ref-gallery-item').first();
  await option.waitFor({state:'visible'});
  await option.click();
  assert.ok((await page.locator('.floating-compose .tn-compose-editor').innerText()).includes('Image'));
  await page.locator('.tn-inline-ref').first().hover();
  assert.equal(await page.locator('.tn-ref-editor-preview').count(),1);
  assert.equal(await page.locator('.tn-ref-hover-preview').count(),0,
    'Inline @image preview should be one large image, not stacked duplicates');
  await page.waitForTimeout(390);
  assert.equal(await page.locator('.tn-inline-ref-x').first().evaluate(el=>getComputedStyle(el).display),'flex',
    'Hovering an inline image reference should replace its thumbnail with a cross');
  const tokenRect=await page.locator('.tn-inline-ref').first().boundingBox();
  const previewRect=await page.locator('.tn-ref-editor-preview').first().boundingBox();
  assert.ok(tokenRect&&previewRect &&
    Math.abs((tokenRect.x+tokenRect.width/2)-(previewRect.x+previewRect.width/2))<12 &&
    Math.abs(previewRect.y+previewRect.height-(tokenRect.y-8))<3,
    'Inline image hover preview must be positioned directly above that exact reference');
  await page.screenshot({path:'../tapnow-inline-image-preview.png',fullPage:true});
  await page.locator('.tn-inline-ref').first().click();
  assert.equal(await page.locator('.tn-inline-ref').count(),0,
    'Clicking the image-to-cross control should remove only that inline reference');
  await page.waitForTimeout(1050);
  const afterRemove=await (await fetch(root+'/api/projects/'+project.id)).json();
  assert.equal(afterRemove.nodes.find(n=>n.id==='doubao-video').data.prompt.includes('@图片1'),false,
    'Removing inline image reference should persist the edited prompt');
  await page.locator('.tn-compose-editor').click();
  await page.keyboard.type('@');
  await page.locator('.tn-ref-gallery-search input').waitFor({state:'visible'});
  await page.locator('.tn-ref-gallery-search input').click();
  assert.ok(await page.locator('.tn-ref-gallery-search input').isVisible(),
    'Typing @ then focusing the reference search must not dismiss the popup');
  await page.locator('.tn-ref-gallery-search input').fill('not available');
  assert.equal(await page.locator('.tn-ref-gallery-item').count(),0);
  await page.locator('.tn-ref-gallery-search input').fill('');
  assert.equal(await page.locator('.tn-ref-gallery-item').count(),1);
  const composeBox=await page.locator('.floating-compose:visible').boundingBox();
  assert.ok(composeBox,'Video compose panel is visible while reference gallery is open');
  await page.mouse.click(composeBox.x+8,composeBox.y+6);
  assert.equal(await page.locator('.tn-ref-gallery').count(),0,
    'Clicking outside must dismiss the reference picker');
  await page.mouse.click(1500,410);
  const exiting=page.locator('.floating-compose.tn-editor-closing');
  await exiting.waitFor({state:'visible',timeout:1400});
  const reverse=await exiting.evaluate(el=>getComputedStyle(el).animationName);
  assert.equal(reverse,'tn-editor-hide','Floating editor should animate on blur instead of disappearing instantly');
  await page.locator('.floating-compose').first().waitFor({state:'hidden',timeout:1600});
  assert.equal(await page.locator('.floating-compose:visible').count(),0,
    'Editor should become hidden after its reverse animation');
  await page.locator('.tn-top-actions button[title="豆包账号与 Cookie 设置"]').click();
  await page.locator('.doubao-settings-heading').waitFor({state:'visible'});
  assert.ok((await page.locator('.doubao-settings-heading').innerText()).includes('多账号浏览器隔离'));
  assert.equal(await page.locator('.doubao-account-card').count(),accounts.length,
    'Settings should list configured accounts without exposing cookies');
  assert.equal(await page.getByRole('button',{name:'原生 Edge 登录'}).count(),
    accounts.length,'Each account must support normal interactive Edge login');
  assert.equal(await page.getByRole('button',{name:'原生 Chrome 登录'}).count(),
    0,'Removed portable Chrome should not have a login action');
  assert.equal(await page.locator('.doubao-browser-network select').count(),0,
    'Removed per-account proxy selector must not appear');
  assert.equal(await page.getByRole('button',{name:'应用并重开'}).count(),0,
    'Removed proxy switch action must not appear');
  if(accounts.length){
    assert.ok(await page.getByRole('button',{name:'检测资源错误'}).first().isVisible());
  }
  assert.ok(await page.locator('textarea[aria-label="豆包账号 Cookie"]').isVisible());
  await page.locator('input[aria-label="豆包账号备注"]').fill('无需 Cookie 的浏览器账号');
  assert.ok(await page.getByRole('button',{name:'创建账号并打开浏览器登录'}).isEnabled(),
    'Login without a preexisting Cookie must be supported');
  if(accounts.length)assert.equal(
    await page.locator('.doubao-login-button').count(),accounts.length);
  assert.deepEqual(errors,[]);
  console.log('PASS: Seedance model, account selector, @image reference, account settings panel');
}finally{
  await browser.close();
  await fetch(root+'/api/projects/'+project.id,{method:'DELETE'});
}
