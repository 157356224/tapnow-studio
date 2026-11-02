import fs from 'node:fs';
import path from 'node:path';
const windowsEdge=[
  path.join(process.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Microsoft','Edge','Application','msedge.exe'),
  path.join(process.env.PROGRAMFILES||'C:\\Program Files','Microsoft','Edge','Application','msedge.exe')
];
export function accountEngine(){
  return 'edge';
}

// Preserve historic portable Chrome profiles; Edge never reuses old Chrome data.
export function accountProfileDir(base,account){
  return path.join(base,account.id+'-edge');
}

export function nativeBrowserExecutable(engine='edge'){
  if(engine!=='edge')throw new Error('仅支持系统 Microsoft Edge 浏览器');
  const binary=windowsEdge.find(file=>fs.existsSync(file));
  if(binary)return binary;
  throw new Error('没有找到系统 Microsoft Edge，请安装或修复 Edge');
}

export function browserLaunchOptions(){
  nativeBrowserExecutable();
  return {chromiumSandbox:true,channel:'msedge'};
}
