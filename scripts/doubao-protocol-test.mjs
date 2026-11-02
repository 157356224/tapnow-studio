import assert from 'node:assert/strict';
import {
  inspectVideoSubmission,validateObservedSubmission,parseSseEvents,
  findVideoIds,getSignedVideoDownload,validateImageReferences
} from '../server/doubao-protocol.mjs';

const req={chat_ability:{ability_type:17,ability_param:JSON.stringify({
  model:'seedance_v2.0',ratio:'3:4',duration:10,resolution:'720p',
  input_box_content:{user_input_content:'not exported here'}
})},messages:[
  {content_block:[{block_type:10052,content:{
    attachment_block:{attachments:[{type:1,image:{uri:'example-local-id'}}]}
  }}]},
  {content_block:[{block_type:10000,content:{text_block:{text:'example'}}}]}
]};
const seen=inspectVideoSubmission(JSON.stringify(req));
assert.deepEqual(seen,{
  abilityType:17,model:'seedance_v2.0',ratio:'3:4',duration:10,
  resolution:'720p',referenceCount:1,hasVideoInput:true
});
assert.ok(validateObservedSubmission(seen,{
  ratio:'3:4',duration:'10s',references:[{kind:'image'}]
}));
assert.throws(()=>validateObservedSubmission(seen,{
  ratio:'9:16',duration:'10s',references:[{kind:'image'}]
}),/比例/);
assert.throws(()=>validateObservedSubmission(seen,{
  ratio:'3:4',duration:'5s',references:[{kind:'image'}]
}),/时长/);
assert.throws(()=>validateObservedSubmission(seen,{
  ratio:'3:4',duration:'10s',references:[]
}),/参考图片/);
assert.equal(parseSseEvents(
  'event: SSE_ACK\ndata: {"a":1}\n\nevent: SSE_REPLY_END\ndata: {}\n\n'
).length,2);
const vid='v0d69cg10004dbj1jci7dld3u39lu4pg';
assert.deepEqual(findVideoIds({downlink_body:JSON.stringify({items:[
  {content:JSON.stringify({video_id:vid})}
]})}),[vid]);
assert.deepEqual(findVideoIds({vid:'not-valid'}),[]);
assert.equal(getSignedVideoDownload({data:{
  download_video:{[vid]:{download_url:'https://v11-vdl.doubao.com/video/abc'}}
}},vid),'https://v11-vdl.doubao.com/video/abc');
assert.equal(getSignedVideoDownload({data:{
  download_video:{[vid]:{download_url:'http://localhost:8700/private'}}
}},vid),null);
assert.ok(validateImageReferences([
  {kind:'image',url:'/api/uploads/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.webp'}
]));
assert.throws(()=>validateImageReferences([
  {kind:'video',url:'/api/uploads/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4'}
]),/仅支持图片/);
console.log('PASS: HAR submission parser, exact settings checks, SSE, video ID, signed URL validation, image-only references');
