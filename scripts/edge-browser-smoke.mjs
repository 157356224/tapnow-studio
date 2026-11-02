import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {
  accountEngine,accountProfileDir,browserLaunchOptions,nativeBrowserExecutable
} from '../server/chromium-binary.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=path.join(root,'work','edge-isolation-test-'+process.pid);
const first=accountProfileDir(base,{id:'first'});
const second=accountProfileDir(base,{id:'second'});
assert.equal(accountEngine(), 'edge');
assert.equal(accountEngine({browserEngine:'portable'}),'edge');
assert.notEqual(first,second);
assert.equal(browserLaunchOptions().channel,'msedge');
assert.equal(browserLaunchOptions().chromiumSandbox,true);
assert.ok(fs.existsSync(nativeBrowserExecutable()));
assert.throws(()=>nativeBrowserExecutable('portable'),/仅支持系统/);
let a,b;
try{
  a=await chromium.launchPersistentContext(first,{...browserLaunchOptions(),headless:true});
  b=await chromium.launchPersistentContext(second,{...browserLaunchOptions(),headless:true});
  const page=a.pages()[0]||await a.newPage();
  await page.goto('data:text/html,<title>Edge isolated profile</title>');
  assert.equal(await page.title(),'Edge isolated profile');
  await a.addCookies([{name:'isolated',value:'account_one',
    url:'https://example.com/'}]);
  assert.equal((await a.cookies('https://example.com/'))
    .find(x=>x.name==='isolated')?.value,'account_one');
  assert.ok(!(await b.cookies('https://example.com/'))
    .some(x=>x.name==='isolated'));
  console.log('PASS: system Edge, sandbox enabled, independent account profiles');
  console.log('VERSION='+a.browser().version());
}finally{
  await b?.close();
  await a?.close();
  fs.rmSync(base,{recursive:true,force:true,maxRetries:8,retryDelay:200});
}
