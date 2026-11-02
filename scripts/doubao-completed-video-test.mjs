import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../server/chromium-binary.mjs';
import {
  watchNewVideoCompletion,findFreshVideoCard,
  revealVideoDownloadControl,findVideoDownloadControl,openFreshVideoPreview
} from '../server/doubao-completed-video.mjs';
import {
  saveBrowserDownload,requestCurrentVideoDownloadLink
} from '../server/doubao-runner.mjs';

const browser=await chromium.launch({...browserLaunchOptions(),headless:true});
const page=await browser.newPage({acceptDownloads:true});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'tapnow-completed-video-'));
const video=Buffer.alloc(4096,0);
video.write('ftyp',4,'ascii');
const asset='https://www.doubao.com/tapnow-test/generated-video.mp4';
const card=(id,modal=false)=>[
  '<article id="'+id+'">',
  '<p>你的视频生成好了。</p>',
  '<div class="video-card" '+(modal?'id="modal-source"':'')+'>',
  '<img class="video-preview" alt="生成的视频" ',
  'src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=">',
  modal?'':('<a class="download" href="'+asset+
    '" download="doubao-video.mp4">下载视频</a>'),
  '</div></article>'
].join('');
await page.route(asset,route=>route.fulfill({
  status:200,contentType:'video/mp4',
  headers:{'content-disposition':'attachment; filename="doubao-video.mp4"'},
  body:video
}));
try{
  await page.setContent([
    '<style>',
    'article{width:500px;margin:16px 0 45px}',
    '.video-card{width:480px;height:240px;position:relative;background:#345}',
    '.video-preview{display:block;width:480px;height:240px}',
    '.download{display:none;position:absolute;right:10px;top:10px}',
    '.video-card:hover .download{display:block}',
    '</style>',
    card('old'),'<div id="user"></div><main id="feed"></main>'
  ].join(''));
  const monitor=await watchNewVideoCompletion(page);
  assert.equal(await monitor.completed(),false,
    'Already-completed video cards from old history must not be re-downloaded');
  await page.evaluate(()=>{
    const message=document.createElement('div');
    message.dataset.messageAuthorRole='user';
    message.textContent='截图显示“你的视频生成好了。”但是不回传';
    document.querySelector('#user').appendChild(message);
  });
  assert.equal(await monitor.completed(),false,
    'User quoting the completion text must not trigger recovery');

  await page.evaluate(html=>
    document.querySelector('#feed').insertAdjacentHTML('beforeend',html),
    card('fresh')
  );
  assert.equal(await monitor.completed(),true);
  const selected=await findFreshVideoCard(page);
  assert.ok(selected,'Completed new video must have a locatable thumbnail');
  assert.equal(await selected.locator('.video-preview').count(),1);
  assert.ok(await selected.evaluate(el=>!!el.closest('#fresh')),
    'Never select the video from older chat history');
  const revealed=await revealVideoDownloadControl(page);
  assert.ok(revealed.control,'Hover should reveal the video Download control');
  assert.equal(await revealed.control.innerText(),'下载视频');
  const saved=await saveBrowserDownload(page,revealed.control,temp);
  assert.equal(path.extname(saved),'.mp4');
  assert.ok(fs.existsSync(saved));
  assert.equal(fs.readFileSync(saved).subarray(4,8).toString(),'ftyp');
  assert.equal(fs.statSync(saved).size,video.length);
  await monitor.stop();

  // Another Doubao variant opens a modal when its video preview is clicked.
  await page.evaluate(()=>{
    const modal=document.createElement('dialog');
    modal.setAttribute('aria-label','视频预览');
    modal.innerHTML='<a href="'+
      'https://www.doubao.com/tapnow-test/generated-video.mp4'+
      '" download="doubao-video.mp4">下载视频</a>';
    document.body.appendChild(modal);
    document.querySelector('#feed').onclick=event=>{
      if(event.target.closest('#modal-source'))modal.showModal();
    };
  });
  const second=await watchNewVideoCompletion(page);
  await page.evaluate(html=>
    document.querySelector('#feed').insertAdjacentHTML('beforeend',html),
    card('modal-fresh',true)
  );
  assert.equal(await second.completed(),true);
  const result=await revealVideoDownloadControl(page);
  assert.ok(result.card);
  assert.equal(result.control,null,'The new card has no visible direct download');
  await result.card.click();
  const modalControl=await findVideoDownloadControl(page,result.card);
  assert.ok(modalControl,'A preview modal should expose its own download link');
  const savedFromModal=await saveBrowserDownload(page,modalControl,temp);
  assert.equal(fs.statSync(savedFromModal).size,video.length);
  await second.stop();

  // The user's screenshot has a tiny play triangle at the top-right of
  // the video thumbnail. Click that control to open the player, not merely
  // the static image in the centre of the card.
  await page.setContent([
    '<style>.video-card{width:480px;height:240px;position:relative}',
    '.video-preview{width:480px;height:240px;display:block}',
    '#play-button{position:absolute;top:4px;right:4px;width:25px;height:25px}',
    '</style><main id="feed"></main>'
  ].join(''));
  const playback=await watchNewVideoCompletion(page);
  await page.evaluate(()=>{
    document.querySelector('#feed').innerHTML=[
      '<article><p>你的视频生成好了。</p>',
      '<div class="video-card"><img class="video-preview" ',
      'src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=">',
      '<button id="play-button" aria-label="播放视频">▶</button></div></article>'
    ].join('');
    document.querySelector('#play-button').onclick=()=>{
      document.body.dataset.playedNewVideo='yes';
    };
  });
  assert.equal(await playback.completed(),true);
  const playCard=await findFreshVideoCard(page);
  assert.ok(playCard);
  assert.equal(await openFreshVideoPreview(playCard),true);
  assert.equal(await page.locator('body').getAttribute('data-played-new-video'),'yes');
  await playback.stop();

  // When the card's player exposes its fresh video ID but Download never
  // appears, request only that video's signed link using the authenticated
  // page context (no copied cookies, no old HAR authorization).
  const vid='v0d69cg10004dbj1jci7dld3u39lu4pg';
  const signed='https://media.doubao.com/mock/video.mp4?sample=1';
  await page.route('https://www.doubao.com/chat/',route=>route.fulfill({
    status:200,contentType:'text/html',body:'<main>Mock logged-in Doubao</main>'
  }));
  let signedRequests=0;
  await page.route('https://www.doubao.com/creativity/resource/get_without_watermark',
    route=>{
      signedRequests++;
      assert.equal(route.request().method(),'POST');
      assert.deepEqual(route.request().postDataJSON(),{vid:[vid]});
      return route.fulfill({status:200,contentType:'application/json',
        body:JSON.stringify({data:{download_video:{
          [vid]:{download_url:signed}
        }}})});
    });
  await page.goto('https://www.doubao.com/chat/',{waitUntil:'domcontentloaded'});
  assert.equal(await requestCurrentVideoDownloadLink(page,vid),signed);
  assert.equal(signedRequests,1);
  assert.equal(await requestCurrentVideoDownloadLink(page,'invalid'),null);
  assert.equal(signedRequests,1,'Invalid video IDs must not reach the API');
  console.log('PASS: fresh success recognized, old/user messages ignored, hover/modal MP4 download, fresh video ID requests signed link in browser session');
}finally{
  await browser.close();
  fs.rmSync(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
