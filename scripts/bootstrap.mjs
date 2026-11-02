import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bootstrap} from './bootstrap-core.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{
  bootstrap({root});
}catch(error){
  console.error('[TapNow Update] 启动准备失败：'+error.message);
  process.exitCode=1;
}
