import {useCallback,useEffect,useState} from 'react';
import {Check,KeyRound,RefreshCcw,Trash2,X} from 'lucide-react';

type Config={configured:boolean;masked:string};
const base='/api/h3';
async function api<T>(path:string,init?:RequestInit):Promise<T>{
  const response=await fetch(base+path,init);
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error((body as {error?:string}).error||'元铂AI API 请求失败');
  return body as T;
}
export function H3SettingsPanel({onClose}:{onClose:()=>void}){
  const [config,setConfig]=useState<Config|null>(null);
  const [key,setKey]=useState('');
  const [status,setStatus]=useState('');
  const [loading,setLoading]=useState(false);
  const [models,setModels]=useState<unknown[]>([]);
  const refresh=useCallback(async()=>{
    try{setConfig(await api<Config>('/config'));}
    catch(error){setStatus('读取配置失败：'+(error as Error).message);}
  },[]);
  useEffect(()=>{void refresh();},[refresh]);
  const save=async()=>{
    if(!key.trim())return;
    setLoading(true);
    try{
      setConfig(await api<Config>('/config',{
        method:'PUT',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({apiKey:key})
      }));
      setKey('');
      setStatus('API Key 已安全保存到本机服务器');
    }catch(error){setStatus((error as Error).message);}
    finally{setLoading(false);}
  };
  const remove=async()=>{
    setLoading(true);
    try{
      setConfig(await api<Config>('/config',{method:'DELETE'}));
      setModels([]);
      setStatus('本机 API Key 已清除（如果配置了环境变量仍会生效）');
    }catch(error){setStatus((error as Error).message);}
    finally{setLoading(false);}
  };
  const test=async()=>{
    setLoading(true);
    try{
      const result=await api<{models:unknown[]}>('/models');
      const items=Array.isArray(result.models)?result.models:[];
      setModels(items);
      setStatus('API Key 验证通过，已读取模型列表。实际价格与可用参数以接口为准');
    }catch(error){setStatus('连接失败：'+(error as Error).message);}
    finally{setLoading(false);}
  };
  return <>
    <div className="panel-topline">
      <KeyRound size={18}/><strong>元铂AI · H3 API</strong>
      <button title="关闭" onClick={onClose}><X size={17}/></button>
    </div>
    <div className="tn-h3-settings">
      <h3>接入三个 H3 视频模型</h3>
      <p>H3 Video · H3 Video Flex · H3 Frames</p>
      <div className="tn-h3-key-status">
        {config?.configured?<><Check size={16}/> 已配置 {config.masked}</>:
          '尚未配置 API Key'}
      </div>
      <label htmlFor="tn-h3-key-input">元铂AI API Key</label>
      <input id="tn-h3-key-input" aria-label="元铂AI API Key"
        type="password" value={key} autoComplete="off"
        placeholder="sc_live_..."
        onChange={event=>setKey(event.target.value)}/>
      <div className="tn-h3-key-actions">
        <button type="button" disabled={!key.trim()||loading}
          onClick={()=>void save()}>保存密钥</button>
        <button type="button" disabled={!config?.configured||loading}
          onClick={()=>void test()}><RefreshCcw size={14}/> 检查模型</button>
        <button type="button" disabled={!config?.configured||loading}
          title="清除本地 API Key" onClick={()=>void remove()}>
          <Trash2 size={14}/>
        </button>
      </div>
      {status&&<p role="status" className="tn-h3-key-message">{status}</p>}
      {models.length>0&&<div className="tn-h3-remote-models">
        {models.filter(item=>typeof item==='object'&&item!==null&&
          ['h3-video','h3-video-flex','h3-video-frames'].includes(
            String((item as {id?:string;key?:string}).id||
              (item as {key?:string}).key))
        ).map((item,index)=>{
          const model=item as {id?:string;key?:string;name?:string};
          return <div key={index}>{model.id||model.key}{model.name?' · '+model.name:''}</div>;
        })}
      </div>}
      <p className="tn-h3-help">
        API Key 仅保存在本机 server/data 中，不写入画布文件；
        提交任务由元铂AI按所选模型计费。H3 提示词优化可能额外计费。
      </p>
    </div>
  </>;
}
