import { useState } from 'react';
import { Activity, Check, CircleHelp, Copy, LogIn, Plus, Shield, Trash2, X } from 'lucide-react';
import type { DoubaoAccount } from './doubao';
import {AccountServiceTabs} from './AccountServiceTabs';

type Props={
  accounts:DoubaoAccount[];
  refresh:()=>Promise<void>;
  onClose:()=>void;
  onSwitch:(provider:'doubao'|'muse')=>void;
};

async function api(route:string,init:RequestInit){
  const res=await fetch(route,init);
  const body=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(body.error||'操作失败');
  return body;
}

export function AccountsPanel({accounts,refresh,onClose,onSwitch}:Props){
  type Entry={time:string;host:string;route:string;method:string;status:number};
  const [name,setName]=useState('');
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const [trace,setTrace]=useState<{accountId:string;records:Entry[]}|null>(null);
  const [browserStates,setBrowserStates]=useState<Record<string,
    {browserOpen:boolean;loginRequired:boolean|null;nativeBrowserOpen?:boolean}>>({});
  const inspect=async(id:string)=>{
    setError('');
    try{
      const result=await api('/api/doubao/accounts/'+id+'/trace',{method:'GET'});
      setTrace(result);
    }catch(e){setError((e as Error).message);}
  };
  const submit=async()=>{
    if(!name.trim()){setError('请输入账号备注');return;}
    setBusy(true);setError('');setMessage('');
    try{
      const account=await api('/api/doubao/accounts',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name:name.trim()})
      });
      setName('');
      await refresh();
      setMessage('独立账号已创建。正在打开原生 Edge，请在浏览器中自行登录…');
      try{
        const opened=await api('/api/doubao/accounts/'+account.id+'/native-login',{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({browserEngine:'edge'})
        });
        setBrowserStates(states=>({...states,[account.id]:{
          browserOpen:false,loginRequired:null,nativeBrowserOpen:true
        }}));
        setMessage(opened.message);
      }catch(e){
        setError('账号已创建，但打开浏览器失败：'+(e as Error).message);
      }
    }catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  };
  const openNative=async(id:string)=>{
    setBusy(true);setError('');setMessage('');
    try{
      const result=await api('/api/doubao/accounts/'+id+'/native-login',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({browserEngine:'edge'})
      });
      await refresh();
      setBrowserStates(states=>({...states,[id]:{
        browserOpen:false,loginRequired:null,nativeBrowserOpen:true
      }}));
      setMessage(result.message);
    }catch(e){setError('打开原生浏览器失败：'+(e as Error).message);}
    finally{setBusy(false);}
  };
  const del=async(id:string)=>{
    if(!confirm('确认删除这个账号及其独立 Edge 浏览器资料吗？这会删除本机保存的登录状态。'))return;
    setBusy(true);setError('');
    try{
      await api('/api/doubao/accounts/'+id,{method:'DELETE'});
      await refresh();
      setMessage('该账号数据和 Edge 配置已删除');
      setBrowserStates(states=>{
        const next={...states};delete next[id];return next;
      });
      if(trace?.accountId===id)setTrace(null);
    }catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  };
  return <>
    <div className="panel-topline"><Shield size={17}/><strong>豆包账号与浏览器</strong>
      <button title="关闭" onClick={onClose}><X size={18}/></button>
    </div>
    <AccountServiceTabs active="doubao" onSwitch={onSwitch}/>
    <div className="doubao-settings-body">
      <div className="doubao-settings-heading">
        <h3>多账号浏览器隔离</h3>
        <p>每个账号使用独立的系统 Edge 浏览器资料。点击登录后，请自行扫码或输入手机号；不再导入或同步其他浏览器的 Cookie。</p>
      </div>
      <div className="doubao-account-list">
        {accounts.map(account=><div className="doubao-account-entry" key={account.id}>
          <div className="doubao-account-card">
          <div className="doubao-account-icon"><Shield size={17}/></div>
          <div className="doubao-account-details"><strong>{account.name}</strong>
            <small><Check size={12}/>
              {browserStates[account.id]?.nativeBrowserOpen
                ?'独立 Edge 已打开 · 登录后关闭窗口'
                :'独立浏览器 · 登录状态以豆包页面为准'}
            </small></div>
          <button className="doubao-login-button" disabled={busy}
            title="在独立原生 Edge 中手动登录豆包" onClick={()=>void openNative(account.id)}>
            <LogIn size={15}/> 登录</button>
          <button disabled={busy} title="查看该账号的接口记录" onClick={()=>void inspect(account.id)}>
            <Activity size={16}/></button>
          <button disabled={busy} title="删除账号及浏览器数据" onClick={()=>void del(account.id)}>
            <Trash2 size={15}/></button>
          </div>
        </div>)}
        {!accounts.length&&<p className="doubao-empty-accounts">还没有账号。填写备注后点击“创建账号并打开浏览器登录”，在独立 Edge 中自行完成豆包登录。</p>}
      </div>
      {trace&&<div className="doubao-trace">
        <div className="doubao-trace-title">
          <strong>XHR / Fetch 接口记录（仅元数据）</strong>
          <button title="复制脱敏接口列表" onClick={()=>void navigator.clipboard.writeText(JSON.stringify(trace.records,null,2))}>
            <Copy size={14}/> 复制</button>
          <button title="关闭接口记录" onClick={()=>setTrace(null)}><X size={14}/></button>
        </div>
        {trace.records.length?trace.records.slice(-50).reverse().map((item,index)=>
          <div className="doubao-trace-row" key={item.time+'-'+index}>
            <span>{item.method}</span>
            <code>{item.host}{item.route}</code>
            <small>{item.status}</small>
          </div>):
          <p>暂未捕获 XHR / Fetch 接口。先打开对应账号的 Edge 浏览器，在豆包页面操作后点击“查看接口记录”刷新。不会采集 Cookie、请求正文或授权头。</p>}
      </div>}
      <div className="doubao-form">
        <h4><Plus size={16}/> 新建独立豆包浏览器账号</h4>
        <label>账号备注<input aria-label="豆包账号备注" value={name} maxLength={60}
          onChange={e=>setName(e.target.value)} placeholder="例如：豆包账号 01"/></label>
        <button className="doubao-create-account" disabled={busy||!name.trim()} onClick={()=>void submit()}>
          <LogIn size={15}/> 创建账号并打开浏览器登录
        </button>
        <p className="doubao-note"><CircleHelp size={14}/> 仅使用本机 Microsoft Edge。各账号的登录状态由其独立浏览器资料目录保存。登录完成请关闭该窗口，画布生成时会复用相同资料。</p>
      </div>
      {!!error&&<div className="doubao-account-error">{error}</div>}
      {!!message&&<div className="doubao-account-message">{message}</div>}
    </div>
  </>;
}
