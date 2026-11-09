// Shared by the browser and the Node.js host. Only stable canvas properties
// participate: local selection, viewport and React Flow measurements do not.
const json=value=>JSON.stringify(value);
const same=(a,b)=>json(a)===json(b);
const clone=value=>structuredClone(value);
const present=value=>value!==undefined&&value!==null;

export function snapshotCanvas(project){
  return {
    title:String(project.title||'Untitled'),
    nodes:(project.nodes||[]).map(node=>{
      const {selected,dragging,measured,resizing,internals,
        __rf,...stored}=node;
      return clone(stored);
    }),
    edges:(project.edges||[]).map(edge=>{
      const {selected,...stored}=edge;
      return clone(stored);
    }),
    groups:clone(project.groups||[]),
    groupColorCursor:Number(project.groupColorCursor)||0
  };
}

function diffItems(before,after,{node=false}={}){
  const previous=new Map(before.map(item=>[item.id,item]));
  const current=new Map(after.map(item=>[item.id,item]));
  const remove=before.filter(item=>!current.has(item.id)).map(item=>item.id);
  const upsert=[];
  for(const item of after){
    const old=previous.get(item.id);
    if(!old){upsert.push({id:item.id,create:item});continue;}
    if(same(old,item))continue;
    if(!node){upsert.push({id:item.id,replace:item});continue;}
    const fields={};
    for(const key of new Set([...Object.keys(old),...Object.keys(item)])){
      if(['id','data'].includes(key))continue;
      if(!same(old[key],item[key]))fields[key]=Object.hasOwn(item,key)?clone(item[key]):null;
    }
    const data={};
    const previousData=old.data||{};
    const currentData=item.data||{};
    for(const key of new Set([...Object.keys(previousData),...Object.keys(currentData)])){
      if(!same(previousData[key],currentData[key]))
        data[key]=Object.hasOwn(currentData,key)?clone(currentData[key]):null;
    }
    upsert.push({id:item.id,fields,data});
  }
  return {upsert,remove};
}

export function diffCanvas(previous,next){
  const before=snapshotCanvas(previous),after=snapshotCanvas(next);
  const nodes=diffItems(before.nodes,after.nodes,{node:true});
  const edges=diffItems(before.edges,after.edges);
  const groups=diffItems(before.groups,after.groups);
  const result={nodes,edges,groups};
  if(before.title!==after.title)result.title=after.title;
  if(before.groupColorCursor!==after.groupColorCursor)
    result.groupColorCursor=after.groupColorCursor;
  return result;
}
export function emptyCanvasPatch(patch){
  return !['nodes','edges','groups'].some(key=>patch[key]?.upsert?.length||patch[key]?.remove?.length)
    &&!Object.hasOwn(patch,'title')&&!Object.hasOwn(patch,'groupColorCursor');
}

function patchItems(old,changes,{node=false,locks=new Map(),clientId=null}={}){
  const items=new Map(old.map(item=>[item.id,clone(item)]));
  if(!changes)return [...items.values()];
  for(const id of changes.remove||[]){
    if(locks.get(id)&&locks.get(id).clientId!==clientId)continue;
    items.delete(id);
  }
  for(const update of changes.upsert||[]){
    const id=update.id;
    if(typeof id!=='string'||id.length>200)continue;
    if(locks.get(id)&&locks.get(id).clientId!==clientId)continue;
    const existing=items.get(id);
    if(!existing){
      if(!update.create)continue;
      items.set(id,clone(update.create));continue;
    }
    if(!node){
      if(update.replace)items.set(id,clone(update.replace));
      continue;
    }
    const modified={...existing};
    for(const [key,value] of Object.entries(update.fields||{})){
      if(key==='id'||key==='data'||key==='selected'||key==='measured')continue;
      if(value===null)delete modified[key];
      else modified[key]=clone(value);
    }
    modified.data={...existing.data};
    for(const [key,value] of Object.entries(update.data||{})){
      if(value===null)delete modified.data[key];
      else modified.data[key]=clone(value);
    }
    items.set(id,modified);
  }
  return [...items.values()];
}

export function applyCanvasPatch(canvas,patch,options={}){
  const before=snapshotCanvas(canvas);
  const result={
    ...before,
    nodes:patchItems(before.nodes,patch.nodes,{...options,node:true}),
    edges:patchItems(before.edges,patch.edges),
    groups:patchItems(before.groups,patch.groups)
  };
  if(typeof patch.title==='string')result.title=patch.title.slice(0,100);
  if(Number.isSafeInteger(patch.groupColorCursor))
    result.groupColorCursor=Math.max(before.groupColorCursor,patch.groupColorCursor);
  return result;
}

export function rebaseLocalCanvas(local,oldRemote,newRemote){
  // Keep changes made locally since the old remote revision; merge any
  // independent changes that arrived from another collaborator.
  return applyCanvasPatch(newRemote,diffCanvas(oldRemote,local));
}

export function withLocalNodeSelection(snapshot,localNodes){
  const selected=new Map(localNodes.map(node=>[node.id,node.selected]));
  return snapshot.nodes.map(node=>({...node,
    selected:!!selected.get(node.id)
  }));
}
