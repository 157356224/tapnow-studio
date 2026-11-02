import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  uploadReference,fillVideoPrompt,doubaoAttachmentPrompt,
  prepareVideoReferencesAndPrompt
} from '../server/doubao-runner.mjs';

// A second unrelated file input is deliberately mounted after the first
// upload. The client must continue choosing the image-specific input.
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'tapnow-upload-'));
const one=path.join(temp,'first.png'),two=path.join(temp,'second.png'),
  three=path.join(temp,'third.png');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
fs.writeFileSync(one,png);fs.writeFileSync(two,png);fs.writeFileSync(three,png);
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage();
const counts={prepare:0,upload:0};
const promptDuringUpload=[];
let rejectUploadAuthorization=false;
const failures=[];
page.on('pageerror',e=>failures.push(e.message));
const html=[
  '<!DOCTYPE html><html><body><h1>Video reference picker</h1>',
  '<input type="file" accept="image/png,image/jpeg,image/webp" id="images">',
  '<div id="references"></div><textarea id="prompt" placeholder="描述你想要的视频"></textarea><script>',
  'document.addEventListener("change",async event=>{',
  ' const input=event.target;if(input.id!=="images")return;',
  ' const file=input.files[0]; if(!file)return;',
  ' const auth=await fetch("/alice/resource/prepare_upload",{method:"POST"});',
  ' if(!auth.ok)return;',
  ' const upload=await fetch("/upload/v1/reference",{method:"POST",body:file});',
  ' if(!upload.ok)return;',
  ' await new Promise(resolve=>setTimeout(resolve,420));',
  ' const img=document.createElement("img");img.alt=file.name;',
  ' img.src=URL.createObjectURL(file);',
  ' document.querySelector("#references").appendChild(img);',
  ' const replacement=input.cloneNode();replacement.value="";input.replaceWith(replacement);',
  ' if(document.querySelector("#references").children.length===2){',
  '   document.querySelector("#prompt").value="";',
  ' }',
  ' if(!document.querySelector("#decoy")){',
  '   const decoy=document.createElement("input");',
  '   decoy.id="decoy";decoy.type="file";decoy.accept="video/mp4";',
  '   document.body.appendChild(decoy);',
  ' }',
  '});</script></body></html>'
].join('\n');
await page.route('https://video-uploads.local/**',async route=>{
  const pathname=new URL(route.request().url()).pathname;
  if(pathname==='/upload-test'){
    await route.fulfill({contentType:'text/html',body:html});
  }else if(pathname==='/alice/resource/prepare_upload'){
    counts.prepare++;
    await route.fulfill({
      status:rejectUploadAuthorization?403:200,
      contentType:'application/json',body:'{"ok":true}'
    });
  }else if(pathname==='/upload/v1/reference'){
    counts.upload++;
    promptDuringUpload.push(await page.locator('#prompt').inputValue());
    await route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});
  }else await route.abort();
});
try{
  await page.goto('https://video-uploads.local/upload-test');
  const refs=[
    {kind:'image',name:'First image',url:'/api/uploads/first.png'},
    {kind:'image',name:'Second image',url:'/api/uploads/second.png'},
    {kind:'image',name:'Third image',url:'/api/uploads/third.png'}
  ];
assert.equal(doubaoAttachmentPrompt('@图片3 之后 @图片1',[
  {token:'@图片1'},{token:'@图片3'}
]),'@图2 之后 @图1','Prompt labels must match actual attachment indices');
assert.equal(doubaoAttachmentPrompt('只参考 @图片2',[{token:'@图片2'}]),
  '只参考 @图1','One selected image maps to attachment slot 1');
assert.throws(()=>doubaoAttachmentPrompt('@图片2',[{token:'@图片1'}]),/未包含/);
  const prompt='按 @图片1、@图片2、@图片3 的顺序构成连续电影镜头';
  const lookup=url=>url.endsWith('/first.png')?one:
    url.endsWith('/second.png')?two:three;
  const progress=[];
  await prepareVideoReferencesAndPrompt({
    page,job:{prompt,references:refs.map((ref,i)=>({...ref,token:'@图片'+(i+1)}))},
    localReferenceFile:lookup,onProgress:(message)=>progress.push(message)
  });
  assert.equal(await page.locator('#prompt').inputValue(),
    '按 @图1、@图2、@图3 的顺序构成连续电影镜头',
    'Prompt must be written after all references have been uploaded');
  assert.deepEqual(promptDuringUpload,['','',''],
    'Do not write or validate the prompt before any reference upload');
  assert.ok(progress.indexOf('参考图片就绪，正在填写视频提示词')>
    progress.indexOf('参考图片已确认 3/3'),
    'Prompt stage must come after every upload confirmation');
  assert.equal(counts.prepare,3,'Each reference requires its own upload authorization');
  assert.equal(counts.upload,3,'Every reference must complete its upload');
  assert.equal(await page.locator('#references img').count(),3,
    'All three thumbnails must appear before any generation submit');
  assert.equal(await page.locator('#decoy').count(),1);
  // An upload failure should be reported before any prompt is inserted, and
  // must never cause a generation request with missing reference pictures.
  rejectUploadAuthorization=true;
  await page.setContent(html);
  await assert.rejects(
    ()=>prepareVideoReferencesAndPrompt({
      page,job:{prompt,references:refs.map((ref,i)=>({...ref,token:'@图片'+(i+1)}))},
      localReferenceFile:lookup,onProgress:()=>{}
    }),
    /第 1\/3 张参考图上传未完成.*403/,
    'A rejected image upload must stop before the prompt is submitted'
  );
  assert.equal(await page.locator('#prompt').inputValue(),'',
    'Do not fill the prompt when the first reference was not uploaded');
  assert.deepEqual(failures,[]);
  console.log('PASS: three images before prompt, remounted picker, delayed thumbnails, @ mappings; failed upload blocks prompt and submission');
}finally{
  await browser.close();
  fs.rmSync(temp,{recursive:true,force:true});
}
