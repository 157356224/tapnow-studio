// Doubao exposes some composer controls as clickable divs/spans rather than
// semantic buttons. Search visible text in the active composer and click the
// label or its interactive ancestor; never rely on the first (possibly hidden)
// match found in the document.
async function visibleMembers(locator,limit=25){
  const found=[];
  const count=Math.min(await locator.count(),limit);
  for(let i=0;i<count;i++){
    const item=locator.nth(i);
    if(await item.isVisible().catch(()=>false))found.push(item);
  }
  return found;
}

async function clickVisible(locator){
  for(const candidate of await visibleMembers(locator)){
    try{
      await candidate.click({timeout:1800});
      return true;
    }catch{/* Another matching label may be covered or not clickable. */}
  }
  return false;
}

export async function visibleText(page,pattern){
  return (await visibleMembers(page.getByText(pattern))).length>0;
}

async function videoComposerReady(page){
  // A closed video-model selector always displays its current Seedance model.
  // A standalone "视频生成" entry in the generic chat composer does not.
  const model=page.getByText(/Seedance\s*2[.\s]*0\s*(Mini|Pro|Lite|Fast)/i);
  return (await visibleMembers(model)).length>0;
}

export async function ensureVideoGenerationMode(page){
  // Already in video mode: do not click the blue "视频生成 ×" chip. Clicking
  // that chip would REMOVE the mode and hide the model selector.
  if(await videoComposerReady(page))return 'already-active';

  const sources=[
    page.getByRole('button',{name:'视频生成',exact:true}),
    page.getByText('视频生成',{exact:true})
  ];
  for(const source of sources){
    // The composer is usually near the end of the page DOM, after chat history.
    for(const entry of (await visibleMembers(source,40)).reverse()){
      const parent=entry.locator('xpath=ancestor-or-self::*['+
        'self::button or @role="button" or @tabindex or '+
        'contains(@class,"cursor-pointer")'+
      '][1]');
      const target=await parent.count()?parent.first():entry;
      if(!await target.isVisible().catch(()=>false))continue;
      try{
        await target.click({timeout:3500});
      }catch{continue;}
      // The model selector may load asynchronously after video mode opens.
      try{
        await page.getByText(/Seedance\s*2[.\s]*0\s*(Mini|Pro|Lite|Fast)/i)
          .last().waitFor({state:'visible',timeout:4500});
        return 'activated';
      }catch{
        if(await videoComposerReady(page))return 'activated';
      }
    }
  }
  throw new Error(
    '已尝试点击豆包「视频生成」入口，但未出现模型设置。请确认网页已进入视频生成模式'
  );
}

async function findClickableModelControl(page){
  // The visible closed control reads "模型 Seedance 2.0 Mini" in Doubao's UI.
  // Prefer its existing clickable ancestor; fallback to the text itself so the
  // bubbled click still reaches a div-based trigger.
  const candidates=[
    page.getByRole('button',{name:/Seedance\s*2[.\s]*0/i}),
    page.locator('[role="button"]:has-text("Seedance")'),
    page.locator('[aria-haspopup]:has-text("Seedance")'),
    page.getByText(/Seedance\s*2[.\s]*0\s*(Mini|Pro|Lite|Fast)/i),
    page.getByText(/Seedance\s*2[.\s]*0/i),
    page.getByText('模型',{exact:true})
  ];
  for(const group of candidates){
    // The composer is after the history in the DOM. Prefer the last visible
    // model label so a previous conversation's "Seedance" is not clicked.
    for(const label of (await visibleMembers(group)).reverse()){
      const interactive=label.locator('xpath=ancestor-or-self::*['+
        'self::button or @role="button" or @aria-haspopup or @tabindex or '+
        'contains(@class,"cursor-pointer") or contains(@class,"select-trigger")'+
      '][1]');
      if(await interactive.count() && await interactive.first().isVisible())
        return interactive.first();
      return label;
    }
  }
  return null;
}

async function modelChoice(page,model){
  if(!['Seedance 2.0 Mini','Seedance 2.0 Fast'].includes(model))
    throw new Error('豆包尚未接入模型：'+model);
  const suffix=model.endsWith('Mini')?'Mini':'Fast';
  const pattern=new RegExp('Seedance\\s*2[.\\s]*0\\s*'+suffix,'i');
  const options=[
    page.getByRole('option',{name:pattern}),
    page.getByRole('menuitem',{name:pattern}),
    page.getByRole('button',{name:pattern}),
    page.getByText(pattern)
  ];
  for(const group of options){
    const items=await visibleMembers(group);
    if(items.length)return items[items.length-1];
  }
  return null;
}

export async function selectSeedanceModel(page,model='Seedance 2.0 Mini'){
  if(!['Seedance 2.0 Mini','Seedance 2.0 Fast'].includes(model))
    throw new Error('豆包尚未接入模型：'+model);
  const suffix=model.endsWith('Mini')?'Mini':'Fast';
  const pattern=new RegExp('Seedance\\s*2[.\\s]*0\\s*'+suffix,'i');
  const trigger=await findClickableModelControl(page);
  if(!trigger)throw new Error(
    '未定位到豆包模型下拉入口（页面未出现「模型 Seedance 2.0 …」）'
  );
  // Do not toggle an already selected model; the click would open the menu.
  const triggerLabel=(await trigger.innerText().catch(()=>''))||'';
  if(pattern.test(triggerLabel) &&
      !new RegExp('Seedance\\s*2[.\\s]*0\\s*'+(suffix==='Mini'?'Fast':'Mini'),'i').test(triggerLabel))
    return;

  await trigger.click({timeout:4500});
  let option=await modelChoice(page,model);
  if(!option){
    await page.waitForTimeout(450);
    option=await modelChoice(page,model);
  }
  if(!option){
    const options=(await page.locator('[role="option"],[role="menuitem"],[role="listbox"],[role="menu"]')
      .allTextContents().catch(()=>[])).join(' ').replace(/\s+/g,' ').slice(0,280);
    throw new Error(
      '模型菜单已点击，但未找到 '+model+
      (options?'（当前可见选项：'+options+'）':'。请检查账号是否提供该模型')
    );
  }
  await option.click({timeout:5500});
  // Verify the selected value, don't silently submit a different model.
  const selected=await findClickableModelControl(page);
  const selectedLabel=selected?await selected.innerText().catch(()=>''):'';
  if(!pattern.test(selectedLabel))
    throw new Error('点击 '+model+' 后未确认模型切换，已停止发送以免使用错误模型');
}

export const selectSeedanceFast=page=>selectSeedanceModel(page,'Seedance 2.0 Fast');

export async function clickFirstVisible(page,patterns){
  for(const pattern of patterns){
    if(await clickVisible(page.getByRole('button',{name:pattern})))return true;
    if(await clickVisible(page.getByText(pattern)))return true;
  }
  return false;
}

export async function clickVisibleOption(page,names){
  for(const name of names){
    const options=[
      page.getByRole('option',{name,exact:true}),
      page.getByRole('menuitem',{name,exact:true}),
      page.getByRole('button',{name,exact:true}),
      page.getByText(name,{exact:true})
    ];
    for(const option of options)if(await clickVisible(option))return true;
  }
  return false;
}
