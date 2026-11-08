import assert from 'node:assert/strict';
import {composeVideoPrompt,voiceDefinitionsForPrompt,referencesForNode} from '../src/doubao.ts';

const mk=(id,kind,voiceDefinition)=>({
  id,type:'studio',position:{x:0,y:0},
  data:{kind,title:'角色 '+id,prompt:'',voiceDefinition,mediaUrl:'/api/uploads/'+id+'.png'}
});
const nodes=[mk('a','image','低沉清澈的成年男声'),mk('b','image','沉稳、略带沙哑的女声'),
  mk('c','image','不应添加的音色'),mk('audio','audio','不应当视作角色音色'),
  mk('video','video','')];
const edges=[{id:'av',source:'a',target:'video'},{id:'bv',source:'b',target:'video'},
  {id:'audio-v',source:'audio',target:'video'}];
const refs=referencesForNode('video',nodes,edges);
const text='@图片1 在街头说：欢迎回来。接着 @图片2 回答。';
const result=composeVideoPrompt(text,refs);
assert.deepEqual(voiceDefinitionsForPrompt(text,refs).map(x=>x.id),['a','b']);
assert.equal(result,'【角色音色定义】\n@图片1（角色 a）音色：低沉清澈的成年男声\n'+
  '@图片2（角色 b）音色：沉稳、略带沙哑的女声\n\n'+text);
assert.equal(composeVideoPrompt(text.replace('@图片1 ','').replace('@图片2 ',''),refs),
  text.replace('@图片1 ','').replace('@图片2 ',''));
assert.equal(composeVideoPrompt('@图片1 说话',refs).includes('角色 b'),false);
assert.equal(composeVideoPrompt('@图片2 说话',refs).includes('角色 a'),false);
assert.equal(composeVideoPrompt('@音频1 声音',refs),'@音频1 声音');
assert.equal(composeVideoPrompt('@图片1 重复 @图片1',refs).split('音色：').length-1,1);
assert.equal(composeVideoPrompt('@图片10 未连接',refs),'@图片10 未连接');
assert.equal(composeVideoPrompt(text,refs).includes('不应添加的音色'),false);
const afterRemove=referencesForNode('video',nodes,edges.filter(edge=>edge.source!=='a'));
assert.equal(composeVideoPrompt('@图片1 对话',afterRemove).includes('低沉清澈'),false);
assert.equal(nodes[4].data.prompt,'');
console.log('PASS: role voice prefix is derived from connected @ references, matches IDs/tokens, and leaves original prompt untouched');
