import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../server/chromium-binary.mjs';
import {
  isVideoConfirmationRequest,hasVideoConfirmationInResponse,
  watchNewVideoConfirmation
} from '../server/doubao-confirmation.mjs';
import {sendVideoConfirmation} from '../server/doubao-runner.mjs';

assert.equal(isVideoConfirmationRequest('确认后我再开始生成视频。'),true);
assert.equal(isVideoConfirmationRequest('确认后\n我再开始生成视频。'),true);
assert.equal(isVideoConfirmationRequest('视频将稍后开始生成。'),false);
assert.equal(isVideoConfirmationRequest('请提供手机验证码再开始生成视频'),false);
assert.equal(isVideoConfirmationRequest('请确认是否保存文件'),false);
const streaming=[
  'event: SSE_MESSAGE',
  'data: '+JSON.stringify({message:{delta:{text:'确认后我再'}}}),
  '',
  'event: SSE_MESSAGE',
  'data: '+JSON.stringify({message:{delta:{text:'开始生成视频。'}}}),
  '',
  'event: SSE_REPLY_END',
  'data: {}',
  ''
].join('\n');
assert.equal(hasVideoConfirmationInResponse(streaming),true,
  'The request must be recognized even when split across SSE JSON events');
assert.equal(hasVideoConfirmationInResponse(
  'event: SSE_MESSAGE\ndata: {"text":"开始生成任务"}\n\n'),false);

const browser=await chromium.launch({...browserLaunchOptions(),headless:true});
const page=await browser.newPage();
let sent=0;
let submittedText='';
const messages=[];
try{
  await page.setContent([
    '<section id="history">',
    '<div data-message-author-role="assistant" id="old">确认后我再开始生成视频。</div>',
    '</section>',
    '<div id="conversation"></div>',
    '<textarea id="composer"></textarea>',
    '<button type="submit" id="send">发送</button>',
    '<script>',
    'document.querySelector("#send").onclick=()=>{',
    '  fetch("https://www.doubao.com/chat/completion",{method:"POST",',
    '    body:JSON.stringify({text:document.querySelector("#composer").value})',
    '  }).catch(()=>{});',
    '};',
    '</script>'
  ].join(''));
  await page.route('https://www.doubao.com/chat/completion',async route=>{
    sent++;
    submittedText=JSON.parse(route.request().postData()).text;
    await route.fulfill({
      status:200,contentType:'application/json',body:'{"ok":true}'
    });
  });
  const monitor=await watchNewVideoConfirmation(page);
  assert.equal(await monitor.requested(),false,
    'An older matching assistant message is not a new confirmation request');
  await page.evaluate(()=>{
    const oldUser=document.createElement('div');
    oldUser.dataset.messageAuthorRole='user';
    oldUser.textContent='我听说豆包会问：确认后我再开始生成视频。';
    document.querySelector('#conversation').appendChild(oldUser);
  });
  assert.equal(await monitor.requested(),false,
    'Quoting the phrase in a user message must not trigger auto-confirmation');
  await page.evaluate(()=>{
    const assistant=document.createElement('div');
    assistant.dataset.messageAuthorRole='assistant';
    assistant.id='new-reply';
    document.querySelector('#conversation').appendChild(assistant);
    assistant.textContent='比例 16:9，时长 10 秒。确认后我再开始生成视频。';
  });
  assert.equal(await monitor.requested(),true,
    'Only a newly added assistant message can request auto-confirmation');
  await sendVideoConfirmation(page,(message,progress)=>{
    messages.push({message,progress});
  });
  assert.equal(sent,1,'Send exactly one confirmation message');
  assert.equal(submittedText,'确认','Send the exact two requested characters');
  assert.ok(messages.some(m=>m.progress===40));
  await monitor.stop();
  await page.evaluate(()=>{
    document.querySelector('#new-reply').textContent=
      '确认后我再开始生成视频。确认后我再开始生成视频。';
  });
  assert.equal(sent,1,'Further repeated text cannot cause a second send');
  const second=await watchNewVideoConfirmation(page);
  assert.equal(await second.requested(),false,
    'Re-arming should never inherit a prior task\'s confirmation state');
  await second.stop();
  console.log('PASS: exact generation confirmation, split SSE, no historical/user triggers, single actual POST containing only 确认');
}finally{
  await browser.close();
}
