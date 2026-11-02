// Muse jobs update both image and video nodes without losing results to a
// delayed browser autosave.
export function setMuseProjectJob(projects,job,patch){
  let changed=false;
  const updated=projects.map(project=>{
    if(project.id!==job.projectId)return project;
    const nodes=project.nodes.map(node=>{
      if(node.id!==job.nodeId||node.data?.kind!==job.kind)return node;
      if(patch.status!=='queued'&&node.data?.jobId!==job.id)return node;
      changed=true;
      return {...node,data:{...node.data,jobId:job.id,...patch}};
    });
    return changed?{...project,nodes,updatedAt:new Date().toISOString()}:project;
  });
  return {changed,projects:updated};
}

export function preserveMuseCompletedMedia(oldProject,incomingNodes){
  const previous=new Map((oldProject.nodes||[]).map(n=>[n.id,n]));
  return incomingNodes.map(node=>{
    const old=previous.get(node.id);
    if(!old||!['image','video'].includes(old.data?.kind)||
       old.data?.provider!=='muse'||!old.data?.jobId)return node;
    if(['queued','running'].includes(old.data.status)&&
      old.data.jobId!==node.data?.jobId)
      return {...node,data:{...node.data,jobId:old.data.jobId,
        status:old.data.status,jobMessage:old.data.jobMessage}};
    if(old.data.status==='done'&&old.data.mediaUrl&&
      old.data.jobId===node.data?.jobId)
      return {...node,data:{...node.data,mediaUrl:old.data.mediaUrl,
        status:'done',progress:100,demo:false,
        jobMessage:old.data.jobMessage||'Muse 媒体已回填'}};
    if(old.data.status==='error'&&old.data.jobId===node.data?.jobId&&
      node.data.status==='running')
      return {...node,data:{...node.data,status:'error',progress:0,
        jobMessage:old.data.jobMessage||'Muse 任务需要操作'}};
    return node;
  });
}
