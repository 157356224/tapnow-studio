import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
const accounts=[];
let createdBody=null;
let nativeLoginCalls=0;
const accountId='00000000-0000-4000-8000-000000000001';
try{
  await page.route('**/api/doubao/accounts',async route=>{
    if(route.request().method()==='POST'){
      createdBody=route.request().postDataJSON();
      const a={id:accountId,name:createdBody.name,hasCookie:false,
        createdAt:new Date().toISOString(),browserEngine:'edge',profile:'isolated-chromium'};
      accounts.push(a);
      return route.fulfill({status:201,contentType:'application/json',body:JSON.stringify(a)});
    }
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(accounts)});
  });
  await page.route('**/api/doubao/accounts/*/native-login',route=>{
    nativeLoginCalls++;
    return route.fulfill({status:200,contentType:'application/json',
      body:JSON.stringify({ok:true,browserEngine:'edge',message:'独立 Edge 已打开，请手动登录'})});
  });
  await page.goto(process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5173/',{waitUntil:'domcontentloaded'});
  await page.locator('button[title="豆包账号与独立浏览器设置"]').click();
  await page.getByText('新建独立豆包浏览器账号').waitFor();
  assert.equal(await page.locator('textarea[aria-label="豆包账号 Cookie"]').count(),0);
  await page.locator('input[aria-label="豆包账号备注"]').fill('TEST_MANUAL_LOGIN');
  await page.getByRole('button',{name:'创建账号并打开浏览器登录'}).click();
  await page.getByText('独立 Edge 已打开，请手动登录').waitFor();
  for(const obsolete of ['.doubao-quota-row','.doubao-native-login',
    '.doubao-browser-maintenance','.doubao-network-diagnostics']){
    assert.equal(await page.locator(obsolete).count(),0,obsolete+' must be removed');
  }
  assert.deepEqual(createdBody,{name:'TEST_MANUAL_LOGIN'});
  assert.equal(nativeLoginCalls,1);
  await page.locator('.doubao-account-entry .doubao-login-button').click();
  assert.equal(nativeLoginCalls,2,'Account login button must use the native Edge login endpoint');
  console.log('PASS: no Cookie field, browser-only create payload, both login actions use native Edge');
}finally{
  await browser.close();
}
