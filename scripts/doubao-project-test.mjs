import assert from 'node:assert/strict';
import { setProjectJob,preserveCompletedVideoMedia } from '../server/doubao-project.mjs';

const job={id:'job-123',projectId:'project-1',nodeId:'video-1'};
const source=[{id:'project-1',updatedAt:'old',nodes:[
  {id:'image-1',data:{kind:'image',mediaUrl:'/api/uploads/a.png'}},
  {id:'video-1',data:{kind:'video',prompt:'test',status:'idle'}}
]}];
const queued=setProjectJob(source,job,{status:'queued'});
assert.ok(queued.changed);
assert.equal(queued.projects[0].nodes[1].data.jobId,'job-123');
const staleBeforeJobId=preserveCompletedVideoMedia(queued.projects[0],[
  {id:'video-1',data:{kind:'video',status:'queued',prompt:'test'}}
]);
assert.equal(staleBeforeJobId[0].data.jobId,'job-123');
assert.equal(staleBeforeJobId[0].data.status,'queued');
const done=setProjectJob(queued.projects,job,{
  status:'done',progress:100,demo:false,
  mediaUrl:'/api/uploads/test.mp4',jobMessage:'done'
});
assert.ok(done.changed);
const stale={id:'video-1',data:{kind:'video',jobId:'job-123',status:'running',progress:30}};
const reconciled=preserveCompletedVideoMedia(done.projects[0],[stale]);
assert.equal(reconciled[0].data.mediaUrl,'/api/uploads/test.mp4');
assert.equal(reconciled[0].data.status,'done');
const failed=setProjectJob(queued.projects,job,{
  status:'error',progress:0,jobMessage:'账号未登录，请在浏览器登录'
});
const staleRunning=preserveCompletedVideoMedia(failed.projects[0],[
  {id:'video-1',data:{kind:'video',jobId:'job-123',status:'running',progress:10}}
]);
assert.equal(staleRunning[0].data.status,'error');
assert.equal(staleRunning[0].data.progress,0);
assert.match(staleRunning[0].data.jobMessage,/登录/);
const retry=preserveCompletedVideoMedia(failed.projects[0],[
  {id:'video-1',data:{kind:'video',jobId:'job-123',status:'queued',progress:0}}
]);
assert.equal(retry[0].data.status,'queued');
const regen=preserveCompletedVideoMedia(done.projects[0],[
  {id:'video-1',data:{kind:'video',jobId:'another-job',status:'queued'}}
]);
assert.equal(regen[0].data.status,'queued');
const deleteCase=setProjectJob(done.projects,{...job,nodeId:'not-present'},{
  status:'done',mediaUrl:'/api/uploads/nope.mp4'
});
assert.equal(deleteCase.changed,false);
const wrongJob=setProjectJob(done.projects,{...job,id:'unrelated'},{
  status:'done',mediaUrl:'/api/uploads/nope.mp4'
});
assert.equal(wrongJob.changed,false);
console.log('PASS: queued project mapping, persistent video completion, stale autosave protection, job isolation');
