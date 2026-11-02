import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../server/chromium-binary.mjs';
import {
  isVideoGenerationStartedText,inspectVideoStartReply,
  assertVideoStartReply,watchNewVideoConfirmation
} from '../server/doubao-confirmation.mjs';

const MINI='Seedance 2.0 Mini';
const FAST='Seedance 2.0 Fast';
const miniReply='本次使用 **Seedance 2.0 Mini** 生成 10 秒视频';
const fastReply='本次使用 **Seedance 2.0 Fast** 生成 5 秒视频';
assert.equal(isVideoGenerationStartedText(miniReply,MINI),true);
assert.equal(isVideoGenerationStartedText(fastReply,FAST),true);
assert.equal(isVideoGenerationStartedText(miniReply,FAST),false,
  'Wrong model should never be shown as a confirmed video start');
assert.equal(isVideoGenerationStartedText('本次使用 Seedance 2.0 Mini 生成',MINI),true);
assert.equal(isVideoGenerationStartedText('本次使用\n **Seedance 2.0 Mini** \n生成',MINI),true);
assert.equal(isVideoGenerationStartedText('我看到这句话：'+miniReply,MINI),false,
  'Quoted text in an unrelated answer cannot count as a start');
assert.equal(isVideoGenerationStartedText('确认后我再开始生成视频。',MINI),false);

const sse=parts=>parts.map(text=>[
  'event: SSE_MESSAGE',
  'data: '+JSON.stringify({message:{delta:{text}}}),
  ''
].join('\n')).join('\n')+'event: SSE_REPLY_END\ndata: {}\n\n';
const splitMini=sse(['本次使','用 **Seedance',' 2.0 Mini** 生','成 10 秒视频']);
assert.deepEqual(inspectVideoStartReply(splitMini,MINI),{
  started:true,hasReplyText:true
});
assert.deepEqual(inspectVideoStartReply(sse([fastReply]),FAST),{
  started:true,hasReplyText:true
});
assert.deepEqual(inspectVideoStartReply(sse([fastReply]),MINI),{
  started:false,hasReplyText:true
});
assert.deepEqual(inspectVideoStartReply(sse(['请修改提示词后重新发送']),MINI),{
  started:false,hasReplyText:true
});
assert.deepEqual(inspectVideoStartReply(sse(['确认后我再开始生成视频。']),MINI),{
  started:false,hasReplyText:true
});
assert.deepEqual(inspectVideoStartReply('event: SSE_ACK\ndata: {}\n\n',MINI),{
  started:false,hasReplyText:false
});
assert.deepEqual(inspectVideoStartReply(
  sse(['本次使用 **Seedance 2.0 Mini** 生成']),
  MINI
),{started:true,hasReplyText:true});
// User text embedded in a nested network payload must not be mistaken for
// an assistant generation reply.
const echoed='event: SSE_MESSAGE\ndata: '+JSON.stringify({
  message:{role:'user',content:miniReply}
})+'\n\n';
assert.equal(inspectVideoStartReply(echoed,MINI).started,false);

assert.equal(assertVideoStartReply({started:true,hasReplyText:true},MINI),true);
assert.equal(assertVideoStartReply(null,MINI),false);
assert.throws(()=>assertVideoStartReply({started:false,hasReplyText:true},MINI,
  {afterConfirmation:true}),/视频未开始生成：发送「确认」后/);
assert.throws(()=>assertVideoStartReply({started:false,hasReplyText:true},FAST),
  /视频未开始生成：豆包回复/);

const browser=await chromium.launch({...browserLaunchOptions(),headless:true});
const page=await browser.newPage();
try{
  await page.setContent([
    '<div id="history" data-message-author-role="assistant">',
    miniReply,'</div>',
    '<main id="conversation"></main>',
    '<textarea id="editor"></textarea>'
  ].join(''));
  const monitor=await watchNewVideoConfirmation(page,MINI);
  assert.equal(await monitor.started(),false,
    'Old assistant messages should not be used as current task proof');
  assert.equal(await monitor.requested(),false);
  await page.evaluate(()=>{
    const u=document.createElement('div');
    u.dataset.messageAuthorRole='user';
    u.textContent='本次使用 Seedance 2.0 Mini 生成';
    document.querySelector('#conversation').append(u);
  });
  assert.equal(await monitor.started(),false,
    'A user message must never be mistaken for assistant generation start');
  await page.evaluate(()=>{
    const a=document.createElement('div');
    a.dataset.messageAuthorRole='assistant';
    a.id='pending';
    a.textContent='确认后我再开始生成视频。';
    document.querySelector('#conversation').append(a);
  });
  assert.equal(await monitor.requested(),true);
  assert.equal(await monitor.started(),false);
  await page.evaluate(()=>{
    const a=document.createElement('div');
    a.dataset.messageAuthorRole='assistant';
    a.id='started';
    document.querySelector('#conversation').append(a);
    a.textContent='本次使用 **Seedance 2.0 Mini** 生成 10 秒视频';
  });
  assert.equal(await monitor.started(),true,
    'Monitor must keep observing after confirmation and recognize start');
  await monitor.stop();

  const fastMonitor=await watchNewVideoConfirmation(page,FAST);
  await page.evaluate(()=>{
    const a=document.createElement('div');
    a.dataset.messageAuthorRole='assistant';
    a.textContent='本次使用 **Seedance 2.0 Mini** 生成 10 秒视频';
    document.querySelector('#conversation').append(a);
  });
  assert.equal(await fastMonitor.started(),false,
    'Selected Fast cannot be confirmed by a Mini response');
  await page.evaluate(()=>{
    const a=document.createElement('div');
    a.dataset.messageAuthorRole='assistant';
    a.textContent='本次使用 **Seedance 2.0 Fast** 生成 10 秒视频';
    document.querySelector('#conversation').append(a);
  });
  assert.equal(await fastMonitor.started(),true);
  await fastMonitor.stop();
  console.log('PASS: Mini/Fast response prefix, split SSE, wrong-model rejection, confirmation follow-up, old/user messages ignored');
}finally{
  await browser.close();
}
