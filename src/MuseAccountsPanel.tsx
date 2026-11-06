import {useState} from 'react';
import {Check, CircleHelp, LogIn, Plus, Shield, Trash2, X} from 'lucide-react';
import type {MuseAccount} from './muse';
import {AccountServiceTabs} from './AccountServiceTabs';

type Props={
  accounts:MuseAccount[];
  refresh:()=>Promise<void>;
  onClose:()=>void;
  onSwitch:(provider:'doubao'|'muse'|'chatgpt')=>void;
};
async function request<T>(route:string,init?:RequestInit):Promise<T>{
  const res=await fetch(route,init);
  const body=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(body.error||'Muse 账号操作失败');
  return body as T;
}
const json=(body:unknown):RequestInit=>({
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
});
export function MuseAccountsPanel({accounts,refresh,onClose,onSwitch}:Props){
  const [name,setName]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const [openIds,setOpenIds]=useState<string[]>([]);
  const open=async(id:string)=>{
    setBusy(true);setError('');setMessage('');
    try{
      const result=await request<{message:string}>(
        '/api/muse/accounts/'+id+'/native-login',json({browserEngine:'edge'}));
      setOpenIds(old=>[...new Set([...old,id])]);
      setMessage(result.message);
    }catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  };
  const create=async()=>{
    if(!name.trim())return;
    setBusy(true);setError('');setMessage('');
    try{
      const created=await request<MuseAccount>('/api/muse/accounts',json({name:name.trim()}));
      setName('');await refresh();
      setBusy(false);
      await open(created.id);
    }catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  };
  const remove=async(id:string)=>{
    if(!confirm('确定删除 Muse 账号及其独立 Edge 登录资料吗？'))return;
    setBusy(true);setError('');setMessage('');
    try{
      await request('/api/muse/accounts/'+id,{method:'DELETE'});
      await refresh();
      setOpenIds(old=>old.filter(x=>x!==id));
      setMessage('Muse 独立账号已删除');
    }catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  };
  return <>
    <div className="panel-topline"><Shield size={17}/><strong>Muse 账号与浏览器</strong>
      <button title="关闭" onClick={onClose}><X size={18}/></button>
    </div>
    <AccountServiceTabs active="muse" onSwitch={onSwitch}/>
    <div className="doubao-settings-body">
      <div className="doubao-settings-heading">
        <h3>Muse 独立 Edge 浏览器</h3>
        <p>每个 Muse 账号拥有自己的浏览器目录，不与豆包共享。您自行登录，完成后关闭登录窗口。每次生成前会点击“旁聊”右侧加号创建新会话。</p>
      </div>
      <div className="doubao-account-list">
        {accounts.map(account=><div className="doubao-account-entry" key={account.id}>
          <div className="doubao-account-card">
            <div className="doubao-account-icon"><Shield size={17}/></div>
            <div className="doubao-account-details">
              <strong>{account.name}</strong>
              <small><Check size={12}/>{openIds.includes(account.id)?
                '独立 Edge 已打开，登录后请关闭':'使用独立 Edge 登录资料'}</small>
            </div>
            <button disabled={busy} className="doubao-login-button"
              title="在 Muse 独立 Edge 中手动登录" onClick={()=>void open(account.id)}>
              <LogIn size={15}/> 登录
            </button>
            <button disabled={busy} title="删除 Muse 账号" onClick={()=>void remove(account.id)}>
              <Trash2 size={15}/>
            </button>
          </div>
        </div>)}
        {!accounts.length&&<p className="doubao-empty-accounts">
          暂无 Muse 账号。请创建独立账号后在 Edge 中自行登录。
        </p>}
      </div>
      <div className="doubao-form">
        <h4><Plus size={16}/> 新建 Muse 独立账号</h4>
        <label>账号备注
          <input aria-label="Muse 账号备注" maxLength={60}
            placeholder="例如：Muse 账号 01" value={name}
            onChange={e=>setName(e.target.value)}/>
        </label>
        <button className="doubao-create-account" disabled={busy||!name.trim()}
          onClick={()=>void create()}><LogIn size={15}/> 创建并打开 Edge 登录</button>
        <p className="doubao-note"><CircleHelp size={14}/>
          登录后关闭原生 Edge 窗口，再在画布发送 Muse 生成任务。不需要输入 Cookie 或 Token。
        </p>
      </div>
      {!!error&&<div className="doubao-account-error">{error}</div>}
      {!!message&&<div className="doubao-account-message">{message}</div>}
    </div>
  </>;
}
