import {clickFirstVisible} from './doubao-controls.mjs';

// The Doubao duration control is a SLIDER with an observed range of 4–15 s,
// not a list of options like "5s" / "10s".
const COMBINED_SETTINGS=/(?:自动|\d{1,2}:\d{1,2})\s*[·•]\s*\d+\s*(?:s|秒)/i;
const SLIDER_SELECTORS=[
  '[role="slider"]',
  'input[type="range"]',
  '[data-slot="slider-thumb"]',
  '[class*="slider-handle"]',
  '[class*="Slider_handle"]',
  '[class*="slider-thumb"]',
  '[class*="SliderThumb"]'
];

function secondsFromDuration(value){
  const match=String(value??'').trim().match(/^(\d{1,2})(?:s|秒)?$/i);
  if(!match)throw new Error('视频时长格式错误：'+String(value));
  const seconds=Number(match[1]);
  if(seconds<4||seconds>15)
    throw new Error('当前豆包视频时长滑块支持 4–15 秒，收到 '+seconds+' 秒');
  return seconds;
}

async function visibleSlider(page){
  for(const selector of SLIDER_SELECTORS){
    const matches=page.locator(selector);
    const count=Math.min(await matches.count(),30);
    for(let i=count-1;i>=0;i--){
      const slider=matches.nth(i);
      if(await slider.isVisible().catch(()=>false)&&
        await displayedDuration(slider)!==null)return slider;
    }
  }
  return null;
}

async function currentValue(slider){
  const tag=await slider.evaluate(el=>el.tagName.toLowerCase()).catch(()=>'');
  if(tag==='input'){
    const value=await slider.inputValue().catch(()=>null);
    if(value!==null && /^\d+$/.test(value))return Number(value);
  }
  for(const attribute of ['aria-valuenow','data-value','value']){
    const value=await slider.getAttribute(attribute).catch(()=>null);
    if(value!==null && /^-?\d+(?:\.\d+)?$/.test(value))return Number(value);
  }
  return null;
}

async function displayedDuration(slider){
  // The screenshot shows a value label (e.g. "9s") above the rail, plus
  // separate endpoint labels "4s" / "15s". The aria-valuenow or input value
  // alone is insufficient if the wrong thumb is selected or the UI lags.
  return slider.evaluate(element=>{
    let node=element;
    for(let depth=0;node&&depth<8;depth++,node=node.parentElement){
      const text=(node.innerText||'').replace(/\s+/g,' ').trim();
      if(text.length>250||!text.includes('时长'))continue;
      const suffix=text.slice(text.indexOf('时长')+2);
      // Chrome may concatenate adjacent labels as "9s4s15s" in innerText.
      const values=[...suffix.matchAll(/(\d{1,2})\s*(?:s|秒)/gi)]
        .map(match=>Number(match[1]));
      // Only treat this as the slider's value display when the same panel
      // contains BOTH endpoint labels; otherwise the first match may be a
      // stale composer setting or one of the endpoints.
      if(values.length>=3&&values.includes(4)&&values.includes(15))
        return values[0];
    }
    return null;
  }).catch(()=>null);
}

async function confirmedDuration(slider,target){
  // Allow React to flush changes and render the actual visible value.
  await slider.page().waitForTimeout(100);
  const control=await currentValue(slider);
  const display=await displayedDuration(slider);
  const bounds=await sliderBounds(slider);
  const actualSeconds=control===null?null:
    bounds.indexed ? control-bounds.min+4 : control;
  return {control,actualSeconds,display,
    correct:actualSeconds===target&&display===target};
}

async function sliderBounds(slider){
  const min=Number(await slider.getAttribute('min') ??
    await slider.getAttribute('aria-valuemin') ?? 4);
  const max=Number(await slider.getAttribute('max') ??
    await slider.getAttribute('aria-valuemax') ?? 15);
  if(!Number.isFinite(min)||!Number.isFinite(max)||min>=max)
    throw new Error('豆包滑块的时长范围不合法');
  // On the real Doubao control, aria-valuenow can be a ZERO-BASED INDEX,
  // e.g. 1 represents 5 seconds, while the tooltip says 5s. The 12 ticks
  // cover 4s..15s, but their control range is 0..11.
  const indexed=min===0&&max===11;
  const secondsMin=indexed?4:min;
  const secondsMax=indexed?15:max;
  return {min,max,indexed,secondsMin,secondsMax};
}

async function dragSlider(page,slider,rawValue,{min,max}){
  // An ARIA slider commonly exposes only its thumb (20px). Use the closest
  // reasonably sized ancestor as track instead of confusing thumb width for
  // the range width. This DOM inspection is read-only; interaction is through
  // pointer events, like a real user.
  const track=await slider.evaluate(el=>{
    const own=el.getBoundingClientRect();
    if(own.width>=120)return {
      x:own.left,y:own.top,width:own.width,height:own.height
    };
    for(let node=el.parentElement;node;node=node.parentElement){
      const box=node.getBoundingClientRect();
      if(box.width>=120 && box.width<=800 && box.height<=90)
        return {x:box.left,y:box.top,width:box.width,height:box.height};
    }
    return null;
  });
  if(!track)throw new Error('豆包时长滑动条缺少可操作的轨道');
  const inset=8;
  const fraction=(rawValue-min)/(max-min);
  const x=track.x+inset+fraction*(track.width-inset*2);
  const y=track.y+track.height/2;
  const thumb=await slider.boundingBox();
  if(thumb){
    await page.mouse.move(thumb.x+thumb.width/2,thumb.y+thumb.height/2);
    await page.mouse.down();
    await page.mouse.move(x,y,{steps:12});
    await page.mouse.up();
  }
  // Track-click is a useful second path for pointer-only sliders which
  // implement click-to-seek instead of dragging an explicit thumb.
  if(await currentValue(slider)!==rawValue)await page.mouse.click(x,y);
}

export async function setVideoDuration(page,duration){
  const target=secondsFromDuration(duration);
  let slider=await visibleSlider(page);
  if(!slider){
    const opened=await clickFirstVisible(page,[
      COMBINED_SETTINGS,/自动\s*[·•]\s*\d+\s*(?:s|秒)/i,
      /时长|视频长度/
    ]);
    if(!opened)throw new Error('找不到豆包「自动 · 10s」时长滑动条设置入口');
    slider=await visibleSlider(page);
    if(!slider){
      await page.waitForTimeout(350);
      slider=await visibleSlider(page);
    }
  }
  if(!slider)throw new Error(
    '已打开时长设置，但未找到含「时长 / 当前秒数 / 4s / 15s」标注的滑动条；'+
    '已停止发送，避免修改其他控件'
  );
  const bounds=await sliderBounds(slider);
  if(target<bounds.secondsMin||target>bounds.secondsMax)
    throw new Error('所选 '+target+' 秒超出豆包当前滑块范围');
  const rawTarget=bounds.indexed?bounds.min+target-4:target;

  // Keyboard interaction works with native inputs and accessible Radix/AntD
  // sliders. Unlike clicking labels, it sets arbitrary seconds such as 5s.
  let result=await confirmedDuration(slider,target);
  if(result.correct)return target;
  try{
    await slider.focus({timeout:2000});
    await slider.press('Home',{timeout:2000});
    for(let i=bounds.min;i<rawTarget;i++){
      await slider.press('ArrowRight',{timeout:1000});
    }
    result=await confirmedDuration(slider,target);
  }catch{/* Canvas/pointer-only sliders need the drag fallback. */}

  if(!result.correct){
    await dragSlider(page,slider,rawTarget,bounds);
    result=await confirmedDuration(slider,target);
  }
  // When the visible number and the slider's property disagree, try gentle
  // keyboard correction based on the VISIBLE number, not guessed geometry.
  if(!result.correct&&result.display!==null&&result.control!==null){
    for(let attempt=0;attempt<2&&!result.correct;attempt++){
      const offset=target-result.display;
      if(!offset||Math.abs(offset)>11)break;
      try{
        await slider.focus({timeout:1000});
        for(let step=0;step<Math.abs(offset);step++)
          await slider.press(offset>0?'ArrowRight':'ArrowLeft',{timeout:900});
        result=await confirmedDuration(slider,target);
      }catch{break;}
    }
  }
  if(!result.correct){
    throw new Error('豆包时长滑块未确认设为 '+target+
      ' 秒（滑块内部值 '+(result.control===null?'无法读取':result.control)+
      (bounds.indexed?'，该内部值为 0–11 档位索引':' 秒')+
      '，页面显示 '+(result.display===null?'无法读取':result.display)+
      ' 秒），已停止提交以防误生成');
  }
  return target;
}
