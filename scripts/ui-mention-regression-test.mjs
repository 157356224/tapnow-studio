import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
const node=(id,kind,title,x,y,extra={})=>({
  id,type:'studio',position:{x,y},
  data:{kind,title,prompt:'',status:'idle',...extra}
});
const project={
  id:'mention-regression',title:'Mention regression',updatedAt:new Date().toISOString(),
  viewport:{x:110,y:140,zoom:.85},
  nodes:[
    node('a','image','图片甲',40,40,{mediaUrl:'/api/uploads/a.png'}),
    node('b','image','图片乙',40,350,{mediaUrl:'/api/uploads/b.png'}),
    node('video','video','视频',680,90,{provider:'doubao',accountId:'test-account',
      model:'Seedance 2.0 Mini',ratio:'16:9',duration:'5s'})
  ],
  edges:[{id:'a-v',source:'a',target:'video'},{id:'b-v',source:'b',target:'video'}]
};
const submitted=[];
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1880,height:1200}});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
try{
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    const json=(data,status=200)=>route.fulfill({
      status,contentType:'application/json',body:JSON.stringify(data)
    });
    if(url.pathname.startsWith('/api/uploads/'))return route.fulfill({
      status:200,contentType:'image/png',body:png
    });
    if(url.pathname==='/api/projects')return json([
      {id:project.id,title:project.title,updatedAt:project.updatedAt}
    ]);
    if(url.pathname==='/api/projects/'+project.id){
      if(request.method()==='PUT'){
        const payload=request.postDataJSON();
        project.nodes=payload.nodes;project.edges=payload.edges;
        return json({id:project.id,updatedAt:new Date().toISOString()});
      }
      return json(project);
    }
    if(url.pathname==='/api/health')return json({
      referenceSelectionRevision:'at-order-v2',
      multiImageUploadRevision:'v3-prompt-first',
      videoModelRevision:'mini-fast-v1',
      videoStartRevision:'reply-prefix-v1',
      videoDownloadRevision:'completed-card-v1'
    });
    if(url.pathname==='/api/doubao/accounts')return json([{id:'test-account',name:'测试账号'}]);
    if(url.pathname==='/api/doubao/jobs'){
      if(request.method()==='POST'){
        submitted.push(request.postDataJSON());
        return json({id:'mention-test-job',status:'queued',message:'已排队'},202);
      }
      return json({id:'mention-test-job',status:'needs-attention',error:'测试到此停止'});
    }
    if(url.pathname==='/api/muse/accounts')return json([]);
    if(url.pathname==='/api/muse/quotas')return json({totalAccounts:0,knownAccounts:0,
      unknownAccounts:0,totalCapacity:0,measuredCapacity:0,totalUsed:0,
      totalRemaining:0,rows:[],refreshedAt:Date.now()});
    return json([]);
  });
  await page.goto(process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5173/',{
    waitUntil:'domcontentloaded'
  });
  const video=page.locator('.react-flow__node[data-id="video"]');
  await video.waitFor({state:'visible',timeout:15000});
  await page.waitForTimeout(600);
  await video.locator('.tn-node-frame').click();
  const compose=page.locator('.floating-compose:visible');
  const editor=compose.locator('.tn-compose-editor');
  const gallery=compose.locator('.tn-ref-gallery');
  const chips=compose.locator('.tn-inline-ref');
  await editor.waitFor({state:'visible',timeout:12000});
  await editor.click();

  // insertText (like some IMEs) dispatches input without a keydown '@'.
  await page.keyboard.insertText('@');
  await gallery.waitFor({state:'visible',timeout:1200});
  await gallery.getByRole('button',{name:/图片甲/}).click();
  assert.deepEqual(await chips.evaluateAll(items=>items.map(x=>x.dataset.token)),['@图片1']);
  await page.keyboard.insertText('25');
  await page.waitForTimeout(120);
  const typed=await editor.evaluate(el=>el.textContent);
  assert.ok(!/[@]图片125/.test(typed),'数字不能与已选择的 @图片1 引用拼成 @图片125');

  // @ chooser must immediately reopen multiple times without losing the caret.
  await page.keyboard.insertText(' @');
  await gallery.waitFor({state:'visible',timeout:1200});
  await gallery.getByRole('button',{name:/图片乙/}).click();
  assert.deepEqual(await chips.evaluateAll(items=>items.map(x=>x.dataset.token)),
    ['@图片1','@图片2']);
  await page.keyboard.insertText('画面继续');
  await editor.press('End');
  await page.keyboard.insertText(' @');
  await gallery.waitFor({state:'visible',timeout:1200});
  await editor.press('Escape');
  await page.keyboard.insertText(' @');
  await gallery.waitFor({state:'visible',timeout:1200});
  // The search input takes focus; the chosen chip still belongs at the
  // original editor caret rather than the start/end of the whole prompt.
  await gallery.getByRole('textbox',{name:'搜索已连接素材'}).fill('图片甲');
  await gallery.getByRole('button',{name:/图片甲/}).click();
  assert.equal(await chips.count(),3);

  await compose.getByTitle('使用选定豆包账号生成视频').click();
  await page.waitForTimeout(350);
  if(await editor.isVisible().catch(()=>false)){
    assert.equal(await chips.count(),3,
      'Clicking send must not replace selected image chips with plain @ tokens');
  }
  assert.equal(submitted.length,1,'Sending should reach the generation endpoint once');
  assert.deepEqual(submitted[0].references,[{id:'a'},{id:'b'}]);
  assert.ok(!/[@]图片125/.test(submitted[0].prompt),'Sent prompt must contain valid tokens');
  assert.deepEqual([...submitted[0].prompt.matchAll(/@图片\d+/g)].map(x=>x[0]),
    ['@图片1','@图片2','@图片1']);
  // Typing right after a chip that replaced @ in the middle of a sentence
  // must also keep the existing right-side whitespace as a token boundary.
  await editor.fill('前半句 @ 后半句');
  await editor.evaluate(el=>{
    const textNode=el.firstChild;
    const offset=textNode.textContent.indexOf('@')+1;
    const range=document.createRange(),selection=window.getSelection();
    range.setStart(textNode,offset);
    range.collapse(true);selection.removeAllRanges();selection.addRange(range);
  });
  await page.keyboard.insertText('甲');
  await page.keyboard.press('Backspace');
  await gallery.waitFor({state:'visible',timeout:1200});
  await gallery.getByRole('button',{name:/图片甲/}).click();
  await page.keyboard.insertText('25');
  assert.equal(await chips.count(),1);
  const middle=await editor.evaluate(el=>el.innerText);
  assert.ok(!middle.includes('@图片125'),'原有空格前的文字也不能与图片引用编号合并');
  assert.ok(middle.includes('后半句'));
  assert.equal(errors.length,0,errors.join(' | '));
  console.log('PASS: IME @ popup, repeated mentions, no number token merging, send preserves selected references');
}finally{
  await browser.close();
}
