// Muse quota uses a Next.js Server Action, not a public REST endpoint.
// Captured request: POST https://muse.ai/ (text/plain) with Next-Action.
// No Cookie, Bearer token, router state or deployment headers are persisted.
export const MUSE_QUOTA_ACTION_ID='409b972cbb33d3e372f4ca9d3c8332677217064f62';
export const MUSE_QUOTA_REFRESH_MS=60_000;

export function parseMuseQuotaFlight(source){
  if(typeof source!=='string')throw new Error('Muse 额度响应不是文本');
  let data=null;
  for(const line of source.split(/\r?\n/)){
    const colon=line.indexOf(':');
    if(colon<0||colon>5)continue;
    const payload=line.slice(colon+1);
    if(!payload.startsWith('{'))continue;
    try{
      const candidate=JSON.parse(payload);
      if(candidate?.subscription?.usage){data=candidate;break;}
    }catch{}
  }
  if(!data){
    try{
      const candidate=JSON.parse(source);
      if(candidate?.subscription?.usage)data=candidate;
    }catch{}
  }
  if(!data?.success||!data?.subscription?.usage)
    throw new Error('Muse 额度接口没有返回 subscription.usage，可能是未登录或接口已更新');
  const usage=data.subscription.usage;
  const used=Number(usage.percentUsed);
  if(!Number.isFinite(used)||used<0||used>100)
    throw new Error('Muse 返回的 percentUsed 不在 0–100% 范围');
  return {
    percentUsed:used,
    percentRemaining:Number((100-used).toFixed(2)),
    quotaStatus:String(usage.quotaStatus||'UNKNOWN'),
    resetsAt:Number.isFinite(Number(usage.resetsAt))?Number(usage.resetsAt):null,
    tierName:String(data.subscription.tier?.name||'Muse'),
    statusSubtitle:String(data.statusSubtitle||''),
    topupBalance:Number.isFinite(Number(data.topupBalance))?Number(data.topupBalance):null
  };
}

export function combineMuseQuotas(accounts,quotas,asOf=Date.now()){
  const rows=accounts.map(account=>{
    const state=quotas.get(account.id);
    const fresh=state?.status==='ok'&&
      Number.isFinite(state.fetchedAt)&&asOf-state.fetchedAt<2*MUSE_QUOTA_REFRESH_MS;
    return {
      id:account.id,name:account.name,
      status:fresh?'ok':state?.status==='error'?'error':'unknown',
      used:fresh?state.percentUsed:null,
      remaining:fresh?state.percentRemaining:null,
      quotaStatus:fresh?state.quotaStatus:null,
      tierName:fresh?state.tierName:null,
      resetsAt:fresh?state.resetsAt:null,
      fetchedAt:fresh?state.fetchedAt:null,
      error:fresh?null:String(state?.error||'等待同步额度')
    };
  });
  const known=rows.filter(item=>item.status==='ok');
  const used=known.reduce((sum,item)=>sum+item.used,0);
  const remaining=known.reduce((sum,item)=>sum+item.remaining,0);
  return {
    totalAccounts:rows.length,
    knownAccounts:known.length,
    unknownAccounts:rows.length-known.length,
    totalCapacity:rows.length*100,
    measuredCapacity:known.length*100,
    totalUsed:Number(used.toFixed(2)),
    totalRemaining:Number(remaining.toFixed(2)),
    rows
  };
}

export function chooseMuseQuotaAccount(accounts,quotas,busyIds=new Set(),asOf=Date.now()){
  const summary=combineMuseQuotas(accounts,quotas,asOf);
  return summary.rows.filter(item=>
    item.status==='ok'&&item.remaining>0&&
    item.quotaStatus!=='EXHAUSTED'&&!busyIds.has(item.id)
  ).sort((a,b)=>b.remaining-a.remaining||
    (a.fetchedAt||0)-(b.fetchedAt||0)||a.id.localeCompare(b.id))[0]||null;
}

export function chooseMuseAutoAccount(accounts,quotas,{
  busyIds=new Set(),lastUsed=new Map(),queueDepths=new Map(),asOf=Date.now()
}={}){
  // An idle account ALWAYS precedes a busy one, even if its quota has not
  // been verified yet. This is essential for parallel image/video jobs.
  const rows=combineMuseQuotas(accounts,quotas,asOf).rows;
  const candidates=rows.filter(row=>row.status==='ok'
    ?row.remaining>0&&row.quotaStatus!=='EXHAUSTED'
    :!/未登录|尚未登录|需要登录|登录窗口未关闭/.test(row.error||''));
  const idle=candidates.filter(row=>!busyIds.has(row.id));
  const pool=idle.length?idle:candidates;
  pool.sort((a,b)=>
    (queueDepths.get(a.id)||0)-(queueDepths.get(b.id)||0)||
    (a.status==='ok'?0:1)-(b.status==='ok'?0:1)||
    (a.status==='ok'?(b.remaining||0)-(a.remaining||0):0)||
    (lastUsed.get(a.id)||0)-(lastUsed.get(b.id)||0)||
    a.id.localeCompare(b.id));
  const chosen=pool[0];
  return chosen?{id:chosen.id,verified:chosen.status==='ok',
    remaining:chosen.status==='ok'?chosen.remaining:null}:null;
}

// Runs inside that account's authenticated muse.ai browser page and never
// copies cookies or credentials into the TapNow server/API response.
export async function fetchMuseQuotaInPage(page,{
  actionId=process.env.MUSE_QUOTA_ACTION_ID||MUSE_QUOTA_ACTION_ID,
  args=process.env.MUSE_QUOTA_ACTION_ARGS||'[]'
}={}){
  if(!/^[a-f\d]{40,80}$/i.test(actionId))
    throw new Error('Muse 额度 Next-Action ID 格式错误');
  let parsedArgs;
  try{parsedArgs=JSON.parse(args)}catch{throw new Error('Muse 额度接口参数格式错误')}
  if(!Array.isArray(parsedArgs))throw new Error('Muse 额度接口参数必须为 JSON 数组');
  const result=await page.evaluate(async({actionId,args})=>{
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),15000);
    try{
      const response=await fetch('/',{
        method:'POST',
        credentials:'same-origin',
        headers:{
          'accept':'text/x-component',
          'content-type':'text/plain;charset=UTF-8',
          'next-action':actionId
        },
        body:JSON.stringify(args),
        signal:controller.signal
      });
      return {status:response.status,body:(await response.text()).slice(0,500_000)};
    }finally{clearTimeout(timeout)}
  },{actionId,args:parsedArgs});
  if(result.status!==200)
    throw new Error('Muse 额度接口 HTTP '+result.status+'；需更新额度 Action ID/请求参数');
  return parseMuseQuotaFlight(result.body);
}
