// All upload selections are derived from prompt @图片N / @音频N tokens and incoming
// graph edges. The client-supplied list never grants permission by itself.
import fs from 'node:fs';
import path from 'node:path';
export function projectMediaReferences(project,nodeId,prompt,submitted=[]){
  const nodes=new Map((project.nodes||[]).map(n=>[n.id,n]));
  const target=nodes.get(nodeId);
  const connected=[...new Set((project.edges||[]).filter(e=>e.target===nodeId)
    .map(e=>e.source))].filter(source=>source!==nodeId&&(
      nodes.get(source)?.data?.kind==='image'||
      (target?.data?.kind==='video'&&nodes.get(source)?.data?.kind==='audio')));
  const preferred=Array.isArray(target?.data?.referenceOrder)
    ?target.data.referenceOrder:[];
  const order=[...new Set([...preferred,...connected])]
    .filter(id=>connected.includes(id));
  const images=order.filter(id=>nodes.get(id)?.data?.kind==='image');
  const audios=order.filter(id=>nodes.get(id)?.data?.kind==='audio');
  const available=[...images,...audios].map(id=>{
    const node=nodes.get(id);
    const kind=node.data.kind;
    const prefix=kind==='audio'?'音频':'图片';
    const index=(kind==='audio'?audios:images).indexOf(id)+1;
    return {
      id,kind,
      name:String(node.data.title||node.data.mediaName||prefix+index),
      token:'@'+prefix+index,url:node.data.mediaUrl||''
    };
  });
  const used=new Set();
  for(const [,prefix,digits] of String(prompt||'').matchAll(/@(图片|音频)(\d+)/g)){
    const index=Number(digits);
    const ref=available.find(ref=>ref.token==='@'+prefix+index);
    if(!ref||index<1||!Number.isSafeInteger(index)||String(index)!==digits)
      throw new Error('引用 @'+prefix+digits+' 没有对应的已连接'+prefix);
    if(!ref.url)throw new Error('引用 @'+prefix+digits+' 对应的'+prefix+'节点还没有'+prefix+'素材');
    used.add(ref.id);
  }
  const chosen=available.filter(ref=>used.has(ref.id));
  if(!Array.isArray(submitted)||submitted.length!==chosen.length||
      chosen.some((ref,i)=>submitted[i]?.id!==ref.id))
    throw new Error('提交的参考素材必须与输入框 @ 引用完全一致，不能自动上传其他已连接素材');
  return chosen;
}

// Historical API name is used by existing tests and the image-to-image flow.
export const projectImageReferences=projectMediaReferences;

export function localReferenceFile(uploadDir,url){
  if(typeof url!=='string'||!url.startsWith('/api/uploads/'))return null;
  const name=url.slice('/api/uploads/'.length);
  if(!/^[a-f0-9-]{36}\.(png|jpg|jpeg|webp|mp3|wav|m4a|ogg|aac|flac|webm)$/i.test(name))return null;
  const file=path.join(uploadDir,name);
  return fs.existsSync(file)?file:null;
}
