// Keep all request observers fully owned by the submit operation. A pending
// Playwright waitForRequest must never become an unhandled rejection when the
// composer button is disabled, detached or clicked without dispatching a POST.
const COMPLETION_PATH='/chat/completion';

export function isVideoRequest(request){
  try{
    const url=new URL(request.url());
    return request.method()==='POST'&&url.pathname===COMPLETION_PATH;
  }catch{return false;}
}

export async function submitAndObserve(page,send,{timeout=20000}={}){
  let completed=false;
  let done;
  let timeoutHandle;
  const observed=new Promise(resolve=>{done=resolve;});
  const onRequest=request=>{
    if(completed||!isVideoRequest(request))return;
    completed=true;
    done({request});
  };
  page.on('request',onRequest);
  try{
    await send.click({timeout:7000});
    timeoutHandle=setTimeout(()=>{
      if(completed)return;
      completed=true;
      done({timeout:true});
    },timeout);
    const result=await observed;
    if(!result.request)throw new Error(
      '豆包发送按钮已点击，但 '+Math.ceil(timeout/1000)+
      ' 秒内未观察到视频提交请求。可能按钮未生效、网页拦截提交，或接口路径已变化。'+
      '请检查豆包页面是否显示提示或验证弹窗'
    );
    return result.request;
  }finally{
    completed=true;
    if(timeoutHandle)clearTimeout(timeoutHandle);
    page.off('request',onRequest);
  }
}

export async function findSendButton(page,editor,{timeout=7000}={}){
  // React enables the composer send button asynchronously after input events.
  // Allow it to settle instead of reading isEnabled() immediately.
  const deadline=Date.now()+timeout;
  let everDisabled=false;
  while(true){
  const groups=[
    page.getByRole('button',{name:/^(发送|生成|生成视频|开始生成|立即生成)$/i}),
    page.locator('button[aria-label*="发送"],button[title*="发送"],button[data-testid*="send"],button[data-testid*="submit"]'),
    page.locator('button[class*="send"],button[class*="submit"],button[class*="Send"],button[class*="Submit"]'),
    page.locator('button[type="submit"]'),
    page.locator('[role="button"][aria-label*="发送"],[role="button"][title*="发送"],[role="button"][class*="send"]')
  ];
  let sawDisabled=false;
  const editorBox=editor?await editor.boundingBox().catch(()=>null):null;
  let best=null;
  let bestScore=-Infinity;
  for(const group of groups){
    const count=Math.min(await group.count(),30);
    for(let i=count-1;i>=0;i--){
      const candidate=group.nth(i);
      if(!await candidate.isVisible().catch(()=>false))continue;
      try{
        await candidate.waitFor({state:'visible',timeout:1500});
        if(await candidate.isEnabled()){
          const box=await candidate.boundingBox();
          // If there are several "发送" controls in the chat history, the
          // rightmost one near our filled composer is the useful one.
          let score=i;
          if(editorBox&&box){
            const cx=box.x+box.width/2,cy=box.y+box.height/2;
            const ex=editorBox.x+editorBox.width/2;
            const ey=editorBox.y+editorBox.height/2;
            score=1000-Math.hypot(cx-ex,cy-ey)+box.x*.01;
          }
          if(score>bestScore){bestScore=score;best=candidate;}
        }else sawDisabled=true;
      }catch{/* Search the next matching control. */}
    }
  }
  if(best)return best;
  // Recent Doubao builds use an icon-only arrow-up submit button. Only use
  // this fallback if its DOM explicitly identifies a send icon/action and it
  // is visually near the video prompt; never guess the microphone button.
  if(editorBox){
    const iconButtons=page.locator(
      'button:has(svg[class*="send"]),button:has(svg[class*="Send"]),'+
      'button:has(svg[class*="arrow-up"]),button:has(svg[data-lucide="arrow-up"]),'+
      '[role="button"]:has(svg[class*="send"])'
    );
    const count=Math.min(await iconButtons.count(),60);
    for(let i=count-1;i>=0;i--){
      const candidate=iconButtons.nth(i);
      const box=await candidate.boundingBox().catch(()=>null);
      if(!box||!await candidate.isEnabled())continue;
      const x=box.x+box.width/2,y=box.y+box.height/2;
      if(x>=editorBox.x+editorBox.width*.6&&
        x<=editorBox.x+editorBox.width+110&&
        y>=editorBox.y-45&&y<=editorBox.y+editorBox.height+95)
        return candidate;
    }
  }
  everDisabled ||= sawDisabled;
  if(Date.now()<deadline){
    await page.waitForTimeout(220);
    continue;
  }
  throw new Error(everDisabled
    ?'视频发送按钮目前处于禁用状态。请确认已输入提示词、关闭参数弹窗，且豆包没有额度/账号提示'
    :'未识别到豆包视频发送按钮。请检查发送图标或页面结构是否已变化');
  }
}
