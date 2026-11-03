// A Doubao assistant reply can pause video generation to ask for explicit
// confirmation. Watch only replies produced after the current submission;
// never respond to old chat history or to a user's message containing a quote.
const CONFIRMATION_PHRASE='确认后我再开始生成视频';
const compact=value=>String(value||'')
  .normalize('NFKC')
  .replace(/[\s\u200b-\u200d\u2060\ufeff]/g,'');

// This is Doubao's explicit start-of-generation reply, not an HTTP 200 or
// upload acknowledgement. Markdown bold markers are optional in the DOM.
export function isVideoGenerationStartedText(value,expectedModel){
  const text=compact(value).replace(/\*\*/g,'');
  const match=/^本次使用Seedance2\.0(Mini|Fast)生成/.exec(text);
  return Boolean(match&&(!expectedModel||
    expectedModel==='Seedance 2.0 '+match[1]));
}

// Read only assistant-like reply TEXT from the current /chat/completion
// response. Do not scan request payloads, old conversation or arbitrary JSON
// metadata, which may quote the same words without starting a video.
function assistantReplyFragments(body){
  const fragments=[];
  const keys=new Set([
    'text','content','message','message_content','text_block','content_block',
    'delta','answer','output','choices','parts','data','messages','result','chunk'
  ]);
  const collect=(node,depth=0,field='')=>{
    if(depth>14||fragments.length>20000||node==null)return;
    if(typeof node==='string'){
      const trimmed=node.trim();
      if((trimmed.startsWith('{')||trimmed.startsWith('['))&&trimmed.length<300000){
        try{collect(JSON.parse(trimmed),depth+1,field);return;}catch{/* text */}
      }
      if(['text','content','message','answer','output','delta'].includes(field))
        fragments.push(node);
      return;
    }
    if(Array.isArray(node)){
      for(const part of node.slice(0,2000))collect(part,depth+1,field);
    }else if(typeof node==='object'){
      if(node.role==='user'||node.author?.role==='user')return;
      for(const [key,value] of Object.entries(node).slice(0,150)){
        if(keys.has(key))collect(value,depth+1,key);
      }
    }
  };
  if(typeof body==='string'){
    if(body.includes('data:')){
      for(const line of body.split(/\r?\n/)){
        if(!line.startsWith('data:'))continue;
        const data=line.slice(5).trim();
        if(data==='[DONE]')continue;
        try{collect(JSON.parse(data));}
        catch{/* Ignore malformed response fragments. */}
      }
    }else{
      try{collect(JSON.parse(body));}
      catch{/* Ignore unrelated plain response bodies. */}
    }
  }
  // Some streams send one text fragment per token; others send cumulative
  // snapshots. Recognize a complete prefix in either representation.
  return fragments;
}

export function inspectVideoStartReply(body,expectedModel){
  const fragments=assistantReplyFragments(body);
  const text=fragments.join('');
  return {
    started:fragments.some(part=>isVideoGenerationStartedText(part,expectedModel))||
      isVideoGenerationStartedText(text,expectedModel),
    hasReplyText:fragments.some(part=>compact(part).length>0)
  };
}

// Once the current "确认" request has received its COMPLETE assistant reply,
// send "生成" if that reply is not the Seedance start announcement. A
// streaming fragment or an empty acknowledgement is not a reply. No emoji
// or reassurance sentence is required.
// This helper is deliberately limited to assistant text in the response body:
// request payloads and historical chat messages are never inspected.
export function inspectPostConfirmationGenerateCue(body){
  const fragments=assistantReplyFragments(body);
  if(!fragments.some(part=>compact(part).length>0))return false;
  const announcesStart=part=>
    /^本次使用Seedance/.test(compact(part).replace(/\*\*/g,''));
  // Some SSE responses emit split deltas, others cumulative text snapshots.
  // If any text announces Seedance has started, do not send a duplicate,
  // including the case where the model name differs from the selected model.
  return !fragments.some(announcesStart)&&!announcesStart(fragments.join(''));
}

export function shouldSendPostConfirmationGenerate({
  confirmationSent=false,generateSent=false,videoStarted=false,reply=null
}={}){
  return Boolean(confirmationSent&&!generateSent&&!videoStarted&&
    reply?.hasReplyText&&reply?.needsGenerate&&!reply?.started);
}

export function assertVideoStartReply(reply,expectedModel,{afterConfirmation=false}={}){
  if(reply?.hasReplyText&&!reply.started){
    const stage=afterConfirmation?'发送「确认」后，豆包的新回复':'豆包回复';
    throw new Error('视频未开始生成：'+stage+
      '不是「本次使用 '+expectedModel+' 生成」；请检查账号窗口');
  }
  return Boolean(reply?.started);
}

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
export async function watchNewVideoConfirmation(page,expectedModel='Seedance 2.0 Mini'){
  await page.evaluate(model=>{
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
    let generationStarted=false;
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
        const started=/^本次使用Seedance2\.0(Mini|Fast)生成/.exec(
          compactText(text).replace(/\*\*/g,''));
        if(started&&model==='Seedance 2.0 '+started[1])
          generationStarted=true;
        if(compactText(text).includes(phrase)){
          requested=true;
          return;
        }
      }
    };
    const observer=new MutationObserver(records=>{
      // Keep observing after a confirmation question: the following assistant
      // reply must still be checked for the actual Seedance start sentence.
      if(requested&&generationStarted)return;
      for(const record of records){
        if(record.type==='characterData')check(record.target);
        for(const node of record.addedNodes)check(node);
        if(requested&&generationStarted)break;
      }
    });
    observer.observe(document.body,{subtree:true,childList:true,characterData:true});
    window.__tapnowVideoConfirmMonitor={
      get requested(){return requested;},
      get generationStarted(){return generationStarted;},
      stop(){observer.disconnect();}
    };
  },expectedModel);
  return {
    async requested(){
      return page.evaluate(()=>
        Boolean(window.__tapnowVideoConfirmMonitor?.requested)).catch(()=>false);
    },
    async started(){
      return page.evaluate(()=>
        Boolean(window.__tapnowVideoConfirmMonitor?.generationStarted)).catch(()=>false);
    },
    async stop(){
      await page.evaluate(()=>{
        window.__tapnowVideoConfirmMonitor?.stop?.();
        delete window.__tapnowVideoConfirmMonitor;
      }).catch(()=>{});
    }
  };
}
