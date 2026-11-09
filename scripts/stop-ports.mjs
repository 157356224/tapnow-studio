import {releasePorts} from './ports-core.mjs';

try{
  await releasePorts();
}catch(error){
  console.error('[TapNow] 自动释放服务端口失败：'+error.message);
  process.exitCode=1;
}
