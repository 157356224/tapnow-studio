import {useEffect,useMemo,useRef,useState} from 'react';
import type {CompositionEvent,KeyboardEvent} from 'react';
import {createPortal} from 'react-dom';
import {Image as ImageIcon,AudioLines,Plus,Search,ChevronLeft,ChevronRight} from 'lucide-react';
import {reorderReferenceNodes} from './doubao';
import type {ReferenceNode} from './doubao';

type Props={
  prompt:string;
  references:ReferenceNode[];
  explicitIds:string[];
  onPrompt:(text:string)=>void;
  onReference:(id:string)=>void;
  onRemove:(id:string)=>void;
  onReorder:(id:string,direction:-1|1,currentPrompt:string)=>void;
};

function editorText(node:Node):string{
  if(node instanceof HTMLElement&&node.dataset.token)return node.dataset.token;
  if(node.nodeType===Node.TEXT_NODE)return node.textContent||'';
  if(node.nodeName==='BR')return '\n';
  return [...node.childNodes].map(editorText).join('')+
    (node.nodeName==='DIV'?'\n':'');
}

function makeMediaChip(ref:ReferenceNode){
  const chip=document.createElement('span');
  chip.className='tn-inline-ref';
  chip.contentEditable='false';
  chip.dataset.token=ref.token;
  chip.dataset.refId=ref.id;
  chip.title=ref.title+'（'+ref.token+'，点击移除）';
  const icon=document.createElement('span');
  icon.className='tn-inline-ref-icon';
  const img=ref.kind==='image'?document.createElement('img'):null;
  if(img){if(ref.url)img.src=ref.url;img.alt='';img.draggable=false;}
  const remove=document.createElement('span');
  remove.className='tn-inline-ref-x';
  remove.textContent='×';
  remove.setAttribute('aria-hidden','true');
  if(img)icon.append(img);
  else{const mark=document.createElement('span');mark.className='tn-ref-audio-mark';mark.textContent='♪';icon.append(mark);}
  icon.append(remove);
  const title=document.createElement('span');
  title.className='tn-inline-ref-title';
  title.textContent=ref.title||ref.token;
  chip.append(icon,title);
  return chip;
}

function renderReferences(editor:HTMLDivElement,prompt:string,refs:ReferenceNode[]){
  const tokenMap=new Map(refs.map(r=>[r.token,r]));
  const parts=prompt.split(/(@(?:图片|音频)\d+)/g);
  editor.replaceChildren(...parts.map(part=>{
    const ref=tokenMap.get(part);
    return ref?makeMediaChip(ref):document.createTextNode(part);
  }));
}

function selectionInside(editor:HTMLElement){
  const selected=window.getSelection();
  return selected&&selected.rangeCount&&editor.contains(selected.anchorNode);
}

type HoveredReference={
  id:string;
  source:'attachment'|'inline';
  left:number;
  bottom:number;
};

function previewPosition(element:HTMLElement){
  const rect=element.getBoundingClientRect();
  const previewWidth=82;
  return {
    left:Math.min(Math.max(8,rect.left+rect.width/2-previewWidth/2),
      Math.max(8,window.innerWidth-previewWidth-8)),
    bottom:window.innerHeight-rect.top+8
  };
}

export function VideoPromptEditor({
  prompt,references,explicitIds,onPrompt,onReference,onRemove,onReorder
}:Props){
  const editor=useRef<HTMLDivElement>(null);
  const richPrompt=useRef<HTMLDivElement>(null);
  const galleryRef=useRef<HTMLDivElement>(null);
  const composing=useRef(false);
  const latestPrompt=useRef(prompt);
  const renderedReferenceMap=useRef('');
  const [picker,setPicker]=useState(false);
  const [search,setSearch]=useState('');
  const [hovered,setHovered]=useState<HoveredReference|null>(null);
  const [focused,setFocused]=useState(false);
  const [hasContent,setHasContent]=useState(Boolean(prompt.trim()));
  // The attachment tray previews every connected image immediately. Only
  // images mentioned in prompt are uploaded by the backend.
  const selected=useMemo(()=>references.filter(r=>r.connected),[references,explicitIds]);
  const used=useMemo(()=>new Set(prompt.match(/@(图片|音频)\d+/g)||[]),[prompt]);
  const filtered=useMemo(()=>references.filter(r=>
    (r.title+' '+r.token+' '+(references.indexOf(r)+1)).toLowerCase()
      .includes(search.trim().toLowerCase())),[references,search]);
  const hoverReference=(id:string,source:HoveredReference['source'],element:HTMLElement)=>{
    const position=previewPosition(element);
    setHovered(previous=>previous?.id===id&&previous.source===source&&
      Math.abs(previous.left-position.left)<1&&Math.abs(previous.bottom-position.bottom)<1
      ? previous : {id,source,...position});
  };
  useEffect(()=>{
    if(references.length)return;
    setPicker(false);
    setHovered(null);
  },[references.length]);
  useEffect(()=>{
    if(!picker)return;
    const dismiss=(event:PointerEvent)=>{
      if(richPrompt.current?.contains(event.target as Node))return;
      setPicker(false);
      setSearch('');
    };
    document.addEventListener('pointerdown',dismiss,true);
    return ()=>document.removeEventListener('pointerdown',dismiss,true);
  },[picker]);

  useEffect(()=>{
    const el=editor.current;
    const mapping=references.map(ref=>ref.id+':'+ref.token+':'+ref.url+':'+ref.title).join('|');
    const orderChanged=mapping!==renderedReferenceMap.current;
    if(!el||composing.current||(document.activeElement===el&&!orderChanged))return;
    const now=editorText(el).replace(/\n$/,'');
    if(orderChanged||now!==prompt||el.querySelectorAll('.tn-inline-ref').length!==
      (prompt.match(/@(图片|音频)\d+/g)||[]).filter(token=>references.some(r=>r.token===token)).length){
      renderReferences(el,prompt,references);
    }
    setHasContent(Boolean(editorText(el).trim()));
    latestPrompt.current=prompt;
    renderedReferenceMap.current=mapping;
  },[prompt,references]);

  const commit=()=>{
    if(!editor.current)return;
    const text=editorText(editor.current).replace(/\n$/,'');
    latestPrompt.current=text;
    setHasContent(Boolean(text.trim()));
    onPrompt(text);
    // The gallery is a deliberate action: clicking + or typing an @ key.
    // Ordinary editing (including IME commits) must never open it.
    if(!composing.current)setPicker(previous=>previous&&references.length>0&&/@[^@\s]*$/.test(text));
  };
  const handleCompositionEnd=(_e:CompositionEvent<HTMLDivElement>)=>{
    composing.current=false;
    commit();
  };
  const insert=(ref:ReferenceNode)=>{
    const el=editor.current;
    if(!el)return;
    el.focus();
    const sel=window.getSelection();
    let range=sel?.rangeCount&&selectionInside(el)?sel.getRangeAt(0):null;
    if(!range){
      range=document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    // Replace the @ query at the caret, not the user's surrounding prose.
    if(range.startContainer.nodeType===Node.TEXT_NODE){
      const text=range.startContainer.textContent||'';
      const before=text.slice(0,range.startOffset);
      const match=before.match(/@[^@\s]*$/);
      if(match)range.setStart(range.startContainer,range.startOffset-match[0].length);
    }
    range.deleteContents();
    const chip=makeMediaChip(ref);
    range.insertNode(chip);
    range.setStartAfter(chip);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    onReference(ref.id);
    commit();
    setPicker(false);
    setSearch('');
  };
  const onKeyDown=(e:KeyboardEvent<HTMLDivElement>)=>{
    if(e.key==='Escape'){setPicker(false);setSearch('');return;}
    if(e.nativeEvent.isComposing||composing.current||e.key==='Process'||e.keyCode===229)return;
    if(e.key==='@'&&references.length){setSearch('');setPicker(true);}
    if(e.key==='Enter'&&picker&&references.length){
      e.preventDefault();insert(references[0]);
    }
  };
  const moveReference=(id:string,direction:-1|1)=>{
    const currentPrompt=editor.current
      ?editorText(editor.current).replace(/\n$/,''):latestPrompt.current;
    const next=reorderReferenceNodes(currentPrompt,references,id,direction);
    if(next.order.every((source,index)=>references[index]?.id===source))return;
    const byId=new Map(references.map(ref=>[ref.id,ref]));
    const counters={image:0,audio:0};
    const nextRefs=next.order.map(source=>{
      const ref=byId.get(source)!;
      return {...ref,token:'@'+(ref.kind==='audio'?'音频':'图片')+(++counters[ref.kind])};
    });
    // Update the contenteditable chips immediately. The editor can retain
    // focus while moving a thumbnail, in which case its normal effect skips
    // external prop synchronization to protect a currently typed sentence.
    if(editor.current){
      renderReferences(editor.current,next.prompt,nextRefs);
      latestPrompt.current=next.prompt;
      renderedReferenceMap.current=nextRefs
        .map(ref=>ref.id+':'+ref.token+':'+ref.url+':'+ref.title).join('|');
    }
    onReorder(id,direction,currentPrompt);
  };
  return <div className="tn-rich-prompt" ref={richPrompt}>
    <div className="tn-ref-attachments">
      {selected.map((ref,index)=><div className={'tn-ref-attachment'+
        (used.has(ref.token)?' tn-ref-cited':' tn-ref-available')}
        key={ref.id} data-ref-id={ref.id} data-token={ref.token}
        title={ref.token+'：'+ref.title+(used.has(ref.token)?'（已引用）':'（仅连接，未引用）')}
        onMouseEnter={e=>hoverReference(ref.id,'attachment',e.currentTarget)}
        onMouseLeave={()=>setHovered(previous=>previous?.id===ref.id&&previous.source==='attachment'?null:previous)}>
        <button type="button" className="tn-ref-thumbnail" disabled={!ref.url}
          title={ref.url?'在提示词插入 '+ref.title:'该节点尚未上传素材'}
          aria-label={'引用'+ref.token} onMouseDown={e=>e.preventDefault()}
          onClick={()=>insert(ref)}>
          {ref.kind==='audio'?<AudioLines size={17}/>:ref.url?
            <img src={ref.url} alt={ref.title} draggable={false}/>:<ImageIcon size={17}/>}
        </button>
        <span className="tn-ref-attachment-label">{index+1}</span>
        <span className="tn-ref-move-controls">
          <button type="button" disabled={!selected.slice(0,index).some(other=>other.kind===ref.kind)}
            aria-label={'将'+ref.token+'前移'} title={'将'+ref.token+'前移'}
            onMouseDown={e=>e.preventDefault()}
            onClick={()=>moveReference(ref.id,-1)}>
            <ChevronLeft size={12}/></button>
          <button type="button" disabled={!selected.slice(index+1).some(other=>other.kind===ref.kind)}
            aria-label={'将'+ref.token+'后移'} title={'将'+ref.token+'后移'}
            onMouseDown={e=>e.preventDefault()}
            onClick={()=>moveReference(ref.id,1)}>
            <ChevronRight size={12}/></button>
        </span>
      </div>)}
      <button className="tn-ref-attach-add" title="添加已连接的参考素材"
        disabled={!references.length}
        aria-label={references.length?'添加已连接素材引用':'请先连接图片或音频节点'}
        onClick={()=>{setSearch('');setPicker(p=>references.length>0&&!p);}}>
        <Plus size={19} strokeWidth={1.6}/>
      </button>
      {!!selected.length&&<span className="tn-ref-attachment-count">
        已连接{selected.length}{selected.some(ref=>ref.kind==='audio')?'项':'张'} · 已引用{selected.filter(ref=>used.has(ref.token)).length}{selected.some(ref=>ref.kind==='audio')?'项':'张'}
      </span>}
      {picker&&<div className="tn-ref-gallery" ref={galleryRef}>
        <label className="tn-ref-gallery-search"><Search size={14} strokeWidth={1.7}/>
          <input aria-label="搜索已连接素材" placeholder="搜索" value={search}
            onMouseDown={e=>e.stopPropagation()}
            onChange={e=>setSearch(e.currentTarget.value)}
            onKeyDown={e=>{
              e.stopPropagation();
              if(e.key==='Escape'){e.preventDefault();setPicker(false);}
              else if(e.key==='Enter'&&filtered.length){e.preventDefault();insert(filtered[0]);}
              else if(/^[1-9]$/.test(e.key)&&!search){
                const ref=references[Number(e.key)-1];
                if(ref){e.preventDefault();insert(ref);}
              }
            }}/>
        </label>
        <div className="tn-ref-gallery-heading">
          <span>已连接节点</span><span>输入序号快选</span>
        </div>
        {filtered.length?filtered.map(ref=><button key={ref.id}
          onMouseDown={e=>e.preventDefault()} onClick={()=>insert(ref)}
          className="tn-ref-gallery-item">
          {ref.kind==='audio'?<AudioLines size={18}/>:ref.url?<img src={ref.url} alt="" draggable={false}/>:<ImageIcon size={18}/>}
          <span>{ref.title||ref.token}</span>
          <small>{ref.token}</small>{ref.kind==='audio'?<AudioLines size={13} className="tn-ref-gallery-kind"/>:<ImageIcon size={13} className="tn-ref-gallery-kind"/>}
        </button>):<p>{references.length?'没有匹配的素材':'请先连接图片或音频节点。'}</p>}
      </div>}
    </div>
    <div className={'tn-compose-prompt tn-compose-editor nodrag nowheel'+
      (hasContent?' tn-prompt-has-content':'')+(focused?' tn-editing':'')}
      aria-label="节点生成提示词" role="textbox" aria-multiline="true"
      data-placeholder="描述任何你想要生成的内容"
      contentEditable suppressContentEditableWarning
      ref={editor}
      onFocus={()=>setFocused(true)}
      onBlur={e=>{
        setFocused(false);
        if(galleryRef.current?.contains(e.relatedTarget as Node))return;
        setPicker(false);
        commit();
      }}
      onCompositionStart={()=>{composing.current=true;}}
      onCompositionEnd={handleCompositionEnd}
      onInput={()=>{if(!composing.current)commit();}}
      onKeyDown={onKeyDown}
      onMouseDown={e=>{
        if((e.target as HTMLElement).closest('.tn-inline-ref'))e.preventDefault();
      }}
      onClick={e=>{
        const chip=(e.target as HTMLElement).closest<HTMLElement>('.tn-inline-ref');
        if(!chip)return;
        chip.remove();
        setHovered(null);
        commit();
      }}
      onMouseOver={e=>{
        const chip=(e.target as HTMLElement).closest<HTMLElement>('.tn-inline-ref');
        const refId=chip?.dataset.refId;
        if(refId&&chip)hoverReference(refId,'inline',chip);
      }}
      onMouseOut={e=>{
        const chip=(e.target as HTMLElement).closest('.tn-inline-ref');
        if(chip&&e.relatedTarget instanceof Node&&chip.contains(e.relatedTarget))return;
        if(chip)setHovered(previous=>previous?.source==='inline'?null:previous);
      }}
    />
    {hovered&&references.some(ref=>ref.id===hovered.id)&&createPortal(
      <div className={'tn-ref-floating-preview '+(hovered.source==='inline'?'tn-ref-editor-preview':'tn-ref-hover-preview')}
        aria-hidden="true" style={{position:'fixed',left:hovered.left,bottom:hovered.bottom,
          width:82,zIndex:99999,pointerEvents:'none'}}>
        {references.find(ref=>ref.id===hovered.id)!.kind==='audio'?<AudioLines size={36}/>:<img src={references.find(ref=>ref.id===hovered.id)!.url} alt=""/>}
        {hovered.source==='attachment'&&<span className="tn-ref-preview-caption">{references.find(ref=>ref.id===hovered.id)!.title}</span>}
      </div>,document.body)}
  </div>;
}
