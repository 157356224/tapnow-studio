import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {requiresWebLogin,showWebLogin} from '../server/doubao-session.mjs';
import {browserLaunchOptions} from '../server/chromium-binary.mjs';

const browser=await chromium.launch({...browserLaunchOptions(),headless:true});
const page=await browser.newPage();
try{
  await page.setContent(
    '<html><body><button id="login">登录</button><div id="dialog" role="dialog" hidden>扫码或手机号登录</div>'+
    '<script>document.querySelector("#login").onclick=()=>{document.querySelector("#dialog").hidden=false;document.querySelector("#login").hidden=true;}</script></body></html>'
  );
  assert.equal(await requiresWebLogin(page),true);
  assert.equal(await showWebLogin(page),true);
  assert.equal(await page.locator('#dialog').isVisible(),true);
  assert.equal(await requiresWebLogin(page),true,
    'Login modal still requires authentication even if original button hides');
  await page.locator('#dialog').evaluate(el=>{el.hidden=true;});
  assert.equal(await requiresWebLogin(page),false,
    'After login UI disappears, session should no longer be flagged as logged out');
}finally{
  await browser.close();
}
console.log('PASS: login button recognized and login dialog opened, credentials not entered');
