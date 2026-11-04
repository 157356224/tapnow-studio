// Only jobs sharing the SAME browser profile are serialized. Different account
// IDs are independent and may execute at the same time.
export function scheduleAccountJob(tails,accountId,task){
  const previous=tails.get(accountId)||Promise.resolve();
  const running=previous.catch(()=>{}).then(task);
  const tail=running.then(()=>{},()=>{});
  tails.set(accountId,tail);
  void tail.then(()=>{
    if(tails.get(accountId)===tail)tails.delete(accountId);
  });
  return running;
}
