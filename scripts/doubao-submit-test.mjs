import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../server/chromium-binary.mjs';
import {findSendButton,submitAndObserve} from '../server/doubao-submit.mjs';

const browser=await chromium.launch({...browserLaunchOptions(),headless:true});
const page=await browser.newPage();
try{
  await page.setContent('<button disabled id="send">发送</button>');
  await assert.rejects(()=>findSendButton(page,null,{timeout:250}),/禁用/);
  await page.evaluate(()=>{
    setTimeout(()=>{document.querySelector('#send').disabled=false;},250);
  });
  const ready=await findSendButton(page,null,{timeout:1500});
  assert.equal(await ready.getAttribute('id'),'send',
    'Delayed enabled button must be awaited instead of rejected immediately');
  await ready.evaluate(el=>el.disabled=true);
  // Crucial regression: a failed click must not leave a rejected
  // waitForRequest promise that crashes the Node backend 20 s later.
  await assert.rejects(
    ()=>submitAndObserve(page,page.locator('#send'),{timeout:250}),
    /not enabled|Timeout|timeout/i
  );
  await new Promise(resolve=>setTimeout(resolve,450));

  await page.locator('#send').evaluate(el=>el.disabled=false);
  await assert.rejects(
    ()=>submitAndObserve(page,page.locator('#send'),{timeout:250}),
    /未观察到视频提交请求/
  );
  assert.equal(page.listenerCount('request'),0,'Request observer must be removed');
  await new Promise(resolve=>setTimeout(resolve,450));

  await page.route('https://www.doubao.com/chat/completion',async route=>{
    await route.fulfill({
      status:200,contentType:'application/json',
      body:'{"ok":true}'
    });
  });
  await page.locator('#send').evaluate(el=>{
    el.onclick=()=>{void fetch('https://www.doubao.com/chat/completion',{
      method:'POST',body:'{"synthetic":true}'
    });};
  });
  const sent=await findSendButton(page);
  const request=await submitAndObserve(page,sent,{timeout:1000});
  assert.equal(request.method(),'POST');
  assert.equal(new URL(request.url()).pathname,'/chat/completion');
  assert.equal(page.listenerCount('request'),0);
  // Icon-only send actions must be discoverable near the active text editor.
  await page.setContent([
    '<div style="position:relative;width:420px;height:160px">',
    '<textarea id="prompt" style="width:340px;height:100px">镜头推进</textarea>',
    '<button class="send-button" id="icon-send" aria-label="提交" style="position:absolute;right:4px;bottom:4px">',
    ' <svg class="arrow-up" width="16" height="16"><path d="M8 16V0"/></svg>',
    '</button></div>'
  ].join(''));
  const iconSend=await findSendButton(page,page.locator('#prompt'));
  assert.equal(await iconSend.getAttribute('id'),'icon-send');
  console.log('PASS: disabled send, no-request timeout, fake intercepted POST; no unhandled observer rejection');
}finally{
  await browser.close();
}
