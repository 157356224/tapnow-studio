// The completed generation is already saved and persisted before this helper
// runs. Close only the account's automated Edge context, never a separate
// native window used for manual login or another account's active browser.
export async function closeCompletedBrowser({
  accountId,context,browsers,hasPending,provider
}){
  if(hasPending(accountId)||browsers.get(accountId)!==context)return false;
  try{
    await context.close();
    if(browsers.get(accountId)===context)browsers.delete(accountId);
    return true;
  }catch(err){
    // A cleanup error must not turn a completed, saved generation into a
    // failed job; keep the context in the map so closing can be retried.
    console.warn(provider+' 生成已完成，但独立 Edge 关闭失败：',
      String(err?.message||err).slice(0,180));
    return false;
  }
}
