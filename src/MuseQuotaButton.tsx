import {Gauge,RefreshCcw} from 'lucide-react';
import type {MuseQuotaSummary} from './muse';

type Props={
  data:MuseQuotaSummary|null;
  loading:boolean;
  error:string;
  onRefresh:()=>void;
  onManageAccounts:()=>void;
};

const number=(value:number)=>Number(value.toFixed(2)).toLocaleString('zh-CN');

export function MuseQuotaButton({data,loading,error,onRefresh,onManageAccounts}:Props){
  return <div className="muse-quota-control">
    <button className="tool-icon muse-quota-trigger" type="button"
      aria-label="查看 Muse 额度" title="查看 Muse 额度"
      onClick={onRefresh}><Gauge size={18}/></button>
    <div className="muse-quota-popover" role="tooltip" aria-label="Muse 所有账号剩余额度">
      <div className="muse-quota-title">
        <strong>Muse 账号额度</strong>
        <button type="button" className="muse-quota-refresh"
          disabled={loading} title="立即刷新全部 Muse 额度"
          onClick={onRefresh}><RefreshCcw size={13}/></button>
      </div>
      {data?<>
        <div className="muse-quota-overview">
          <span>总剩余</span>
          <strong>{number(data.totalRemaining)}%</strong>
          <small>总已使用 {number(data.totalUsed)}%</small>
        </div>
        <div className="muse-quota-meter">
          <span style={{width:data.measuredCapacity?
            (data.totalRemaining/data.measuredCapacity*100)+'%':'0%'}}/>
        </div>
        <p className="muse-quota-hint">
          {data.knownAccounts} 个账号已同步，合计 {data.measuredCapacity}% 额度
          {data.unknownAccounts>0?
            ' · '+data.unknownAccounts+' 个账号额度未知':''}
        </p>
        <div className="muse-quota-list">
          {data.rows.map(item=><div className="muse-quota-account" key={item.id}>
            <span title={item.name}>{item.name}</span>
            {item.status==='ok'
              ?<strong>{number(item.remaining!)}% 剩余
                <small>已用 {number(item.used!)}%</small></strong>
              :<strong className="muse-quota-unavailable" title={item.error||''}>
                未知 <small>{item.error||'未同步'}</small>
              </strong>}
          </div>)}
          {!data.rows.length&&<p className="muse-quota-empty">
            还没有 Muse 账号，请先在 Muse 账号设置中添加。</p>}
        </div>
        {data.unknownAccounts>0&&<p className="muse-quota-warning">
          未知账号不计入已用或剩余合计，避免虚报可用额度。
        </p>}
      </>:<p className="muse-quota-empty">
        {loading?'正在同步 Muse 账号额度…':'暂无额度数据'}</p>}
      {error&&<p className="muse-quota-warning">{error}</p>}
      <p className="muse-quota-foot">
        {loading||data?.refreshing?'正在刷新…':data?.refreshedAt?
          '上次刷新：'+new Date(data.refreshedAt).toLocaleTimeString('zh-CN'):
          '尚未完成刷新'} · 每分钟刷新
      </p>
      <button type="button" className="muse-quota-manage"
        onClick={onManageAccounts}>管理 / 添加 Muse 账号</button>
    </div>
  </div>;
}
