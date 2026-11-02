import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../server/chromium-binary.mjs';

// Public landing-page reachability only. Does not open user accounts or
// perform authentication, video generation or human verification.
const browser=await chromium.launch({
  ...browserLaunchOptions(),headless:true
});
try{
  const page=await browser.newPage();
  const reply=await page.goto('https://www.doubao.com/chat/',{
    waitUntil:'domcontentloaded',timeout:20000
  });
  assert.ok(reply&&reply.status()<400);
  console.log('PASS: system Edge loads Doubao public homepage; HTTP '+reply.status());
}finally{
  await browser.close();
}
