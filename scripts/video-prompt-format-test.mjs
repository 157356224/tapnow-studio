import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../server/chromium-binary.mjs';
import {BLOCK_ELEMENTS,serializePromptEditor} from '../src/prompt-editor-text.mjs';

const browser=await chromium.launch({...browserLaunchOptions(),headless:true});
const page=await browser.newPage();
try{
  await page.setContent([
    '<div id="editor" class="tn-compose-editor" contenteditable="true">',
    '<p>【角色引用定义｜最高优先级】</p>',
    '<p>@图片1 = <strong>陆沉</strong></p>',
    '<p>年轻男性，黑色短发，黑色修身西装</p>',
    '<p><br></p>',
    '<p>【全局控制】</p>',
    '<p>视频时长15秒，16:9横屏，24fps</p>',
    '<div><span class="tn-inline-ref" data-token="@图片2">图片2</span> 林晚</div>',
    '</div>'
  ].join(''));
  await page.addStyleTag({
    content:readFileSync(new URL('../src/style-refinements.css',import.meta.url),'utf8')
  });
  await page.addScriptTag({
    content:'const BLOCK_ELEMENTS = new Set('+JSON.stringify([...BLOCK_ELEMENTS])+');'+
      'window.serializePromptEditor = '+serializePromptEditor.toString()
  });
  const formatted=await page.locator('#editor').evaluate(
    element=>window.serializePromptEditor(element,true)
  );
  assert.equal(formatted,
    '【角色引用定义｜最高优先级】\n'+
    '@图片1 = 陆沉\n'+
    '年轻男性，黑色短发，黑色修身西装\n\n'+
    '【全局控制】\n'+
    '视频时长15秒，16:9横屏，24fps\n'+
    '@图片2 林晚\n',
    'P/DIV paragraphs, blank lines, inline formatting and atomic @ chips must survive serialization');

  const persisted=JSON.parse(JSON.stringify({prompt:formatted})).prompt;
  assert.equal(persisted,formatted,'Project JSON persistence must preserve prompt newlines');
  await page.locator('#editor').evaluate((element,prompt)=>{
    element.replaceChildren(document.createTextNode(prompt));
  },persisted);
  assert.equal(await page.locator('#editor').evaluate(
    element=>getComputedStyle(element).whiteSpace
  ),'pre-wrap','Restored prompts must render their saved line breaks');
  assert.equal(await page.locator('#editor').textContent(),persisted,
    'Restoring a project must not flatten the saved prompt text');

  await page.locator('#editor').evaluate(element=>{
    element.replaceChildren(document.createTextNode('第一行\n第二行\n\n第三行'));
  });
  assert.equal(await page.locator('#editor').evaluate(
    element=>window.serializePromptEditor(element,true)
  ),'第一行\n第二行\n\n第三行',
  'Newlines in plain pasted text must remain unchanged');

  await page.locator('#editor').evaluate(element=>{
    element.innerHTML='<div>第一段</div><div>第二段</div>';
  });
  assert.equal(await page.locator('#editor').evaluate(
    element=>window.serializePromptEditor(element,true)
  ),'第一段\n第二段\n','Nested DIV blocks must retain paragraph boundaries');
  console.log('PASS: rich paragraphs, blank lines, DIV blocks, pasted newlines and @ reference chips survive prompt serialization');
}finally{
  await browser.close();
}
