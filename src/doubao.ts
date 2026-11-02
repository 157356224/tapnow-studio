import type { StudioNode, StudioEdge } from './types';

export type DoubaoAccount = {
  id: string;
  name: string;
  hasCookie: boolean;
  browserEngine?: 'edge';
  createdAt: string;
  profile: 'isolated-chromium';
};
export type ReferenceNode = {
  id:string;
  kind:'image';
  title:string;
  token:string;
  url:string;
  connected:boolean;
};
export type DoubaoJob = {
  id:string;
  accountId:string;
  projectId:string;
  nodeId:string;
  model:string;
  status:'queued'|'starting'|'running'|'completed'|'needs-attention'|'needs-login'|'interrupted';
  progress:number;
  message:string;
  error?:string;
  videoUrl?:string;
};

/** Only image nodes that have an incoming wire to this video can be referenced. */
export function referencesForNode(id:string,nodes:StudioNode[],edges:StudioEdge[]):ReferenceNode[]{
  const byId=new Map(nodes.map(node=>[node.id,node]));
  const target=byId.get(id);
  const connected=[...new Set(edges.filter(e=>e.target===id).map(e=>e.source))]
    .filter(source=>{
      const node=byId.get(source);
      return source!==id&&node?.data.kind==='image';
    });
  const preferred=Array.isArray(target?.data.referenceOrder)
    ?target.data.referenceOrder:[];
  const order=[...new Set([...preferred,...connected])].filter(source=>connected.includes(source));
  return order.map((source,index)=>{
    const node=byId.get(source)!;
    return {id:source,kind:'image',title:node.data.title||'图片'+(index+1),
      token:'@图片'+(index+1),url:node.data.mediaUrl||'',connected:true};
  });
}

/** Keep each mentioned source image attached to its original ID when moved. */
export function reorderReferenceNodes(
  prompt:string,references:ReferenceNode[],id:string,direction:-1|1
):{order:string[];prompt:string}{
  const updated=[...references];
  const index=updated.findIndex(ref=>ref.id===id);
  const next=index+direction;
  if(index<0||next<0||next>=updated.length)
    return {order:updated.map(ref=>ref.id),prompt};
  [updated[index],updated[next]]=[updated[next],updated[index]];
  const byOriginalToken=new Map(references.map(ref=>[ref.token,ref.id]));
  const byId=new Map(updated.map((ref,index)=>[ref.id,'@图片'+(index+1)]));
  const newPrompt=prompt.replace(/@图片\d+/g,token=>{
    const oldId=byOriginalToken.get(token);
    return oldId?byId.get(oldId)||token:token;
  });
  return {order:updated.map(ref=>ref.id),prompt:newPrompt};
}

export function resolveReferences(
  prompt:string,
  explicitIds:string[],
  references:ReferenceNode[]
):ReferenceNode[]{
  // A wire only makes an image available for @ selection. It is NEVER an
  // upload request. Legacy explicitIds are only an editor UI hint.
  void explicitIds;
  const connected=new Map(references.filter(ref=>ref.connected).map(ref=>[ref.token,ref]));
  const used=new Set<string>();
  for(const [,digits] of prompt.matchAll(/@图片(\d+)/g)){
    const index=Number(digits);
    if(index<1||!Number.isSafeInteger(index)||String(index)!==digits)
      throw new Error('无效的图片引用：@图片'+digits);
    const token='@图片'+index;
    if(!connected.has(token))
      throw new Error('引用 '+token+' 没有对应的已连接图片，请调整 @ 图片引用');
    used.add(token);
  }
  // Upload in the displayed reference order, not the order of @ words in
  // the prompt. E.g. '@图片2 ... @图片1' must attach image 1, then image 2.
  return references.filter(ref=>{
    if(!used.has(ref.token))return false;
    if(!ref.url)throw new Error(ref.token+' 对应的图片节点还没有图片素材');
    return true;
  });
}
