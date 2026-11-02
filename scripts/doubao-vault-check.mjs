import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const api='http://127.0.0.1:3701/api/doubao/accounts';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exampleValue='local_validation_'+crypto.randomUUID();
let id;
try {
  const rejected=await fetch(api,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name:'自动化隔离验证账号',cookie:'verification='+exampleValue})
  });
  assert.equal(rejected.status,400,'Cookie import must be disabled');
  assert.match((await rejected.json()).error,/Cookie 导入/);
  const res=await fetch(api,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name:'独立浏览器手动登录验证'})
  });
  const account=await res.json();
  if(!res.ok)throw new Error('Manual login account could not be created: '+account.error);
  id=account.id;
  assert.equal(account.hasCookie,false);
  assert.ok(!('cookie' in account),'Account response cannot contain plaintext cookies');
  const list=await fetch(api).then(r=>r.json());
  assert.ok(list.some(a=>a.id===id));
  assert.ok(!JSON.stringify(list).includes(exampleValue),'Read API must never expose cookie values');
  const vaultFile=path.join(root,'server','data','doubao-secrets',id+'.dpapi');
  assert.ok(!fs.existsSync(vaultFile),'No separate Cookie vault is created');
  const metadata=await fetch(api+'/'+id+'/trace').then(r=>r.json());
  assert.deepEqual(metadata.records,[],'Network trace is initially empty for each new account');
  assert.ok(!JSON.stringify(metadata).includes(exampleValue),
    'Trace endpoint cannot expose the cookie');
  const forbidden=await fetch(api+'/'+id+'/open',{
    method:'POST',headers:{Origin:'https://not-local.example'}
  });
  assert.equal(forbidden.status,403,'Cross-origin local account actions must be forbidden');
  console.log('PASS: Cookie import rejected, no Cookie vault created, account APIs redacted, origin rejection');
}finally{
  if(id){
    const del=await fetch(api+'/'+id,{method:'DELETE'});
    assert.equal(del.status,204,'Validation account was cleaned up');
  }
}
