import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap, ConnectionLineType,
  SelectionMode, ViewportPortal, addEdge, useEdgesState, useNodesState, useReactFlow
} from '@xyflow/react';
import type { Connection, Edge, NodeChange } from '@xyflow/react';
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, AudioLines, Bot, Check, ChevronDown,
  ChevronLeft, ChevronRight, CircleHelp, Clapperboard, Cloud, Copy, Download,
  Ellipsis, FilePlus2, FileText, FolderOpen, Grid3X3, Image as ImageIcon, Layers3, LayoutGrid,
  Maximize, Menu, MessageCircle, Minus, MousePointer2, PanelRightClose, PanelRightOpen,
  Plus, Redo2, Search, Settings2, Share2, SlidersHorizontal, Sparkles, Square,
  Type, Undo2, Upload, Video, WandSparkles, Workflow, X, ZoomIn, ZoomOut, Play,
  SquareDashedMousePointer, Trash2, LoaderCircle, CheckCircle2, Shield, Scissors
} from 'lucide-react';
import { StudioActionsContext } from './nodes';
import { ConnectionHighlightContext,ConnectionInvalidContext,FlowTargetContext,NodeEditorContext,StudioNodeV2 } from './StudioNodeV2';
import type { ConnectionHighlight,NodeEditorState } from './StudioNodeV2';
import {FlowEdge} from './FlowEdge';
import {SelectionGroupControls} from './SelectionGroupControls';
import {planGroupConnections} from './node-alignment.mjs';
import {snapNodePositionChanges} from './node-smart-guides.mjs';
import type {SmartGuides} from './node-smart-guides.mjs';
import { demoImages, defaultVideoModel, kindLabels, models, newData, normalizeVideoNodes, sampleAdCanvas, sampleCanvas, supportedDoubaoVideoModels } from './sample';
import { referencesForNode, resolveReferences, reorderReferenceNodes } from './doubao';
import type { DoubaoAccount, DoubaoJob } from './doubao';
import { AccountsPanel } from './AccountsPanel';
import {MuseAccountsPanel} from './MuseAccountsPanel';
import {MuseQuotaButton} from './MuseQuotaButton';
import type {MuseAccount,MuseJob,MuseQuotaSummary} from './muse';
import type { Kind, Project, ProjectSummary, StudioEdge, StudioNode, StudioNodeData } from './types';

const nodeTypes = { studio: StudioNodeV2 };
const edgeTypes = { blueflow: FlowEdge };
const edgeDefaults = {
  type: 'bezier',
  style: { stroke: '#535357', strokeWidth: 1.9 }
};
const entryTools: { kind: Kind; label: string; desc: string; icon: typeof ImageIcon }[] = [
  { kind: 'text', label: '文本', desc: '创意、脚本、提示词', icon: Type },
  { kind: 'image', label: '图片生成', desc: '文生图、图生图、编辑', icon: ImageIcon },
  { kind: 'video', label: '视频生成', desc: '文生视频、首尾帧', icon: Clapperboard },
  { kind: 'audio', label: '音频生成', desc: '配乐、音效、旁白', icon: AudioLines }
];
const uid = () => crypto.randomUUID();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Panel = 'agent' | 'projects' | 'assets' | 'inspector' | 'doubao' | 'muse' | null;
type NodeMenuOrigin = {id:string;side:'source'|'target';dropped:boolean;ids?:string[]};
type History = { nodes: StudioNode[]; edges: StudioEdge[] };
type Plan = { valid: boolean; steps?: {id: string; kind: Kind}[]; skipped?: string[]; error?: string };

// Reject duplicate pairs, reverse links and any edge which would create a cycle.
function canConnect(source: string, target: string, edges: StudioEdge[]) {
  if (!source || !target || source === target) return false;
  if (edges.some(e => (e.source === source && e.target === target) ||
                      (e.source === target && e.target === source))) return false;
  const visited = new Set<string>();
  const pending = [target];
  while (pending.length) {
    const id = pending.pop()!;
    if (id === source) return false;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const edge of edges) if (edge.source === id) pending.push(edge.target);
  }
  return true;
}

function mockPoster(kind: Kind, name: string) {
  const heading = kind === 'video' ? 'VIDEO CONCEPT' : kind === 'audio' ? 'AUDIO CONCEPT' : 'IMAGE CONCEPT';
  const safe = (name || 'Creative study').slice(0, 30).replace(/[<>&"']/g, ' ');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560" viewBox="0 0 900 560"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#233652"/><stop offset=".42" stop-color="#67617a"/><stop offset="1" stop-color="#231f32"/></linearGradient><radialGradient id="r"><stop stop-color="#dbc4cc" stop-opacity=".5"/><stop offset="1" stop-color="#dbc4cc" stop-opacity="0"/></radialGradient></defs><rect width="900" height="560" fill="url(#g)"/><circle cx="575" cy="220" r="300" fill="url(#r)"/><path d="M0 420 Q190 210 400 420 T900 360 V560 H0" fill="#293851" opacity=".65"/><path d="M0 490 Q300 280 520 460 T900 415 V560 H0" fill="#8b7c8d" opacity=".5"/><text x="50" y="69" fill="#f7f7fc" font-size="18" font-family="Arial" letter-spacing="5">' + heading + '</text><text x="50" y="510" fill="white" font-size="34" font-family="Arial">' + safe + '</text><text x="50" y="539" fill="#ffffff" opacity=".6" font-size="15" font-family="Arial">LOCAL DEMO · NOT AI GENERATED</text></svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
function exportTextFile(name: string, data: string, mime = 'application/json') {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function request<T>(route: string, init?: RequestInit): Promise<T> {
  const res = await fetch(route, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as {error?: string}).error || '服务器返回错误');
  return body as T;
}
function JSONBody(body: unknown): RequestInit { return { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) }; }

function Workspace() {
  const rf = useReactFlow<StudioNode, StudioEdge>();
  const [nodes, setNodes, onNodesChange] = useNodesState<StudioNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<StudioEdge>([]);
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('Untitled');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [ready, setReady] = useState(false);
  const [saveStatus, setSaveStatus] = useState('已保存到本地');
  const [panel, setPanel] = useState<Panel>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [menuOrigin,setMenuOrigin]=useState<NodeMenuOrigin|null>(null);
  const [menuPos, setMenuPos] = useState<{x:number;y:number;flow?:{x:number;y:number}}>({x:88,y:130});
  const [menuSearch, setMenuSearch] = useState('');
  const [agentDraft, setAgentDraft] = useState('');
  const [agentKind, setAgentKind] = useState<Kind>('image');
  const [toast, setToast] = useState('');
  const [running, setRunning] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [showMinimap, setShowMinimap] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [viewportRevision, setViewportRevision] = useState(0);
  const [showTemplates, setShowTemplates] = useState(false);
  const [doubaoAccounts, setDoubaoAccounts] = useState<DoubaoAccount[]>([]);
  const [museAccounts,setMuseAccounts]=useState<MuseAccount[]>([]);
  const [museQuota,setMuseQuota]=useState<MuseQuotaSummary|null>(null);
  const [museQuotaLoading,setMuseQuotaLoading]=useState(false);
  const [museQuotaError,setMuseQuotaError]=useState('');
  const [connectionHighlight, setConnectionHighlight] = useState<ConnectionHighlight | null>(null);
  const [draggingNodeId,setDraggingNodeId]=useState<string|null>(null);
  const [marqueeSelecting,setMarqueeSelecting]=useState(false);
  const [smartGuides,setSmartGuides]=useState<SmartGuides>(null);
  const nodeDragActive=useRef(false);
  const [cutMode,setCutMode]=useState(false);
  const [cutHoverEdge,setCutHoverEdge]=useState<string|null>(null);
  const cutModeRef=useRef(false);
  const cutHoverEdgeRef=useRef<string|null>(null);
  const cutPointerRef=useRef<{x:number;y:number}|null>(null);
  const cutCursorRef=useRef<HTMLDivElement>(null);
  const [invalidTargets,setInvalidTargets]=useState<ReadonlySet<string>>(new Set());
  // A React Flow selected node may be selected by drag/marquee. Only a direct
  // click should reveal the floating editor and its input focus targets.
  const [editorState,setEditorState]=useState<NodeEditorState>({id:null,instant:true});
  const connectionStart = useRef<{nodeId:string;handleType:'source'|'target'} | null>(null);
  const viewport = useRef({x:0,y:0,zoom:1});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectSaveTail=useRef<Promise<void>>(Promise.resolve());
  const generatingNodeIds=useRef(new Set<string>());
  const history = useRef<History[]>([]);
  const forward = useRef<History[]>([]);
  const clipboard = useRef<StudioNode[]>([]);
  const removalTimers=useRef(new Map<string,number>());
  const filePicker = useRef<HTMLInputElement>(null);
  const importPicker = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef<StudioNode[]>([]);
  const edgesRef = useRef<StudioEdge[]>([]);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  // During a drag positions change every frame, but edge styling depends on
  // selection/drag state only. Avoid rebuilding every edge per move.
  const selectionKey=nodes.filter(n=>n.selected).map(n=>n.id).join('|');
  const selectedSourceIds=useMemo(()=>new Set(selectionKey?selectionKey.split('|'):[]),[selectionKey]);
  // Droplet animations are expensive on large fan-out selections. Animate
  // connected wires only when exactly one node is selected; marquee/Shift
  // multi-selection renders ordinary static Bezier edges instead.
  const singleNodeSelected=!marqueeSelecting&&selectedSourceIds.size===1;
  const renderedEdges=useMemo(()=>edges.map(e=>({...e,
    type:singleNodeSelected&&(
      selectedSourceIds.has(e.source)||selectedSourceIds.has(e.target)||
      draggingNodeId===e.source||draggingNodeId===e.target)
      ?'blueflow':'bezier',
    style:{stroke:'#4d4d50',strokeWidth:1.9},
    markerEnd:undefined,zIndex:0
  })),[edges,selectedSourceIds,singleNodeSelected,draggingNodeId]);
  const flowTargetIds=useMemo(()=>new Set(
    edges.filter(e=>selectedSourceIds.has(e.source)).map(e=>e.target)
  ),[edges,selectedSourceIds]);

  const notify = useCallback((message: string) => setToast(message), []);
  const refreshDoubaoAccounts=useCallback(async()=>{
    try{
      const fresh=await request<DoubaoAccount[]>('/api/doubao/accounts');
      setDoubaoAccounts(fresh);
    }catch{setDoubaoAccounts([]);}
  },[]);
  const openAccountBrowser=useCallback(async(id:string)=>{
    try{
      const result=await request<{ok:boolean;message:string}>(
        '/api/doubao/accounts/'+id+'/native-login',JSONBody({browserEngine:'edge'})
      );
      notify(result.message);
    }catch(e){
      notify('打开账号浏览器失败：'+(e as Error).message);
    }
  },[notify]);
  const refreshMuseAccounts=useCallback(async()=>{
    try{setMuseAccounts(await request<MuseAccount[]>('/api/muse/accounts'));}
    catch{setMuseAccounts([]);}
  },[]);
  const refreshMuseQuota=useCallback(async(force=false)=>{
    setMuseQuotaLoading(true);
    try{
      const result=await request<MuseQuotaSummary>(
        '/api/muse/quotas'+(force?'?force=1':''));
      setMuseQuota(result);
      setMuseQuotaError('');
    }catch(e){setMuseQuotaError((e as Error).message);}
    finally{setMuseQuotaLoading(false);}
  },[]);
  const openMuseAccountBrowser=useCallback(async(id:string)=>{
    try{
      const result=await request<{ok:boolean;message:string}>(
        '/api/muse/accounts/'+id+'/native-login',JSONBody({browserEngine:'edge'})
      );
      notify(result.message);
    }catch(e){notify('打开 Muse 独立浏览器失败：'+(e as Error).message);}
  },[notify]);
  useEffect(()=>{
    void refreshDoubaoAccounts();
    const timer=setInterval(()=>{
      void refreshDoubaoAccounts();
    },120000);
    return ()=>clearInterval(timer);
  },[refreshDoubaoAccounts]);
  useEffect(()=>{
    void refreshMuseAccounts();
    const timer=setInterval(()=>void refreshMuseAccounts(),60000);
    return ()=>clearInterval(timer);
  },[refreshMuseAccounts]);
  useEffect(()=>{
    void refreshMuseQuota();
    const timer=setInterval(()=>void refreshMuseQuota(),60000);
    return ()=>clearInterval(timer);
  },[refreshMuseQuota]);
  useEffect(()=>{
    if(!museQuota?.refreshing)return;
    const timer=setInterval(()=>void refreshMuseQuota(),4000);
    return ()=>clearInterval(timer);
  },[museQuota?.refreshing,refreshMuseQuota]);
  useEffect(()=>{
    if(museAccounts.length)void refreshMuseQuota();
  },[museAccounts.length,refreshMuseQuota]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 3300); return () => clearTimeout(t); }, [toast]);
  const snapshot = useCallback(() => {
    history.current.push({nodes:structuredClone(nodesRef.current), edges:structuredClone(edgesRef.current)});
    if (history.current.length > 40) history.current.shift();
    forward.current = [];
  }, []);
  const undo = useCallback(() => {
    const item = history.current.pop();
    if (!item) return;
    forward.current.push({nodes:structuredClone(nodesRef.current), edges:structuredClone(edgesRef.current)});
    setNodes(item.nodes); setEdges(item.edges);
  }, [setNodes, setEdges]);
  const redo = useCallback(() => {
    const item = forward.current.pop();
    if (!item) return;
    history.current.push({nodes:structuredClone(nodesRef.current), edges:structuredClone(edgesRef.current)});
    setNodes(item.nodes); setEdges(item.edges);
  }, [setNodes, setEdges]);

  const openProject = useCallback(async (id: string) => {
    try {
      for(const pending of removalTimers.current.values())window.clearTimeout(pending);
      removalTimers.current.clear();
      setReady(false);
      const p = await request<Project>('/api/projects/' + id);
      setProjectId(p.id); setTitle(p.title); setNodes(normalizeVideoNodes(p.nodes)); setEdges(p.edges);
      history.current = []; forward.current = [];
      viewport.current = p.viewport;
      setPanel(null);
      setTimeout(() => { void rf.setViewport(p.viewport, {duration:300}); setReady(true); }, 60);
    } catch (e) { notify('打开项目失败：' + (e as Error).message); setReady(true); }
  }, [rf, setNodes, setEdges, notify]);
  useEffect(() => {
    let active = true;
    const init = async () => {
      try {
        const list = await request<ProjectSummary[]>('/api/projects');
        if (!active) return;
        if (list.length) { setProjects(list); await openProject(list[0].id); }
        else {
          const p = await request<Project>('/api/projects', JSONBody({
            title: 'Creative OS 新画布', nodes:[],edges:[], viewport: {x:0,y:0,zoom:1}
          }));
          if (!active) return;
          setProjects([{id:p.id,title:p.title,updatedAt:p.updatedAt}]);
          await openProject(p.id);
        }
      } catch (e) {
        setNodes([]); setEdges([]); setTitle('离线演示画布');
        setReady(true); notify('本地服务未连接，画布暂时仅保存在浏览器');
      }
    };
    void init();
    return () => { active = false; };
  }, []); // one-time initial load

  // Serialize full-project PUTs. Two fast submissions used to race: a stale
  // snapshot from node A could arrive AFTER node B's queued state was saved.
  // Each POST /jobs still runs independently once its own snapshot is saved.
  const saveProjectSnapshot=useCallback((
    id:string,content:Pick<Project,'title'|'nodes'|'edges'|'viewport'>
  )=>{
    const task=projectSaveTail.current.then(()=>request<{id:string;updatedAt:string}>(
      '/api/projects/'+id,{
        method:'PUT',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(content)
      }
    ));
    projectSaveTail.current=task.then(()=>{},()=>{});
    return task;
  },[]);
  const saveNow = useCallback(async () => {
    if (!projectId || !ready) return;
    try {
      setSaveStatus('正在保存…');
      const r=await saveProjectSnapshot(projectId,{
        title,nodes:nodesRef.current,edges:edgesRef.current,viewport:viewport.current
      });
      setSaveStatus('已保存到本地');
      setProjects(ps => ps.map(p => p.id === projectId ? {...p,title,updatedAt:r.updatedAt} : p));
    } catch (e) {
      setSaveStatus('保存失败');
      localStorage.setItem('tapnow-local-backup', JSON.stringify({title,nodes:nodesRef.current,edges:edgesRef.current,viewport:viewport.current}));
    }
  }, [projectId, ready, title, saveProjectSnapshot]);
  useEffect(() => {
    if (!ready) return;
    setSaveStatus('有未保存的更改');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void saveNow(); }, 1000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [nodes, edges, title, ready, viewportRevision, saveNow]);

  const createProject = useCallback(async (name='Untitled', template:'blank'|'demo'|'ad'='blank') => {
    try {
      const content = template === 'demo' ? sampleCanvas() : template === 'ad' ? sampleAdCanvas() : {nodes:[],edges:[]};
      const p = await request<Project>('/api/projects', JSONBody({title:name, ...content,viewport:{x:170,y:120,zoom:1}}));
      setProjects(prev => [{id:p.id,title:p.title,updatedAt:p.updatedAt},...prev]);
      setShowTemplates(false); await openProject(p.id);
      if (template !== 'blank') setTimeout(() => void rf.fitView({padding:.22,duration:450}), 200);
      notify('画布创建成功');
    } catch (e) { notify('创建失败：' + (e as Error).message); }
  }, [openProject, notify, rf]);
  const deleteProject = async (id:string) => {
    if (projects.length <= 1) { notify('请先创建另一个画布'); return; }
    if (!confirm('确定删除此画布吗？此操作不可撤销。')) return;
    try {
      await fetch('/api/projects/'+id,{method:'DELETE'});
      const remaining=projects.filter(p=>p.id!==id);
      setProjects(remaining);
      if (id===projectId) await openProject(remaining[0].id);
    } catch { notify('删除项目失败'); }
  };
  const update = useCallback((id:string, patch:Partial<StudioNodeData>) => {
    setNodes(prev => prev.map(node => node.id === id ? {...node,data:{...node.data,...patch}}:node));
  }, [setNodes]);
  const addNode = useCallback((kind:Kind, point?:{x:number;y:number}, patch:Partial<StudioNodeData>={}) => {
    snapshot();
    const pos = point || rf.screenToFlowPosition({x:window.innerWidth * .47,y:window.innerHeight * .46});
    const id = uid();
    const added: StudioNode = {id,type:'studio',position:pos,data:newData(kind,patch),selected:true};
    setNodes(prev=>[...prev,added].map(n => ({...n,selected:n.id===id})));
    setShowAdd(false); setMenuSearch('');
    return id;
  }, [rf, setNodes, snapshot]);
  const revealNewNode=useCallback((point:{x:number;y:number},kind:Kind)=>{
    const centre={x:point.x+(kind==='video'?245:155),y:point.y+155};
    const screen=rf.flowToScreenPosition(centre);
    const view=rootRef.current?.querySelector('.canvas-container')?.getBoundingClientRect();
    if(!view)return;
    const margin=110;
    if(screen.x<view.left+margin||screen.x>view.right-margin||
       screen.y<view.top+margin||screen.y>view.bottom-margin)
      window.setTimeout(()=>void rf.setCenter(centre.x,centre.y,{
        zoom:rf.getZoom(),duration:350
      }),70);
  },[rf]);
  const addAfter = useCallback((id:string, kind:Kind) => {
    const source = nodesRef.current.find(n=>n.id===id);
    if (!source) return;
    const point={x:source.position.x+(source.data.kind==='video'?710:535),y:source.position.y + 16};
    const nextId = addNode(kind,point);
    setEdges(prev=>addEdge({...edgeDefaults,id:uid(),source:id,target:nextId},prev));
    revealNewNode(point,kind);
  }, [addNode, setEdges,revealNewNode]);
  const addBefore = useCallback((id:string,kind:Kind)=>{
    const target=nodesRef.current.find(n=>n.id===id);
    if(!target)return;
    const point={x:target.position.x-(kind==='video'?715:530),y:target.position.y+16};
    const sourceId=addNode(kind,point);
    setEdges(prev=>addEdge({...edgeDefaults,id:uid(),source:sourceId,target:id},prev));
    revealNewNode(point,kind);
  },[addNode,setEdges,revealNewNode]);
  const openNodeMenu=useCallback((id:string,side:'source'|'target',x:number,y:number,dropped=false)=>{
    const box=rootRef.current?.querySelector('.canvas-container')?.getBoundingClientRect();
    if(!box)return;
    setMenuPos({
      x:Math.max(8,Math.min(x-box.left+12,box.width-314)),
      y:Math.max(8,Math.min(y-box.top+12,box.height-264)),
      flow:rf.screenToFlowPosition({x,y})
    });
    setMenuSearch('');
    setMenuOrigin({id,side,dropped});
    setShowAdd(true);
  },[rf]);
  const addFromMenu=useCallback((kind:Kind)=>{
    const from=menuOrigin;
    if(!from){addNode(kind,menuPos.flow);return;}
    if(from.ids?.length){
      const location=menuPos.flow||rf.screenToFlowPosition({
        x:window.innerWidth/2,y:window.innerHeight/2
      });
      const id=addNode(kind,{x:location.x,y:location.y-105});
      const groupSources=from.ids.filter(source=>
        nodesRef.current.some(node=>node.id===source));
      setEdges(prev=>{
        const planned=planGroupConnections(groupSources,id,prev,canConnect);
        return planned.length?[...prev,...planned.map(edge=>({
          ...edgeDefaults,...edge,id:uid()
        }))]:prev;
      });
      setMenuOrigin(null);
      revealNewNode({x:location.x,y:location.y-105},kind);
      notify('已创建'+kindLabels[kind]+'节点并连接所选节点');
      return;
    }
    if(!from.dropped){
      if(from.side==='source')addAfter(from.id,kind);
      else addBefore(from.id,kind);
      setMenuOrigin(null);
      return;
    }
    const location=menuPos.flow||rf.screenToFlowPosition({x:window.innerWidth/2,y:window.innerHeight/2});
    const point={x:location.x-(from.side==='target'?(kind==='video'?490:310):0),y:location.y-105};
    const id=addNode(kind,point);
    const source=from.side==='source'?from.id:id;
    const target=from.side==='source'?id:from.id;
    setEdges(prev=>canConnect(source,target,prev)
      ? addEdge({...edgeDefaults,id:uid(),source,target,sourceHandle:'out',targetHandle:'in'},prev)
      : prev);
    setMenuOrigin(null);
  },[menuOrigin,menuPos.flow,addNode,addAfter,addBefore,rf,setEdges,revealNewNode,notify]);
  const removeAnimated=useCallback((ids:string[])=>{
    const valid=ids.filter(id=>nodesRef.current.some(n=>n.id===id)&&!removalTimers.current.has(id));
    if(!valid.length)return;
    snapshot();
    for(const id of valid){
      const flowNode=[...document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')]
        .find(el=>el.dataset.id===id);
      flowNode?.querySelector('.tn-node')?.classList.add('tn-node-exiting');
    }
    const removed=new Set(valid);
    const timeout=window.setTimeout(()=>{
      setNodes(prev=>prev.filter(n=>!removed.has(n.id)));
      setEdges(prev=>prev.filter(e=>!removed.has(e.source)&&!removed.has(e.target)));
      for(const id of valid)removalTimers.current.delete(id);
    },340);
    for(const id of valid)removalTimers.current.set(id,timeout);
  },[snapshot,setNodes,setEdges]);
  const remove=useCallback((id:string)=>removeAnimated([id]),[removeAnimated]);
  const duplicate = useCallback((id:string) => {
    const n=nodesRef.current.find(x=>x.id===id);
    if (n) addNode(n.data.kind,{x:n.position.x+40,y:n.position.y+50},{...n.data,title:n.data.title+' Copy',status:'idle'});
  }, [addNode]);
  const uploadFor = useCallback(async (id:string,file:File) => {
    const fd=new FormData(); fd.append('file',file);
    try {
      const measure=(async()=>{
        if(!file.type.startsWith('image/'))return {};
        try{
          const image=await createImageBitmap(file);
          const dimensions={mediaWidth:image.width,mediaHeight:image.height};
          image.close();
          return dimensions;
        }catch{return {};}
      })();
      const [asset,dimensions]=await Promise.all([
        request<{url:string;name:string}>('/api/assets',{method:'POST',body:fd}),measure
      ]);
      update(id,{mediaUrl:asset.url,mediaName:asset.name,demo:false,status:'idle',...dimensions});
      notify('已导入素材：'+asset.name);
    } catch(e) {notify('导入失败：'+(e as Error).message);}
  },[update,notify]);
  const extractingFrameIds=useRef(new Set<string>());
  const extractLastFrame=useCallback(async(id:string)=>{
    if(extractingFrameIds.current.has(id))return;
    const source=nodesRef.current.find(n=>n.id===id);
    if(!source||source.data.kind!=='video'||source.data.demo||
       !/^\/api\/uploads\/[^?#]+\.(?:mp4|mov|webm|ogg|m4v)$/i.test(source.data.mediaUrl||'')){
      notify('请先生成或上传本地视频');
      return;
    }
    extractingFrameIds.current.add(id);
    try{
      notify('正在提取视频最后一帧…');
      const result=await request<{
        url:string;name:string;width:number;height:number
      }>('/api/videos/extract-last-frame',JSONBody({mediaUrl:source.data.mediaUrl}));
      const current=nodesRef.current.find(n=>n.id===id);
      if(!current||current.data.mediaUrl!==source.data.mediaUrl){
        notify('视频节点已发生变化，尾帧图片已保存至本地素材目录');
        return;
      }
      const point={
        x:current.position.x+Math.max(current.measured?.width||0,550)+125,
        y:current.position.y+25
      };
      const imageId=addNode('image',point,{
        title:(current.data.title||'视频')+' · 尾帧',
        mediaUrl:result.url,mediaName:result.name,
        mediaWidth:result.width,mediaHeight:result.height,
        prompt:'',status:'done',progress:100,demo:false
      });
      setEdges(prev=>canConnect(id,imageId,prev)
        ?addEdge({...edgeDefaults,id:uid(),source:id,target:imageId,
          sourceHandle:'out',targetHandle:'in'},prev):prev);
      revealNewNode(point,'image');
      notify('尾帧提取成功，已添加图片节点并连接原视频');
    }catch(error){
      notify('尾帧提取失败：'+(error as Error).message);
    }finally{
      extractingFrameIds.current.delete(id);
    }
  },[addNode,setEdges,revealNewNode,notify]);
  const uploadFiles = useCallback(async(files:FileList|File[],point?:{x:number;y:number})=>{
    const list=Array.from(files);
    for(let i=0;i<list.length;i++){
      const f=list[i]; const kind:Kind=f.type.startsWith('video')?'video':f.type.startsWith('audio')?'audio':'image';
      const id=addNode(kind,point?{x:point.x+i*38,y:point.y+i*32}:undefined,{title:f.name.slice(0,35),prompt:''});
      await uploadFor(id,f);
    }
  },[addNode,uploadFor]);

  // React Flow may not re-render a target node when only its incoming edges
  // or an upstream image's media changes. Rebuild this context function only
  // when a reference input/order changed (not on every canvas drag/typing).
  const referenceSignature=useMemo(()=>[
    ...edges.map(e=>e.target+':'+e.source),
    ...nodes.filter(n=>n.data.kind==='image'||n.data.kind==='audio')
      .map(n=>n.id+':'+(n.data.mediaUrl||'')+':'+n.data.title),
    ...nodes.filter(n=>n.data.referenceOrder?.length)
      .map(n=>n.id+':'+n.data.referenceOrder?.join(','))
  ].join('|'),[edges,nodes]);
  const referencesFor=useCallback((id:string)=>
    referencesForNode(id,nodesRef.current,edgesRef.current),[referenceSignature]);
  const reorderReferences=useCallback((
    id:string,refId:string,direction:-1|1,currentPrompt?:string
  )=>{
    const node=nodesRef.current.find(n=>n.id===id);
    if(!node)return;
    const current=referencesFor(id);
    const next=reorderReferenceNodes(currentPrompt??(node.data.prompt||''),current,refId,direction);
    if(next.order.every((source,index)=>current[index]?.id===source))return;
    snapshot();
    update(id,{referenceOrder:next.order,prompt:next.prompt});
  },[referencesFor,update,snapshot]);

  const generate = useCallback(async (id:string,kindOverride?:Kind) => {
    const source=nodesRef.current.find(n=>n.id===id);
    if (!source) return;
    const kind=kindOverride || (source.data.kind==='text'?'image':source.data.kind);
    if (['running','queued'].includes(source.data.status||'')) return;
    // React state may not have committed the queued flag on a rapid double
    // click. Guard only THIS node; other nodes remain free to submit jobs.
    if(generatingNodeIds.current.has(id))return;
    generatingNodeIds.current.add(id);
    try{
    const museMode=(source.data.kind==='image'&&kind==='image')||
      (source.data.kind==='video'&&kind==='video'&&source.data.provider==='muse');
    if(museMode){
      if(!museAccounts.length){
        const fresh=await request<MuseAccount[]>('/api/muse/accounts').catch(()=>[]);
        if(!fresh.length){
          notify('请先创建 Muse 独立浏览器账号并完成登录');
          setPanel('muse');return;
        }
        setMuseAccounts(fresh);
      }
      if(!projectId){notify('请先保存画布');return;}
      let museRefs:ReturnType<typeof resolveReferences>;
      try{
        museRefs=resolveReferences(source.data.prompt||'',
          source.data.referenceIds||[],referencesFor(id));
      }catch(e){notify((e as Error).message);return;}
      try{
        const health=await request<{
          museBridgeRevision?:string;museMediaRevision?:string;
          audioReferenceRevision?:string
        }>('/api/health');
        if(health.museBridgeRevision!=='quota-auto-v6-image-resolution')
          throw new Error('当前 Muse API 是旧版本，请关闭旧 TapNow 服务并重新运行 start.bat');
        if(health.museMediaRevision!=='fresh-chat-media-v2')
          throw new Error('Muse 图片回传后端仍为旧版本，请先关闭旧 TapNow API 并重新运行 start.bat');
        if(museRefs.some(ref=>ref.kind==='audio')&&health.audioReferenceRevision!=='mixed-media-v1')
          throw new Error('Muse 音频引用需要新版 API，请先关闭旧版 TapNow 并重新运行 start.bat');
        // Persist the node's exact mode and current prompt before accepting
        // a job; debounce may otherwise overwrite the generated media.
        if(timer.current)clearTimeout(timer.current);
        const staged=nodesRef.current.map(node=>node.id===id?
          {...node,data:{...node.data,provider:'muse' as const,
            status:'queued' as const,progress:0,
            jobMessage:'Muse：正在启动独立 Edge 并准备新建会话'}}:node);
        nodesRef.current=staged;setNodes(staged);
        setSaveStatus('正在保存…');
        const saved=await saveProjectSnapshot(projectId,{
          title,nodes:staged,edges:edgesRef.current,viewport:viewport.current
        });
        setSaveStatus('已保存到本地');
        setProjects(ps=>ps.map(p=>p.id===projectId?
          {...p,updatedAt:saved.updatedAt}:p));
        const job=await request<MuseJob>('/api/muse/jobs',JSONBody({
          provider:'muse',projectId,nodeId:id,
          accountId:source.data.museAccountId||'auto',
          prompt:source.data.prompt,ratio:source.data.ratio,
          resolution:kind==='image'?(source.data.resolution||'2K'):undefined,
          duration:source.data.duration||'5s',
          references:museRefs.map(ref=>({id:ref.id}))
        }));
        update(id,{jobId:job.id,status:'queued',progress:0,
          jobMessage:job.message});
        for(let attempt=0;attempt<1000;attempt++){
          await pause(1900);
          const status=await request<MuseJob>('/api/muse/jobs/'+job.id);
          if(!nodesRef.current.some(n=>n.id===id))return;
          if(status.status==='completed'&&status.mediaUrl){
            update(id,{status:'done',progress:100,demo:false,
              mediaUrl:status.mediaUrl,jobMessage:'Muse '+(kind==='video'?'视频':'图片')+'已回填'});
            notify('Muse '+(kind==='video'?'视频':'图片')+'生成成功，文件已保存');return;
          }
          if(['needs-attention','needs-login','interrupted'].includes(status.status)){
            update(id,{status:'error',progress:0,
              jobMessage:status.error||status.message});
            notify('Muse 任务需要操作：'+(status.error||status.message));return;
          }
          const waiting=['queued','starting'].includes(status.status);
          update(id,{status:waiting?'queued':'running',
            jobMessage:status.message,progress:waiting?0:(status.progress||0)});
        }
        update(id,{status:'error',jobMessage:'Muse 等待结果超时，请检查独立 Edge 中的会话'});
      }catch(e){
        update(id,{status:'error',progress:0,jobMessage:(e as Error).message});
        notify('Muse 生成未完成：'+(e as Error).message);
      }
      return;
    }
    if(kind==='video'){
      const selectedModel=source.data.model||defaultVideoModel;
      if(!supportedDoubaoVideoModels.some(model=>model===selectedModel)){
        notify('该视频模型尚未接入真实生成服务，请选择 Seedance 2.0 Mini 或 Fast');
        return;
      }
      if(!source.data.accountId){
        notify('先在账号设置中创建独立豆包浏览器账号，再在视频节点选择账号');
        setPanel('doubao');
        return;
      }
      if(!projectId){notify('请先保存画布');return;}
      let refs:ReturnType<typeof resolveReferences>;
      try{
        refs=resolveReferences(source.data.prompt||'',source.data.referenceIds||[],
          referencesFor(id));
      }catch(e){notify((e as Error).message);return;}
      try{
        const health=await request<{multiImageUploadRevision?:string;videoModelRevision?:string;
          videoStartRevision?:string;videoDownloadRevision?:string;
          referenceSelectionRevision?:string;audioReferenceRevision?:string;
          audioMp4Revision?:string}>('/api/health');
        if(health.referenceSelectionRevision!=='at-order-v2')
          throw new Error('本地视频 API 是旧版本，参考图排序可能错误；请重启 TapNow。');
        if(refs.some(ref=>ref.kind==='audio')&&health.audioReferenceRevision!=='mixed-media-v1')
          throw new Error('豆包音频引用需要新版 API，请关闭旧版 TapNow 后重新运行 start.bat');
        if(refs.some(ref=>ref.kind==='audio'&&/\.mp3(?:\?|$)/i.test(ref.url))&&
          health.audioMp4Revision!=='mp3-to-mp4-v1')
          throw new Error('豆包 MP3 转 MP4 功能尚未加载，请重启 TapNow 的 API 服务');
        if(health.videoModelRevision!=='mini-fast-v1')
          throw new Error('本地豆包 API 仍是旧版，可能错误选用 Fast。请先退出旧的 TapNow API 并重新运行当前项目 start.bat。');
        if(health.videoStartRevision!=='reply-prefix-v1')
          throw new Error('本地豆包 API 不支持视频实际开工回执，请退出旧的 TapNow API 并重新启动 start.bat。');
        if(health.videoDownloadRevision!=='completed-card-v1')
          throw new Error('本地豆包 API 仍是旧版，无法自动下载豆包已生成的视频卡片；请退出旧版 API 后重新启动 start.bat。');
        if(refs.length>1&&health.multiImageUploadRevision!=='v3-prompt-first')
          throw new Error('本地豆包 API 仍在运行旧版多图上传代码。请结束旧的 TapNow 启动窗口与 API 进程，重新运行 start.bat 后再发送。');
        // Persist the exact current canvas BEFORE submitting the job. Auto-save
        // is debounced and might not yet include newly attached reference IDs.
        if(timer.current)clearTimeout(timer.current);
        const stagedNodes=nodesRef.current.map(n=>n.id===id
          ? {...n,data:{...n.data,status:'queued' as const,progress:0,
            jobMessage:'正在启动对应账号浏览器'}}
          : n);
        nodesRef.current=stagedNodes;
        setNodes(stagedNodes);
        setSaveStatus('正在保存…');
        const saved=await saveProjectSnapshot(projectId,{
          title,nodes:stagedNodes,edges:edgesRef.current,viewport:viewport.current
        });
        setSaveStatus('已保存到本地');
        setProjects(ps=>ps.map(p=>p.id===projectId?{...p,updatedAt:saved.updatedAt}:p));
        const job=await request<DoubaoJob>('/api/doubao/jobs',JSONBody({
          projectId,nodeId:id,accountId:source.data.accountId,
          model:selectedModel,prompt:source.data.prompt,
          ratio:source.data.ratio,duration:source.data.duration,
          references:refs.map(ref=>({id:ref.id}))
        }));
        update(id,{jobId:job.id,status:'queued',progress:0,jobMessage:job.message});
        for(let attempt=0;attempt<1000;attempt++){
          await pause(1900);
          const status=await request<DoubaoJob>('/api/doubao/jobs/'+job.id);
          if(!nodesRef.current.some(n=>n.id===id))return;
          if(status.status==='completed' && status.videoUrl){
            update(id,{status:'done',progress:100,jobMessage:'视频已回填到此节点',
              mediaUrl:status.videoUrl,demo:false});
            notify('Seedance 视频已保存到对应节点');
            return;
          }
          if(['needs-attention','needs-login','interrupted'].includes(status.status)){
            update(id,{status:'error',progress:0,jobMessage:status.error||status.message});
            notify('豆包任务需要操作：'+(status.error||status.message));
            return;
          }
          const waiting=['queued','starting'].includes(status.status);
          update(id,{status:waiting?'queued':'running',
            jobMessage:status.message,progress:waiting?0:(status.progress||0)});
        }
        update(id,{status:'error',jobMessage:'任务监控超时；可在对应账号浏览器查看结果'});
      }catch(e){
        update(id,{status:'error',progress:0,jobMessage:(e as Error).message});
        notify('豆包视频生成未完成：'+(e as Error).message);
      }
      return;
    }
    snapshot();
    update(id,{status:'running',progress:4});
    for(let i=1;i<=8;i++){ await pause(140); update(id,{progress:i*12}); }
    const latest=nodesRef.current.find(n=>n.id===id) || source;
    const prompt=latest.data.prompt || latest.data.text || 'Untitled creative';
    const childId=uid();
    const child:StudioNode={
      id:childId,type:'studio',
      position:{x:source.position.x+(source.data.kind==='video'?705:530),y:source.position.y+30},
      data:newData(kind,{
        title:kind==='audio'?'Audio · Demo':'Image · Demo',
        prompt,model:models[kind][0],ratio:source.data.ratio,
        mediaUrl:kind==='audio'?undefined:mockPoster(kind,String(prompt)),
        status:'done',progress:100,demo:true
      })
    };
    setNodes(prev=>[...prev.map(n=>n.id===id?{...n,data:{...n.data,status:'done' as const,progress:100}}:n),child]);
    setEdges(prev=>addEdge({...edgeDefaults,id:uid(),source:id,target:childId},prev));
    notify('已创建演示结果节点（未调用 AI 模型）');
    }finally{
      generatingNodeIds.current.delete(id);
    }
  },[snapshot,update,setNodes,setEdges,notify,projectId,referencesFor,title,museAccounts.length,saveProjectSnapshot]);
  const runWorkflow=useCallback(async()=>{
    if(running || !nodesRef.current.length)return;
    try{
      const plan=await request<Plan>('/api/workflow/plan',JSONBody({nodes:nodesRef.current,edges:edgesRef.current}));
      if(!plan.valid){notify(plan.error||'工作流验证失败');return;}
      setRunning(true);
      let count=0;
      for(const step of plan.steps||[]){
        if(step.kind==='text')continue;
        const item=nodesRef.current.find(n=>n.id===step.id);
        if(!item)continue;
        update(step.id,{status:'running',progress:12});
        for(const n of [34,63,89,100]){await pause(160);update(step.id,{progress:n});}
        if(!item.data.mediaUrl && step.kind!=='audio')
          update(step.id,{mediaUrl:mockPoster(step.kind,item.data.prompt),demo:true,status:'done'});
        else update(step.id,{status:'done'});
        count++;
      }
      notify('演示执行完成：'+count+' 个任务，跳过 '+(plan.skipped?.length||0)+' 个节点');
    }catch(e){notify('运行失败：'+(e as Error).message)}
    finally{setRunning(false)}
  },[running,update,notify]);
  const expand = useCallback((id:string) => { setPreview(id); },[]);
  const inspect = useCallback((id:string) => {
    setNodes(prev=>prev.map(n=>({...n,selected:n.id===id})));
    setPanel('inspector');
  },[setNodes]);
  const actions=useMemo(()=>({
    update,generate,addAfter,addBefore,uploadFor,extractLastFrame,duplicate,remove,expand,inspect,
    openNodeMenu:(id:string,side:'source'|'target',x:number,y:number)=>openNodeMenu(id,side,x,y),
    accounts:doubaoAccounts,museAccounts,referencesFor,reorderReferences,
    openAccountsSettings:()=>setPanel('doubao'),
    openMuseAccountsSettings:()=>setPanel('muse'),
    openAccountBrowser,openMuseAccountBrowser
  }),[update,generate,addAfter,addBefore,openNodeMenu,uploadFor,extractLastFrame,duplicate,remove,
    expand,inspect,doubaoAccounts,museAccounts,referencesFor,reorderReferences,
    openAccountBrowser,openMuseAccountBrowser]);
  const selected=nodes.find(n=>n.selected) || null;
  const onConnect=useCallback((connection:Connection)=>{
    if (!canConnect(connection.source, connection.target, edgesRef.current)) return;
    snapshot();
    setEdges(prev => canConnect(connection.source,connection.target,prev)
      ? addEdge({...connection,...edgeDefaults,id:uid()},prev) : prev);
  },[snapshot,setEdges]);
  const changeCanvasNodes=useCallback((changes:NodeChange<StudioNode>[])=>{
    if(!nodeDragActive.current){
      onNodesChange(changes);
      return;
    }
    const snapped=snapNodePositionChanges(
      nodesRef.current,changes,rf.getZoom()
    );
    setSmartGuides(prev=>{
      const next=snapped.guides;
      if(JSON.stringify(prev)===JSON.stringify(next))return prev;
      return next;
    });
    onNodesChange(snapped.changes);
  },[onNodesChange,rf]);
  const groupTargets=useCallback((ids:string[],targetId:string)=>{
    const validIds=ids.filter(id=>nodesRef.current.some(n=>n.id===id));
    const planned=planGroupConnections(validIds,targetId,edgesRef.current,canConnect);
    if(!planned.length){notify('没有可连接的节点（可能已连接或会形成循环）');return;}
    snapshot();
    setEdges(prev=>{
      const accepted=planGroupConnections(validIds,targetId,prev,canConnect);
      return accepted.length?[...prev,...accepted.map(edge=>({
        ...edgeDefaults,...edge,id:uid()
      }))]:prev;
    });
    notify('已连接 '+planned.length+' 个节点'+
      (planned.length<validIds.length?'，已跳过重复或不允许的连接':''));
  },[snapshot,setEdges,notify]);
  const groupAdd=useCallback((ids:string[],point:{x:number;y:number})=>{
    const box=rootRef.current?.querySelector('.canvas-container')?.getBoundingClientRect();
    if(!box||!ids.length)return;
    setMenuPos({
      x:Math.max(8,Math.min(point.x-box.left+12,box.width-314)),
      y:Math.max(8,Math.min(point.y-box.top+12,box.height-264)),
      flow:rf.screenToFlowPosition(point)
    });
    setMenuSearch('');
    setMenuOrigin({id:ids[0],side:'source',dropped:true,ids});
    setShowAdd(true);
  },[rf]);
  const groupDragStart=useCallback((ids:string[])=>{
    setEditorState({id:null,instant:true});
    const blocked=new Set<string>();
    for(const node of nodesRef.current){
      if(ids.includes(node.id))continue;
      if(!ids.some(id=>canConnect(id,node.id,edgesRef.current)))
        blocked.add(node.id);
    }
    setInvalidTargets(blocked);
  },[]);
  const groupDragHover=useCallback((target:string|null,ids:string[])=>{
    if(!target){setConnectionHighlight(null);return false;}
    const valid=ids.some(id=>canConnect(id,target,edgesRef.current));
    setConnectionHighlight(prev=>prev?.id===target&&prev.valid===valid&&
      prev.direction==='ltr'?prev:{id:target,valid,direction:'ltr'});
    return valid;
  },[]);
  const groupDragEnd=useCallback(()=>{
    setConnectionHighlight(null);
    setInvalidTargets(new Set());
  },[]);
  const onConnectStart = useCallback((
    _event: MouseEvent | TouchEvent,
    params: {nodeId:string|null;handleType:'source'|'target'|null}
  )=>{
    connectionStart.current = params.nodeId && params.handleType
      ? {nodeId:params.nodeId,handleType:params.handleType}:null;
    setConnectionHighlight(null);
    if(!params.nodeId||!params.handleType){setInvalidTargets(new Set());return;}
    const blocked=new Set<string>();
    for(const node of nodesRef.current){
      if(node.id===params.nodeId)continue;
      const source=params.handleType==='source'?params.nodeId:node.id;
      const target=params.handleType==='source'?node.id:params.nodeId;
      if(!canConnect(source,target,edgesRef.current))blocked.add(node.id);
    }
    setInvalidTargets(blocked);
  },[]);
  const onConnectionPointerMove = useCallback((e:{clientX:number;clientY:number})=>{
    const start=connectionStart.current;
    if(!start)return;
    const element=document.elementFromPoint(e.clientX,e.clientY);
    const candidate=element?.closest('.react-flow__node')?.getAttribute('data-id');
    if(!candidate || candidate===start.nodeId || !nodesRef.current.some(n=>n.id===candidate)){
      setConnectionHighlight(prev=>prev ? null : prev);
      return;
    }
    const direction=start.handleType==='source'?'ltr':'rtl';
    const source=start.handleType==='source'?start.nodeId:candidate;
    const target=start.handleType==='source'?candidate:start.nodeId;
    const valid=canConnect(source,target,edgesRef.current);
    setConnectionHighlight(prev=>
      prev?.id===candidate && prev.valid===valid && prev.direction===direction
      ? prev : {id:candidate,valid,direction});
  },[]);
  // React Flow can capture the pointer while dragging a connection from a
  // moving magnetic ring. Listen at the document level so the glow target is
  // resolved from the actual cursor position rather than the captured handle.
  useEffect(()=>{
    document.addEventListener('pointermove',onConnectionPointerMove,true);
    return ()=>document.removeEventListener('pointermove',onConnectionPointerMove,true);
  },[onConnectionPointerMove]);
  const onConnectEnd=useCallback((event: MouseEvent | TouchEvent, state: {fromNode:{id:string}|null;fromHandle:{type?:string}|null;isValid:boolean|null})=>{
    connectionStart.current=null;
    setConnectionHighlight(null);
    setInvalidTargets(new Set());
    // React Flow only accepts a native handle as a target. When dropped anywhere
    // on a node's card, resolve the node under the pointer and connect to its handle.
    if(state.isValid||!state.fromNode)return;
    const position='changedTouches' in event && event.changedTouches.length
      ? event.changedTouches[0]
      : event as MouseEvent;
    const hit=document.elementFromPoint(position.clientX,position.clientY);
    const targetElement=hit?.closest('.react-flow__node');
    const targetId=targetElement?.getAttribute('data-id');
    const fromId=state.fromNode.id;
    if(!targetId){
      const side=state.fromHandle?.type==='target'?'target':'source';
      // onPaneClick may still fire on release, so open after that event.
      window.setTimeout(()=>openNodeMenu(fromId,side,position.clientX,position.clientY,true),0);
      return;
    }
    if(targetId===fromId||!nodesRef.current.some(n=>n.id===targetId))return;
    const startsFromTarget=state.fromHandle?.type==='target';
    const source=startsFromTarget?targetId:fromId;
    const target=startsFromTarget?fromId:targetId;
    if(!canConnect(source,target,edgesRef.current))return;
    snapshot();
    setEdges(prev=>canConnect(source,target,prev)
      ? addEdge({...edgeDefaults,id:uid(),source,target,sourceHandle:'out',targetHandle:'in'},prev)
      : prev);
  },[snapshot,setEdges,openNodeMenu]);
  const validConnection=useCallback((connection:{source:string;target:string})=>
    canConnect(connection.source,connection.target,edgesRef.current),[]);
  const handleNodeDragStart=useCallback((
    _event:MouseEvent|TouchEvent,node:StudioNode
  )=>{
    nodeDragActive.current=true;
    setSmartGuides(null);
    setDraggingNodeId(node.id);
    setEditorState({id:null,instant:true});
    snapshot();
  },[snapshot]);
  const handleNodeDragStop=useCallback(()=>{
    nodeDragActive.current=false;
    setSmartGuides(null);
    setDraggingNodeId(null);
  },[]);
  const handleSelectionStart=useCallback(()=>{
    setMarqueeSelecting(true);
    setEditorState({id:null,instant:true});
  },[]);
  const handleSelectionEnd=useCallback(()=>setMarqueeSelecting(false),[]);
  const handlePaneClick=useCallback(()=>{
    setEditorState({id:null,instant:false});
    setShowAdd(false);
    setMenuSearch('');
    setMenuOrigin(null);
  },[]);
  const handlePaneContext=useCallback((e:{preventDefault:()=>void})=>{
    e.preventDefault();
    setShowAdd(false);
    setMenuSearch('');
    setMenuOrigin(null);
  },[]);
  const handleViewportMove=useCallback((_e:unknown,v:{x:number;y:number;zoom:number})=>{
    viewport.current=v;
    setZoom(v.zoom);
  },[]);
  const handleViewportMoveEnd=useCallback((_e:unknown,v:{x:number;y:number;zoom:number})=>{
    viewport.current=v;
    setZoom(v.zoom);
    setViewportRevision(n=>n+1);
  },[]);
  const onDrop=useCallback((e:DragEvent<HTMLDivElement>)=>{
    e.preventDefault();
    const point=rf.screenToFlowPosition({x:e.clientX,y:e.clientY});
    const files=e.dataTransfer.files;
    if(files?.length)void uploadFiles(files,point);
    else{
      const kind=e.dataTransfer.getData('application/tapnow-kind') as Kind;
      if(['image','video','text','audio'].includes(kind))addNode(kind,point);
    }
  },[rf,uploadFiles,addNode]);
  const onDragOver=(e:DragEvent<HTMLDivElement>)=>{e.preventDefault();e.dataTransfer.dropEffect='copy';};
  const openAddMenu=(clientX:number,clientY:number)=>{
    const box=rootRef.current?.getBoundingClientRect();
    if(!box)return;
    setMenuPos({x:Math.min(clientX-box.left,box.width-295),y:Math.min(clientY-box.top,box.height-330),
      flow:rf.screenToFlowPosition({x:clientX,y:clientY})});
    setMenuOrigin(null);
    setShowAdd(true);
  };
  const onCanvasDoubleClick=(e:React.MouseEvent<HTMLDivElement>)=>{
    const el=e.target as HTMLElement;
    if(el.closest('.react-flow__node,.canvas-tools,.bottom-left-controls,.add-popover,.tn-empty-start,.tn-topbar,.right-panel')) return;
    if(el.closest('.react-flow') || el.classList.contains('canvas-container')){
      e.preventDefault();
      e.stopPropagation();
      openAddMenu(e.clientX,e.clientY);
    }
  };
  const onNodeClick = (_event: React.MouseEvent, node: StudioNode) => {
    setEditorState({id:node.id,instant:false});
    const container=rootRef.current?.querySelector('.canvas-container');
    const nodeElement=[...document.querySelectorAll('.react-flow__node')].find(el=>el.getAttribute('data-id')===node.id);
    if(!container||!nodeElement)return;
    const frame=container.getBoundingClientRect();
    const rect=nodeElement.getBoundingClientRect();
    const overflow=rect.bottom+222-frame.bottom+18;
    if(overflow>0) {
      const v=rf.getViewport();
      void rf.setViewport({...v,y:v.y-overflow},{duration:220});
    }
  };
  // C + hover shows the scissors on the actual edge hit area. Pointer tracking
  // only changes React state when the hovered edge changes, not every frame.
  const setCutHover=useCallback((edgeId:string|null)=>{
    if(cutHoverEdgeRef.current===edgeId)return;
    cutHoverEdgeRef.current=edgeId;
    setCutHoverEdge(edgeId);
  },[]);
  const hitTestCutEdge=useCallback((x:number,y:number)=>{
    const hit=document.elementFromPoint(x,y);
    const id=hit?.closest<SVGGElement>('.react-flow__edge[data-id]')?.dataset.id;
    return id&&edgesRef.current.some(edge=>edge.id===id)?id:null;
  },[]);
  useEffect(()=>{
    const onMove=(event:PointerEvent)=>{
      cutPointerRef.current={x:event.clientX,y:event.clientY};
      if(!cutModeRef.current)return;
      const edgeId=hitTestCutEdge(event.clientX,event.clientY);
      setCutHover(edgeId);
      const badge=cutCursorRef.current;
      if(badge){
        badge.style.left=event.clientX+'px';
        badge.style.top=event.clientY+'px';
      }
    };
    document.addEventListener('pointermove',onMove,true);
    return ()=>document.removeEventListener('pointermove',onMove,true);
  },[hitTestCutEdge,setCutHover]);
  useEffect(()=>{
    const pointer=cutPointerRef.current;
    if(!pointer||!cutCursorRef.current)return;
    cutCursorRef.current.style.left=pointer.x+'px';
    cutCursorRef.current.style.top=pointer.y+'px';
  },[cutMode,cutHoverEdge]);
  const handleEdgeClick=useCallback((event:React.MouseEvent,edge:StudioEdge)=>{
    if(!cutModeRef.current||event.button!==0)return;
    event.preventDefault();
    event.stopPropagation();
    if(!edgesRef.current.some(item=>item.id===edge.id))return;
    snapshot();
    setEdges(current=>current.filter(item=>item.id!==edge.id));
    setCutHover(null);
  },[snapshot,setEdges,setCutHover]);
  const exportJSON=()=>exportTextFile((title||'canvas')+'.json',JSON.stringify({version:1,title,nodes,edges,viewport:viewport.current},null,2));
  const importJSON=async(file:File)=>{
    try{
      const data=JSON.parse(await file.text());
      if(!Array.isArray(data.nodes)||!Array.isArray(data.edges))throw new Error('不是有效的工作流 JSON');
      snapshot();setNodes(normalizeVideoNodes(data.nodes));setEdges(data.edges);setTitle(data.title||'导入的项目');
      if(data.viewport)void rf.setViewport(data.viewport);
      notify('工作流导入成功');
    }catch(e){notify('导入失败：'+(e as Error).message)}
  };
  const agentSubmit=()=>{
    if(!agentDraft.trim()){notify('先输入创作需求');return;}
    const chosen=nodesRef.current.filter(n=>n.selected);
    const content=agentDraft.trim();
    snapshot();
    const x=chosen.length?Math.max(...chosen.map(n=>n.position.x))+395:rf.screenToFlowPosition({x:window.innerWidth*.48,y:window.innerHeight*.45}).x;
    const y=chosen.length?Math.min(...chosen.map(n=>n.position.y)):rf.screenToFlowPosition({x:window.innerWidth*.48,y:window.innerHeight*.45}).y;
    const id=uid();
    const n:StudioNode={id,type:'studio',position:{x,y},data:newData(agentKind,{prompt:content,title:kindLabels[agentKind]+'任务'})};
    setNodes(prev=>[...prev.map(n=>({...n,selected:false})),{...n,selected:true}]);
    if(chosen.length)setEdges(prev=>[...prev,...chosen.map(n=>({...edgeDefaults,id:uid(),source:n.id,target:id}))]);
    setAgentDraft(''); notify('已将创作需求添加为'+kindLabels[agentKind]+'节点');
    setTimeout(()=>void rf.fitView({padding:.2,duration:400}),200);
  };
  const keyHandler=useCallback((e:globalThis.KeyboardEvent)=>{
    const element=e.target as HTMLElement;
    if(e.isComposing||e.key==='Process'||e.keyCode===229)return;
    if(['INPUT','TEXTAREA','SELECT'].includes(element.tagName)||element.isContentEditable)return;
    const mod=e.ctrlKey||e.metaKey;
    if(e.key.toLowerCase()==='c'&&!mod&&!e.altKey){
      if(!cutModeRef.current){
        cutModeRef.current=true;
        setCutMode(true);
        const pointer=cutPointerRef.current;
        setCutHover(pointer?hitTestCutEdge(pointer.x,pointer.y):null);
      }
      return;
    }
    if(mod&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();}
    if(mod&&e.key.toLowerCase()==='y'){e.preventDefault();redo();}
    if(mod&&e.key.toLowerCase()==='s'){e.preventDefault();void saveNow();}
    if(mod&&e.key.toLowerCase()==='c'){clipboard.current=nodesRef.current.filter(n=>n.selected).map(n=>structuredClone(n));}
    if(mod&&e.key.toLowerCase()==='v'&&clipboard.current.length){
      e.preventDefault();snapshot();
      const list=clipboard.current.map(n=>({...n,id:uid(),position:{x:n.position.x+64,y:n.position.y+64},selected:true}));
      setNodes(prev=>[...prev.map(n=>({...n,selected:false})),...list]);
    }
    if(e.key==='Delete'||e.key==='Backspace'){
      const ids=nodesRef.current.filter(n=>n.selected).map(n=>n.id);
      if(ids.length){e.preventDefault();removeAnimated(ids);}
    }
    if(e.key==='Escape'){setShowAdd(false);setMenuOrigin(null);setPreview(null);setShowTemplates(false);}
  },[undo,redo,saveNow,snapshot,setNodes,setEdges,removeAnimated,hitTestCutEdge,setCutHover]);
  useEffect(()=>{document.addEventListener('keydown',keyHandler);return()=>document.removeEventListener('keydown',keyHandler);},[keyHandler]);
  useEffect(()=>{
    const deactivate=()=>{
      cutModeRef.current=false;
      setCutMode(false);
      setCutHover(null);
    };
    const keyUp=(event:globalThis.KeyboardEvent)=>{
      if(event.key.toLowerCase()==='c')deactivate();
    };
    document.addEventListener('keyup',keyUp);
    window.addEventListener('blur',deactivate);
    return ()=>{
      document.removeEventListener('keyup',keyUp);
      window.removeEventListener('blur',deactivate);
    };
  },[setCutHover]);
  const activePreview=nodes.find(n=>n.id===preview);
  const filteredTools=entryTools.filter(item=>item.label.includes(menuSearch)||item.desc.includes(menuSearch)||item.kind.includes(menuSearch.toLowerCase()));
  return <div className="app-shell tn-app-shell" ref={rootRef}>
    <div className="tn-topbar">
      <div className="tn-project-pill">
        <span className="tn-project-logo"><span className="brand-mark"><i/><i/><i/><i/></span></span>
        <span className="tn-top-divider"/>
        <input value={title} onChange={e=>setTitle(e.target.value)} maxLength={100} aria-label="画布名称"/>
        <button title="切换画布" onClick={()=>setPanel(panel==='projects'?null:'projects')}><ChevronDown size={13}/></button>
      </div>
      <div className="tn-top-actions">
        <button title="添加到画布" onClick={()=>{setMenuOrigin(null);setShowAdd(true)}}><Plus size={17}/></button>
        <button title="导入工作流" onClick={()=>importPicker.current?.click()}><Upload size={16}/></button>
        <button title="保存工作流 JSON" onClick={exportJSON}><Share2 size={16}/></button>
        <span className="tn-top-divider"/>
        <button title="素材库" onClick={()=>setPanel('assets')}><Layers3 size={16}/></button>
        <button title="豆包账号与独立浏览器设置" onClick={()=>setPanel(panel==='doubao'?null:'doubao')}><Settings2 size={17}/></button>
        <button className="tn-muse-account-link" aria-label="Muse 账号管理"
          title="Muse 账号与独立 Edge 浏览器管理"
          onClick={()=>setPanel(panel==='muse'?null:'muse')}>
          <Shield size={15}/><span>Muse 账号</span>
        </button>
        <button title="工作流模板" onClick={()=>setShowTemplates(true)}><LayoutGrid size={16}/></button>
      </div>
    </div>
    <input ref={filePicker} hidden type="file" multiple accept="image/*,video/*,audio/*" onChange={e=>{
      if(e.target.files)void uploadFiles(e.target.files);e.target.value='';
    }}/>
    <input ref={importPicker} hidden type="file" accept=".json" onChange={e=>{
      const f=e.target.files?.[0];if(f)void importJSON(f);e.target.value='';
    }}/>
    <div className="work-area">
      <div className={'canvas-container'+(cutMode?' tn-cut-mode':'')+(selectedSourceIds.size>1?' tn-multi-selection':'')}
        onDoubleClickCapture={onCanvasDoubleClick}
        onDragOver={onDragOver} onDrop={onDrop}
        onContextMenu={e=>{e.preventDefault();setShowAdd(false);setMenuOrigin(null);setMenuSearch('');}}>
        <StudioActionsContext.Provider value={actions}>
          <ConnectionHighlightContext.Provider value={connectionHighlight}>
          <ConnectionInvalidContext.Provider value={invalidTargets}>
          <FlowTargetContext.Provider value={flowTargetIds}>
          <NodeEditorContext.Provider value={editorState}>
          <ReactFlow
            nodes={nodes} edges={renderedEdges}
            nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={changeCanvasNodes} onEdgesChange={onEdgesChange} onConnect={onConnect}
            isValidConnection={validConnection}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onNodeClick={onNodeClick}
            onEdgeClick={handleEdgeClick}
            onNodeDragStart={handleNodeDragStart}
            onNodeDragStop={handleNodeDragStop}
            onSelectionStart={handleSelectionStart}
            onSelectionEnd={handleSelectionEnd}
            onPaneClick={handlePaneClick}
            onPaneContextMenu={handlePaneContext}
            onMove={handleViewportMove}
            onMoveEnd={handleViewportMoveEnd}
            fitView={false} defaultViewport={{x:0,y:0,zoom:1}}
            minZoom={.12} maxZoom={2.5} panOnScroll panOnDrag={[1,2]} zoomOnScroll={false}
            zoomOnPinch zoomOnDoubleClick={false} selectionOnDrag selectionMode={SelectionMode.Partial}
            onlyRenderVisibleElements
            connectionLineType={ConnectionLineType.Bezier}
            deleteKeyCode={null} multiSelectionKeyCode="Shift"
            proOptions={{hideAttribution:true}}
          ><Background color="#55565a" gap={23} size={1.3} variant={BackgroundVariant.Dots}/>
          {nodes.filter(node=>node.selected).length>=2&&
            <SelectionGroupControls nodes={nodes} zoom={zoom}
              onConnect={groupTargets} onAdd={groupAdd}
              onStart={groupDragStart} onHover={groupDragHover} onEnd={groupDragEnd}/>}
          {smartGuides&&<ViewportPortal>
            {smartGuides.vertical&&<div className="tn-smart-guide tn-smart-guide-vertical"
              data-testid="smart-guide-vertical" style={{
                left:smartGuides.vertical.x,top:smartGuides.vertical.y1,
                height:smartGuides.vertical.y2-smartGuides.vertical.y1,
                width:1/Math.max(.1,zoom)
              }}/>}
            {smartGuides.horizontal&&<div className="tn-smart-guide tn-smart-guide-horizontal"
              data-testid="smart-guide-horizontal" style={{
                left:smartGuides.horizontal.x1,top:smartGuides.horizontal.y,
                width:smartGuides.horizontal.x2-smartGuides.horizontal.x1,
                height:1/Math.max(.1,zoom)
              }}/>}
          </ViewportPortal>}
          {showMinimap&&<MiniMap className="studio-minimap" pannable zoomable position="bottom-right" nodeStrokeWidth={2} nodeColor="#555967" maskColor="#0d0e13aa"/>}
          </ReactFlow>
          </NodeEditorContext.Provider>
          </FlowTargetContext.Provider>
          </ConnectionInvalidContext.Provider>
          </ConnectionHighlightContext.Provider>
        </StudioActionsContext.Provider>
        {cutMode&&cutHoverEdge&&<div className="tn-edge-cut-cursor" ref={cutCursorRef}
          role="img" aria-label="剪断连接线" title="左键剪断连接线">
          <Scissors size={17} strokeWidth={1.8}/>
        </div>}
        {ready && nodes.length===0 && !showAdd && <div className="tn-empty-start">
          <div><span className="tn-double-click"><MousePointer2 size={14}/> 双击</span> 画布自由生成 或者 看模板</div>
          <div className="tn-start-choices">
            <button onClick={()=>addNode('video')}><Video size={15}/> 文字生视频</button>
            <button onClick={()=>addNode('image')}><ImageIcon size={15}/> 图片转背景</button>
            <button onClick={()=>addNode('video')}><Sparkles size={15}/> 首帧生视频</button>
            <button onClick={()=>addNode('audio')}><AudioLines size={15}/> 音频生视频</button>
            <button onClick={()=>setShowTemplates(true)}><LayoutGrid size={15}/> 模板</button>
          </div>
        </div>}
        <aside className="canvas-tools">
          <button className="tool-main-add" title="添加节点" onClick={()=>{setMenuOrigin(null);setMenuPos({x:77,y:215});setShowAdd(v=>!v);}}><Plus size={20}/></button>
          <button className="tool-icon" title="搜索节点" onClick={()=>{setMenuOrigin(null);setMenuSearch('');setMenuPos({x:77,y:215});setShowAdd(true);}}><Search size={18}/></button>
          <button className="tool-icon" title="导入素材" onClick={()=>filePicker.current?.click()}><FolderOpen size={17}/></button>
          <button className="tool-icon" title="工作流模板" onClick={()=>setShowTemplates(true)}><LayoutGrid size={17}/></button>
          <button className="tool-icon" title="图文节点" onClick={()=>addNode('text')}><MessageCircle size={17}/></button>
          <button className="tool-icon" title="历史操作" onClick={undo}><Undo2 size={17}/></button>
          <MuseQuotaButton data={museQuota} loading={museQuotaLoading}
            error={museQuotaError}
            onRefresh={()=>void refreshMuseQuota(true)}
            onManageAccounts={()=>setPanel('muse')}/>
          <button className="tn-tool-avatar" title="项目设置" onClick={()=>setPanel('projects')}>B</button>
        </aside>
        {showAdd && <div className={'add-popover'+(menuOrigin?' tn-node-add-popover':'')} style={{left:Math.max(menuOrigin?8:74,menuPos.x),top:Math.max(menuOrigin?8:72,menuPos.y)}}>
          <div className="popover-heading">{menuOrigin?'引用该节点生成':'添加到画布'}{!menuOrigin&&<button onClick={()=>setShowAdd(false)}><X size={14}/></button>}</div>
          {!menuOrigin&&<div className="popover-search"><Search size={14}/><input autoFocus placeholder="搜索节点…" value={menuSearch} onChange={e=>setMenuSearch(e.target.value)}/></div>}
          <div className="popover-tools">{(menuOrigin?entryTools.filter(t=>t.kind!=='audio'):filteredTools).map(({kind,label,desc,icon:Icon})=><button key={kind} onClick={()=>addFromMenu(kind)}><span className="tool-list-icon"><Icon size={17}/></span><span><strong>{menuOrigin&&kind==='text'?'文本生成':label}</strong>{(!menuOrigin||kind==='text')&&<small>{menuOrigin&&kind==='text'?'脚本、广告词、品牌文案':desc}</small>}</span>{!menuOrigin&&<Plus size={14}/>}</button>)}</div>
          {!menuOrigin&&<button className="popover-upload" onClick={()=>{setShowAdd(false);filePicker.current?.click()}}><Upload size={16}/> 上传本地素材</button>}
        </div>}
        <div className="bottom-left-controls">
          <button title="撤销 Ctrl+Z" onClick={undo}><Undo2 size={16}/></button>
          <button title="重做 Ctrl+Y" onClick={redo}><Redo2 size={16}/></button>
          <span className="bottom-divider"/>
          <button title="缩小" onClick={()=>rf.zoomOut({duration:200})}><Minus size={17}/></button>
          <span className="zoom-label">{Math.round(zoom*100)}%</span>
          <button title="放大" onClick={()=>rf.zoomIn({duration:200})}><Plus size={17}/></button>
          <span className="bottom-divider"/>
          <button title="适应画布" onClick={()=>void rf.fitView({padding:.15,duration:450})}><Maximize size={16}/></button>
          <button title="切换画布导航地图" onClick={()=>setShowMinimap(v=>!v)}><SquareDashedMousePointer size={16}/></button>
          <button title="帮助" onClick={()=>setShowHelp(true)}><CircleHelp size={16}/></button>
        </div>
        <div className="tn-bottom-right">
          <button title="画布导航地图" onClick={()=>setShowMinimap(v=>!v)}><Layers3 size={19}/></button>
        </div>
        {toast && <div className="toast"><CheckCircle2 size={15}/>{toast}</div>}
      </div>
      {panel && <aside className="right-panel">
        {panel==='doubao'&&<AccountsPanel accounts={doubaoAccounts} refresh={refreshDoubaoAccounts}
          onClose={()=>setPanel(null)} onSwitch={setPanel}/>}
        {panel==='muse'&&<MuseAccountsPanel accounts={museAccounts}
          refresh={refreshMuseAccounts} onClose={()=>setPanel(null)} onSwitch={setPanel}/>}
        {panel==='agent' && <>
          <div className="panel-topline"><span className="panel-icon"><Sparkles size={18}/></span><strong>AI Creative Agent</strong><span className="demo-small">DEMO</span><button onClick={()=>setPanel(null)}><X size={17}/></button></div>
          <div className="agent-body">
            <div className="agent-intro"><span className="agent-sparkle">✦</span><div className="agent-hello">Hi, 创作者</div><h1>今天想创造<br/>什么精彩内容？</h1><p>输入创意，搭建属于你的视觉工作流。</p></div>
            <div className="suggestions">
              {['制作一支电影感广告','创作一段故事分镜','将图片转成动态视频','设计角色与场景'].map(s=><button key={s} onClick={()=>setAgentDraft(s)}><Sparkles size={13}/>{s}</button>)}
            </div>
          </div>
          <div className="agent-compose">
            {nodes.some(n=>n.selected)&&<div className="agent-reference"><Layers3 size={13}/> 已选择 {nodes.filter(n=>n.selected).length} 个参考节点 <button onClick={()=>setNodes(prev=>prev.map(n=>({...n,selected:false})))}><X size={12}/></button></div>}
            <textarea rows={4} value={agentDraft} onChange={e=>setAgentDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();agentSubmit();}}} placeholder="描述你的创意…&#10;选择节点可作为上下文参考。"/>
            <div className="agent-compose-bottom">
              <select aria-label="创建节点类型" value={agentKind} onChange={e=>setAgentKind(e.target.value as Kind)}>
                {entryTools.map(t=><option key={t.kind} value={t.kind}>{t.label}</option>)}
              </select>
              <span className="compose-note">画布规划</span>
              <button className="agent-send" title="创建节点" onClick={agentSubmit}><ArrowUp size={18}/></button>
            </div>
          </div>
          <div className="panel-footnote">本地工作台 · Agent 暂未接入大模型</div>
        </>}
        {panel==='projects'&&<>
          <div className="panel-topline"><FolderOpen size={18}/><strong>我的画布</strong><button onClick={()=>setPanel(null)}><X size={17}/></button></div>
          <button className="panel-create" onClick={()=>void createProject('未命名画布')}><Plus size={17}/> 创建空白画布</button>
          <button className="panel-create secondary" onClick={()=>setShowTemplates(true)}><LayoutGrid size={17}/> 从模板开始</button>
          <div className="section-label">最近项目 <span>{projects.length}</span></div>
          <div className="project-list">{projects.map(p=><div key={p.id} className={'project-list-item '+(p.id===projectId?'current':'')}>
            <button onClick={()=>void openProject(p.id)}><span className="project-icon"><Grid3X3 size={17}/></span><span><strong>{p.title}</strong><small>{new Date(p.updatedAt).toLocaleString('zh-CN')}</small></span></button>
            <button title="删除" className="delete-small" onClick={()=>void deleteProject(p.id)}><Trash2 size={15}/></button>
          </div>)}</div>
        </>}
        {panel==='assets'&&<>
          <div className="panel-topline"><Layers3 size={18}/><strong>素材库</strong><button onClick={()=>setPanel(null)}><X size={17}/></button></div>
          <div className="asset-heading"><h2>素材与参考图</h2><p>当前画布里的图片、视频和音频素材</p><button onClick={()=>filePicker.current?.click()}><Upload size={15}/> 导入素材</button></div>
          <div className="asset-grid">{nodes.filter(n=>n.data.mediaUrl).map(n=><button className="asset-card" key={n.id} onClick={()=>{setNodes(prev=>prev.map(x=>({...x,selected:x.id===n.id})));setPanel('inspector')}}>
            {n.data.kind==='audio'?<AudioLines size={24}/>:<img src={n.data.mediaUrl} alt={n.data.title}/>}
            <span>{n.data.title}</span>
          </button>)}</div>
          {!nodes.some(n=>n.data.mediaUrl)&&<p className="empty-state">还没有素材。通过上传按钮开始添加。</p>}
        </>}
        {panel==='inspector'&&<>
          <div className="panel-topline"><Settings2 size={18}/><strong>节点属性</strong><button onClick={()=>setPanel('agent')}><X size={17}/></button></div>
          {!selected?<div className="empty-state">选择画布上的节点来编辑属性。</div>:<div className="inspector-body">
            <label>节点名称<input value={selected.data.title} onChange={e=>update(selected.id,{title:e.target.value})}/></label>
            <label>节点类型<div className="readonly-field">{kindLabels[selected.data.kind]}</div></label>
      {selected.data.kind!=='text'&&selected.data.kind!=='audio'&&<>
              {selected.data.kind==='image'&&
                <label>生成方式<div className="readonly-field">Muse 生图</div></label>}
              {selected.data.kind==='video'&&
                <label>生成方式<select
                  aria-label="节点生成服务"
                  value={selected.data.provider||'doubao'}
                  onChange={e=>{
                    const provider=e.target.value as 'doubao'|'muse';
                    update(selected.id,{provider,
                      ...(provider==='muse'&&selected.data.kind==='video'&&
                        Number.parseInt(selected.data.duration||'5s',10)>10
                        ?{duration:'10s'}:{})});
                  }}>
                    <option value="doubao">豆包生成</option>
                    <option value="muse">Muse 生成</option>
                </select></label>}
              {((selected.data.kind!=='video'&&selected.data.kind!=='image')||
                selected.data.kind==='video'&&
                  (selected.data.provider||'doubao')==='doubao')&&
                <label>模型<select value={selected.data.model}
                  onChange={e=>update(selected.id,{model:e.target.value})}>
                  {models[selected.data.kind].map(x=><option key={x}>{x}</option>)}
                </select></label>}
              <label>画幅比例<select value={selected.data.ratio} onChange={e=>update(selected.id,{ratio:e.target.value})}>{(selected.data.kind==='video'?['16:9','4:3','1:1','3:4','9:16','21:9']:['16:9','4:3','1:1','3:4','9:16','21:9','2:3']).map(x=><option key={x}>{x}</option>)}</select></label>
              {selected.data.kind==='image'&&
                <label>分辨率<select value={selected.data.resolution||'2K'}
                  onChange={e=>update(selected.id,{resolution:e.target.value})}>
                  {['1080p','2K','4K','8K'].map(x=><option key={x}>{x}</option>)}
                </select></label>}
              {selected.data.kind==='video'&&<label>时长<select value={selected.data.duration}
                onChange={e=>update(selected.id,{duration:e.target.value})}>
                {Array.from({length:selected.data.provider==='muse'?7:12},
                  (_,i)=>(i+4)+'s').map(x=><option key={x}>{x}</option>)}
              </select></label>}
              {selected.data.kind==='video'&&(selected.data.provider||'doubao')==='doubao'&&
                <label>豆包浏览器账号
                <select value={selected.data.accountId||''} onChange={e=>update(selected.id,{accountId:e.target.value})}>
                  <option value="">未选择账号</option>
                  {doubaoAccounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <button className="doubao-quick-settings" onClick={()=>setPanel('doubao')}>管理豆包账号</button>
              </label>}
              {(['image','video'].includes(selected.data.kind))&&
                (selected.data.provider||(selected.data.kind==='image'?'muse':'doubao'))==='muse'&&
                <label>Muse 独立浏览器账号
                  <select value={selected.data.museAccountId||'auto'}
                    onChange={e=>update(selected.id,{museAccountId:e.target.value})}>
                    <option value="auto">自动选择空闲账号（优先有额度）</option>
                    {museAccounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <button className="doubao-quick-settings" onClick={()=>setPanel('muse')}>
                    管理 Muse 账号
                  </button>
                </label>}
              <label>生成提示词<textarea rows={8} value={selected.data.prompt} onChange={e=>update(selected.id,{prompt:e.target.value})}/></label>
            </>}
            {selected.data.kind==='text'&&<label>文本内容<textarea rows={14} value={selected.data.text || ''} onChange={e=>update(selected.id,{text:e.target.value})}/></label>}
            <label className="check-label"><input type="checkbox" checked={!!selected.data.bypass} onChange={e=>update(selected.id,{bypass:e.target.checked})}/> 运行工作流时跳过此节点</label>
            {selected.data.kind!=='audio'&&<button className="inspector-generate" onClick={()=>void generate(selected.id)}><WandSparkles size={16}/>
              {(selected.data.provider||(selected.data.kind==='image'?'muse':'doubao'))==='muse'&&
                ['image','video'].includes(selected.data.kind)
                ?'发送到 Muse 生成'+(selected.data.kind==='video'?'视频':'图片')
                :selected.data.kind==='video'?'发送到豆包生成视频':'生成演示结果'}
            </button>}
            <button className="inspector-delete" onClick={()=>remove(selected.id)}><Trash2 size={15}/> 删除节点</button>
          </div>}
        </>}
      </aside>}
    </div>
    {showTemplates&&<div className="modal-scrim" onMouseDown={()=>setShowTemplates(false)}><div className="template-modal" onMouseDown={e=>e.stopPropagation()}>
      <div className="modal-heading"><div><small>START CREATING</small><h2>从哪里开始？</h2></div><button onClick={()=>setShowTemplates(false)}><X size={20}/></button></div>
      <div className="template-grid">
        <button onClick={()=>void createProject('新的创意画布','blank')}><div className="template-picture template-blank"><Plus size={34}/></div><strong>空白画布</strong><small>从一个全新的空间开始</small></button>
        <button onClick={()=>void createProject('电影感创作流程','demo')}><div className="template-picture template-demo"><ImageIcon size={32}/><Clapperboard size={22}/></div><strong>AI 视觉工作流</strong><small>脚本 → 参考图 → 视频 → 音频</small></button>
        <button onClick={()=>void createProject('产品广告工作流','ad')}><div className="template-picture template-ad"><Sparkles size={32}/></div><strong>产品广告</strong><small>从创意到主视觉与广告视频</small></button>
      </div>
    </div></div>}
    {showHelp&&<div className="modal-scrim" onMouseDown={()=>setShowHelp(false)}><div className="help-modal" onMouseDown={e=>e.stopPropagation()}>
      <div className="modal-heading"><div><small>QUICK GUIDE</small><h2>画布快捷操作</h2></div><button onClick={()=>setShowHelp(false)}><X size={20}/></button></div>
      <div className="shortcuts">{[
        ['双击空白区域','快速创建节点'],['鼠标滚轮','平移画布'],['按住鼠标中键 / 右键拖动','移动画布'],
        ['Ctrl + 滚轮 / 触控板双指缩放','缩放画布'],['Shift + 点击','多选节点'],
        ['Ctrl + C / Ctrl + V','复制 / 粘贴节点'],['Ctrl + Z / Ctrl + Y','撤销 / 重做'],
        ['Delete','删除选中的节点'],['节点右侧 +','延续当前创作流程'],['右上角运行全部','按依赖顺序模拟执行']
      ].map(([left,right])=><div key={left}><span>{left}</span><strong>{right}</strong></div>)}</div>
    </div></div>}
    {activePreview&&<div className="modal-scrim preview-scrim" onMouseDown={()=>setPreview(null)}><div className="preview-modal" onMouseDown={e=>e.stopPropagation()}>
      <div className="preview-header"><span>{activePreview.data.title}</span><button onClick={()=>setPreview(null)}><X size={21}/></button></div>
      {activePreview.data.mediaUrl && activePreview.data.kind!=='audio'?<img src={activePreview.data.mediaUrl} alt={activePreview.data.title}/>:<div className="preview-text">{activePreview.data.text||activePreview.data.prompt||'暂无预览内容'}</div>}
      <div className="preview-bottom"><span>{activePreview.data.demo?'演示素材 / 非 AI 实际生成':'素材预览'}</span><button onClick={()=>{setPreview(null);setNodes(prev=>prev.map(n=>({...n,selected:n.id===activePreview.id})));setPanel('inspector')}}>编辑属性 <ArrowRight size={14}/></button></div>
    </div></div>}
  </div>;
}

export default function App() { return <ReactFlowProvider><Workspace/></ReactFlowProvider>; }
