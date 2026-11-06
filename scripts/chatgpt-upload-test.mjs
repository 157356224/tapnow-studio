import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import {chromium} from 'playwright';
import {runChatGPTBrowser,uploadChatGPTReferences} from '../server/chatgpt-runner.mjs';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'tapnow-chatgpt-ref-'));
const png=path.join(temp,'one.png');
const png2=path.join(temp,'two.png');
const ff=spawnSync(ffmpeg,[
  '-y','-hide_banner','-loglevel','error',
  '-f','lavfi','-i','color=c=blue:s=512x512:d=0.2',
  '-frames:v','1',png
],{encoding:'utf8'});
assert.equal(ff.status,0,ff.stderr);
fs.copyFileSync(png,png2);
const refs=[
  {id:'first',name:'图片1',kind:'image',file:png},
  {id:'second',name:'图片2',kind:'image',file:png2}
];
const source='data:image/png;base64,'+fs.readFileSync(png).toString('base64');
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage();
  await page.setContent('<form id="composer">'+
    '<div id="prompt-textarea" contenteditable="true" role="textbox"></div>'+
    '<button id="plus" type="button" data-testid="composer-plus-btn">+</button>'+
    '<button type="button" data-testid="send-button">发送</button>'+
    '</form>');
  await page.evaluate(imageSource=>{
    window.uploadedNames=[];
    window.sentNames=[];
    const form=document.querySelector('#composer');
    document.querySelector('#plus').onclick=()=>{
      if(form.querySelector('input[type="file"]'))return;
      const picker=document.createElement('input');
      picker.type='file';picker.accept='image/png';picker.hidden=true;
      picker.onchange=()=>{
        const files=[...picker.files];
        for(const file of files){
          window.uploadedNames.push(file.name);
          const status=document.createElement('div');
          status.setAttribute('role','status');
          status.setAttribute('aria-label','Uploading image');
          status.textContent='Uploading image';
          form.append(status);
          setTimeout(()=>{
            status.remove();
            const thumbnail=document.createElement('img');
            thumbnail.alt='已上传 '+file.name;
            thumbnail.src=imageSource;
            thumbnail.width=52;thumbnail.height=52;
            form.append(thumbnail);
          },240);
        }
        picker.value='';
      };
      form.append(picker);
    };
    document.querySelector('[data-testid="send-button"]').onclick=()=>{
      window.sentNames=[...window.uploadedNames];
      const section=document.createElement('section');
      section.setAttribute('data-message-author-role','assistant');
      const img=document.createElement('img');
      img.src=imageSource;img.alt='生成结果';
      img.width=512;img.height=512;
      section.append(img);document.body.append(section);
    };
  },source);
  const states=[];
  const result=await runChatGPTBrowser({
    page,job:{prompt:'参考 @图片1 和 @图片2，生成角色图',ratio:'16:9'},
    outputDir:temp,navigate:false,intervalMs:50,timeoutMs:5000,
    references:refs,onProgress:state=>states.push(state)
  });
  const actual=await page.evaluate(()=>({
    uploaded:window.uploadedNames,sent:window.sentNames,
    prompt:document.querySelector('#prompt-textarea').textContent,
    previews:document.querySelectorAll('#composer img').length
  }));
  assert.deepEqual(actual.uploaded,['one.png','two.png']);
  assert.deepEqual(actual.sent,['one.png','two.png'],
    'The send click must happen only after BOTH references attached');
  assert.equal(actual.previews,2);
  assert.match(actual.prompt,/已上传的参考图片 1/);
  assert.match(actual.prompt,/已上传的参考图片 2/);
  assert.ok(states.some(state=>/已确认 2 张参考图/.test(state.message)));
  assert.ok(fs.existsSync(path.join(temp,path.basename(result.mediaUrl))));
  console.log('PASS: lazy ChatGPT plus-menu input, sequential 2-image upload, asynchronous previews before send');
  await page.close();

  const menuPage=await browser.newPage();
  await menuPage.setContent('<form id="composer">'+
    '<div id="prompt-textarea" contenteditable="true" role="textbox"></div>'+
    '<button id="plus" type="button" data-testid="composer-plus-btn">+</button></form>');
  await menuPage.evaluate(imageSource=>{
    const form=document.querySelector('#composer');
    document.querySelector('#plus').onclick=()=>{
      const menu=document.createElement('div');
      menu.setAttribute('role','menu');
      const item=document.createElement('button');
      item.type='button';item.setAttribute('role','menuitem');
      item.textContent='上传文件';
      item.onclick=()=>{
        const input=document.createElement('input');
        input.type='file';input.accept='image/png';
        input.style.display='none';form.append(input);
        input.onchange=()=>{
          const img=document.createElement('img');
          img.src=imageSource;img.width=50;img.height=50;
          form.append(img);
        };
        input.click();
      };
      menu.append(item);form.append(menu);
    };
  },source);
  await uploadChatGPTReferences(menuPage,refs.slice(0,1),null,{
    confirmTimeoutMs:4500,pollMs:50
  });
  assert.equal(await menuPage.locator('#composer img').count(),1);
  console.log('PASS: plus menu > upload file > native filechooser > composer preview');
  await menuPage.close();

  const failed=await browser.newPage();
  await failed.setContent('<form><div id="prompt-textarea" contenteditable="true" role="textbox"></div>'+
    '<input type="file" accept="image/*" />'+
    '<button data-testid="send-button" type="button">发送</button></form>');
  await failed.evaluate(()=>{
    window.sent=false;
    document.querySelector('[data-testid="send-button"]').onclick=()=>{window.sent=true;};
  });
  await assert.rejects(
    runChatGPTBrowser({
      page:failed,job:{prompt:'参考 @图片1 绘制图像'},navigate:false,
      outputDir:temp,references:refs.slice(0,1),
      referenceUploadTimeoutMs:550,timeoutMs:1300
    }),
    /未确认第 1\/1 张参考图已加入输入框/
  );
  assert.equal(await failed.evaluate(()=>window.sent),false,
    'Never send the prompt when the browser has not shown a reference image');
  console.log('PASS: missing upload previews stop prompt submission without losing references');
  await failed.close();
}finally{
  await browser.close();
  fs.rmSync(temp,{recursive:true,force:true});
}
