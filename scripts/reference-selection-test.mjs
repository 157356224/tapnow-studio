import assert from 'node:assert/strict';
import {projectImageReferences} from '../server/reference-selection.mjs';

const project={
  nodes:[
    {id:'a',data:{kind:'image',title:'图A',mediaUrl:'/api/uploads/a.png'}},
    {id:'b',data:{kind:'image',title:'图B',mediaUrl:'/api/uploads/b.png'}},
    {id:'c',data:{kind:'image',title:'图C',mediaUrl:'/api/uploads/c.png'}},
    {id:'unlinked',data:{kind:'image',mediaUrl:'/api/uploads/unused.png'}},
    {id:'video',data:{kind:'video',prompt:'只用 @图片2'}},
    {id:'image-target',data:{kind:'image',prompt:'重绘 @图片1'}}
  ],
  edges:[
    {source:'a',target:'video'}, {source:'b',target:'video'},
    {source:'c',target:'video'}, {source:'a',target:'image-target'}
  ]
};
function refs(prompt,ids,node='video'){
  return projectImageReferences(project,node,prompt,ids.map(id=>({id})));
}
assert.deepEqual(refs('只是连线不引用',[]),[],
  'Connected images are available but cannot be uploaded without @');
assert.deepEqual(refs('第一个 @图片2 以及 @图片2', ['b']).map(x=>x.id),['b'],
  'Repeated @ token must upload only once');
assert.deepEqual(refs('@图片3，再看 @图片1', ['a','c']).map(x=>x.id),['a','c'],
  'Upload order must follow numbered thumbnails, not @ occurrence order');
assert.deepEqual(refs('参考 @图片1',['a'],'image-target').map(x=>x.id),['a'],
  'Muse image nodes can also reference connected source images');
assert.throws(()=>refs('没有 @ 引用',['a']),/必须与输入框/);
assert.throws(()=>refs('@图片2',['b','a']),/必须与输入框/);
assert.throws(()=>refs('@图片1',['unlinked']),/必须与输入框/);
assert.throws(()=>refs('@图片4',[]),/没有对应的已连接图片/);
assert.throws(()=>refs('@图片0',[]),/没有对应的已连接图片/);
assert.throws(()=>refs('@图片01',[]),/没有对应的已连接图片/);
project.nodes.find(n=>n.id==='video').data.referenceOrder=['c','a','b'];
assert.deepEqual(refs('@图片1 @图片3',['c','b']).map(x=>x.id),['c','b'],
  'Explicit thumbnail order must also control server-side @ lookup');
assert.throws(()=>refs('@图片1',[{id:'a'}]),/必须与输入框/);
project.nodes.find(n=>n.id==='a').data.mediaUrl='';
assert.throws(()=>refs('@图片2',[]),/还没有图片素材/);
assert.deepEqual(refs('@图片3',['b']).map(x=>x.id),['b'],
  'Missing images keep their index and do not shift later @ references');
console.log('PASS: only @ referenced connected images, Muse/Doubao shared policy, no duplicates, ordered refs, invalid refs fail closed');
