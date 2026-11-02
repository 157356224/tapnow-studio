import assert from 'node:assert/strict';
import {closeCompletedBrowser} from '../server/browser-cleanup.mjs';

const accounts=new Map();
const calls=[];
const makeContext=name=>({
  async close(){calls.push(name)}
});
const muse=makeContext('muse');
const doubao=makeContext('doubao');
accounts.set('muse-1',muse);
accounts.set('doubao-1',doubao);
const run=(accountId,context,hasPending=()=>false)=>closeCompletedBrowser({
  accountId,context,browsers:accounts,hasPending,provider:'TEST'
});

assert.equal(await run('muse-1',muse,id=>id==='muse-1'),false,
  'Queued job must keep shared account Edge open');
assert.deepEqual(calls,[]);
assert.equal(await run('muse-1',doubao),false,
  'A different browser must never be closed');
assert.deepEqual(calls,[]);
assert.equal(await run('muse-1',muse),true,
  'Saved Muse result closes the matching automated Edge context');
assert.equal(accounts.has('muse-1'),false);
assert.equal(await run('muse-1',muse),false,'Closing is idempotent');
assert.equal(await run('doubao-1',doubao),true,
  'Saved Doubao result also closes the matching automated Edge context');
assert.equal(accounts.has('doubao-1'),false);
assert.deepEqual(calls,['muse','doubao']);

const error=new Error('simulated close failure');
const broken={async close(){throw error}};
accounts.set('bad',broken);
const originalWarn=console.warn;
const warnings=[];
try{
  console.warn=(...args)=>warnings.push(args.join(' '));
  assert.equal(await run('bad',broken),false,
    'An Edge close failure does not invalidate the already completed result');
}finally{
  console.warn=originalWarn;
}
assert.equal(accounts.get('bad'),broken,
  'Keep failing browser available for another cleanup attempt');
assert.ok(warnings.join(' ').includes('simulated close failure'));
console.log('PASS: completed Muse/Doubao contexts close, pending and unrelated contexts remain, failures do not corrupt completed jobs');
