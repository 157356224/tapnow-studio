// Optional offline regression against the operator's own HAR export.
// Emits only structural assertions and static, non-secret model settings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  findVideoIds,inspectVideoSubmission,parseSseEvents,
  SEEDANCE_HAR_ABILITY_TYPE,SEEDANCE_HAR_MODEL
} from '../server/doubao-protocol.mjs';

const filename=process.env.DOUBAO_HAR_FILE||
  'C:/Users/lhw20/Desktop/豆包.devtools';
if(!fs.existsSync(filename)){
  console.error('HAR file not found; set DOUBAO_HAR_FILE to its absolute location');
  process.exit(2);
}
const entries=JSON.parse(fs.readFileSync(filename,'utf8')).log.entries;
const pathOf=e=>new URL(e.request.url).pathname;
const posts=entries.filter(e=>e.request.method==='POST');
const submission=posts.filter(e=>pathOf(e)==='/chat/completion' &&
  inspectVideoSubmission(e.request.postData?.text).abilityType===SEEDANCE_HAR_ABILITY_TYPE);
assert.ok(submission.length,'HAR must include at least one video-generation request');
const sample=inspectVideoSubmission(submission[0].request.postData.text);
assert.equal(sample.model,SEEDANCE_HAR_MODEL);
assert.equal(sample.ratio,'3:4');
assert.equal(sample.duration,10);
assert.equal(sample.resolution,'720p');
assert.equal(sample.referenceCount,1);
const sse=parseSseEvents(submission[0].response.content?.text||'');
assert.ok(sse.some(x=>x.event==='SSE_ACK'));
assert.ok(sse.some(x=>x.event==='SSE_REPLY_END'));
const play=posts.filter(e=>pathOf(e)==='/samantha/video/get_play_info');
const downloads=posts.filter(e=>pathOf(e)==='/creativity/resource/get_without_watermark');
assert.ok(play.length&&downloads.length);
const playedIds=new Set(play.flatMap(e=>{
  try{return [JSON.parse(e.request.postData.text).vid];}catch{return [];}
}));
const requestedIds=new Set(downloads.flatMap(e=>{
  try{return JSON.parse(e.request.postData.text).vid||[];}catch{return [];}
}));
assert.ok([...playedIds].some(id=>requestedIds.has(id)),
  'Video play metadata and later download must refer to the same video ID');
const conversationMatches=posts.filter(e=>pathOf(e)==='/im/chain/single')
  .flatMap(e=>findVideoIds(e.response.content?.text||''));
const matched=[...playedIds].filter(id=>conversationMatches.includes(id));
// The prior HAR used nested IM JSON; if its representation changes, keep this
// as an observation rather than falsely asserting a stable schema.
console.log('PASS: actual HAR contains video ability 17, seedance_v2.0, 3:4, 10s, 720p, one image, SSE, linked play/download');
console.log('IM_CHAIN_VIDEO_ID_MATCHES='+matched.length);
