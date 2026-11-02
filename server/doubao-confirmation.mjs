// A Doubao assistant reply can pause video generation to ask for explicit
// confirmation. Watch only replies produced after the current submission;
// never respond to old chat history or to a user's message containing a quote.
const CONFIRMATION_PHRASE='确认后我再开始生成视频';
const compact=value=>String(value||'')
  .normalize('NFKC')
  .replace(/[\s\u200b-\u200d\u2060\ufeff]/g,'');

export function isVideoConfirmationRequest(value){
  return compact(value).includes(CONFIRMATION_PHRASE);
}

// SSE bodies may escape Chinese text or stream it in separate JSON fragments.
// Parse response bodies in memory only; never log or persist conversation text.
export function hasVideoConfirmationInResponse(body){
  if(typeof body!=='string'||!body)return false;
  if(isVideoConfirmationRequest(body))return true;
  const fragments=[];
  const collect=(value,depth=0)=>{
    if(depth>12||fragments.length>15000||value==null)return;
    if(typeof value==='string'){
      if(value.length<20000){
        if(value[0]==='{'||value[0]==='['){
          try{collect(JSON.parse(value),depth+1);return;}catch{/* plain text */}
        }
        fragments.push(value);
      }
      return;
    }
    if(Array.isArray(value)){
      for(const part of value)collect(part,depth+1);
    }else if(typeof value==='object'){
      for(const part of Object.values(value).slice(0,150))collect(part,depth+1);
    }
  };
  for(const line of body.split(/\r?\n/)){
    if(!line.startsWith('data:'))continue;
    const data=line.slice(5).trim();
    if(data==='[DONE]')continue;
    try{collect(JSON.parse(data));}
    catch{fragments.push(data);}
  }
  return isVideoConfirmationRequest(fragments.join(''));
}

// This MutationObserver is armed immediately before the first video request.
// A phrase from a previous conversation is never sufficient to trigger it.
export async function watchNewVideoConfirmation(page){
  await page.evaluate(()=>{
    window.__tapnowVideoConfirmMonitor?.stop?.();
    const compactText=value=>String(value||'').normalize('NFKC')
      .replace(/[\s\u200b-\u200d\u2060\ufeff]/g,'');
    const phrase='确认后我再开始生成视频';
    const userSelector=[
      '[data-message-author-role="user"]',
      '[data-message-role="user"]',
      '[data-role="user"]',
      '[data-testid="user-message"]',
      '.user-message'
    ].join(',');
    let requested=false;
    const check=node=>{
      const element=node?.nodeType===Node.TEXT_NODE?
        node.parentElement:node;
      if(!element||element.nodeType!==Node.ELEMENT_NODE)return;
      if(element.closest('textarea,input,[contenteditable="true"],'+userSelector))
        return;
      // A reply may stream into nested spans; walk up a few levels, but never
      // read the full page (which would include old conversations).
      let current=element;
      for(let level=0;level<4&&current;level++,current=current.parentElement){
        if(current.closest('textarea,input,[contenteditable="true"],'+userSelector))
          return;
        if(current.matches('script,style,noscript'))return;
        const text=current.textContent||'';
        if(text.length>4000)break;
        if(compactText(text).includes(phrase)){
          requested=true;
          return;
        }
      }
    };
    const observer=new MutationObserver(records=>{
      if(requested)return;
      for(const record of records){
        if(record.type==='characterData')check(record.target);
        for(const node of record.addedNodes)check(node);
        if(requested)break;
      }
    });
    observer.observe(document.body,{subtree:true,childList:true,characterData:true});
    window.__tapnowVideoConfirmMonitor={
      get requested(){return requested;},
      stop(){observer.disconnect();}
    };
  });
  return {
    async requested(){
      return page.evaluate(()=>
        Boolean(window.__tapnowVideoConfirmMonitor?.requested)).catch(()=>false);
    },
    async stop(){
      await page.evaluate(()=>{
        window.__tapnowVideoConfirmMonitor?.stop?.();
        delete window.__tapnowVideoConfirmMonitor;
      }).catch(()=>{});
    }
  };
}
