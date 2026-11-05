import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const base=process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5173/';
const now=new Date().toISOString();
const project={
  id:'h3-ui-regression',title:'H3 UI integration test',
  updatedAt:now,viewport:{x:80,y:75,zoom:1},
  nodes:[
    {id:'h3-frame-source',type:'studio',position:{x:60,y:70},
      data:{kind:'image',title:'首帧图',mediaUrl:'/api/uploads/first.png',status:'done'}},
    {id:'h3-video',type:'studio',position:{x:560,y:80},
      data:{kind:'video',title:'H3测试',provider:'h3',model:'h3-video',
        duration:'6s',resolution:'768p',prompt:'云海中的古城',ratio:'16:9',status:'idle'}}
  ],
  edges:[{id:'h3-ref',source:'h3-frame-source',target:'h3-video',
    sourceHandle:'out',targetHandle:'in'}]
};
const errors=[];
let configured=false;
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1800,height:980}});
page.on('pageerror',error=>errors.push(error.message));
page.setDefaultTimeout(8500);
const send=(route,body,status=200)=>route.fulfill({
  status,contentType:'application/json',body:JSON.stringify(body)
});
try{
  await page.route('**/api/**',async route=>{
    const request=route.request();
    const pathname=new URL(request.url()).pathname;
    if(pathname==='/api/projects')return send(route,[
      {id:project.id,title:project.title,updatedAt:now}
    ]);
    if(pathname==='/api/projects/'+project.id){
      if(request.method()==='PUT'){
        Object.assign(project,request.postDataJSON());
        return send(route,{id:project.id,updatedAt:now});
      }
      return send(route,project);
    }
    if(pathname==='/api/h3/config'){
      if(request.method()==='PUT'){
        configured=true;
        assert.equal(request.postDataJSON().apiKey,'sc_live_test_only_key');
        return send(route,{configured:true,masked:'••••_key'});
      }
      return send(route,{configured,masked:configured?'••••_key':''});
    }
    if(pathname==='/api/h3/models')return send(route,{
      models:['h3-video','h3-video-flex','h3-video-frames'].map(id=>({id}))
    });
    if(pathname==='/api/muse/quotas')return send(route,{
      totalAccounts:0,knownAccounts:0,unknownAccounts:0,
      totalUsed:0,totalRemaining:0,rows:[],refreshing:false
    });
    return send(route,[]);
  });
  await page.goto(base,{waitUntil:'domcontentloaded'});
  const video=page.locator('.react-flow__node[data-id="h3-video"]');
  await video.waitFor({state:'visible',timeout:15000});
  await video.locator('.tn-node-caption').click();
  const compose=page.locator('.floating-compose:not(.tn-editor-closing)');
  await compose.waitFor({state:'visible'});
  assert.equal(await compose.getByRole('button',{name:'H3 API',exact:true}).getAttribute('aria-pressed'),
    'true','Existing H3 project must reopen with H3 selected');
  const toggle=compose.locator('.tn-video-model-picker>button');
  assert.match(await toggle.innerText(),/h3-video/);
  await toggle.click();
  const choices=page.getByRole('listbox',{name:'视频模型'});
  await choices.waitFor({state:'visible'});
  assert.deepEqual(await choices.getByRole('option').allTextContents(),
    (await choices.getByRole('option').allTextContents()).filter(text=>
      /h3-video/.test(text)));
  assert.equal(await choices.getByRole('option').count(),3,
    'All three native Yuanbo H3 models must appear');
  await choices.getByRole('option',{name:/h3-video-frames/}).click();
  await page.waitForTimeout(380);
  assert.match(await toggle.innerText(),/h3-video-frames/);
  const settingsButton=compose.locator('.tn-video-settings-toggle');
  await settingsButton.click();
  const frameSelect=page.getByRole('combobox',{name:'H3 首帧'});
  await frameSelect.waitFor({state:'visible'});
  assert.equal(await frameSelect.locator('option').count(),2,
    'Connected image should be available as an H3 first frame');
  await frameSelect.selectOption('h3-frame-source');
  assert.equal(await frameSelect.inputValue(),'h3-frame-source');
  const h3KeyButton=compose.getByRole('button',{name:/H3 API Key/});
  await h3KeyButton.click();
  const keyInput=page.getByLabel('元铂AI API Key');
  await keyInput.waitFor({state:'visible'});
  await keyInput.fill('sc_live_test_only_key');
  await page.getByRole('button',{name:'保存密钥'}).click();
  await page.getByRole('button',{name:'检查模型'}).click();
  await page.getByText('API Key 验证通过',{exact:false}).waitFor({state:'visible'});
  assert.equal(configured,true);
  assert.deepEqual(errors,[],'H3 UI should not produce browser exceptions');
  console.log('PASS: H3 provider reopens, all 3 model choices, connected first frame, local API Key settings and remote model lookup');
}finally{
  await browser.close();
}
