import { createContext, useContext, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Handle, NodeToolbar, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import {
  AudioLines, Check, ChevronDown, Clapperboard, Copy, Download, Ellipsis,
  Image as ImageIcon, Maximize2, MoreHorizontal, Play, Plus, Sparkles,
  Type, WandSparkles, X, Zap, CirclePause, ArrowUp, RefreshCw
} from 'lucide-react';
import type { Kind, StudioNode, StudioNodeData } from './types';
import type { DoubaoAccount, ReferenceNode } from './doubao';
import type {MuseAccount} from './muse';
import { kindEnglish, kindLabels, models } from './sample';

type Actions = {
  update: (id: string, patch: Partial<StudioNodeData>) => void;
  generate: (id: string, kind?: Kind) => void;
  addAfter: (id: string, kind: Kind) => void;
  addBefore: (id: string, kind: Kind) => void;
  openNodeMenu: (id: string, side: 'source'|'target', x: number, y: number) => void;
  uploadFor: (id: string, file: File) => Promise<void>;
  extractLastFrame: (id: string) => Promise<void>;
  openFrameEditor: (id: string) => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
  expand: (id: string) => void;
  inspect: (id: string) => void;
  accounts: DoubaoAccount[];
  museAccounts: MuseAccount[];
  referencesFor: (id: string) => ReferenceNode[];
  reorderReferences: (nodeId:string,referenceId:string,direction:-1|1,currentPrompt?:string)=>void;
  openAccountsSettings: () => void;
  openMuseAccountsSettings: () => void;
  openH3Settings: () => void;
  openAccountBrowser: (id: string) => Promise<void>;
  openMuseAccountBrowser: (id: string) => Promise<void>;
};
export const StudioActionsContext = createContext<Actions | null>(null);
function useActions() {
  const ctx = useContext(StudioActionsContext);
  if (!ctx) throw new Error('Missing StudioActionsContext');
  return ctx;
}
const KIND_ICON = { image: ImageIcon, video: Clapperboard, text: Type, audio: AudioLines };
function NodeActions({ id, kind }: { id: string; kind: Kind }) {
  const api = useActions();
  const [more, setMore] = useState(false);
  return <div className="node-actions nodrag" onMouseDown={e => e.stopPropagation()}>
    <button title="放大预览" onClick={() => api.expand(id)}><Maximize2 size={15} /></button>
    <button title="复制节点" onClick={() => api.duplicate(id)}><Copy size={15} /></button>
    <button title="从节点生成" onClick={() => api.generate(id)}><WandSparkles size={15} /></button>
    <button title="更多" onClick={() => setMore(v => !v)}><MoreHorizontal size={17} /></button>
    {more && <div className="node-more-menu">
      {(['text', 'image', 'video', 'audio'] as Kind[]).map(item =>
        <button key={item} onClick={() => { api.addAfter(id, item); setMore(false); }}>新增{kindLabels[item]}节点</button>)}
      <button onClick={() => { api.update(id, { bypass: true }); setMore(false); }}>跳过此节点</button>
      <button className="danger" onClick={() => { api.remove(id); setMore(false); }}>删除节点</button>
    </div>}
  </div>;
}

function Preview({ data, id }: { data: StudioNodeData; id: string }) {
  const api = useActions();
  const input = useRef<HTMLInputElement>(null);
  const isLocalVideo = data.kind === 'video' && data.mediaUrl && !data.demo && /\.(mp4|mov|webm|ogg)(?:\?|$)/i.test(data.mediaUrl);
  return <div className={'media-frame media-' + data.kind}>
    {data.mediaUrl && data.kind === 'image' && <img src={data.mediaUrl} alt={data.title} draggable={false} />}
    {data.mediaUrl && data.kind === 'video' && (isLocalVideo
      ? <video src={data.mediaUrl} playsInline controls className="nodrag nowheel" />
      : <><img src={data.mediaUrl} alt="视频预览封面" draggable={false} /><div className="big-play"><Play size={17} fill="currentColor" /></div></>)}
    {!data.mediaUrl && <div className="empty-media">
      {data.kind === 'image' ? <ImageIcon size={26} strokeWidth={1.35}/> : <Clapperboard size={27} strokeWidth={1.35}/>}
      <span>{data.kind === 'image' ? '添加图片或生成新图片' : '从文字或参考素材生成视频'}</span>
      <button className="upload-action nodrag" onClick={() => input.current?.click()}><Plus size={13}/> 上传素材</button>
    </div>}
    {data.mediaUrl && <button title="替换素材" className="frame-upload nodrag" onClick={() => input.current?.click()}>↑ 上传</button>}
    {data.demo && <span className="demo-pill">演示素材</span>}
    <input ref={input} type="file" hidden accept={data.kind === 'image' ? 'image/*' : 'video/*'} onChange={e => {
      const f = e.currentTarget.files?.[0];
      if (f) void api.uploadFor(id, f);
      e.currentTarget.value = '';
    }}/>
  </div>;
}

function SoundPreview({ data, id }: { data: StudioNodeData; id: string }) {
  const api = useActions();
  const input = useRef<HTMLInputElement>(null);
  return <div className="sound-preview">
    <div className="sound-symbol"><AudioLines size={21}/></div>
    <div className="sound-content">
      <div className="waveform">
        {Array.from({length: 44}).map((_, i) => <i key={i} style={{height: (7 + (Math.sin(i*2.7)+1)*10 + Math.abs(Math.cos(i*.91))*16) + 'px'}}/>)}
      </div>
      {data.mediaUrl ? <audio src={data.mediaUrl} controls className="nodrag nowheel"/> :
        <button className="sound-upload nodrag" onClick={() => input.current?.click()}>上传音频文件 <ArrowUp size={13}/></button>}
    </div>
    <input ref={input} type="file" hidden accept="audio/*" onChange={e => {
      const f = e.currentTarget.files?.[0]; if (f) void api.uploadFor(id, f); e.currentTarget.value = '';
    }}/>
  </div>;
}

export function StudioNodeView({ id, data, selected }: NodeProps<StudioNode>) {
  const api = useActions();
  const kind = data.kind;
  const Icon = KIND_ICON[kind];
  const [expandPrompt, setExpandPrompt] = useState(false);
  const blockControlPointer = (e: React.MouseEvent | React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button,input,textarea,select,a')) e.stopPropagation();
  };
  return <div className={'studio-node kind-' + kind + (selected ? ' node-selected' : '') + (data.bypass ? ' node-bypassed' : '')}
    onPointerDown={blockControlPointer} onMouseDown={blockControlPointer}>
    <Handle type="target" position={Position.Left} id="in" className="studio-handle handle-in" />
    <NodeToolbar isVisible={selected} position={Position.Top} offset={11}>
      <NodeActions id={id} kind={kind}/>
    </NodeToolbar>
    <div className="node-title-row">
      <span className="node-kind-icon"><Icon size={14} strokeWidth={1.7}/></span>
      <span className="node-title-text">{data.title || kindEnglish[kind]}</span>
      {data.bypass && <span className="node-bypass-label">已跳过</span>}
      {data.status === 'done' && <Check size={13} color="#8dcca9"/>}
      <button className="node-subtle-button nodrag" onClick={() => api.inspect(id)} title="详细设置"><Ellipsis size={16}/></button>
    </div>
    {kind === 'text' ? <textarea
      className="text-node-input nodrag nowheel"
      spellCheck={false}
      placeholder="输入灵感、脚本、分镜或提示词…"
      value={data.text ?? ''}
      onChange={e => api.update(id, {text: e.currentTarget.value})}
      rows={9}
    /> : <>
      {kind === 'audio' ? <SoundPreview data={data} id={id} /> : <Preview data={data} id={id} />}
      <div className="node-prompt-body">
        {kind !== 'audio' && <div className="reference-row"><span>✧</span> 提示词 <span className="reference-hint">@ 引用连接的节点</span></div>}
        <textarea
          className={'prompt-input nodrag nowheel' + (expandPrompt ? ' prompt-expanded' : '')}
          spellCheck={false}
          placeholder={kind === 'audio' ? '描述想要的声音、音乐或旁白…' : kind === 'image' ? '描述你想生成的画面…' : '描述场景、人物动作及运镜…'}
          rows={3}
          value={data.prompt}
          onChange={e => api.update(id, {prompt: e.currentTarget.value})}
          onFocus={() => setExpandPrompt(true)}
        />
      </div>
      <div className="node-footer">
        <button className="node-select nodrag" onClick={() => {
          const values = models[kind]; const current = values.indexOf(data.model || '');
          api.update(id, {model: values[(current + 1) % values.length]});
        }}>{data.model || models[kind][0]} <ChevronDown size={12}/></button>
        {kind !== 'audio' && <button className="node-spec nodrag" title="切换画幅" onClick={() => {
          const values = ['16:9', '9:16', '1:1', '3:4', '4:3'];
          api.update(id, { ratio: values[(values.indexOf(data.ratio || '16:9') + 1) % values.length] });
        }}>{data.ratio || '16:9'}</button>}
        <span className="node-spec muted-spec">{kind === 'video' ? data.duration || '5s' : kind === 'image' ? data.resolution || '2K' : 'HQ'}</span>
        <button className="node-generate nodrag" title="生成演示结果" onClick={() => void api.generate(id)}><ArrowUp size={16}/></button>
      </div>
    </>}
    {(data.status === 'queued' || data.status === 'running') && <div className="node-progress"><div style={{width:(data.progress || 0) + '%'}}/><span>{data.status === 'queued' ? '等待运行' : '模拟生成 ' + (data.progress || 0) + '%'}</span></div>}
    {data.status === 'error' && <div className="node-error">任务失败，请重试</div>}
    <Handle type="source" position={Position.Right} id="out" className="studio-handle handle-out" />
    <button className="node-plus nodrag" title="从此节点继续创作" onClick={() => api.addAfter(id, kind === 'text' ? 'image' : kind === 'image' ? 'video' : 'image')}><Plus size={14}/></button>
  </div>;
}
