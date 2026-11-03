import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const sampleRate=8000;
const wav=Buffer.alloc(44+sampleRate*2);
wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);
wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
wav.writeUInt32LE(sampleRate,24);wav.writeUInt32LE(sampleRate*2,28);
wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);
wav.write('data',36);wav.writeUInt32LE(sampleRate*2,40);
for(let i=0;i<sampleRate;i++)wav.writeInt16LE(Math.round(9000*Math.sin(i*2*Math.PI*440/sampleRate)),44+i*2);

const node=(id,kind,title,x,y,extras={})=>({
  id,type:'studio',position:{x,y},data:{kind,title,prompt:'',status:'idle',...extras}
});
const project={id:'audio-ui-test',title:'Audio UI Test',updatedAt:new Date().toISOString(),
  viewport:{x:170,y:100,zoom:.75},nodes:[
    node('audio','audio','原始配音',80,50,{mediaUrl:'/api/uploads/test.wav'}),
    node('image','image','旧场景',80,360,{mediaUrl:'/api/uploads/test.png',ratio:'1:1'}),
    node('video','video','原始视频',730,130,{prompt:'使用 @音频1 和 @图片1',provider:'doubao',
      model:'Seedance 2.0 Mini',ratio:'16:9',duration:'5s',accountId:'test'}),
    node('text','text','旧脚本',80,690,{text:'故事正文'})
  ],edges:[{id:'a-v',source:'audio',target:'video'},
    {id:'i-v',source:'image',target:'video'}]};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1900,height:1150}});
const pageErrors=[];
page.on('pageerror',error=>pageErrors.push(error.message));
try{
  await page.route('**/api/**',async route=>{
    const request=route.request();const url=new URL(request.url());
    const json=data=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
    if(url.pathname==='/api/uploads/test.wav')return route.fulfill({status:200,contentType:'audio/wav',body:wav});
    if(url.pathname==='/api/uploads/test.png')return route.fulfill({status:200,contentType:'image/png',body:png});
    if(url.pathname==='/api/projects')return json([{id:project.id,title:project.title,updatedAt:project.updatedAt}]);
    if(url.pathname==='/api/projects/'+project.id){
      if(request.method()==='PUT'){
        const update=request.postDataJSON();
        project.nodes=update.nodes;project.edges=update.edges;
        return json({id:project.id,updatedAt:new Date().toISOString()});
      }
      return json(project);
    }
    if(url.pathname.endsWith('/accounts'))return json([]);
    if(url.pathname==='/api/muse/quotas')return json({totalAccounts:0,knownAccounts:0,
      unknownAccounts:0,totalCapacity:0,measuredCapacity:0,totalUsed:0,
      totalRemaining:0,rows:[],refreshedAt:Date.now(),refreshIntervalMs:60000});
    if(url.pathname==='/api/health')return json({ok:true});
    return json([]);
  });
  await page.goto(process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5173/',{waitUntil:'domcontentloaded'});
  const n=id=>page.locator('.react-flow__node[data-id="'+id+'"]');
  await n('audio').waitFor({state:'visible',timeout:15000});
  await page.waitForTimeout(700);
  await n('audio').locator('.tn-node-frame').click();
  assert.equal(await page.locator('.floating-compose:visible').count(),0,
    '音频节点不允许弹出生成输入框');
  const rename=async(id,title)=>{
    await n(id).getByRole('button',{name:'重命名节点'}).click();
    const input=n(id).getByRole('textbox',{name:'修改节点名称'});
    await input.fill(title);await input.press('Enter');
    assert.equal(await n(id).locator('.tn-node-name').innerText(),title);
  };
  await rename('audio','配音重命名');
  const visual=n('audio').locator('.tn-audio-visual');
  await visual.hover();
  await page.waitForFunction(()=>{
    const element=document.querySelector('.react-flow__node[data-id="audio"] audio');
    return element&&!element.paused;
  },null,{timeout:4500});
  await page.mouse.move(1700,1100);
  await page.waitForFunction(()=>document.querySelector('.react-flow__node[data-id="audio"] audio')?.paused,{timeout:4500});
  await rename('image','场景重命名');
  await rename('text','脚本重命名');
  await n('video').locator('.tn-node-frame').click();
  const editor=page.locator('.floating-compose:visible .tn-compose-editor');
  await editor.waitFor({state:'visible',timeout:9000});
  const chips=page.locator('.floating-compose:visible .tn-inline-ref');
  await chips.first().waitFor();
  assert.deepEqual(await chips.evaluateAll(elements=>elements.map(el=>[el.dataset.token,el.lastChild?.textContent])),
    [['@音频1','配音重命名'],['@图片1','场景重命名']]);
  await rename('video','视频重命名');
  // Rich video/image prompt: short text starts taller and long text expands
  // naturally before internal scrolling becomes necessary.
  const richHeight=()=>editor.evaluate(el=>el.getBoundingClientRect().height);
  const initialRich=await richHeight();
  assert.ok(initialRich>=150,'非空视频提示词输入框应增加高度');
  await editor.fill(Array.from({length:38},(_,i)=>'镜头 '+(i+1)+'：角色从画面左侧走入').join('\n'));
  assert.ok(await richHeight()>=300,'长视频提示词应自动展开，而不局限在原来的 130px');
  assert.ok(await richHeight()<=425,'视频提示词不可无限向下撑开');
  await editor.fill('简短的视频提示词');
  assert.ok(await richHeight()<220,'缩短内容时应自动恢复较小高度');
  await editor.fill('');
  assert.ok(await richHeight()<100,'清空后视频输入框应恢复初始高度');

  // Textarea-based prompt uses the same behavior, including multiline IME-safe
  // drafts and shrinking again when the user removes long text.
  await n('text').locator('.tn-node-frame').click();
  const textPrompt=page.locator('.floating-compose:visible textarea.tn-compose-prompt');
  await textPrompt.waitFor({state:'visible',timeout:9000});
  await textPrompt.fill('短文本');
  assert.ok(await textPrompt.evaluate(el=>el.getBoundingClientRect().height)>=150);
  await textPrompt.fill(Array.from({length:33},(_,i)=>'段落 '+i+'：详细描述故事背景').join('\n'));
  const tall=await textPrompt.evaluate(el=>el.getBoundingClientRect().height);
  assert.ok(tall>=300&&tall<=425,'长文本提示词应该自动增高至视口约一半');
  await textPrompt.fill('短文本');
  const short=await textPrompt.evaluate(el=>el.getBoundingClientRect().height);
  assert.ok(short<tall&&short>=150,'清空长文本后输入框需要自动缩小');
  await textPrompt.fill('');
  assert.ok(await textPrompt.evaluate(el=>el.getBoundingClientRect().height)<100,
    '完全清空后文本输入框应恢复初始高度');
  assert.equal(pageErrors.length,0,'Unhandled page errors: '+pageErrors.join(' | '));
  console.log('PASS: all four nodes renamed, audio playback, named reference chips, auto-growing rich prompt and textarea');
}catch(error){
  console.error('AUDIO_UI_DEBUG',{
    url:page.url(),errors:pageErrors,
    body:(await page.locator('body').innerText().catch(()=>'' )).slice(0,700),
    nodeIds:await page.locator('.react-flow__node').evaluateAll(elements=>elements.map(el=>el.getAttribute('data-id'))).catch(()=>[])
  });
  throw error;
}finally{await browser.close();}
