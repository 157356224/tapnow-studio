// Only the stable shapes observed in the operator's HAR are represented here.
// The HAR is NOT a bearer-token template: never copy auth, cookies, signature,
// device identifiers, transient signed URLs or conversation IDs from it.
export const SEEDANCE_HAR_ABILITY_TYPE=17;
export const SEEDANCE_HAR_MODEL='seedance_v2.0';

const safeParse=value=>{
  try{return typeof value==='string'?JSON.parse(value):value;}
  catch{return null;}
};

export function inspectVideoSubmission(body) {
  const payload=safeParse(body);
  const ability=safeParse(payload?.chat_ability?.ability_param);
  const attachments=(payload?.messages||[]).flatMap(message=>
    (message.content_block||[]).flatMap(block=>
      block?.content?.attachment_block?.attachments||[]
    )
  );
  return {
    abilityType:payload?.chat_ability?.ability_type??null,
    model:typeof ability?.model==='string'?ability.model:null,
    ratio:typeof ability?.ratio==='string'?ability.ratio:null,
    duration:Number.isFinite(Number(ability?.duration))?Number(ability?.duration):null,
    resolution:typeof ability?.resolution==='string'?ability.resolution:null,
    referenceCount:attachments.filter(x=>typeof x==='object'&&x!==null).length,
    hasVideoInput:Boolean(ability?.input_box_content),
  };
}

export function validateObservedSubmission(actual,expected) {
  if(actual.abilityType!==SEEDANCE_HAR_ABILITY_TYPE)
    throw new Error('网页发送的不是 HAR 记录的 Seedance 视频生成能力');
  if(actual.ratio!==expected.ratio)
    throw new Error('网页实际提交的比例与视频节点不一致（'+String(actual.ratio)+'）');
  if(actual.duration!==Number.parseInt(expected.duration,10))
    throw new Error('网页实际提交的时长与视频节点不一致（'+String(actual.duration)+'）');
  if(actual.referenceCount!==expected.references.length)
    throw new Error('网页提交的参考图片数量与节点引用数量不一致');
  // The observed request used seedance_v2.0, but a single capture does not
  // prove that this ID exclusively means Fast. Check the visible UI separately.
  if(!actual.model?.startsWith('seedance_v2.0'))
    throw new Error('网页实际提交的模型不属于 HAR 观察到的 Seedance 2.0 系列');
  return true;
}

export function parseSseEvents(text) {
  if(typeof text!=='string')return [];
  return text.split(/\r?\n\r?\n/).map(chunk=>{
    const lines=chunk.split(/\r?\n/);
    const event=lines.find(x=>x.startsWith('event:'))?.slice(6).trim();
    if(!event)return null;
    return {
      event,
      // Do not surface arbitrary event data to UI, files or logs.
      hasData:lines.some(x=>x.startsWith('data:'))
    };
  }).filter(Boolean);
}

export function findVideoIds(value) {
  const ids=new Set();
  const seen=new WeakSet();
  const walk=(node,depth=0)=>{
    if(depth>13 || ids.size>50 || node===null)return;
    if(typeof node==='string'){
      if(depth<9 && node.length<500000 &&
        (node.startsWith('{')||node.startsWith('['))){
        const json=safeParse(node);
        if(json)walk(json,depth+1);
      }
      return;
    }
    if(typeof node!=='object'||seen.has(node))return;
    seen.add(node);
    if(Array.isArray(node))return node.slice(0,300).forEach(x=>walk(x,depth+1));
    for(const [key,field] of Object.entries(node).slice(0,100)){
      if(/^(vid|video_id|videoId)$/.test(key) &&
        typeof field==='string' && /^v[a-z0-9]{20,45}$/i.test(field))ids.add(field);
      else if(typeof field==='object' || typeof field==='string')walk(field,depth+1);
    }
  };
  walk(value);
  return [...ids];
}

// Resolves one non-expired signed download URL only from fresh, account-local
// responses. Never persist remote URLs as project mediaUrl.
export function getSignedVideoDownload(reply,videoId) {
  const parsed=safeParse(reply);
  const data=parsed?.data;
  const entry=data?.download_video?.[videoId];
  const raw=entry?.download_url;
  if(typeof raw!=='string')return null;
  try {
    const url=new URL(raw);
    if(url.protocol!=='https:')return null;
    if(!/(\.|^)(doubao\.com|snssdk\.com|byteimg\.com|bytedance\.com)$/.test(url.hostname))
      return null;
    return raw;
  }catch{return null;}
}

export function validateImageReferences(references) {
  if(!Array.isArray(references))throw new Error('参考素材格式错误');
  if(references.length>12)throw new Error('最多支持 12 张参考图片');
  for(const ref of references){
    if(ref?.kind!=='image')throw new Error('本版本仅支持图片参考，音频与视频参考暂不启用');
    if(typeof ref.url!=='string'||!ref.url.startsWith('/api/uploads/'))
      throw new Error('图片参考必须先上传到画布本地素材库');
  }
  return true;
}
