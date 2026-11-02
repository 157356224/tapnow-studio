// Server-side project reconciliation: a running job survives a closed tab and
// cannot be overwritten with stale "running" data by debounced frontend saves.
export function setProjectJob(projects,job,patch) {
  let changed=false;
  const updated=projects.map(project=>{
    if(project.id!==job.projectId)return project;
    const nodes=project.nodes.map(node=>{
      if(node.id!==job.nodeId||node.data?.kind!=='video')return node;
      if(patch.status!=='queued' && node.data?.jobId!==job.id)return node;
      changed=true;
      return {...node,data:{...node.data,jobId:job.id,...patch}};
    });
    return changed?{...project,nodes,updatedAt:new Date().toISOString()}:project;
  });
  return {changed,projects:updated};
}

export function preserveCompletedVideoMedia(oldProject,incomingNodes) {
  const oldNodes=new Map((oldProject?.nodes||[]).map(node=>[node.id,node]));
  return incomingNodes.map(node=>{
    const old=oldNodes.get(node.id);
    if(!old||old.data?.kind!=='video'||!old.data?.jobId)return node;
    // A queued submission may have been accepted by the backend before the
    // frontend receives its jobId. A slow autosave must not erase that link.
    if(['queued','running'].includes(old.data.status)&&
      old.data.jobId!==node.data?.jobId){
      return {...node,data:{...node.data,
        jobId:old.data.jobId,status:old.data.status,
        jobMessage:old.data.jobMessage
      }};
    }
    if(old.data.status==='done'&&old.data.mediaUrl&&
      old.data.jobId===node.data?.jobId){
      return {...node,data:{...node.data,
        mediaUrl:old.data.mediaUrl,status:'done',progress:100,demo:false,
        jobMessage:old.data.jobMessage||'豆包视频已生成并回填'
      }};
    }
    if(old.data.status==='error'&&old.data.jobId===node.data?.jobId&&
      node.data.status==='running'){
      return {...node,data:{...node.data,
        status:'error',progress:0,
        jobMessage:old.data.jobMessage||'豆包任务失败，请重新发送'
      }};
    }
    return node;
  });
}
