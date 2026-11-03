import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {doubaoAttachmentPrompt,uploadAudioReference} from '../server/doubao-runner.mjs';
import {buildMusePrompt,uploadMuseReferences} from '../server/muse-runner.mjs';
import {validateMediaReferences} from '../server/doubao-protocol.mjs';

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'tapnow-audio-ref-'));
const sound=path.join(tmp,crypto.randomUUID()+'.wav');
const picture=path.join(tmp,crypto.randomUUID()+'.png');
fs.writeFileSync(sound,Buffer.from('49443303000000000000','hex'));
fs.writeFileSync(picture,Buffer.from('89504e470d0a1a0a','hex'));
const refs=[
  {id:'pic',kind:'image',name:'封面',token:'@图片1',url:'/api/uploads/a.png'},
  {id:'snd',kind:'audio',name:'配音节点',token:'@音频1',url:'/api/uploads/a.wav'}
];
const local=url=>url.endsWith('.wav')?sound:picture;
assert.equal(validateMediaReferences(refs),true);
assert.equal(doubaoAttachmentPrompt('听 @音频1，参考 @图片1',refs),'听 配音节点，参考 @图1');
assert.equal(doubaoAttachmentPrompt('@音频1内的声音',[{
  ...refs[1],name:'speak-faster-no-time.mp3'
}]),'speak-faster-no-time.mp4内的声音');
assert.equal(doubaoAttachmentPrompt('先 @音频1，再 @音频1',[{
  ...refs[1],name:'speech.MP3'
}]),'先 speech.mp4，再 speech.mp4');
assert.match(buildMusePrompt({kind:'video',ratio:'16:9',duration:'5s',
  prompt:'配合 @音频1 和 @图片1',references:refs}),/已上传的参考音频「配音节点」 和 @图1/);

const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage();
try{
  await page.setContent('<form><textarea aria-label="消息"></textarea>'+
    '<input type="file" multiple accept="image/*,audio/*" id="f"></form>'+
    '<div id="previews"></div><script>f.onchange=e=>{'+
    'for(const file of e.target.files){const element=document.createElement(file.type.startsWith("audio/")?"audio":"img");'+
    'element.setAttribute("data-file",file.name);document.querySelector("#previews").append(element);}' +
    '};</script>');
  await uploadMuseReferences(page,refs,local,()=>{});
  assert.equal(await page.locator('#previews audio').count(),1);
  assert.equal(await page.locator('#previews img').count(),1);
  await page.locator('#f').evaluate(el=>el.accept='image/*');
  await assert.rejects(()=>uploadMuseReferences(page,refs,local,()=>{}),/没有声明支持音频/);

  await page.route('https://audio-upload.local/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname==='/test'){
      await route.fulfill({contentType:'text/html',body:'<input id="audio" type="file" accept="audio/*">'+
        '<div id="attachments"></div><script>document.querySelector("#audio").onchange=async e=>{'+
        'const file=e.target.files[0];'+
        'await fetch("/alice/resource/prepare_upload",{method:"POST"});'+
        'await fetch("/upload/v1/reference",{method:"POST",body:file});'+
        'await fetch("/resource/pre_handle",{method:"POST"});'+
        'const player=document.createElement("audio");player.controls=true;'+
        'document.querySelector("#attachments").append(player);};</script>'});
    }else await route.fulfill({status:200,body:'OK'});
  });
  await page.goto('https://audio-upload.local/test');
  await uploadAudioReference(page,refs[1],local,()=>{});
  assert.equal(await page.locator('#attachments audio').count(),1);
  console.log('PASS: audio references, Muse upload confirmation/rejection, Doubao audio upload acknowledgement');
}finally{
  await browser.close();
  fs.rmSync(tmp,{recursive:true,force:true});
}
