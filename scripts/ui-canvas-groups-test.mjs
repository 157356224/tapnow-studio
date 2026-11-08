import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const project={
  id:'colored-canvas-group-test',
  title:'Colored Canvas Groups',
  updatedAt:new Date().toISOString(),
  viewport:{x:150,y:90,zoom:1},
  nodes:[
    {id:'text-a',type:'studio',position:{x:100,y:100},
      data:{kind:'text',title:'测试文字内容',text:'用鼠标拖动时不应出现蓝色文本选中',prompt:'',status:'idle'}}
  ],
  edges:[],groups:[],groupColorCursor:0
};
let saves=0;
const errors=[];
const url=process.env.TAPNOW_TEST_URL||'http://127.0.0.1:5173/';
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1550,height:960}});
  page.setDefaultTimeout(10000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',async route=>{
    const req=route.request();
    const path=new URL(req.url()).pathname;
    const respond=data=>route.fulfill({
      status:200,contentType:'application/json',body:JSON.stringify(data)
    });
    if(path==='/api/projects')return respond([
      {id:project.id,title:project.title,updatedAt:project.updatedAt}
    ]);
    if(path==='/api/projects/'+project.id){
      if(req.method()==='PUT'){
        Object.assign(project,req.postDataJSON());
        saves++;
        return respond({id:project.id,updatedAt:new Date().toISOString()});
      }
      return respond(project);
    }
    if(path==='/api/doubao/accounts'||path==='/api/muse/accounts')return respond([]);
    if(path==='/api/muse/quotas')return respond({
      totalAccounts:0,knownAccounts:0,unknownAccounts:0,totalCapacity:0,
      measuredCapacity:0,totalUsed:0,totalRemaining:0,rows:[]
    });
    if(path==='/api/health')return respond({});
    return respond([]);
  });
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.locator('.react-flow__node[data-id="text-a"]').waitFor();
  const readonlyText=page.locator('.react-flow__node[data-id="text-a"] .tn-node-text[readonly]');
  assert.equal(await readonlyText.evaluate(el=>getComputedStyle(el).userSelect),'none',
    'readonly text cards must not allow native blue text selection');
  const create=page.locator('aside.canvas-tools button[aria-label="创建彩色分组"]');
  await create.click();
  await create.click();
  const frames=page.getByTestId('canvas-group');
  await frames.nth(1).waitFor();
  assert.equal(await frames.count(),2);
  let colors=await frames.evaluateAll(items=>items.map(item=>item.style.getPropertyValue('--tn-group-color')));
  assert.equal(new Set(colors).size,2,'new frames must have distinct colors');

  const first=frames.first();
  const header=first.getByTestId('canvas-group-header');
  let old=await first.evaluate(el=>({x:parseFloat(el.style.left),y:parseFloat(el.style.top),
    width:parseFloat(el.style.width),height:parseFloat(el.style.height)}));
  const rect=await header.boundingBox();
  assert.ok(rect);
  await page.mouse.move(rect.x+38,rect.y+18);
  await page.mouse.down();
  await page.mouse.move(rect.x+96,rect.y+51,{steps:8});
  await page.mouse.up();
  let moved=await first.evaluate(el=>({x:parseFloat(el.style.left),y:parseFloat(el.style.top)}));
  assert.ok(Math.abs(moved.x-old.x-58)<3 && Math.abs(moved.y-old.y-33)<3,
    'dragging the colored frame header must move the frame');
  assert.equal(await page.evaluate(()=>window.getSelection()?.toString()||''),'',
    'canvas dragging must not select text');

  const resize=first.getByTestId('canvas-group-resize-se');
  const handle=await resize.boundingBox();
  assert.ok(handle);
  await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);
  await page.mouse.down();
  await page.mouse.move(handle.x+80,handle.y+60,{steps:7});
  await page.mouse.up();
  const sized=await first.evaluate(el=>({
    width:parseFloat(el.style.width),height:parseFloat(el.style.height)
  }));
  assert.ok(sized.width>old.width+60 && sized.height>old.height+35,
    'dragging the SE handle must resize width and height');

  await header.locator('.tn-canvas-group-name').dblclick();
  const nameInput=first.getByRole('textbox',{name:'分组名称'});
  await nameInput.fill('蓝图规划组');
  await nameInput.press('Enter');
  await page.getByText('蓝图规划组',{exact:true}).waitFor();

  // A frame created around a selected node must drag that node along with it.
  const node=page.locator('.react-flow__node[data-id="text-a"]');
  await node.locator('.tn-node-caption').click();
  await create.click();
  await frames.nth(2).waitFor();
  colors=await frames.evaluateAll(items=>items.map(item=>item.style.getPropertyValue('--tn-group-color')));
  assert.equal(new Set(colors).size,3);
  const third=frames.nth(2);
  const nodeBefore=await node.boundingBox();
  const groupBefore=await third.evaluate(el=>({x:parseFloat(el.style.left),y:parseFloat(el.style.top)}));
  const h3=await third.getByTestId('canvas-group-header').boundingBox();
  assert.ok(nodeBefore&&h3);
  await page.mouse.move(h3.x+39,h3.y+16);
  await page.mouse.down();
  await page.mouse.move(h3.x+87,h3.y+48,{steps:7});
  await page.mouse.up();
  const nodeAfter=await node.boundingBox();
  const groupAfter=await third.evaluate(el=>({x:parseFloat(el.style.left),y:parseFloat(el.style.top)}));
  assert.ok(nodeAfter && nodeAfter.x>nodeBefore.x+30 && nodeAfter.y>nodeBefore.y+20,
    'moving a group containing a node should move the node');
  assert.ok(groupAfter.x>groupBefore.x+30);

  // Deleting just the frame must not delete its contents; undo restores it.
  await third.getByRole('button',{name:/删除分组/}).click();
  assert.equal(await frames.count(),2);
  assert.equal(await node.count(),1);
  await page.keyboard.press('Control+z');
  await frames.nth(2).waitFor();

  await page.waitForTimeout(1500);
  assert.ok(saves>0 && project.groups.length===3,'groups should autosave');
  assert.ok(project.groupColorCursor>=3);
  await page.reload({waitUntil:'domcontentloaded'});
  await frames.nth(2).waitFor();
  assert.equal(await page.getByText('蓝图规划组',{exact:true}).count(),1);
  assert.equal(errors.length,0,'no uncaught browser errors: '+errors.join('; '));
  console.log('PASS: distinct colors, create, title edit, drag, resize, content motion, no text selection, delete/undo, autosave/reload');
}finally{
  await browser.close();
}
