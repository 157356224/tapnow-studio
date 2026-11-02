import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {
  accountProfileDir,browserLaunchOptions
} from '../server/chromium-binary.mjs';

const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.join(base,'work','edge-engine-check-'+process.pid);
const account={id:'temporary',browserEngine:'edge'};
const edgeProfile=accountProfileDir(dir,account);
const legacyProfile=path.join(dir,'temporary');
assert.notEqual(edgeProfile,legacyProfile);
assert.equal(accountProfileDir(dir,{id:'temporary',browserEngine:'portable'}),edgeProfile,
  'Legacy account metadata must migrate to Edge without using old Chrome profile');
assert.ok(!fs.existsSync(dir),'Temporary browser directory already exists');
let context;
try{
  context=await chromium.launchPersistentContext(edgeProfile,{
    ...browserLaunchOptions(),headless:true
  });
  const page=context.pages()[0]||await context.newPage();
  await page.goto('data:text/html,<title>Edge account test</title>');
  assert.equal(await page.title(),'Edge account test');
  assert.ok(Number(context.browser().version().split('.')[0])>=150);
  assert.equal(fs.existsSync(legacyProfile),false);
  await context.addCookies([{
    name:'local_account_test',value:'edge_only',
    url:'https://example.com/'
  }]);
  const cookie=await context.cookies('https://example.com/');
  assert.equal(cookie.find(x=>x.name==='local_account_test')?.value,'edge_only');
  console.log('PASS: system Edge automation launches with separate profile, legacy Chrome folder unchanged');
  console.log('EDGE_VERSION='+context.browser().version());
}finally{
  await context?.close();
  fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}
