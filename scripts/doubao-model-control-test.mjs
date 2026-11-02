import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../server/chromium-binary.mjs';
import {selectSeedanceFast,selectSeedanceModel,ensureVideoGenerationMode} from '../server/doubao-controls.mjs';
import {configureVideo} from '../server/doubao-runner.mjs';

const browser=await chromium.launch({...browserLaunchOptions(),headless:true});
const page=await browser.newPage();
async function labelTestSlider(){
  await page.locator('#settings-list').evaluate(panel=>{
    const slider=panel.querySelector('input[type="range"]');
    const header=document.createElement('div');
    header.textContent='时长';
    const label=document.createElement('output');
    label.textContent=slider.value+'s';
    const min=document.createElement('span');
    min.textContent='4s';
    const max=document.createElement('span');
    max.textContent='15s';
    panel.prepend(header,label);
    panel.append(min,max);
    slider.addEventListener('input',()=>label.textContent=slider.value+'s');
  });
}

try{
  // Screenshot layout: video chip, composite text "模型 Seedance 2.0 Mini"
  // and a non-semantic div that opens the actual model menu.
  await page.setContent([
    '<div style="display:none"><span>模型 Seedance 2.0 Mini</span></div>',
    '<div><span>视频生成</span><span>×</span></div>',
    '<div id="model-picker" class="cursor-pointer" style="cursor:pointer">',
    ' <span>✦ 模型</span> <span id="current">Seedance 2.0 Mini</span>',
    ' <span>⌄</span>',
    '</div>',
    '<div id="model-list" hidden>',
    ' <div role="option" id="mini">Seedance 2.0 Mini</div>',
    ' <div role="option" id="fast">Seedance 2.0 Fast</div>',
    '</div>',
    '<script>',
    'document.getElementById("model-picker").onclick=()=>{',
    ' document.getElementById("model-list").hidden=false;};',
    'document.getElementById("mini").onclick=()=>{',
    ' document.getElementById("current").textContent="Seedance 2.0 Mini";',
    ' document.getElementById("model-list").hidden=true;};',
    'document.getElementById("fast").onclick=()=>{',
    ' document.getElementById("current").textContent="Seedance 2.0 Fast";',
    ' document.getElementById("model-list").hidden=true;};',
    '</script>'
  ].join(''));
  await selectSeedanceFast(page);
  assert.equal(await page.locator('#current').innerText(),'Seedance 2.0 Fast');
  assert.equal(await page.locator('#model-list').isVisible(),false);
  await selectSeedanceFast(page);
  assert.equal(await page.locator('#model-list').isVisible(),false,
    'already-selected Fast should not reopen the menu');

  await selectSeedanceModel(page,'Seedance 2.0 Mini');
  assert.equal(await page.locator('#current').innerText(),'Seedance 2.0 Mini');
  assert.equal(await page.locator('#model-list').isVisible(),false);
  await selectSeedanceModel(page,'Seedance 2.0 Mini');
  assert.equal(await page.locator('#model-list').isVisible(),false,
    'already-selected Mini should not reopen the menu');
  await selectSeedanceModel(page,'Seedance 2.0 Fast');
  assert.equal(await page.locator('#current').innerText(),'Seedance 2.0 Fast');

  await page.locator('#current').evaluate(el=>el.textContent='Seedance 2.0 Mini');
  await page.locator('#fast').evaluate(el=>el.remove());
  await assert.rejects(()=>selectSeedanceFast(page),/未找到 Seedance 2.0 Fast/,
    'Unavailable Fast should report an accurate error, never silently choose Mini');
  // The current composer places ratio and duration in a shared div labelled
  // "自动 · 10s" rather than separate "画面比例" / "时长" buttons.
  await page.setContent([
    '<div><span>视频生成</span><span>×</span></div>',
    '<div id="model-picker" style="cursor:pointer" onclick="document.getElementById(\'model-list\').hidden=false">',
    '<span>✦ 模型</span><span id="current">Seedance 2.0 Mini</span></div>',
    '<div id="model-list" hidden><div role="option" id="fast"',
    ' onclick="document.getElementById(\'current\').textContent=\'Seedance 2.0 Fast\';',
    ' document.getElementById(\'model-list\').hidden=true">Seedance 2.0 Fast</div>',
    ' <div role="option" id="mini" onclick="document.getElementById(\'current\').textContent=\'Seedance 2.0 Mini\';',
    ' document.getElementById(\'model-list\').hidden=true">Seedance 2.0 Mini</div></div>',
    '<div id="settings-picker" style="cursor:pointer" ',
    ' onclick="document.getElementById(\'settings-list\').hidden=false">',
    '<span id="ratio">自动</span> · <span id="time">10s</span></div>',
    '<div id="settings-list" hidden>',
    '<div role="option" id="ratio-option" onclick="document.getElementById(\'ratio\').textContent=\'3:4\';',
    'document.getElementById(\'settings-list\').hidden=true">3:4</div>',
    '<input aria-label="时长" type="range" min="4" max="15" value="10" ',
    'oninput="document.getElementById(\'time\').textContent=this.value+\'s\'">',
    '</div>'
  ].join(''));
  await labelTestSlider();
  await configureVideo(page,{model:'Seedance 2.0 Fast',ratio:'3:4',duration:'10s'});
  assert.equal(await page.locator('#current').innerText(),'Seedance 2.0 Fast');
  assert.equal(await page.locator('#ratio').innerText(),'3:4');
  assert.equal(await page.locator('#time').innerText(),'10s');
  await configureVideo(page,{model:'Seedance 2.0 Mini',ratio:'3:4',duration:'10s'});
  assert.equal(await page.locator('#current').innerText(),'Seedance 2.0 Mini',
    'Configuring an actual Mini job must switch the browser model to Mini');

  // Regression: the screenshot shows a WHITE standalone "视频生成" entry,
  // not the BLUE selected video chip. It must be clicked before model setup.
  await page.setContent([
    '<div id="video-entry" class="cursor-pointer"><span>▣</span><span>视频生成</span></div>',
    '<div id="video-chip" hidden>视频生成 <span>×</span></div>',
    '<section id="video-controls" hidden>',
    ' <div id="model-picker" class="cursor-pointer"><span>✦ 模型</span>',
    '  <span id="current">Seedance 2.0 Mini</span>⌄</div>',
    ' <div id="model-list" hidden><div role="option" id="fast">Seedance 2.0 Fast</div></div>',
    ' <div id="settings-picker" class="cursor-pointer">',
    '  <span id="ratio">自动</span> · <span id="time">10s</span></div>',
    ' <div id="settings-list" hidden>',
    '  <div role="option" id="ratio-option">3:4</div>',
    '  <input type="range" id="duration-slider" aria-label="时长" min="4" max="15" value="10"/>',
    ' </div>',
    '</section>'
  ].join(''));
  await page.evaluate(()=>{
    window.videoEntryClicks=0;
    document.querySelector('#video-entry').addEventListener('click',()=>{
      window.videoEntryClicks++;
      document.querySelector('#video-entry').hidden=true;
      document.querySelector('#video-chip').hidden=false;
      document.querySelector('#video-controls').hidden=false;
    });
    document.querySelector('#video-chip').addEventListener('click',()=>{
      document.querySelector('#video-chip').hidden=true;
      document.querySelector('#video-controls').hidden=true;
    });
    document.querySelector('#model-picker').addEventListener('click',()=>{
      document.querySelector('#model-list').hidden=false;
    });
    document.querySelector('#fast').addEventListener('click',()=>{
      document.querySelector('#current').textContent='Seedance 2.0 Fast';
      document.querySelector('#model-list').hidden=true;
    });
    document.querySelector('#settings-picker').addEventListener('click',()=>{
      document.querySelector('#settings-list').hidden=false;
    });
    document.querySelector('#ratio-option').addEventListener('click',()=>{
      document.querySelector('#ratio').textContent='3:4';
      document.querySelector('#settings-list').hidden=true;
    });
    document.querySelector('#duration-slider').addEventListener('input',e=>{
      document.querySelector('#time').textContent=e.target.value+'s';
    });
  });
  await labelTestSlider();
  await configureVideo(page,{model:'Seedance 2.0 Fast',ratio:'3:4',duration:'5s'});
  assert.equal(await page.evaluate(()=>window.videoEntryClicks),1,
    'Must click the unselected video-generation entry before selecting model');
  assert.equal(await page.locator('#video-chip').isVisible(),true);
  assert.equal(await page.locator('#current').innerText(),'Seedance 2.0 Fast');
  assert.equal(await page.locator('#ratio').innerText(),'3:4');
  assert.equal(await page.locator('#duration-slider').inputValue(),'5');
  assert.equal(await page.locator('#time').innerText(),'5s');
  assert.equal(await ensureVideoGenerationMode(page),'already-active');
  assert.equal(await page.locator('#video-chip').isVisible(),true,
    'Must not toggle off the already-selected video-generation chip');
  console.log('PASS: entry click activates video mode, selected chip retained, Fast selected, 4–15s duration slider set to 5s');
}finally{
  await browser.close();
}
