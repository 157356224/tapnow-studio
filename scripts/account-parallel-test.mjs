import assert from 'node:assert/strict';
import {scheduleAccountJob} from '../server/account-queue.mjs';
import {chooseMuseAutoAccount} from '../server/muse-quota.mjs';

// Simulate multiple Playwright account profiles without opening real
// browsers or sending any live generation requests.
const tails=new Map(),started=[],finished=[];
const deferred=()=>{
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no});
  return {promise,resolve,reject};
};
const gates=[deferred(),deferred(),deferred(),deferred()];
const simulate=(account,index)=>scheduleAccountJob(tails,account,async()=>{
  started.push(account+'-'+index);
  await gates[index].promise;
  finished.push(account+'-'+index);
});
const first=simulate('muse-a',0);
const second=simulate('muse-b',1);
const third=simulate('muse-a',2);
const fourth=simulate('doubao-c',3);
await new Promise(resolve=>setImmediate(resolve));
assert.deepEqual(started,['muse-a-0','muse-b-1','doubao-c-3'],
  'Different account profiles must start simultaneously; same account queues');
gates[1].resolve();
gates[3].resolve();
await Promise.all([second,fourth]);
assert.deepEqual(started,['muse-a-0','muse-b-1','doubao-c-3'],
  'Completing other accounts must not start a second job on busy account');
gates[0].resolve();
await first;
await new Promise(resolve=>setImmediate(resolve));
assert.deepEqual(started.at(-1),'muse-a-2');
gates[2].resolve();
await third;
await new Promise(resolve=>setImmediate(resolve));
assert.equal(tails.size,0,'Completed account tails must be released');

// A failed task must not leave its account permanently locked; another
// account remains unaffected even during error handling.
const failed=deferred(),next=deferred();
const error=scheduleAccountJob(tails,'muse-a',()=>failed.promise);
const recovered=scheduleAccountJob(tails,'muse-a',()=>{
  started.push('recovered');return next.promise;
});
const independent=scheduleAccountJob(tails,'doubao-b',()=>{
  started.push('independent');return 'done';
});
assert.equal(await independent,'done');
failed.reject(new Error('Browser closed unexpectedly'));
await assert.rejects(error,/Browser closed/);
await new Promise(resolve=>setImmediate(resolve));
assert.equal(started.at(-1),'recovered');
next.resolve('recovered-ok');
assert.equal(await recovered,'recovered-ok');
await new Promise(resolve=>setImmediate(resolve));
assert.equal(tails.size,0);

// Busy high-quota account must never beat an idle account. Unknown quota
// idle profiles remain eligible; exhausted profiles are not.
const asOf=1760000000000;
const accounts=[{id:'a'},{id:'b'},{id:'c'}];
const known=(remaining)=>({
  status:'ok',percentRemaining:remaining,percentUsed:100-remaining,
  quotaStatus:remaining?'SUFFICIENT':'EXHAUSTED',fetchedAt:asOf-1000
});
const quotas=new Map([
  ['a',known(90)],['b',known(30)],['c',{status:'error',error:'额度接口版本暂不可读'}]
]);
assert.equal(chooseMuseAutoAccount(accounts,quotas,{
  busyIds:new Set(['a']),asOf
}).id,'b','Use verified idle account b rather than busy higher-quota a');
assert.deepEqual(chooseMuseAutoAccount(accounts,quotas,{
  busyIds:new Set(['a','b']),asOf
}),{id:'c',verified:false,remaining:null},
  'Use idle unverified account when all verified accounts are busy');
assert.equal(chooseMuseAutoAccount(accounts,quotas,{
  busyIds:new Set(['a','b','c']),queueDepths:new Map([['a',5],['b',1],['c',3]]),
  asOf
}).id,'b','If all accounts are busy, queue on the least loaded account');
assert.equal(chooseMuseAutoAccount(accounts,
  new Map([['a',known(0)],['b',known(0)],
    ['c',{status:'error',error:'Muse 尚未登录'}]]),{asOf}),null,
  'Exhausted or logged-out accounts must not be scheduled');

console.log('PASS: simultaneous separate-account jobs, same-account FIFO, failure recovery, Muse idle-first allocation and balanced queue fallback');
