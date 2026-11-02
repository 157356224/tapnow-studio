// A generated Doubao video can arrive as a chat video card without an
// initially visible Download button. This observer is attached BEFORE the
// current submission so completed videos from older chats are never reused.
const DONE_TEXT='你的视频生成好了';

export async function watchNewVideoCompletion(page){
  await page.evaluate(phrase=>{
    window.__tapnowVideoCompletion?.stop?.();
    const excluded=[
      'textarea','input','[contenteditable="true"]',
      '[data-message-author-role="user"]','[data-message-role="user"]',
      '[data-role="user"]','[data-testid="user-message"]','.user-message'
    ].join(',');
    let completed=false;
    const inspect=node=>{
      let el=node?.nodeType===Node.TEXT_NODE?node.parentElement:node;
      for(let i=0;el&&i<5;i++,el=el.parentElement){
        if(!el.matches||el.matches('script,style,noscript')||
          el.closest(excluded))return;
        const content=(el.textContent||'').replace(/\s+/g,'');
        if(content.length>1500)break;
        if(content.includes(phrase)){
          completed=true;
          // When the app mounts an entire message at once, identify the
          // smallest child containing the text instead of the outer message
          // (whose bounding box also includes the video thumbnail).
          let textContainer=el;
          for(let depth=0;depth<7;depth++){
            const child=[...textContainer.children].find(item=>{
              const text=(item.textContent||'').replace(/\s+/g,'');
              return text.includes(phrase)&&text.length<1500;
            });
            if(!child)break;
            textContainer=child;
          }
          // The marker identifies the fresh assistant reply; a completed
          // card is selected spatially below it after the preview renders.
          if(!document.querySelector('[data-tapnow-video-complete-reply]'))
            textContainer.setAttribute('data-tapnow-video-complete-reply','');
          return;
        }
      }
    };
    const observer=new MutationObserver(records=>{
      if(completed)return;
      for(const record of records){
        if(record.type==='characterData')inspect(record.target);
        for(const node of record.addedNodes)inspect(node);
        if(completed)break;
      }
    });
    observer.observe(document.body,{childList:true,characterData:true,subtree:true});
    window.__tapnowVideoCompletion={
      get completed(){return completed;},
      stop(){observer.disconnect();}
    };
  },DONE_TEXT);
  return {
    async completed(){
      return page.evaluate(()=>
        Boolean(window.__tapnowVideoCompletion?.completed)).catch(()=>false);
    },
    async stop(){
      await page.evaluate(()=>{
        window.__tapnowVideoCompletion?.stop?.();
        delete window.__tapnowVideoCompletion;
        document.querySelectorAll('[data-tapnow-video-complete-reply],'+
          '[data-tapnow-video-result-card]').forEach(el=>{
          el.removeAttribute('data-tapnow-video-complete-reply');
          el.removeAttribute('data-tapnow-video-result-card');
        });
      }).catch(()=>{});
    }
  };
}

// Find the *new* video preview nearest below the new assistant success reply.
// No fixed Doubao CSS classes are required: versions use <video>, <img>, a
// poster element, or a div with a CSS background image.
export async function findFreshVideoCard(page){
  const found=await page.evaluate(()=>{
    const reply=document.querySelector('[data-tapnow-video-complete-reply]');
    if(!reply)return null;
    const bounds=reply.getBoundingClientRect();
    const media=[...document.querySelectorAll(
      'video,img,[poster],[style*="background-image"],'+
      '[data-testid*="video"],[class*="video-preview"]'
    )];
    const matches=media.map(el=>{
      if(el.closest('textarea,input,[contenteditable="true"],'+
        '[data-message-author-role="user"],[data-message-role="user"]'))
        return null;
      const rect=el.getBoundingClientRect();
      const delta=rect.top-bounds.bottom;
      if(rect.width<130||rect.height<75||delta< -55||delta>950)
        return null;
      const horizontal=Math.abs(
        (rect.left+Math.min(rect.width,480)/2)-(bounds.left+Math.min(bounds.width,480)/2)
      );
      return {el,score:Math.abs(delta)+horizontal*.15};
    }).filter(Boolean).sort((a,b)=>a.score-b.score);
    const mediaElement=matches[0]?.el;
    if(!mediaElement)return null;
    let card=mediaElement;
    for(let i=0;i<3&&card.parentElement;i++){
      const parent=card.parentElement;
      const r=parent.getBoundingClientRect();
      if(r.width>mediaElement.getBoundingClientRect().width*1.65||
         r.height>mediaElement.getBoundingClientRect().height*2.2)break;
      card=parent;
    }
    document.querySelectorAll('[data-tapnow-video-result-card]')
      .forEach(el=>el.removeAttribute('data-tapnow-video-result-card'));
    card.setAttribute('data-tapnow-video-result-card','');
    return {type:mediaElement.tagName.toLowerCase()};
  }).catch(()=>null);
  return found?page.locator('[data-tapnow-video-result-card]'):null;
}

const DOWNLOAD=/下载|保存视频|无水印|download/i;
async function visibleCandidate(locator){
  const count=Math.min(await locator.count().catch(()=>0),15);
  for(let i=count-1;i>=0;i--){
    const item=locator.nth(i);
    if(await item.isVisible().catch(()=>false)&&
      await item.isEnabled().catch(()=>false))return item;
  }
  return null;
}

export async function findVideoDownloadControl(page,card){
  // A click on the card's Download icon may open a portal menu outside the
  // card. Prefer the open menu action rather than clicking the icon again and
  // closing the menu before the file is downloaded.
  const overlay=await visibleCandidate(page.getByRole('menuitem',{name:DOWNLOAD}))
    ||await visibleCandidate(page.getByRole('dialog')
      .getByRole('button',{name:DOWNLOAD}))
    ||await visibleCandidate(page.getByRole('dialog')
      .getByRole('link',{name:DOWNLOAD}));
  if(overlay)return overlay;
  for(const scope of [card,card.locator('xpath=..')]){
    const candidate=await visibleCandidate(scope.getByRole('button',{name:DOWNLOAD}))
      ||await visibleCandidate(scope.getByRole('link',{name:DOWNLOAD}))
      ||await visibleCandidate(scope.locator(
        'a[download],button[title*="下载"],button[aria-label*="下载"],'+
        '[role="button"][title*="下载"],[data-testid*="download"],'+
        'a[title*="下载"]'
      ));
    if(candidate)return candidate;
  }
  return null;
}

export async function revealVideoDownloadControl(page){
  const card=await findFreshVideoCard(page);
  if(!card)return {card:null,control:null};
  await card.hover({timeout:3000}).catch(()=>{});
  let control=await findVideoDownloadControl(page,card);
  if(control)return {card,control};
  // Controls may be revealed by opening the card's “more” menu.
  const more=await visibleCandidate(card.getByRole('button',{
    name:/更多|操作|more|\.\.\.|···|…/i
  }))||await visibleCandidate(card.locator(
    'button[title*="更多"],button[aria-label*="更多"],'+
    'button[title*="操作"],button[aria-label*="操作"]'
  ));
  if(more){
    await more.click({timeout:3000}).catch(()=>{});
    control=await findVideoDownloadControl(page,card);
    if(control)return {card,control};
  }
  return {card,control:null};
}

export async function openFreshVideoPreview(card){
  // The generated thumbnail can have a small play icon at its top-right
  // (rather than making the entire card clickable).
  let play=await visibleCandidate(card.getByRole('button',{
    name:/播放|预览|play/i
  }))||await visibleCandidate(card.locator(
    'button[title*="播放"],button[aria-label*="播放"],'+
    '[data-testid*="play"],[title*="预览"]'
  ));
  if(!play){
    const marker=await card.evaluate(element=>{
      const bounds=element.getBoundingClientRect();
      const controls=[...element.querySelectorAll('button,[role="button"]')];
      const icon=controls.find(button=>{
        const rect=button.getBoundingClientRect();
        return rect.width>=12&&rect.width<=65&&rect.height>=12&&
          rect.top>=bounds.top-4&&rect.top<bounds.top+65&&
          rect.right>bounds.right-90&&rect.left<bounds.right+10;
      });
      if(icon)icon.setAttribute('data-tapnow-video-play-preview','');
      return Boolean(icon);
    }).catch(()=>false);
    if(marker)play=card.locator('[data-tapnow-video-play-preview]').first();
  }
  if(play){
    try{
      await play.click({timeout:3000});
      return true;
    }catch{/* Falling back to the card. */}
  }
  await card.click({timeout:3000}).catch(()=>{});
  return false;
}
