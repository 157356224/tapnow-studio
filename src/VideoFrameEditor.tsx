import {useCallback,useEffect,useRef,useState} from 'react';
import type {CSSProperties} from 'react';
import {ArrowLeft,Check,ChevronLeft,ChevronRight,LoaderCircle,Pause,Play,X} from 'lucide-react';

type Props={
  title:string;
  mediaUrl:string;
  onClose:()=>void;
  onExtract:(seconds:number)=>Promise<boolean>;
};

function clock(seconds:number){
  const ms=Math.max(0,Math.round(seconds*1000));
  const s=Math.floor(ms/1000);
  const hh=Math.floor(s/3600);
  const mm=String(Math.floor(s%3600/60)).padStart(2,'0');
  const ss=String(s%60).padStart(2,'0');
  const fraction=String(ms%1000).padStart(3,'0');
  return (hh?hh+':':'')+mm+':'+ss+'.'+fraction;
}

// Preview seeks and server-side FFmpeg extraction share the same seconds
// offset; the final PNG comes from the original file, not a scaled screenshot.
export function VideoFrameEditor({title,mediaUrl,onClose,onExtract}:Props){
  const videoRef=useRef<HTMLVideoElement>(null);
  const timelineRef=useRef<HTMLInputElement>(null);
  const [duration,setDuration]=useState(0);
  const [position,setPosition]=useState(0);
  const [playing,setPlaying]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [thumbnails,setThumbnails]=useState<string[]>([]);
  const scrubRef=useRef(false);

  useEffect(()=>{
    const onKeyDown=(e:KeyboardEvent)=>{
      if(e.key==='Escape'&&!busy){e.preventDefault();onClose();}
    };
    document.addEventListener('keydown',onKeyDown);
    timelineRef.current?.focus();
    return ()=>document.removeEventListener('keydown',onKeyDown);
  },[onClose,busy]);

  useEffect(()=>{
    let cancelled=false;
    const preview=document.createElement('video');
    preview.preload='auto';
    preview.muted=true;
    preview.playsInline=true;
    preview.src=mediaUrl;
    const wait=(event:'loadedmetadata'|'seeked')=>new Promise<void>((resolve,reject)=>{
      const abort=()=>{cleanup();reject(new Error('无法生成时间轴缩略图'));};
      const ok=()=>{cleanup();resolve();};
      const cleanup=()=>{
        preview.removeEventListener(event,ok);
        preview.removeEventListener('error',abort);
      };
      preview.addEventListener(event,ok,{once:true});
      preview.addEventListener('error',abort,{once:true});
    });
    void(async()=>{
      try{
        const metadata=wait('loadedmetadata');
        preview.load();
        await metadata;
        if(!Number.isFinite(preview.duration)||preview.duration<=0)return;
        const count=8;
        const collected:string[]=[];
        for(let i=0;i<count&&!cancelled;i++){
          const time=Math.min(Math.max(0,preview.duration-.05),
            (i+.5)/count*preview.duration);
          if(Math.abs(preview.currentTime-time)<.001&&preview.readyState>=2){
            const canvas=document.createElement('canvas');
            canvas.width=148;canvas.height=84;
            canvas.getContext('2d')?.drawImage(preview,0,0,148,84);
            collected.push(canvas.toDataURL('image/jpeg',.72));
            setThumbnails([...collected]);
            continue;
          }
          const seeked=wait('seeked');
          preview.currentTime=time;
          await seeked;
          if(cancelled)break;
          const canvas=document.createElement('canvas');
          canvas.width=148;canvas.height=84;
          canvas.getContext('2d')?.drawImage(preview,0,0,canvas.width,canvas.height);
          collected.push(canvas.toDataURL('image/jpeg',.72));
          setThumbnails([...collected]);
        }
      }catch{
        // A video that cannot produce thumbnails can still be scrubbed.
      }finally{
        preview.pause();preview.removeAttribute('src');preview.load();
      }
    })();
    return ()=>{cancelled=true;preview.pause();preview.removeAttribute('src');preview.load();};
  },[mediaUrl]);

  const seek=useCallback((seconds:number)=>{
    const video=videoRef.current;
    const max=Math.max(0,duration-.001);
    const time=Math.max(0,Math.min(max,seconds));
    setPosition(time);
    if(video&&Number.isFinite(time))video.currentTime=time;
  },[duration]);

  const togglePlay=()=>{
    const video=videoRef.current;
    if(!video)return;
    if(video.paused)void video.play().catch(()=>setError('视频预览播放失败'));
    else video.pause();
  };

  const submit=async()=>{
    if(busy||!duration)return;
    videoRef.current?.pause();
    setBusy(true);setError('');
    try{
      if(await onExtract(position))onClose();
      else setError('提取失败，请检查提示后重试');
    }catch(e){
      setError((e as Error).message);
    }finally{setBusy(false);}
  };

  const percent=duration?Math.min(100,position/duration*100):0;
  return <div className="tn-frame-editor-backdrop" onPointerDown={e=>e.stopPropagation()}>
    <section className="tn-frame-editor" role="dialog" aria-modal="true"
      aria-label="视频帧编辑器">
      <header className="tn-frame-editor-header">
        <span className="tn-frame-editor-title"><strong>视频帧编辑器</strong>
          <small>{title}</small></span>
        <button type="button" title="关闭帧编辑器" aria-label="关闭帧编辑器"
          disabled={busy} onClick={onClose}><X size={20}/></button>
      </header>
      <div className="tn-frame-editor-stage">
        <video ref={videoRef} src={mediaUrl} preload="auto" playsInline
          onLoadedMetadata={event=>{
            const seconds=event.currentTarget.duration;
            if(Number.isFinite(seconds)&&seconds>0)setDuration(seconds);
            else setError('无法读取视频时长');
          }}
          onTimeUpdate={event=>{
            if(!scrubRef.current)setPosition(event.currentTarget.currentTime);
          }}
          onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)}
          onEnded={()=>setPlaying(false)}
          onError={()=>setError('无法读取视频，请检查素材文件')}
        />
      </div>
      <div className="tn-frame-editor-bottom">
        <div className="tn-frame-transport">
          <div className="tn-frame-playback">
            <button type="button" onClick={()=>seek(position-1/30)}
              aria-label="上一帧" title="上一帧（约 1/30 秒）"><ChevronLeft size={19}/></button>
            <button type="button" onClick={togglePlay}
              aria-label={playing?'暂停':'播放'} title={playing?'暂停':'播放'}>
              {playing?<Pause size={18}/>:<Play size={18}/>}
            </button>
            <button type="button" onClick={()=>seek(position+1/30)}
              aria-label="下一帧" title="下一帧（约 1/30 秒）"><ChevronRight size={19}/></button>
          </div>
          <span className="tn-frame-clock" aria-live="off">{clock(position)}
            <span> / {clock(duration)}</span>
          </span>
        </div>
        <div className="tn-frame-ruler">
          <span>00:00</span><span>{clock(duration*.25).split('.')[0]}</span>
          <span>{clock(duration*.5).split('.')[0]}</span>
          <span>{clock(duration*.75).split('.')[0]}</span><span>{clock(duration).split('.')[0]}</span>
        </div>
        <div className="tn-frame-timeline" style={{'--frame-percent':percent+'%'} as CSSProperties}>
          <div className="tn-frame-filmstrip">
            {Array.from({length:8},(_,i)=><div className="tn-frame-thumb" key={i}>
              {thumbnails[i]&&<img src={thumbnails[i]} alt="" draggable={false}/>}
            </div>)}
          </div>
          <div className="tn-frame-playhead" aria-hidden="true"><span/></div>
          <input ref={timelineRef} type="range" className="tn-frame-timeline-input"
            min={0} max={duration||1} step=".001" disabled={!duration||busy}
            value={position} aria-label="视频时间轴"
            onPointerDown={()=>{scrubRef.current=true;videoRef.current?.pause();}}
            onPointerUp={()=>{scrubRef.current=false;}}
            onPointerCancel={()=>{scrubRef.current=false;}}
            onInput={e=>seek(Number(e.currentTarget.value))}
            onKeyDown={e=>{
              if(e.key==='ArrowLeft'||e.key==='ArrowRight'){
                e.preventDefault();
                seek(position+(e.key==='ArrowRight'?1:-1)*(e.shiftKey?1:1/30));
              }
            }}/>
        </div>
        <p className="tn-frame-hint">拖动时间轴指针定位画面；← / → 微调，Shift + 方向键移动 1 秒</p>
        <footer className="tn-frame-editor-actions">
          <button type="button" className="tn-frame-cancel" onClick={onClose}
            disabled={busy}><ArrowLeft size={15}/> 取消</button>
          <div className="tn-frame-action-right">
            {error&&<span role="alert" className="tn-frame-error">{error}</span>}
            <button type="button" className="tn-frame-extract"
              disabled={!duration||busy} onClick={()=>void submit()}>
              {busy?<LoaderCircle className="tn-frame-spinner" size={16}/>:<Check size={16}/>}
              {busy?'正在提取…':'提取当前帧到画布'}
            </button>
          </div>
        </footer>
      </div>
    </section>
  </div>;
}
