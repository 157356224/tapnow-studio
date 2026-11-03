import {useEffect,useLayoutEffect,useRef,useState} from 'react';

type Props={
  value:string;
  onChange:(next:string)=>void;
  className:string;
  placeholder:string;
  label:string;
  rows?:number;
};

// Keep in-progress Chinese/Japanese/Korean IME composition in the DOM.
// Writing the unfinished phonetic text to the ReactFlow node state would
// re-render the parent canvas and cancel the native candidate window.
export function ComposingTextarea({value,onChange,className,placeholder,label,rows=3}:Props){
  const [draft,setDraft]=useState(value);
  const textareaRef=useRef<HTMLTextAreaElement>(null);
  const composing=useRef(false);
  const focused=useRef(false);
  useLayoutEffect(()=>{
    const textarea=textareaRef.current;
    if(!textarea)return;
    const resize=()=>{
      // Start compact; expand as soon as the user enters a prompt, then grow
      // with wrapped lines until about half the viewport is occupied.
      const maxHeight=Math.min(420,Math.max(120,window.innerHeight*.48));
      const minHeight=Math.min(maxHeight,draft.trim()?160:72);
      textarea.style.height='auto';
      const needed=Math.max(minHeight,textarea.scrollHeight);
      textarea.style.height=Math.min(needed,maxHeight)+'px';
      textarea.style.overflowY=needed>maxHeight?'auto':'hidden';
    };
    resize();
    window.addEventListener('resize',resize);
    return ()=>window.removeEventListener('resize',resize);
  },[draft]);
  useEffect(()=>{
    if(!focused.current&&!composing.current)setDraft(value);
  },[value]);
  return <textarea ref={textareaRef}
    className={className+(draft.trim()?' tn-prompt-has-content':'')} aria-label={label}
    placeholder={placeholder} rows={rows} value={draft}
    onFocus={()=>{focused.current=true;}}
    onBlur={e=>{
      focused.current=false;
      if(!composing.current)onChange(e.currentTarget.value);
    }}
    onCompositionStart={()=>{composing.current=true;}}
    onCompositionEnd={e=>{
      composing.current=false;
      setDraft(e.currentTarget.value);
      onChange(e.currentTarget.value);
    }}
    onChange={e=>{
      setDraft(e.currentTarget.value);
      if(!composing.current)onChange(e.currentTarget.value);
    }}
  />;
}
