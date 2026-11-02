import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';
import {
  buildMusePrompt,clickMuseNewConversation,runMuseBrowser,waitForMuseMedia
} from '../server/muse-runner.mjs';

assert.match(buildMusePrompt({kind:'image',ratio:'3:4',prompt:'一只白猫'}),/生成图片.*3:4/);
assert.equal(buildMusePrompt({
  kind:'image',ratio:'1:1',prompt:'参考@图片2的背景，修改@图片1的服装',
  references:[{token:'@图片1'},{token:'@图片2'}]
}),'请生成图片，图片画面比例 1:1，目标分辨率 2K。\n参考@图2的背景，修改@图1的服装',
  'Image-to-image mode must preserve the referenced image identities and upload-slot order');
assert.equal(buildMusePrompt({
  kind:'image',ratio:'3:4',prompt:'修改@图片3的姿态',
  references:[{token:'@图片3'}]
}),'请生成图片，图片画面比例 3:4，目标分辨率 2K。\n修改@图1的姿态',
  'A single selected image must map to the first uploaded Muse attachment');
for(const resolution of ['1080p','2K','4K','8K']){
  assert.match(buildMusePrompt({
    kind:'image',ratio:'9:16',resolution,prompt:'城市夜景'
  }),new RegExp('画面比例 9:16，目标分辨率 '+resolution+'。'),
  'Muse must receive the selected image resolution in its generation prompt');
}
assert.throws(()=>buildMusePrompt({
  kind:'image',ratio:'1:1',resolution:'500K',prompt:'测试图片'
}),/图片分辨率请选择/);
assert.match(buildMusePrompt({kind:'video',ratio:'16:9',duration:'10s',prompt:'缓慢推镜'}),/10 秒/);
const twoRefPrompt=buildMusePrompt({
  kind:'video',ratio:'16:9',duration:'10s',
  prompt:'@图片1在厕所里面捡到一块@图片2，然后放到背包里面',
  references:[{token:'@图片1'},{token:'@图片2'}]
});
assert.match(twoRefPrompt,/@图1在厕所里面捡到一块@图2/);
assert.ok(!twoRefPrompt.includes('已上传的'));
assert.ok(!twoRefPrompt.includes('请严格参考本次上传的'));
assert.equal(buildMusePrompt({
  kind:'video',ratio:'16:9',duration:'10s',prompt:'只使用@图片2',
  references:[{token:'@图片2'}]
}).includes('只使用@图1'),true,'图片按本次实际上传顺序编号');
assert.throws(()=>buildMusePrompt({kind:'video',ratio:'16:9',
  duration:'11s',prompt:'不可生成'}),/最多 10 秒/);
assert.throws(()=>buildMusePrompt({kind:'image',ratio:'invalid',prompt:'X'}),/比例/);

const browser=await chromium.launch({channel:'msedge',headless:true});
const outputDir=path.resolve('work','.tmp-muse-runner-'+crypto.randomUUID());
fs.mkdirSync(outputDir,{recursive:true});
const page=await browser.newPage({viewport:{width:1150,height:810}});
try{
  // Match the user's failure case: a full-resolution, valid PNG served at
  // Muse's promotional hero-mobile.webp URL. It must NEVER become an output.
  const promoPng=Buffer.from(await page.evaluate(()=>{
    const canvas=document.createElement('canvas');
    canvas.width=512;canvas.height=512;
    const context=canvas.getContext('2d');
    context.fillStyle='#ee1188';context.fillRect(0,0,512,512);
    return canvas.toDataURL('image/png').split(',')[1];
  }),'base64');
  await page.route('https://muse.ai/images/landing/hero-mobile@3x.webp',
    route=>route.fulfill({status:200,contentType:'image/png',body:promoPng}));
  await page.setContent([
    '<aside><div style="display:flex;align-items:center;gap:20px">',
    '<span>旁聊</span><button id="wrong-plus" title="其他操作">+</button>',
    '<button id="new-chat" aria-label="新旁聊" title="新旁聊" data-testid="hatch-chat-compose">',
    '<svg viewBox="0 0 24 24"><path d="M12 3.13C12.48 3.13 12.88 3.52 12.88 4V11.12H20C20.48 11.12 20.87 11.51 20.88 12C20.88 12.48 20.48 12.87 20 12.87H12.88V20C12.88 20.48 12.48 20.88 12 20.88C11.52 20.87 11.13 20.48 11.13 20V12.87H4C3.52 12.87 3.13 12.48 3.13 12C3.13 11.51 3.52 11.12 4 11.12H11.13V4C11.13 3.52 11.52 3.13 12 3.13Z"/></svg>',
    '</button></div></aside>',
    '<div id="promo-host"></div>',
    '<main><div id="history">旧会话内容</div><div id="ref-preview"></div>',
    '<form id="composer"><textarea id="muse-editor" data-hatch-composer-prehydration-input="true"',
    ' aria-label="消息" placeholder="消息" rows="1"></textarea>',
    '<input id="muse-attachment" type="file" multiple class="sr-only">',
    '<button type="submit">发送</button></form>',
    '<textarea placeholder="其他无关输入"></textarea></main>',
    '<script>',
    'window.newChatClicks=0;window.wrongPlusClicks=0;window.promoClicks=0;',
    'window.sent=[];window.uploaded=[];',
    'document.querySelector("#wrong-plus").onclick=()=>window.wrongPlusClicks++;',
    'document.querySelector("#new-chat").onclick=()=>{',
    'window.newChatClicks++;document.querySelector("#history").innerHTML="";',
    'document.querySelector("#ref-preview").innerHTML="";};',
    'document.querySelector("#muse-attachment").onchange=e=>{',
    'const files=[...e.target.files];window.uploaded.push(files.map(f=>f.name));',
    'files.forEach(file=>{const image=new Image();image.width=350;image.height=265;',
    'image.src=URL.createObjectURL(file);document.querySelector("#ref-preview").append(image);});};',
    'document.querySelector("#composer").onsubmit=e=>{',
    'e.preventDefault();window.sent.push(document.querySelector("#muse-editor").value);',
    'const promotion=new Image();promotion.width=560;promotion.height=460;',
    'promotion.src="https://muse.ai/images/landing/hero-mobile@3x.webp";',
    'document.querySelector("#promo-host").append(promotion);',
    'const appButton=document.createElement("button");appButton.textContent="下载应用";',
    'appButton.onclick=()=>window.promoClicks++;',
    'document.querySelector("#promo-host").append(appButton);',
    'const image=new Image();image.width=350;image.height=265;',
    'const canvas=document.createElement("canvas");canvas.width=512;canvas.height=512;',
    'const context=canvas.getContext("2d");context.fillStyle="#B8D8F0";',
    'context.fillRect(0,0,512,512);image.src=canvas.toDataURL("image/png");',
    'const assistant=document.createElement("div");',
    'assistant.setAttribute("data-message-author-role","assistant");',
    'assistant.append(image);document.querySelector("#history").append(assistant);};',
    '</script>'
  ].join(''));
  const job={kind:'image',ratio:'3:4',prompt:'画一只蓝色猫',duration:'5s'};
  const output=await runMuseBrowser({page,job,outputDir,onProgress:()=>{}});
  assert.equal(await page.evaluate(()=>window.newChatClicks),1,
    'Each generated task must click sidebar 旁聊 plus');
  assert.equal(await page.evaluate(()=>window.wrongPlusClicks),0,
    'Must not click another plus merely because it is near the 旁聊 label');
  const messages=await page.evaluate(()=>window.sent);
  assert.equal(messages.length,1);
  assert.match(messages[0],/生成图片/);
  assert.match(messages[0],/3:4/);
  assert.match(messages[0],/蓝色猫/);
  assert.match(output.mediaUrl,/^\/api\/uploads\/[a-f0-9-]+\.png$/);
  assert.ok(fs.readdirSync(outputDir).some(name=>name.endsWith('.png')));
  const received=fs.readFileSync(path.join(outputDir,path.basename(output.mediaUrl)));
  assert.notDeepEqual(received,promoPng,
    'Muse landing hero must never be captured even when larger than the generated image');
  assert.equal(await page.evaluate(()=>window.promoClicks),0,
    'Never click a mobile app download button');

  const second=await runMuseBrowser({page,job:{...job,prompt:'第二次生成独立图片'},
    outputDir,onProgress:()=>{}});
  assert.equal(await page.evaluate(()=>window.newChatClicks),2,
    'Second task must click the same sidebar plus again');
  assert.equal(await page.evaluate(()=>window.wrongPlusClicks),0);
  assert.equal((await page.evaluate(()=>window.sent)).length,2);
  assert.match(second.mediaUrl,/^\/api\/uploads\/[a-f0-9-]+\.png$/);
  assert.notEqual(second.mediaUrl,output.mediaUrl,'every task receives an independent media file');

  const attachment=path.join(outputDir,'selected-reference.png');
  const refPng=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512;
    const context=canvas.getContext('2d');context.fillStyle='orange';
    context.fillRect(0,0,512,512);return canvas.toDataURL('image/png').split(',')[1];
  });
  fs.writeFileSync(attachment,Buffer.from(refPng,'base64'));
  const refJob={...job,prompt:'参考 @图片2 制作雪山图',
    references:[{id:'connected-2',name:'第二张连接图片',
      token:'@图片2',url:'/api/uploads/selected-reference.png'}]};
  const third=await runMuseBrowser({
    page,job:refJob,outputDir,onProgress:()=>{},
    localReferenceFile:url=>url.endsWith('selected-reference.png')?attachment:null
  });
  assert.match(third.mediaUrl,/\.png$/);
  const uploads=await page.evaluate(()=>window.uploaded);
  assert.equal(uploads.length,1,'Only the referenced image must be uploaded');
  assert.deepEqual(uploads[0],['selected-reference.png']);
  assert.equal(await page.evaluate(()=>window.newChatClicks),3,
    'Reference generation also needs a fresh chat');
  assert.match((await page.evaluate(()=>window.sent)).at(-1),/@图1/);
  assert.ok(!(await page.evaluate(()=>window.sent)).at(-1).includes('@图片2'),
    'Muse text should describe the attached reference instead of an application-specific @ token');
  // When the only newly shown image is a promotional asset, fail closed.
  // The output folder must remain untouched and the app download button
  // must never be clicked by the fallback downloader.
  await clickMuseNewConversation(page);
  const previouslySaved=fs.readdirSync(outputDir).length;
  await page.evaluate(()=>{
    const promotion=new Image();
    promotion.width=560;promotion.height=460;
    promotion.src='https://muse.ai/images/landing/hero-mobile@3x.webp';
    document.querySelector('#promo-host').append(promotion);
  });
  await assert.rejects(
    ()=>waitForMuseMedia(page,{kind:'image'},outputDir,()=>{},
      {timeoutMs:2400,baseline:[]}),/未能确认新会话中由助手生成的媒体/
  );
  assert.equal(fs.readdirSync(outputDir).length,previouslySaved,
    'A promotional page with no assistant result must not create a fake output');
  assert.equal(await page.evaluate(()=>window.promoClicks),0);
  await page.locator('#new-chat').evaluate(el=>el.remove());
  await assert.rejects(()=>clickMuseNewConversation(page),/旁聊.*加号/);
  console.log('PASS: Muse independent chats, only selected image uploaded, real assistant result captured, promo hero-mobile rejected, no-result fails closed, app download never clicked');
}finally{
  await browser.close();
  fs.rmSync(outputDir,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}
