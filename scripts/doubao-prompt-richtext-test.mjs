import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {fillVideoPrompt} from '../server/doubao-runner.mjs';
import {browserLaunchOptions} from '../server/chromium-binary.mjs';

const browser=await chromium.launch({...browserLaunchOptions(),headless:true});
const page=await browser.newPage();
try{
  const prompt='镜头从树林向上移动，参考 @图1，时长 10 秒';
  await page.setContent([
    '<!doctype html><div contenteditable="true" style="display:none">旧聊天</div>',
    '<textarea id="composer" placeholder="视频提示词"></textarea>'
  ].join(''));
  await fillVideoPrompt(page,prompt);
  assert.equal(await page.locator('#composer').inputValue(),prompt,
    'A regular textarea should keep the full prompt exactly');

  // Doubao-style rich editors may transform @ mentions into atomic widgets
  // and insert non-breaking/zero-width spaces after the input event.
  await page.setContent([
    '<!doctype html><div contenteditable="true" id="rich" role="textbox"></div>',
    '<script>',
    'const rich=document.querySelector("#rich");',
    'rich.addEventListener("input",()=>setTimeout(()=>{',
    ' rich.innerHTML="<p>镜头从树林向上移动，参考&nbsp;"+',
    '  "<span contenteditable=\\"false\\" aria-label=\\"@图1\\">图1</span>"+',
    '  "，时长&nbsp;10&nbsp;秒</p>";',
    '},20));',
    '</script>'
  ].join(''));
  await fillVideoPrompt(page,prompt);
  assert.equal(await page.locator('#rich [aria-label="@图1"]').count(),1,
    'Rich-text mention should be accepted from the live editor DOM');

  await page.setContent([
    '<!doctype html><div contenteditable="true" id="rich" role="textbox"></div>',
    '<script>',
    'document.querySelector("#rich").addEventListener("input",()=>{',
    ' setTimeout(()=>document.querySelector("#rich").textContent="只剩一个短句",25);',
    '});',
    '</script>'
  ].join(''));
  await assert.rejects(
    ()=>fillVideoPrompt(page,prompt),
    /视频提示词未完整保留/,
    'An actually truncated prompt must still block submission'
  );
  assert.equal(await page.locator('#rich').textContent(),'只剩一个短句');
  console.log('PASS: native textarea, React-style rich-text mention, Unicode whitespace, genuinely truncated prompt rejected');
}finally{
  await browser.close();
}
