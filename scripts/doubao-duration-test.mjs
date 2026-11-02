import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../server/chromium-binary.mjs';
import {setVideoDuration} from '../server/doubao-duration.mjs';

const browser=await chromium.launch({...browserLaunchOptions(),headless:true});
const page=await browser.newPage();
try{
  // Match screenshot: the "自动 · 10s" menu reveals a slider from 4s to 15s.
  await page.setContent([
    '<button id="settings" onclick="document.querySelector(\'#panel\').hidden=false">',
    '自动 · 10s</button>',
    '<div id="panel" hidden>时长 <output id="current">10s</output>',
    '<input id="duration" type="range" min="4" max="15" step="1" value="10"',
    ' oninput="document.querySelector(\'#current\').textContent=this.value+\'s\'">',
    '<span>4s</span><span>15s</span></div>'
  ].join(''));
  assert.equal(await setVideoDuration(page,'5s'),5);
  assert.equal(await page.locator('#duration').inputValue(),'5');
  assert.equal(await page.locator('#current').innerText(),'5s');
  assert.equal(await setVideoDuration(page,'15s'),15);
  assert.equal(await page.locator('#duration').inputValue(),'15');
  assert.equal(await setVideoDuration(page,'4s'),4);
  assert.equal(await page.locator('#duration').inputValue(),'4');
  assert.equal(await setVideoDuration(page,'10s'),10);
  assert.equal(await page.locator('#duration').inputValue(),'10');
  await assert.rejects(()=>setVideoDuration(page,'3s'),/4–15 秒/);
  await assert.rejects(()=>setVideoDuration(page,'16s'),/4–15 秒/);

  // Reproduce the user's regression: an automation sees input value=5, but
  // the Doubao panel continues to DISPLAY 9s. This must never be accepted.
  await page.locator('#duration').evaluate(el=>{
    el.value='5';
    const label=document.querySelector('#current');
    label.textContent='9s';
    // This simulates a broken/custom control whose display stays at 9s even
    // as the input or thumb property changes.
    el.oninput=null;
  });
  await assert.rejects(()=>setVideoDuration(page,'5s'),/页面显示 9 秒/,
    'Slider property=5 but visible label=9 must stop rather than submit');

  // Custom canvas-style slider without an input element or ARIA keyboard
  // implementation must be controlled through real pointer movement.
  await page.setContent([
    '<div id="custom-panel">时长 <output id="custom-duration">10s</output>',
    '<div id="custom-track" style="position:relative;width:320px;height:24px; background:#eee">',
    ' <div role="slider" tabindex="0" id="thumb" aria-valuemin="4" aria-valuemax="15"',
    ' aria-valuenow="10" style="position:absolute;left:50%;top:0;height:24px;width:18px;background:#888"></div>',
    '</div><span>4s</span><span>15s</span></div>',
    '<script>',
    'let drag=false;',
    'const track=document.querySelector("#custom-track");',
    'const thumb=document.querySelector("#thumb");',
    'thumb.addEventListener("pointerdown",e=>{drag=true;thumb.setPointerCapture(e.pointerId)});',
    'document.addEventListener("pointermove",e=>{if(!drag)return;',
    'const r=track.getBoundingClientRect(),f=Math.max(0,Math.min(1,(e.clientX-r.left-8)/(r.width-16)));',
    'const n=Math.round(4+f*11);thumb.setAttribute("aria-valuenow",String(n));',
    'document.querySelector("#custom-duration").textContent=n+"s";',
    'thumb.style.left=((n-4)/11*304)+"px";});',
    'thumb.addEventListener("pointerup",()=>{drag=false});',
    'document.addEventListener("pointerup",()=>{drag=false});',
    '</script>'
  ].join(''));
  await setVideoDuration(page,'5s');
  assert.equal(await page.locator('#thumb').getAttribute('aria-valuenow'),'5');

  // Actual screenshot regression: Doubao shows 5s, but its slider reports
  // aria-valuenow=1 because 1 is the second tick (4s + 1), NOT one second.
  await page.setContent([
    '<div id="indexed-panel">时长 <output id="indexed-display">5s</output>',
    '<input id="indexed-slider" type="range" min="0" max="11" step="1" value="1"',
    ' oninput="document.querySelector(\'#indexed-display\').textContent=(Number(this.value)+4)+\'s\'">',
    '<span>4s</span><span>15s</span></div>'
  ].join(''));
  assert.equal(await setVideoDuration(page,'5s'),5);
  assert.equal(await page.locator('#indexed-slider').inputValue(),'1',
    'The existing correct 5s setting must be accepted without changing the thumb');
  assert.equal(await page.locator('#indexed-display').innerText(),'5s');
  assert.equal(await setVideoDuration(page,'13s'),13);
  assert.equal(await page.locator('#indexed-slider').inputValue(),'9');
  assert.equal(await page.locator('#indexed-display').innerText(),'13s');
  assert.equal(await setVideoDuration(page,'4s'),4);
  assert.equal(await page.locator('#indexed-slider').inputValue(),'0');

  await page.setContent([
    '<div id="aria-panel">时长 <output id="aria-display">5s</output>',
    '<div role="slider" id="aria-slider" tabindex="0" aria-valuemin="0"',
    ' aria-valuemax="11" aria-valuenow="1" style="width:300px;height:16px"></div>',
    '<span>4s</span><span>15s</span></div>',
    '<script>',
    'document.querySelector("#aria-slider").addEventListener("keydown",e=>{',
    'let el=e.currentTarget, n=Number(el.getAttribute("aria-valuenow"));',
    'if(e.key==="Home")n=0;',
    'else if(e.key==="ArrowRight")n=Math.min(11,n+1);',
    'else if(e.key==="ArrowLeft")n=Math.max(0,n-1);',
    'el.setAttribute("aria-valuenow",n);',
    'document.querySelector("#aria-display").textContent=(4+n)+"s";',
    '});',
    '</script>'
  ].join(''));
  assert.equal(await setVideoDuration(page,'5s'),5);
  assert.equal(await page.locator('#aria-slider').getAttribute('aria-valuenow'),'1');
  assert.equal(await setVideoDuration(page,'10s'),10);
  assert.equal(await page.locator('#aria-slider').getAttribute('aria-valuenow'),'6');
  assert.equal(await page.locator('#aria-display').innerText(),'10s');
  console.log('PASS: native 4–15s slider (4/5/10/15), rejected out-of-range values, pointer-only slider fallback');
}finally{
  await browser.close();
}
