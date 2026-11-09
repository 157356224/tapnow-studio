import {useCallback,useEffect,useRef,useState} from 'react';
import {
  snapshotCanvas,diffCanvas,emptyCanvasPatch,rebaseLocalCanvas,withLocalNodeSelection
} from './share-sync.mjs';
import type {CanvasGroup,Project,StudioEdge,StudioNode} from './types';
import {uuid} from './uuid';
import {guestRoute} from './remoteGuest';

export type ShareRole='loading'|'none'|'join'|'host'|'guest';
export type ShareInfo={
  role:ShareRole;
  projectId?:string;
  code?:string;
  links?:string[];
  clientId?:string;
  label?:string;
};
export type ShareLock={nodeId:string;clientId:string;label:string};
export type ShareMember={id:string;label:string;role:'host'|'guest'};
type Canvas={title:string;nodes:StudioNode[];edges:StudioEdge[];
  groups:CanvasGroup[];groupColorCursor:number};
type ShareEvent={
  type:'state'|'stopped';revision?:number;project?:Project;
  locks?:ShareLock[];online?:ShareMember[];
};
type ModelRef<T>={current:T};

const clientStorageKey='tapnow-collaboration-client';
function clientId(){
  let stored=sessionStorage.getItem(clientStorageKey);
  if(!stored){
    stored=uuid();
    sessionStorage.setItem(clientStorageKey,stored);
  }
  return stored;
}
async function api<T>(url:string,init?:RequestInit):Promise<T>{
  const response=await fetch(guestRoute(url),init);
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||'协作连接失败');
  return data as T;
}
const post=<T>(url:string,body:unknown)=>api<T>(url,{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
});

export function useSharedCanvas(args:{
  projectId:string;ready:boolean;
  nodes:StudioNode[];edges:StudioEdge[];groups:CanvasGroup[];
  title:string;groupColorCursor:ModelRef<number>;
  nodesRef:ModelRef<StudioNode[]>;edgesRef:ModelRef<StudioEdge[]>;
  groupsRef:ModelRef<CanvasGroup[]>;
  setNodes:(value:StudioNode[]|((current:StudioNode[])=>StudioNode[]))=>void;
  setEdges:(value:StudioEdge[]|((current:StudioEdge[])=>StudioEdge[]))=>void;
  setGroups:(value:CanvasGroup[]|((current:CanvasGroup[])=>CanvasGroup[]))=>void;
  setTitle:(value:string)=>void;
  notify:(message:string)=>void;
}){
  const {projectId,ready,nodes,edges,groups,title,groupColorCursor,nodesRef,
    edgesRef,groupsRef,setNodes,setEdges,setGroups,setTitle,notify}=args;
  const [share,setShare]=useState<ShareInfo>({role:'loading'});
  const [locks,setLocks]=useState<ShareLock[]>([]);
  const [online,setOnline]=useState<ShareMember[]>([]);
  const shareRef=useRef(share);
  shareRef.current=share;
  const titleRef=useRef(title);
  titleRef.current=title;
  const ownId=useRef(clientId());
  const baseline=useRef<Canvas|null>(null);
  const revision=useRef(0);
  const source=useRef<EventSource|null>(null);
  const sending=useRef<Promise<void>|null>(null);
  const selectedLock=useRef<string|null>(null);
  const locksRef=useRef<ShareLock[]>([]);
  locksRef.current=locks;
  const active=share.role==='host'||share.role==='guest';

  const current=useCallback(()=>snapshotCanvas({
    title:titleRef.current,nodes:nodesRef.current,edges:edgesRef.current,
    groups:groupsRef.current,groupColorCursor:groupColorCursor.current
  }) as Canvas,[nodesRef,edgesRef,groupsRef,groupColorCursor]);

  const applyRemote=useCallback((event:ShareEvent)=>{
    if(event.type==='stopped'){
      setShare({role:'join'});
      source.current?.close();source.current=null;
      baseline.current=null;
      setLocks([]);setOnline([]);
      notify('主机已关闭共享画布');
      return;
    }
    if(event.locks)setLocks(event.locks);
    if(event.online)setOnline(event.online);
    if(!event.project||!event.revision||event.revision<=revision.current)return;
    const remote=snapshotCanvas(event.project) as Canvas;
    const merged=baseline.current
      ?rebaseLocalCanvas(current(),baseline.current,remote) as Canvas
      :remote;
    baseline.current=remote;
    revision.current=event.revision;
    groupColorCursor.current=merged.groupColorCursor;
    setNodes(previous=>withLocalNodeSelection(merged,previous) as StudioNode[]);
    setEdges(merged.edges);
    setGroups(merged.groups);
    if(titleRef.current!==merged.title){
      titleRef.current=merged.title;
      setTitle(merged.title);
    }
  },[current,groupColorCursor,setNodes,setEdges,setGroups,setTitle,notify]);

  const flush=useCallback(async()=>{
    if(!['host','guest'].includes(shareRef.current.role)||!baseline.current)return;
    if(sending.current){await sending.current;return flush();}
    const patch=diffCanvas(baseline.current,current());
    if(emptyCanvasPatch(patch))return;
    const work=(async()=>{
      const response=await post<{revision:number;project:Project}>('/api/share/patch',{
        patch,clientId:ownId.current
      });
      applyRemote({...response,type:'state'});
    })();
    sending.current=work;
    try{await work;}finally{sending.current=null;}
    // Changes made while this HTTP request was in flight need another patch.
    const remaining=diffCanvas(baseline.current,current());
    if(!emptyCanvasPatch(remaining))void flush();
  },[current,applyRemote]);

  const initializeFromProject=useCallback((project:Project)=>{
    if(['host','guest'].includes(shareRef.current.role)){
      baseline.current=snapshotCanvas(project) as Canvas;
      revision.current=0;
    }
  },[]);

  useEffect(()=>{
    let alive=true;
    void api<ShareInfo>('/api/share/info')
      .then(info=>{if(alive)setShare(
        ['host','guest','join'].includes(info?.role)?info:{role:'none'}
      );})
      .catch(()=>{if(alive)setShare({role:'none'});});
    return()=>{alive=false;};
  },[]);

  useEffect(()=>{
    if(!active||!ready||projectId!==share.projectId)return;
    const events=new EventSource(guestRoute('/api/share/events?clientId='+
      encodeURIComponent(ownId.current)));
    source.current=events;
    events.onmessage=e=>{
      try{applyRemote(JSON.parse(e.data) as ShareEvent);}catch{}
    };
    events.onerror=()=>notify('协作连接中断，正在重连…');
    return()=>{
      events.close();
      if(source.current===events)source.current=null;
    };
  },[active,ready,projectId,share.projectId,applyRemote,notify]);

  useEffect(()=>{
    if(!active||!ready||projectId!==share.projectId||!baseline.current)return;
    const timeout=setTimeout(()=>void flush().catch(error=>notify(error.message)),90);
    return()=>clearTimeout(timeout);
  },[active,ready,projectId,share.projectId,nodes,edges,groups,title,flush,notify]);

  const start=useCallback(async()=>{
    if(!projectId)throw new Error('请先打开画布');
    const result=await post<ShareInfo>('/api/share/start',{
      projectId,clientId:ownId.current
    });
    baseline.current=current();revision.current=0;
    setShare(result);
    return result;
  },[projectId,current]);
  const stop=useCallback(async()=>{
    await post('/api/share/stop',{clientId:ownId.current});
    source.current?.close();
    source.current=null;
    baseline.current=null;
    selectedLock.current=null;
    setLocks([]);setOnline([]);
    setShare({role:'none'});
  },[]);
  const join=useCallback(async(code:string)=>{
    const result=await post<ShareInfo>('/api/share/join',{code});
    baseline.current=null;revision.current=0;
    setShare(result);
    return result;
  },[]);
  const leave=useCallback(async()=>{
    await post('/api/share/leave',{});
    source.current?.close();source.current=null;
    baseline.current=null;selectedLock.current=null;
    setLocks([]);setOnline([]);
    setShare({role:'join'});
  },[]);
  const release=useCallback((id?:string)=>{
    const target=id||selectedLock.current;
    if(!target||!['host','guest'].includes(shareRef.current.role))return;
    if(selectedLock.current===target)selectedLock.current=null;
    void post('/api/share/lock',{action:'release',nodeId:target,
      clientId:ownId.current}).catch(()=>{});
  },[]);
  const lockedByOther=useCallback((id:string)=>{
    const lock=locksRef.current.find(item=>item.nodeId===id);
    return lock&&lock.clientId!==(
      shareRef.current.role==='guest'?shareRef.current.clientId:ownId.current)
      ?lock.label:null;
  },[]);
  const acquire=useCallback(async(id:string)=>{
    if(!['host','guest'].includes(shareRef.current.role))return true;
    const locked=lockedByOther(id);
    if(locked){notify(locked+' 正在使用此节点');return false;}
    if(selectedLock.current&&selectedLock.current!==id)release();
    try{
      await post('/api/share/lock',{action:'acquire',nodeId:id,
        clientId:ownId.current});
      selectedLock.current=id;
      return true;
    }catch(error){
      notify((error as Error).message);
      return false;
    }
  },[lockedByOther,release,notify]);
  useEffect(()=>{
    if(!active)return;
    const interval=setInterval(()=>{
      const target=selectedLock.current;
      if(target)void post('/api/share/lock',{action:'heartbeat',
        nodeId:target,clientId:ownId.current}).catch(()=>{selectedLock.current=null;});
    },7000);
    return()=>{clearInterval(interval);release();};
  },[active,release]);

  return {
    share,shareRef,active,locks,online,ownId:ownId.current,
    setShare,start,stop,join,leave,flush,initializeFromProject,
    acquire,release,lockedByOther
  };
}
