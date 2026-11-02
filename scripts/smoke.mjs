import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:3701';
async function req(path, init) {
  const r = await fetch(base+path, init);
  let body = {};
  try { body = await r.json(); } catch {}
  return { status:r.status, body };
}
const json = body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const health=await req('/api/health');
assert.equal(health.status,200);
assert.equal(health.body.mode,'local-canvas');
assert.ok(health.body.browserBridges.includes('doubao-seedance-v2'));
assert.equal(health.body.liveVideoGenerationVerified,false);
const made=await req('/api/projects',json({title:'Test Project',nodes:[],edges:[]}));
assert.equal(made.status,201);
const id=made.body.id;
try {
  const got=await req('/api/projects/'+id);
  assert.equal(got.body.title,'Test Project');
  const saved=await req('/api/projects/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Updated Project'})});
  assert.equal(saved.status,200);
  const planned=await req('/api/workflow/plan',json({
    nodes:[{id:'a',data:{kind:'text'}},{id:'b',data:{kind:'image'}},{id:'c',data:{kind:'video',bypass:true}}],
    edges:[{source:'a',target:'b'},{source:'b',target:'c'}]
  }));
  assert.equal(planned.status,200);
  assert.deepEqual(planned.body.order,['a','b','c']);
  assert.deepEqual(planned.body.skipped,['c']);
  const cyclic=await req('/api/workflow/plan',json({
    nodes:[{id:'a'},{id:'b'}],edges:[{source:'a',target:'b'},{source:'b',target:'a'}]
  }));
  assert.equal(cyclic.status,422);
  console.log('PASS: health, create/get/update project, DAG ordering, bypass, cycle detection');
} finally {
  await req('/api/projects/'+id,{method:'DELETE'});
}
