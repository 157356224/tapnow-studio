import {useEffect,useState} from 'react';
import {Check,CircleHelp,LogIn,Plus,Shield,Trash2,X} from 'lucide-react';
import {AccountServiceTabs} from './AccountServiceTabs';
import type {ChatGPTAccount} from './chatgpt';

type Props={
  accounts:ChatGPTAccount[];
  refresh:()=>Promise<void>;
  onClose:()=>void;
  onSwitch:(provider:'doubao'|'muse'|'chatgpt')=>void;
};
async function request<T>(url:string,init?:RequestInit):Promise<T>{
  const res=await fetch(url,init);
  const body=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(body.error||'ChatGPT 账号操作失败');
  return body as T;
}
const json=(value:unknown):RequestInit=>({
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify(value)
});

export function ChatGPTPanel({accounts,refresh,onClose,onSwitch}:Props){
  const [name,setName]=useState('');
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  useEffect(()=>{
    const timer=setInterval(()=>void refresh(),5000);
    return ()=>clearInterval(timer);
  },[refresh]);

  const open=async(id:string)=>{
    setBusy(true);setError('');setMessage('');
    try{
      const result=await request<{message:string}>(
        '/api/chatgpt/accounts/'+id+'/native-login',json({browserEngine:'edge'}));
      setMessage(result.message);
      await refresh();
    }catch(err){setError((err as Error).message);}
    finally{setBusy(false);}
  };
  const create=async()=>{
    if(!name.trim())return;
    setBusy(true);setError('');setMessage('');
    try{
      const account=await request<ChatGPTAccount>('/api/chatgpt/accounts',
        json({name:name.trim()}));
      setName('');
      await refresh();
      setBusy(false);
      await open(account.id);
    }catch(err){setError((err as Error).message);}
    finally{setBusy(false);}
  };
  const remove=async(id:string)=>{
    if(!confirm('确定删除该 ChatGPT 账号及其独立 Edge 登录资料吗？'))return;
    setBusy(true);setError('');setMessage('');
    try{
      await request('/api/chatgpt/accounts/'+id,{method:'DELETE'});
      await refresh();
      setMessage('ChatGPT 独立账号及其 Edge 资料已删除');
    }catch(err){setError((err as Error).message);}
    finally{setBusy(false);}
  };

  return <>
    <div className="panel-topline">
      <Shield size={17}/><strong>ChatGPT 账号与浏览器</strong>
      <button title="关闭" onClick={onClose}><X size={18}/></button>
    </div>
    <AccountServiceTabs active="chatgpt" onSwitch={onSwitch}/>
    <div className="doubao-settings-body">
      <div className="doubao-settings-heading">
        <h3>ChatGPT 独立 Edge 浏览器</h3>
        <p>每个 ChatGPT 账号有独立的 Edge 登录资料，不与豆包、Muse 共用。
          添加账号后打开浏览器手动登录，完成后关闭登录窗口，再回画布生图。</p>
      </div>
      <div className="doubao-account-list">
        {accounts.map(account=><div className="doubao-account-entry" key={account.id}>
          <div className="doubao-account-card">
            <div className="doubao-account-icon"><Shield size={17}/></div>
            <div className="doubao-account-details">
              <strong>{account.name}</strong>
              <small><Check size={12}/>
                {account.nativeBrowserOpen
                  ?'独立 Edge 已打开 · 登录后请关闭'
                  :'独立 Edge 登录资料 · 登录状态以网页为准'}
              </small>
            </div>
            <button className="doubao-login-button" disabled={busy}
              title="在该账号的独立 Edge 中登录 ChatGPT"
              onClick={()=>void open(account.id)}>
              <LogIn size={15}/> 登录
            </button>
            <button disabled={busy} title="删除 ChatGPT 账号及浏览器资料"
              onClick={()=>void remove(account.id)}><Trash2 size={15}/></button>
          </div>
        </div>)}
        {!accounts.length&&<p className="doubao-empty-accounts">
          暂无 ChatGPT 账号。填写备注后点击“创建并打开 Edge 登录”，
          在浏览器中手动完成登录。
        </p>}
      </div>
      <div className="doubao-form">
        <h4><Plus size={16}/> 新建独立 ChatGPT 浏览器账号</h4>
        <label>账号备注
          <input aria-label="ChatGPT 账号备注" maxLength={60}
            placeholder="例如：ChatGPT 账号 01" value={name}
            onChange={e=>setName(e.target.value)}/>
        </label>
        <button className="doubao-create-account"
          disabled={busy||!name.trim()} onClick={()=>void create()}>
          <LogIn size={15}/> 创建账号并打开浏览器登录
        </button>
        <p className="doubao-note"><CircleHelp size={14}/>
          使用系统 Microsoft Edge；每个账号保存独立登录资料，
          不导入 HAR Cookie 或 Token。登录后关闭该窗口，
          图片节点可选择账号进行生成。
        </p>
      </div>
      {!!error&&<div className="doubao-account-error" role="alert">{error}</div>}
      {!!message&&<div className="doubao-account-message" role="status">{message}</div>}
    </div>
  </>;
}
