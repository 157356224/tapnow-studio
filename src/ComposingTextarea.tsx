import {useEffect,useRef,useState} from 'react';

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
  const composing=useRef(false);
  const focused=useRef(false);
  useEffect(()=>{
    if(!focused.current&&!composing.current)setDraft(value);
  },[value]);
  return <textarea className={className} aria-label={label}
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
