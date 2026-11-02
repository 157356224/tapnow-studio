import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Handle, NodeToolbar, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import {
  Image as ImageIcon, Video, AlignLeft, AudioLines, Upload, Plus, Tag, Copy,
  FolderPlus, Maximize2, ChevronDown, ArrowUp, Sparkles, Check,
  Play, MoreHorizontal, Trash2, X, Settings2, RotateCw, WandSparkles,
  CircleHelp, MousePointer2, LogIn, Gem, Volume2, Download
} from 'lucide-react';
import { StudioActionsContext } from './nodes';
import type { Kind, StudioNode } from './types';
import { defaultVideoModel, models, videoModelOptions } from './sample';
import { VideoPromptEditor } from './VideoPromptEditor';
import { ComposingTextarea } from './ComposingTextarea';
import { GenerationVisualCanvas } from './GenerationVisualCanvas';

const ICON = { image: ImageIcon, video: Video, text: AlignLeft, audio: AudioLines };
const TITLE = { image: 'Image', video: 'Video', text: 'Text', audio: 'Audio' };
const RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];
const IMAGE_RATIOS = [...RATIOS, '2:3'];
const IMAGE_RESOLUTIONS = ['1080p', '2K', '4K', '8K'];
const videoFrames:Record<string,{width:number;height:number}>={
  '16:9':{width:500,height:282},
  '4:3':{width:430,height:322},
  '1:1':{width:370,height:370},
  '3:4':{width:345,height:460},
  '9:16':{width:298,height:530},
  '21:9':{width:540,height:232},
  '2:3':{width:324,height:486}
};

export type ConnectionHighlight = { id: string; valid: boolean; direction: 'ltr' | 'rtl' };
export const ConnectionHighlightContext = createContext<ConnectionHighlight | null>(null);
export const ConnectionInvalidContext=createContext<ReadonlySet<string>>(new Set());
export const FlowTargetContext=createContext<ReadonlySet<string>>(new Set());
export type NodeEditorState={id:string|null;instant:boolean};
export const NodeEditorContext=createContext<NodeEditorState>({id:null,instant:true});

// Shared, frame-scheduled pointer tracking. Proximity does not re-render nodes.
const magnetRegistry = new Set<HTMLElement>();
type MagnetGeometry={box:DOMRect;width:number;updated:number};
const geometryCache=new WeakMap<HTMLElement,MagnetGeometry>();
type MagnetSide = { left: boolean; right: boolean };
const magnetState = new WeakMap<HTMLElement, MagnetSide>();
let latestPointer: {x:number;y:number} | null = null;
let magnetFrame = 0;
function flushMagnetFrame() {
  magnetFrame = 0;
  if (!latestPointer) return;
  const pointer=latestPointer;
  const now=performance.now();
  const updates:{el:HTMLElement;left:boolean;right:boolean;x:number;y:number;distance:number}[]=[];
  for (const el of magnetRegistry) {
    const old=geometryCache.get(el);
    const dragging=el.closest('.react-flow__node')?.classList.contains('dragging');
    const geometry=!old||dragging||now-old.updated>130
      ?{box:el.getBoundingClientRect(),width:Math.max(1,el.offsetWidth),updated:now}
      :old;
    if(geometry!==old)geometryCache.set(el,geometry);
    const {box}=geometry;
    if(box.right<-175||box.left>window.innerWidth+175||
       box.bottom<-175||box.top>window.innerHeight+175)continue;
    const scale=box.width/geometry.width;
    // The entire exterior corridor is magnetic, including the area beyond
    // the circle's resting position. Its own hit target moves with the cursor.
    const range=174*scale;
    const restingGap=46*scale;
    const edgeReset=6*scale;
    const frameTop=box.top+27*scale;
    const vertical=pointer.y>=frameTop-22*scale && pointer.y<=box.bottom+22*scale;
    const nearLeft=vertical && pointer.x<box.left-edgeReset && pointer.x>=box.left-range;
    const nearRight=vertical && pointer.x>box.right+edgeReset && pointer.x<=box.right+range;
    const previous=magnetState.get(el);
    if(!nearLeft&&!nearRight&&!previous?.left&&!previous?.right)continue;
    const frameHeight=box.bottom-frameTop;
    const center=frameTop+frameHeight/2;
    // Keep both "+" rings in the middle strip of the media frame, as in
    // the canvas reference (roughly 18% to 78% of its height). The bounds
    // scale with image/video aspect-ratio changes and React Flow zoom.
    const minY=frameTop+frameHeight*.18;
    const maxY=frameTop+frameHeight*.78;
    const followY=(Math.max(minY,Math.min(maxY,pointer.y))-center)/scale;
    const fromCenter=nearLeft?pointer.x-(box.left-restingGap):pointer.x-(box.right+restingGap);
    const followX=Math.max(-range/scale+restingGap/scale,Math.min(range/scale-restingGap/scale,fromCenter/scale));
    updates.push({
      el,left:nearLeft,right:nearRight,x:followX,y:followY,
      distance:nearLeft?box.left-pointer.x:nearRight?pointer.x-box.right:Infinity
    });
  }
  // Adjacent nodes can have overlapping magnetic corridors. Only the closest
  // card gets the ring: otherwise the farther node's target "+" would hover
  // over the source "+" and steal the initial connection pointerdown.
  const winner=updates.reduce<(typeof updates)[number]|null>(
    (best,current)=>(current.left||current.right)&&
      (!best||current.distance<best.distance)?current:best,null
  );
  // Geometry reads end above; only compositor-friendly transforms below.
  for (const entry of updates) {
    const {el,x,y}=entry;
    const left=entry===winner&&entry.left;
    const right=entry===winner&&entry.right;
    const previous=magnetState.get(el);
    if(previous?.left!==left)el.classList.toggle('tn-near-left',left);
    if(previous?.right!==right)el.classList.toggle('tn-near-right',right);
    magnetState.set(el,{left,right});
    const inVisual=el.querySelector<HTMLElement>('.tn-port-in .tn-port-visual');
    const outVisual=el.querySelector<HTMLElement>('.tn-port-out .tn-port-visual');
    if(inVisual&&(left||previous?.left))
      inVisual.style.translate=left?(x+'px '+y+'px'):'0px 0px';
    if(outVisual&&(right||previous?.right))
      outVisual.style.translate=right?(x+'px '+y+'px'):'0px 0px';
  }
}
function trackMagnets(e:PointerEvent){
  latestPointer={x:e.clientX,y:e.clientY};
  if(!magnetFrame)magnetFrame=requestAnimationFrame(flushMagnetFrame);
}
export function StudioNodeV2({ id, data, selected }: NodeProps<StudioNode>) {
  const api = useContext(StudioActionsContext);
  if (!api) throw new Error('Actions not ready');
  const highlight = useContext(ConnectionHighlightContext);
  const invalidTargets=useContext(ConnectionInvalidContext);
  const flowTargets=useContext(FlowTargetContext);
  const editorState=useContext(NodeEditorContext);
  const showingCompose=selected&&editorState.id===id;
  const [mountedComposer,setMountedComposer]=useState(showingCompose);
  const [closingComposer,setClosingComposer]=useState(false);
  const toolbarVisible=showingCompose||(mountedComposer&&closingComposer);
  useEffect(()=>{
    if(showingCompose){
      setMountedComposer(true);
      setClosingComposer(false);
      return;
    }
    if(editorState.instant){
      setMountedComposer(false);
      setClosingComposer(false);
      return;
    }
    if(!mountedComposer)return;
    setClosingComposer(true);
    const timeout=window.setTimeout(()=>{
      setMountedComposer(false);
      setClosingComposer(false);
    },420);
    return ()=>window.clearTimeout(timeout);
  },[showingCompose,editorState.instant,mountedComposer]);
  const [editing, setEditing] = useState(false);
  const [textDraft,setTextDraft]=useState(data.text||'');
  const textComposing=useRef(false);
  const [menu, setMenu] = useState(false);
  const [showModel, setShowModel] = useState(false);
  const [modelMounted,setModelMounted]=useState(false);
  const [modelClosing,setModelClosing]=useState(false);
  const [showDuration, setShowDuration] = useState(false);
  const [durationMounted,setDurationMounted]=useState(false);
  const [durationClosing,setDurationClosing]=useState(false);
  const settingsRef=useRef<HTMLDivElement>(null);
  const modelRef=useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const nodeRef = useRef<HTMLDivElement>(null);
  const kind = data.kind;
  const videoFrame=videoFrames[data.ratio||'16:9']||videoFrames['16:9'];
  // Use the requested output aspect ratio for image frames, just like videos.
  // The original media is displayed within the frame without stretching.
  const imageFrame=kind==='image'
    ?videoFrames[data.ratio||'2:3']||videoFrames['2:3']:null;
  const nodeSize=kind==='video'?{
    '--tn-video-width':videoFrame.width+'px',
    '--tn-video-height':videoFrame.height+'px'
  } as CSSProperties:imageFrame?{
    '--tn-image-width':imageFrame.width+'px',
    '--tn-image-height':imageFrame.height+'px'
  } as CSSProperties:undefined;
  const provider=kind==='video'?(data.provider||'doubao'):
    kind==='image'?'muse':'demo';
  // Image-to-image references must work on a newly created image node too:
  // image nodes default to Muse without storing provider in their data yet.
  // Keep the same connected thumbnail and @ ordering UI in demo mode.
  const references=(kind==='video'||kind==='image')?api.referencesFor(id):[];
  const museMode=(kind==='video'||kind==='image')&&provider==='muse';
  const account=museMode
    ?api.museAccounts.find(a=>a.id===data.museAccountId)
    :api.accounts.find(a=>a.id===data.accountId);
  const selectedModel=kind==='video'
    ?(models.video.includes(data.model||'')?data.model!:defaultVideoModel)
    :(data.model||models[kind][0]);
  useEffect(()=>{
    if(showingCompose)return;
    setShowDuration(false);setShowModel(false);
  },[showingCompose]);
  useEffect(()=>{
    if(showDuration){
      setDurationMounted(true);
      setDurationClosing(false);
      return;
    }
    if(!durationMounted)return;
    setDurationClosing(true);
    const timer=window.setTimeout(()=>{
      setDurationMounted(false);
      setDurationClosing(false);
    },240);
    return ()=>window.clearTimeout(timer);
  },[showDuration,durationMounted]);
  useEffect(()=>{
    if(showModel){
      setModelMounted(true);
      setModelClosing(false);
      return;
    }
    if(!modelMounted)return;
    setModelClosing(true);
    const timer=window.setTimeout(()=>{
      setModelMounted(false);
      setModelClosing(false);
    },240);
    return ()=>window.clearTimeout(timer);
  },[showModel,modelMounted]);
  useEffect(()=>{
    if(!showDuration&&!showModel)return;
    const onOutside=(event:PointerEvent)=>{
      const element=event.target as Node;
      if(showDuration&&!settingsRef.current?.contains(element))setShowDuration(false);
      if(showModel&&!modelRef.current?.contains(element))setShowModel(false);
    };
    document.addEventListener('pointerdown',onOutside,true);
    return ()=>document.removeEventListener('pointerdown',onOutside,true);
  },[showDuration,showModel]);
  useEffect(()=>{
    if(!textComposing.current&&document.activeElement!==textRef.current)
      setTextDraft(data.text||'');
  },[data.text]);
  const Icon = ICON[kind];
  const stopEvents = (e: ReactMouseEvent | ReactPointerEvent) => {
    const target=e.target as HTMLElement;
    if(target.closest('.tn-node-text[readonly]'))return;
    if(target.closest('button,input,textarea,select,a,.floating-compose'))e.stopPropagation();
  };
  useEffect(()=>{
    const el=nodeRef.current;
    if(!el)return;
    magnetRegistry.add(el);
    if(magnetRegistry.size===1)window.addEventListener('pointermove',trackMagnets,{passive:true});
    return ()=>{
      magnetRegistry.delete(el);
      if(magnetRegistry.size===0){
        window.removeEventListener('pointermove',trackMagnets);
        if(magnetFrame)cancelAnimationFrame(magnetFrame);
        magnetFrame=0;
        latestPointer=null;
      }
    };
  },[]);
  const fileAccept = kind === 'image' ? 'image/*' : kind === 'video' ? 'video/*' : 'audio/*';
  const upstream = kind === 'video' ? 'image' : 'text';
  const downstream = kind === 'text' ? 'image' : kind === 'image' ? 'video' : 'image';
  const isVideo = kind === 'video' && !!data.mediaUrl && !data.demo &&
    /\.(mp4|mov|webm|ogg)(\?|$)/i.test(data.mediaUrl);
  const downloadFilename=(()=>{
    const extension=data.mediaUrl?.match(/\.([a-z\d]{2,5})(?:\?|$)/i)?.[1]
      ||(kind==='video'?'mp4':'png');
    const title=(data.title||kind).replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,64)||kind;
    return title+'.'+extension.toLowerCase();
  })();
  const showGenerationVisual=(kind==='image'||kind==='video')&&
    (data.status==='queued'||data.status==='running');
  const [revealMedia,setRevealMedia]=useState(false);
  const previousGeneration=useRef({status:data.status,mediaUrl:data.mediaUrl});
  useEffect(()=>{
    const previous=previousGeneration.current;
    previousGeneration.current={status:data.status,mediaUrl:data.mediaUrl};
    if((previous.status==='queued'||previous.status==='running')&&
       data.status==='done'&&data.mediaUrl){
      setRevealMedia(true);
      const timer=window.setTimeout(()=>setRevealMedia(false),830);
      return ()=>window.clearTimeout(timer);
    }
    if(data.status==='queued'||data.status==='running')setRevealMedia(false);
  },[data.status,data.mediaUrl]);
  const playVideoOnHover=()=>{
    const video=videoRef.current;
    if(!video)return;
    // Preserve the video's sound setting. Muting on each hover overrides the
    // user's choice in native media controls and silently disables audio.
    // Browsers may require a user interaction before audible autoplay.
    void video.play().catch(()=>{});
  };
  const pauseVideoOnLeave=()=>{
    videoRef.current?.pause();
  };
  return <div
    ref={nodeRef}
    style={nodeSize}
    className={'tn-node tn-'+kind+(imageFrame?' tn-image-natural':'')+
      (selected?' tn-selected':'')+(flowTargets.has(id)?' tn-flow-target':'')+
      (data.bypass?' tn-bypass':'')
      +(invalidTargets.has(id)||highlight?.id===id&&!highlight.valid?' tn-drop-invalid':'')
      +(highlight?.id===id&&highlight.valid?' tn-drop-target tn-scan-'+highlight.direction:'')}
    onPointerDown={stopEvents} onMouseDown={stopEvents}
  >
    <div className="tn-node-caption"><Icon size={13} strokeWidth={1.8}/><span>{data.title || TITLE[kind]}</span></div>
    <div className="tn-node-frame">
      {kind === 'text' ? <textarea
        ref={textRef}
        aria-label="文本节点内容"
        className={'tn-node-text nowheel'+(editing?' nodrag':'')}
        placeholder="双击开始编辑..."
        readOnly={!editing}
        value={textDraft}
        onDoubleClick={e=>{e.stopPropagation();setEditing(true);setTimeout(()=>textRef.current?.focus(),0);}}
        onBlur={()=>{
          if(textComposing.current)return;
          setEditing(false);
          api.update(id,{text:textRef.current?.value||''});
        }}
        onCompositionStart={()=>{textComposing.current=true;}}
        onCompositionEnd={e=>{
          textComposing.current=false;
          setTextDraft(e.currentTarget.value);
          api.update(id,{text:e.currentTarget.value});
        }}
        onChange={e=>{
          setTextDraft(e.currentTarget.value);
          if(!textComposing.current)api.update(id,{text:e.currentTarget.value});
        }}
      /> : kind === 'audio' ?
        <div className="tn-audio-visual">
          <AudioLines size={46} strokeWidth={1.45}/>
          <div className="tn-wave">{Array.from({length:27},(_,i)=><i key={i} style={{height:(12+Math.abs(Math.sin(i*1.7))*40)+'%'}}/>)}</div>
          {data.mediaUrl && <audio controls src={data.mediaUrl} className="nodrag nowheel"/>}
        </div>
        : data.mediaUrl ? (
          isVideo ? <video ref={videoRef}
            className={'tn-media nowheel'+(revealMedia?' tn-media-reveal':'')}
            src={data.mediaUrl}
            controls playsInline preload="metadata" disablePictureInPicture
            disableRemotePlayback controlsList="nodownload noremoteplayback nofullscreen"
            onMouseEnter={playVideoOnHover}
            onMouseLeave={pauseVideoOnLeave}
            onCanPlay={()=>{
              if(videoRef.current?.matches(':hover'))playVideoOnHover();
            }}/> :
          <><img className={'tn-media'+(revealMedia?' tn-media-reveal':'')}
             draggable={false} alt={data.title} src={data.mediaUrl}
             onLoad={e=>{
               const img=e.currentTarget;
               if(kind==='image'&&img.naturalWidth&&img.naturalHeight&&
                  (data.mediaWidth!==img.naturalWidth||data.mediaHeight!==img.naturalHeight)){
                 api.update(id,{mediaWidth:img.naturalWidth,mediaHeight:img.naturalHeight});
               }
             }}/>
            {kind==='video' && <span className="tn-video-play"><Play size={20} fill="currentColor"/></span>}
          </>
        ) :
        <div className="tn-empty-icon">{kind==='video'?<span className="tn-video-symbol"><Play size={19} fill="currentColor"/></span>:<ImageIcon size={57} strokeWidth={1.9}/>}</div>
      }
      {showGenerationVisual&&<div className="tn-generating-visual"
        role="status" aria-label={data.status==='queued'?'排队等待生成':'正在生成'}
        title={data.jobMessage||'正在生成'} data-generation-status={data.status}>
        <GenerationVisualCanvas nodeId={id}/>
      </div>}
      {kind!=='image'&&kind!=='video'&&data.status==='running'&&
        <div className="tn-running">生成中 {data.progress||0}%<span style={{width:(data.progress||0)+'%'}}/></div>}
      {kind!=='image'&&kind!=='video'&&data.status==='queued'&&
        <div className="tn-queued" title={data.jobMessage||'正在连接对应账号'}>
          {data.jobMessage||'正在打开账号浏览器'}</div>}
      {data.status==='error' && <div className="tn-node-error" title={data.jobMessage||'生成失败'}>
        {data.jobMessage||'生成失败，请检查账号登录状态'}</div>}
      {data.bypass && <span className="tn-disabled-marker">已跳过</span>}
    </div>
    {(kind==='image'||kind==='video') &&
      <button className="tn-upload-chip nodrag" title="上传素材" onClick={()=>inputRef.current?.click()}><Upload size={14}/> 上传</button>}
    <input hidden ref={inputRef} type="file" accept={fileAccept} onChange={e=>{
      const file=e.currentTarget.files?.[0]; if(file)void api.uploadFor(id,file);e.currentTarget.value='';
    }}/>
    <Handle className="tn-port tn-port-in" type="target" position={Position.Left} id="in"
      onClick={e=>{e.stopPropagation();api.openNodeMenu(id,'target',e.clientX,e.clientY);}}>
      <span className="tn-port-visual"><span className="tn-port-disc"><Plus size={20} strokeWidth={1.7}/></span></span>
    </Handle>
    <Handle className="tn-port tn-port-out" type="source" position={Position.Right} id="out"
      onClick={e=>{e.stopPropagation();api.openNodeMenu(id,'source',e.clientX,e.clientY);}}>
      <span className="tn-port-visual"><span className="tn-port-disc"><Plus size={20} strokeWidth={1.7}/></span></span>
    </Handle>
    <NodeToolbar isVisible={toolbarVisible} position={Position.Top} offset={12} align="center">
      <div className={'tn-toolbar nodrag'+(closingComposer?' tn-editor-closing':'')} onPointerDown={e=>e.stopPropagation()}>
        <button title="颜色" className="tn-color"><span/></button>
        <i className="tn-toolbar-sep"/>
        <button title="标记" onClick={()=>api.update(id,{color:data.color==='#a6c9f6'?'#e1acbf':'#a6c9f6'})}><Tag size={16}/></button>
        <button title="复制节点" onClick={()=>api.duplicate(id)}><Copy size={16}/></button>
        <button title="在此添加节点" onClick={()=>api.addAfter(id,downstream)}><FolderPlus size={17}/></button>
        <button title="放大" onClick={()=>api.expand(id)}><Maximize2 size={16}/></button>
        <button title="节点设置" onClick={()=>api.inspect(id)}><Settings2 size={16}/></button>
        <button title="删除节点" onClick={()=>api.remove(id)}><Trash2 size={16}/></button>
        {(kind==='image'||kind==='video')&&data.mediaUrl&&
          <a className="tn-toolbar-download nodrag" href={data.mediaUrl}
            title="下载生成素材" aria-label="下载生成素材"
            download={downloadFilename} onClick={event=>event.stopPropagation()}>
            <Download size={17}/>
          </a>}
      </div>
    </NodeToolbar>
    <NodeToolbar isVisible={toolbarVisible} position={Position.Bottom} offset={15} align="center">
      <div className={'floating-compose nodrag nowheel'+(closingComposer?' tn-editor-closing':'')}
        onMouseDown={e=>e.stopPropagation()} onPointerDown={e=>e.stopPropagation()}>
        <div className="tn-compose-top">
          {kind!=='video'&&kind!=='image'&&<button className="tn-compose-square" title="添加参考素材" onClick={()=>inputRef.current?.click()}><Plus size={17}/></button>}
          <span className="tn-compose-top-spacer"/>
          {kind!=='video'&&<span className="tn-compose-label">{kind==='image'?'图像生成':kind==='text'?'文本创作':'音频生成'}</span>}
        </div>
        {(kind==='video'||kind==='image')?<VideoPromptEditor
          prompt={data.prompt||''} references={references} explicitIds={data.referenceIds||[]}
          onReorder={(referenceId,direction,currentPrompt)=>
            api.reorderReferences(id,referenceId,direction,currentPrompt)}
          onPrompt={value=>api.update(id,{prompt:value})}
          onReference={referenceId=>api.update(id,{
            referenceIds:[...new Set([...(data.referenceIds||[]),referenceId])]
          })}
          onRemove={referenceId=>{
            const ref=references.find(r=>r.id===referenceId);
            api.update(id,{
              referenceIds:(data.referenceIds||[]).filter(x=>x!==referenceId),
              prompt:ref?(data.prompt||'').replaceAll(ref.token,''):data.prompt
            });
          }}
        />:<ComposingTextarea
          className="tn-compose-prompt"
          label="节点生成提示词"
          placeholder="描述任何你想要生成的内容"
          rows={3}
          value={data.prompt||''}
          onChange={next=>api.update(id,{prompt:next})}
        />}
        <div className="tn-compose-footer">
          {kind==='video'&&<div className="tn-provider-switch"
            role="group" aria-label="生成服务">
            {[
              {id:'doubao',label:'豆包生成'},{id:'muse',label:'Muse 生成'}
            ].map(item=><button key={item.id} type="button"
              className={provider===item.id?'active':''}
              aria-pressed={provider===item.id}
              onClick={()=>{
                api.update(id,{provider:item.id as 'doubao'|'muse',
                  ...(item.id==='muse'&&kind==='video'&&Number.parseInt(data.duration||'5s',10)>10
                    ?{duration:'10s'}:{})});
                setShowDuration(false);setShowModel(false);
              }}>{item.label}</button>)}
          </div>}
          {kind==='image'&&<div className="tn-provider-switch"
            role="group" aria-label="生成服务">
            <button type="button" className="active" aria-pressed="true">Muse 生图</button>
          </div>}
          {(kind==='video'||museMode)&&<div className="tn-account-picker">
            <select aria-label={museMode?'Muse 生成账号':'视频生成账号'}
              title={museMode?'Muse 独立浏览器账号':'豆包独立浏览器账号'}
              value={museMode?(data.museAccountId||'auto'):(data.accountId||'')}
              onChange={e=>api.update(id,museMode
                ?{museAccountId:e.target.value}:{accountId:e.target.value})}>
              {museMode?
                <option value="auto">自动选择有剩余额度的账号</option>:
                <option value="">选择豆包账号</option>}
              {(museMode?api.museAccounts:api.accounts).map(a=><option key={a.id} value={a.id}>
                {a.name}
              </option>)}
            </select>
            {account&&<button className="tn-account-login"
              title={museMode?'打开该账号独立 Edge 登录 Muse':'打开该账号独立浏览器登录豆包'}
              onClick={()=>void (museMode?api.openMuseAccountBrowser(account.id):
                api.openAccountBrowser(account.id))}>
              <LogIn size={13}/> 登录</button>}
            {!(museMode?api.museAccounts:api.accounts).length&&
              <button className="tn-account-add" title={museMode?'添加 Muse 账号':'添加豆包账号'}
                onClick={museMode?api.openMuseAccountsSettings:api.openAccountsSettings}>
                添加账号</button>}
          </div>}
          {!museMode&&<div className={'tn-combobox'+(kind==='video'?' tn-video-model-picker':'')} ref={modelRef}>
            <button title="选择模型" aria-expanded={showModel}
              onClick={()=>{setShowModel(v=>!v);setShowDuration(false);}}>
              {kind==='video'?<span className="tn-model-symbol"><i/><i/><i/></span>:<Sparkles size={14}/>}
              {selectedModel}<ChevronDown size={12}/>
            </button>
            {(kind==='video'?modelMounted:showModel) && (kind==='video'?
              <div className={'tn-dropdown tn-video-model-menu'+(modelClosing?' tn-settings-closing':'')}
                role="listbox" aria-label="视频模型" aria-hidden={modelClosing}
                onPointerDown={e=>e.stopPropagation()}>
                {videoModelOptions.map(option=><button key={option.name}
                  type="button" role="option"
                  aria-selected={selectedModel===option.name}
                  className={'tn-video-model-row'+(selectedModel===option.name?' is-selected':'')}
                  title={option.name}
                  onClick={()=>{api.update(id,{model:option.name});setShowModel(false);}}>
                  <span className="tn-model-row-top">
                    <span className="tn-model-brand-icon">
                      <span className="tn-model-symbol"><i/><i/><i/></span>
                    </span>
                    <span className="tn-model-row-name">{option.name}</span>
                    {selectedModel===option.name&&<Check className="tn-model-row-state" size={16}/>}
                  </span>
                  {!!option.resolution&&<span className="tn-model-row-badges">
                    <span className="tn-model-badge"><Gem size={12}/>{option.resolution}</span>
                    <span className="tn-model-badge">{option.duration}</span>
                    {option.audio&&<span className="tn-model-badge tn-model-audio"><Volume2 size={12}/></span>}
                  </span>}
                </button>)}
              </div>:
              <div className="tn-dropdown">{models[kind].map(m=><button key={m}
                onClick={()=>{api.update(id,{model:m});setShowModel(false);}}>{m}</button>)}</div>)}
          </div>}
          {kind!=='text' && <span className="tn-compose-divider"/>}
          {(kind==='image'||kind==='video') && <div className="tn-video-settings-control" ref={settingsRef}>
            <button className="tn-video-settings-toggle"
              title={kind==='image'?'设置图片比例和分辨率':'设置视频比例和时长'}
              aria-expanded={showDuration}
              onClick={()=>{setShowDuration(v=>!v);setShowModel(false);}}>
              {kind==='image'
                ?(data.ratio||'2:3')+' · '+(data.resolution||'2K')
                :(data.ratio||'16:9')+' · '+(data.duration||'5s')}
              <ChevronDown size={12}/>
            </button>
            {durationMounted&&<div className={'tn-video-settings'+
              (kind==='image'?' tn-image-settings':'')+
              (durationClosing?' tn-settings-closing':'')} onPointerDown={e=>e.stopPropagation()}>
              <div className="tn-video-setting-heading">比例</div>
              <div className={'tn-video-ratios'+(kind==='image'?' tn-image-ratios':'')}>
                {(kind==='image'?IMAGE_RATIOS:RATIOS).map(r=><button key={r}
                  aria-pressed={(data.ratio||(kind==='image'?'2:3':'16:9'))===r}
                  className={(data.ratio||(kind==='image'?'2:3':'16:9'))===r?'active':''}
                  onClick={()=>api.update(id,{ratio:r})}>
                  <span className="tn-ratio-icon" style={{
                    aspectRatio:r.replace(':','/')}}/>
                  <small>{r}</small>
                </button>)}
              </div>
              {kind==='image'?<>
                <div className="tn-video-setting-heading">图片分辨率</div>
                <div className="tn-image-resolutions">
                  {IMAGE_RESOLUTIONS.map(res=><button key={res}
                    aria-pressed={(data.resolution||'2K')===res}
                    className={(data.resolution||'2K')===res?'active':''}
                    onClick={()=>api.update(id,{resolution:res})}>{res}</button>)}
                </div>
              </>:<>
                <div className="tn-video-setting-heading">生成时长</div>
                <div className="tn-video-durations">
                  {Array.from({length:museMode?7:12},(_,i)=>i+4).map(n=><button key={n}
                    className={(data.duration||'5s')===n+'s'?'active':''}
                    onClick={()=>api.update(id,{duration:n+'s'})}>{n}s</button>)}
                </div>
              </>}
            </div>}
          </div>}
          <span className="tn-compose-fill"/>
          <button className="tn-submit" title={museMode?'使用 Muse 生成'+(kind==='video'?'视频':'图片'):
            kind==='video'?'使用选定豆包账号生成视频':'生成内容'}
            onClick={()=>void api.generate(id)}><ArrowUp size={16}/></button>
        </div>
        {(kind==='video'||museMode)&&<div className="tn-job-caption">
          {data.jobMessage|| (account?'使用 '+account.name+' 的独立 Edge 浏览器':
            museMode?'自动选择剩余额度最多的 Muse 账号':
              '选择账号后发送到 '+selectedModel)}
        </div>}
      </div>
    </NodeToolbar>
  </div>;
}
