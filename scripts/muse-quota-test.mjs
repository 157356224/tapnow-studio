import assert from 'node:assert/strict';
import {
  MUSE_QUOTA_REFRESH_MS,parseMuseQuotaFlight,
  combineMuseQuotas,chooseMuseQuotaAccount,chooseMuseAutoAccount
} from '../server/muse-quota.mjs';

const flight=[
  '0:{"a":"$@1","q":"","i":false}',
  '1:{"success":true,"subscription":{"tier":{"name":"Muse 免费版"},'+
    '"usage":{"state":"METERED","percentUsed":9,"resetsAt":1793997139,'+
    '"quotaStatus":"SUFFICIENT"}},"statusSubtitle":"每周限额将在 11月6日重置",'+
    '"topupBalance":120000000}'
].join('\n');
const result=parseMuseQuotaFlight(flight);
assert.equal(result.percentUsed,9);
assert.equal(result.percentRemaining,91);
assert.equal(result.resetsAt,1793997139);
assert.equal(result.quotaStatus,'SUFFICIENT');
assert.equal(result.tierName,'Muse 免费版');
assert.equal(result.topupBalance,120000000);
assert.throws(()=>parseMuseQuotaFlight('1:{"success":false}'),/没有返回/);
assert.throws(()=>parseMuseQuotaFlight(
  '1:{"success":true,"subscription":{"usage":{"percentUsed":102}}}'
),/0–100/);
const now=1760000000000;
const accounts=[
  {id:'a',name:'Muse A'},
  {id:'b',name:'Muse B'},
  {id:'c',name:'Muse C'}
];
const map=new Map([
  ['a',{...result,status:'ok',fetchedAt:now-1000}],
  ['b',{...result,percentUsed:75,percentRemaining:25,status:'ok',fetchedAt:now-2000}],
  ['c',{status:'error',error:'需要登录',fetchedAt:now-2000}]
]);
const summary=combineMuseQuotas(accounts,map,now);
assert.equal(summary.totalAccounts,3);
assert.equal(summary.totalCapacity,300);
assert.equal(summary.measuredCapacity,200);
assert.equal(summary.knownAccounts,2);
assert.equal(summary.unknownAccounts,1);
assert.equal(summary.totalUsed,84);
assert.equal(summary.totalRemaining,116);
assert.equal(chooseMuseQuotaAccount(accounts,map,new Set(),now).id,'a');
assert.equal(chooseMuseQuotaAccount(accounts,map,new Set(['a']),now).id,'b');
assert.equal(chooseMuseQuotaAccount(accounts,map,new Set(['a','b']),now),null);
assert.equal(chooseMuseQuotaAccount(accounts,map,new Set(),now+MUSE_QUOTA_REFRESH_MS*3),null);
assert.deepEqual(chooseMuseAutoAccount(accounts,map,{asOf:now}),
  {id:'a',verified:true,remaining:91});
assert.deepEqual(chooseMuseAutoAccount(accounts,map,{
  asOf:now,busyIds:new Set(['a'])
}),{id:'b',verified:true,remaining:25},
  'Busy high-quota account must not block parallel work on idle account');
assert.deepEqual(chooseMuseAutoAccount(accounts,map,{
  asOf:now,busyIds:new Set(['a','b'])
}),{id:'a',verified:true,remaining:91},
  'If only eligible profiles are busy, queue behind a valid profile instead of a login-error account');
const unknownMap=new Map([
  ['a',{status:'error',error:'接口需要升级'}],
  ['b',{status:'error',error:'接口需要升级'}],
  ['c',{status:'error',error:'Muse 尚未登录'}]
]);
assert.deepEqual(chooseMuseAutoAccount(accounts,unknownMap,{
  asOf:now,lastUsed:new Map([['a',now-1000],['b',now-500]])
}),{id:'a',verified:false,remaining:null},
  'Unknown quota must be explicitly unverified; use least-recently-used non-login-error fallback');
const exhausted=new Map(accounts.map(account=>[
  account.id,{...result,status:'ok',percentUsed:100,percentRemaining:0,fetchedAt:now}
]));
assert.equal(chooseMuseAutoAccount(accounts,exhausted,{asOf:now}),null);
console.log('PASS: 9% used => 91% remaining; total 116% left / 84% used of 200% measured, unknown excluded, account selection follows remaining quota');
