import {useCallback,useEffect,useState} from 'react';
import {ExternalLink,RefreshCcw,X} from 'lucide-react';

type Status={
  profileCreated:boolean;loginWindowOpen:boolean;
  browserOpen:boolean;jobsRunning:number
};
export function ChatGPTPanel({onClose}:{onClose:()=>void}){
  const [status,setStatus]=useState<Status|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const refresh=useCallback(async()=>{
    try{
      const response=await fetch('/api/chatgpt/account');
      const body=await response.json();
      if(!response.ok)throw new Error(body.error||'读取状态失败');
      setStatus(body);
    }catch(err){setMessage(String((err as Error).message));}
  },[]);
  useEffect(()=>{
    void refresh();
    const timer=setInterval(()=>void refresh(),6000);
    return ()=>clearInterval(timer);
  },[refresh]);
  const login=async()=>{
    setBusy(true);
    try{
      const response=await fetch('/api/chatgpt/login',{method:'POST'});
      const body=await response.json();
      if(!response.ok)throw new Error(body.error||'无法打开独立 Edge');
      setMessage(body.message);
      await refresh();
    }catch(err){setMessage(String((err as Error).message));}
    finally{setBusy(false);}
  };
  return <>
    <div className="panel-topline">
      <ExternalLink size={17}/><strong>ChatGPT 生图账号</strong>
      <button aria-label="关闭 ChatGPT 账号面板" onClick={onClose}><X size={17}/></button>
    </div>
    <div className="tn-chatgpt-panel">
      <h3>ChatGPT 网页生图</h3>
      <p>TapNow 使用独立 Microsoft Edge 浏览器资料。请手动登录自己的 ChatGPT 账号，随后关闭登录窗口，再在图片节点点击生成。</p>
      <div className="tn-chatgpt-login-state">
        {status?.loginWindowOpen?'登录浏览器已打开':
          status?.jobsRunning?'正在执行 '+status.jobsRunning+' 个任务':
          status?.profileCreated?'本地登录资料已创建（实际登录状态在运行时验证）':
          '尚未创建 ChatGPT 登录资料'}
      </div>
      <div className="tn-chatgpt-panel-actions">
        <button type="button" disabled={busy||!!status?.jobsRunning}
          onClick={()=>void login()}><ExternalLink size={14}/>
          {status?.loginWindowOpen?'打开的登录窗口':'打开 Edge 登录 ChatGPT'}
        </button>
        <button type="button" title="刷新登录状态"
          onClick={()=>void refresh()}><RefreshCcw size={14}/></button>
      </div>
      {message&&<p role="status">{message}</p>}
      <p className="tn-chatgpt-panel-note">
        登录 Cookie 仅在本机独立 Edge 资料中保存，不读取、导入或上传 HAR 登录凭据。
        生图时会读取 ChatGPT 页面真正显示的百分比并同步到画布；
        没有数字进度时只显示“生成中”，不会伪造百分比。
      </p>
    </div>
  </>;
}
