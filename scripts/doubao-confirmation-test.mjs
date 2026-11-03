import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../server/chromium-binary.mjs';
import {
  isVideoConfirmationRequest,hasVideoConfirmationInResponse,
  inspectPostConfirmationGenerateCue,shouldSendPostConfirmationGenerate,
  watchNewVideoConfirmation
} from '../server/doubao-confirmation.mjs';
import {sendVideoConfirmation,sendVideoGenerate} from '../server/doubao-runner.mjs';

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

const assistantStream=parts=>parts.map(text=>
  'event: SSE_MESSAGE\ndata: '+JSON.stringify({message:{delta:{text}}})+'\n\n'
).join('')+'event: SSE_REPLY_END\ndata: {}\n\n';
const screenshotReply1='好的，已确认全部设定，现在启动视频生成：\n'+
  '✅ 角色：陆沉（图2）\n✅ 规格：10s | 16:9 | 24fps\n'+
  '✅ 场景：雨夜办公室\n正在生成，请稍等片刻。';
const screenshotReply2='收到，已经确认全部设定，现在开始生成这条 10 秒写实剧情视频：\n'+
  '✅ 角色锁定：陆沉（图1）\n✅ 场景：落地窗外细雨\n'+
  '正在渲染，请稍等片刻。';
assert.equal(inspectPostConfirmationGenerateCue(
  assistantStream([screenshotReply1.slice(0,32),screenshotReply1.slice(32)])),true);
assert.equal(inspectPostConfirmationGenerateCue(
  assistantStream([screenshotReply2])),true);
assert.equal(inspectPostConfirmationGenerateCue(
  assistantStream(['已经确认参数，请稍等片刻。'])),true,
  'Any complete non-start reply should trigger, with or without ✅');
assert.equal(inspectPostConfirmationGenerateCue(
  assistantStream(['✅设定已经确认'])),true,
  'The presence of ✅ is irrelevant to the new decision');
assert.equal(inspectPostConfirmationGenerateCue(
  assistantStream(['请修改提示词后重试。'])),true);
assert.equal(inspectPostConfirmationGenerateCue(
  assistantStream(['生成任务已经开始'])),true);
assert.equal(inspectPostConfirmationGenerateCue(
  assistantStream(['收到，参数和图片已经锁定，正在生成中。'])),true,
  'No fixed emoji or wait phrase is required');
assert.equal(inspectPostConfirmationGenerateCue(
  assistantStream(['本次使用 **Seedance 2.0 Mini** 生成 10 秒视频'])),false,
  'A genuine Seedance start acknowledgement must suppress the follow-up');
assert.equal(inspectPostConfirmationGenerateCue(
  assistantStream(['本次使用 **Seedance 2.0 Fast** 生成 10 秒视频'])),false,
  'A wrong-model Seedance acknowledgement must not trigger duplicate generation');
assert.equal(inspectPostConfirmationGenerateCue(
  assistantStream(['本次使','用 **Seedance',' 2.0 Mini** 生成 10 秒视频'])),false,
  'Split streaming fragments must be joined before deciding');
assert.equal(inspectPostConfirmationGenerateCue(
  'event: SSE_MESSAGE\ndata: '+
    JSON.stringify({message:{role:'user',content:screenshotReply1}})+'\n\n'),false,
  'An echoed user message must never influence the decision');
assert.equal(inspectPostConfirmationGenerateCue(
  assistantStream([])),false);
assert.equal(inspectPostConfirmationGenerateCue(
  'event: SSE_ACK\ndata: {}\n\n'),false,
  'An empty acknowledgement must not trigger the follow-up');
const followUpReply={hasReplyText:true,started:false,needsGenerate:true};
assert.equal(shouldSendPostConfirmationGenerate({
  confirmationSent:true,reply:followUpReply
}),true);
assert.equal(shouldSendPostConfirmationGenerate({
  confirmationSent:false,reply:followUpReply
}),false,'Never send 生成 before the real confirmation request');
assert.equal(shouldSendPostConfirmationGenerate({
  confirmationSent:true,generateSent:true,reply:followUpReply
}),false,'Never send 生成 twice');
assert.equal(shouldSendPostConfirmationGenerate({
  confirmationSent:true,videoStarted:true,reply:followUpReply
}),false,'No follow-up after video start is confirmed');
assert.equal(shouldSendPostConfirmationGenerate({
  confirmationSent:true,reply:{...followUpReply,hasReplyText:false}
}),false,'The current confirmation must have a nonempty completed assistant reply');
assert.equal(shouldSendPostConfirmationGenerate({
  confirmationSent:true,reply:{...followUpReply,started:true}
}),false,'Already-started assistant reply must not cause a follow-up');

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
  // A follow-up is a new single POST containing only "生成".
  await sendVideoGenerate(page,(message,progress)=>{
    messages.push({message,progress});
  });
  assert.equal(sent,2,'Exactly one follow-up generation request should be submitted');
  assert.equal(submittedText,'生成','The follow-up must contain only 生成');
  assert.ok(messages.some(m=>m.progress===43));
  const second=await watchNewVideoConfirmation(page);
  assert.equal(await second.requested(),false,
    'Re-arming should never inherit a prior task\'s confirmation state');
  await second.stop();
  console.log('PASS: confirmation and single 生成 POST, any completed non-Seedance reply, empty/user/start replies ignored');
}finally{
  await browser.close();
}
