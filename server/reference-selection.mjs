// All upload selections are derived from prompt @图片N tokens and incoming
// graph edges. The client-supplied list never grants permission by itself.
import fs from 'node:fs';
import path from 'node:path';
export function projectImageReferences(project,nodeId,prompt,submitted=[]){
  const nodes=new Map((project.nodes||[]).map(n=>[n.id,n]));
  const target=nodes.get(nodeId);
  const connected=[...new Set((project.edges||[]).filter(e=>e.target===nodeId)
    .map(e=>e.source))].filter(source=>source!==nodeId&&
      nodes.get(source)?.data?.kind==='image');
  const preferred=Array.isArray(target?.data?.referenceOrder)
    ?target.data.referenceOrder:[];
  const order=[...new Set([...preferred,...connected])]
    .filter(id=>connected.includes(id));
  const available=order.map((id,i)=>{
    const node=nodes.get(id);
    return {
      id,kind:'image',
      name:String(node.data.mediaName||node.data.title||'图片'+(i+1)),
      token:'@图片'+(i+1),url:node.data.mediaUrl||''
    };
  });
  const used=new Set();
  for(const [,digits] of String(prompt||'').matchAll(/@图片(\d+)/g)){
    const index=Number(digits);
    const ref=available[index-1];
    if(!ref||index<1||!Number.isSafeInteger(index)||String(index)!==digits)
      throw new Error('引用 @图片'+digits+' 没有对应的已连接图片');
    if(!ref.url)throw new Error('引用 @图片'+digits+' 对应的图片节点还没有图片素材');
    used.add(ref.id);
  }
  const chosen=available.filter(ref=>used.has(ref.id));
  if(!Array.isArray(submitted)||submitted.length!==chosen.length||
      chosen.some((ref,i)=>submitted[i]?.id!==ref.id))
    throw new Error('提交的参考图片必须与输入框 @图片 引用完全一致，不能自动上传其他已连接图片');
  return chosen;
}

export function localReferenceFile(uploadDir,url){
  if(typeof url!=='string'||!url.startsWith('/api/uploads/'))return null;
  const name=url.slice('/api/uploads/'.length);
  if(!/^[a-f0-9-]{36}\.(png|jpg|jpeg|webp)$/i.test(name))return null;
  const file=path.join(uploadDir,name);
  return fs.existsSync(file)?file:null;
}
