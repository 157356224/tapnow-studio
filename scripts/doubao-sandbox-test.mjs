import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../server/chromium-binary.mjs';
const context=await chromium.launchPersistentContext('',{
  ...browserLaunchOptions(),headless:true,
  args:['--no-first-run','--no-default-browser-check']
});
try{
  const page=context.pages()[0]||await context.newPage();
  await page.goto('edge://version');
  const commandLine=await page.locator('#command_line').textContent();
  assert.ok(commandLine?.includes('msedge.exe'),
    'Edge version page must expose active command line');
  assert.doesNotMatch(commandLine,/--no-sandbox\b/,
    'System Edge must not start with --no-sandbox');
  await page.goto('data:text/html,<title>Sandbox enabled</title>');
  assert.equal(await page.title(),'Sandbox enabled');
  console.log('PASS: system Edge starts with sandbox enabled and no --no-sandbox flag');
}finally{
  await context.close();
}
