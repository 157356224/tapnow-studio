type Props={
  active:'doubao'|'muse'|'chatgpt';
  onSwitch:(provider:'doubao'|'muse'|'chatgpt')=>void;
};

export function AccountServiceTabs({active,onSwitch}:Props){
  return <div className="tn-account-service-tabs" role="group" aria-label="账号服务选择">
    <button type="button" aria-pressed={active==='doubao'}
      className={active==='doubao'?'active':''}
      onClick={()=>onSwitch('doubao')}>豆包账号</button>
    <button type="button" aria-pressed={active==='muse'}
      className={active==='muse'?'active':''}
      onClick={()=>onSwitch('muse')}>Muse 账号</button>
    <button type="button" aria-pressed={active==='chatgpt'}
      className={active==='chatgpt'?'active':''}
      onClick={()=>onSwitch('chatgpt')}>ChatGPT 账号</button>
  </div>;
}
