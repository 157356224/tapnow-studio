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
  kind:'image'|'audio';
  title:string;
  token:string;
  url:string;
  connected:boolean;
  voiceDefinition?:string;
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

/** Image nodes can reference images; video nodes can reference images and audio. */
export function referencesForNode(id:string,nodes:StudioNode[],edges:StudioEdge[]):ReferenceNode[]{
  const byId=new Map(nodes.map(node=>[node.id,node]));
  const target=byId.get(id);
  const connected=[...new Set(edges.filter(e=>e.target===id).map(e=>e.source))]
    .filter(source=>{
      const node=byId.get(source);
      return source!==id&&(node?.data.kind==='image'||
        (target?.data.kind==='video'&&node?.data.kind==='audio'));
    });
  const preferred=Array.isArray(target?.data.referenceOrder)
    ?target.data.referenceOrder:[];
  const order=[...new Set([...preferred,...connected])].filter(source=>connected.includes(source));
  // Number image and audio attachments separately, so @图片N keeps its
  // meaning when an audio edge is connected or reordered.
  const imageIds=order.filter(source=>byId.get(source)?.data.kind==='image');
  const audioIds=order.filter(source=>byId.get(source)?.data.kind==='audio');
  return [...imageIds,...audioIds].map(source=>{
    const node=byId.get(source)!;
    const kind=node.data.kind as 'image'|'audio';
    const index=(kind==='image'?imageIds:audioIds).indexOf(source)+1;
    const prefix=kind==='image'?'图片':'音频';
    return {id:source,kind,title:node.data.title||prefix+index,
      token:'@'+prefix+index,url:node.data.mediaUrl||'',connected:true,
      voiceDefinition:kind==='image'?node.data.voiceDefinition:undefined};
  });
}

/**
 * Voice text is computed from the current connections and literal @图片N
 * mentions. Do not persist the derived prefix in node.data.prompt; removing
 * a mention or changing an image's voice must update the result immediately.
 */
export function voiceDefinitionsForPrompt(prompt:string,references:ReferenceNode[]){
  const mentioned=new Set(Array.from(prompt.matchAll(/@图片\d+/g),match=>match[0]));
  return references.filter(ref=>
    ref.connected&&ref.kind==='image'&&mentioned.has(ref.token)&&
    typeof ref.voiceDefinition==='string'&&ref.voiceDefinition.trim()
  ).map(ref=>({
    id:ref.id,token:ref.token,title:ref.title,
    definition:ref.voiceDefinition!.trim()
  }));
}

export function composeVideoPrompt(prompt:string,references:ReferenceNode[]){
  const voiceLines=voiceDefinitionsForPrompt(prompt,references).map(ref=>
    ref.token+'（'+ref.title+'）音色：'+ref.definition);
  if(!voiceLines.length)return prompt;
  return '【角色音色定义】\n'+voiceLines.join('\n')+'\n\n'+prompt;
}

/** Keep each token attached to the source ID when reordered. */
export function reorderReferenceNodes(
  prompt:string,references:ReferenceNode[],id:string,direction:-1|1
):{order:string[];prompt:string}{
  const kind=references.find(ref=>ref.id===id)?.kind;
  const group=references.filter(ref=>ref.kind===kind);
  const index=group.findIndex(ref=>ref.id===id);
  const next=index+direction;
  if(index<0||next<0||next>=group.length)
    return {order:references.map(ref=>ref.id),prompt};
  [group[index],group[next]]=[group[next],group[index]];
  let at=0;
  const updated=references.map(ref=>ref.kind===kind?group[at++]:ref);
  const byOriginalToken=new Map(references.map(ref=>[ref.token,ref.id]));
  const ordinal={image:0,audio:0};
  const byId=new Map(updated.map(ref=>{
    ordinal[ref.kind]++;
    return [ref.id,'@'+(ref.kind==='image'?'图片':'音频')+ordinal[ref.kind]];
  }));
  const newPrompt=prompt.replace(/@(图片|音频)\d+/g,token=>{
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
  // A wire only makes a media node available for @ selection. It is NEVER an
  // upload request. Legacy explicitIds are only an editor UI hint.
  void explicitIds;
  const connected=new Map(references.filter(ref=>ref.connected).map(ref=>[ref.token,ref]));
  const used=new Set<string>();
  for(const [,prefix,digits] of prompt.matchAll(/@(图片|音频)(\d+)/g)){
    const index=Number(digits);
    if(index<1||!Number.isSafeInteger(index)||String(index)!==digits)
      throw new Error('无效的素材引用：@'+prefix+digits);
    const token='@'+prefix+index;
    if(!connected.has(token))
      throw new Error('引用 '+token+' 没有对应的已连接素材，请调整 @ 引用');
    used.add(token);
  }
  // Upload in displayed order, not the occurrence order inside the prompt.
  return references.filter(ref=>{
    if(!used.has(ref.token))return false;
    if(!ref.url)throw new Error(ref.token+' 对应的'+(ref.kind==='audio'?'音频':'图片')+'节点还没有素材');
    return true;
  });
}
