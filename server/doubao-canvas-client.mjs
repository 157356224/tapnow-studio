// Single-session Doubao Canvas client, ported from the supplied Python sample.
// No account profiles, resolution upgrades or anonymous-identity rotation.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {setTimeout as pause} from 'node:timers/promises';

export const CANVAS_BASE='https://www.doubao.com';
const DEVICE_ID='3813542872529774';
const QUERY='version_code=20800&language=zh&device_platform=web&doubao_device_platform=desktop'+
  '&aid=582478&real_aid=582478&pkg_type=release_version&device_id='+DEVICE_ID+
  '&pc_version=2.32.6&doubao_pc_version=2.32.6&region=CN&sys_region=CN'+
  '&samantha_web=1&web_platform=desktop&use-olympus-account=1&runtime=web'+
  '&runtime_version=3.41.3&client_platform=pc_client'+
  '&chromium_version=147.0.7727.149&channel=win';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '+
  '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Samantha';
const MAX_IMAGE=20*1024*1024;
const MAX_VIDEO=250*1024*1024;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const hmac=(key,value)=>crypto.createHmac('sha256',key).update(value).digest();
const encode=value=>encodeURIComponent(String(value))
  .replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());

export function signImagexRequest(method,pathname,params,credentials,now=new Date()){
  const amz=now.toISOString().replace(/[-:]|\.\d{3}/g,'');
  const day=amz.slice(0,8);
  const query=[...params].sort(([ak,av],[bk,bv])=>
    ak<bk?-1:ak>bk?1:av<bv?-1:av>bv?1:0)
    .map(([key,value])=>encode(key)+'='+encode(value)).join('&');
  const signed='x-amz-date;x-amz-security-token';
  const canonical=[method,pathname,query,
    'x-amz-date:'+amz+'\nx-amz-security-token:'+credentials.token+'\n',
    signed,hash(Buffer.alloc(0))].join('\n');
  const scope=day+'/cn-north-1/imagex/aws4_request';
  const message=['AWS4-HMAC-SHA256',amz,scope,hash(canonical)].join('\n');
  let key=hmac('AWS4'+credentials.sk,day);
  for(const part of ['cn-north-1','imagex','aws4_request'])key=hmac(key,part);
  const signature=hmac(key,message).toString('hex');
  return {
    authorization:'AWS4-HMAC-SHA256 Credential='+credentials.ak+'/'+scope+
      ', SignedHeaders='+signed+', Signature='+signature,
    amz,query
  };
}

const crcTable=Array.from({length:256},(_,i)=>{
  let value=i;
  for(let j=0;j<8;j++)value=(value&1)?0xedb88320^(value>>>1):value>>>1;
  return value>>>0;
});
export function crc32(buffer){
  let value=0xffffffff;
  for(const byte of buffer)value=crcTable[(value^byte)&255]^(value>>>8);
  return ((value^0xffffffff)>>>0).toString(16).padStart(8,'0');
}

export function imageDimensions(bytes){
  if(bytes.length>=24&&bytes[0]===0x89&&
     bytes.subarray(1,4).toString()==='PNG'){
    return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),format:'png'};
  }
  if(bytes.length>12&&bytes[0]===255&&bytes[1]===216){
    let offset=2;
    while(offset+9<bytes.length){
      if(bytes[offset]!==255){offset++;continue;}
      const marker=bytes[offset+1];
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]
        .includes(marker))
        return {width:bytes.readUInt16BE(offset+7),
          height:bytes.readUInt16BE(offset+5),format:'jpeg'};
      if(marker===0xd8||marker===0xd9){offset+=2;continue;}
      const size=bytes.readUInt16BE(offset+2);
      if(size<2)break;
      offset+=2+size;
    }
  }
  if(bytes.length>=30&&bytes.toString('ascii',0,4)==='RIFF'&&
     bytes.toString('ascii',8,12)==='WEBP'){
    const variant=bytes.toString('ascii',12,16);
    if(variant==='VP8X')return {width:bytes.readUIntLE(24,3)+1,
      height:bytes.readUIntLE(27,3)+1,format:'webp'};
    if(variant==='VP8 '&&bytes.length>=30)return {
      width:bytes.readUInt16LE(26)&0x3fff,height:bytes.readUInt16LE(28)&0x3fff,
      format:'webp'
    };
    if(variant==='VP8L'&&bytes.length>=25)return {
      width:1+bytes[21]+((bytes[22]&0x3f)<<8),
      height:1+(bytes[22]>>6)+(bytes[23]<<2)+((bytes[24]&0x0f)<<10),
      format:'webp'
    };
  }
  throw new Error('参考图片格式无效，仅支持 PNG、JPEG、WebP');
}

function externalURL(value,{allowHttp=false}={}){
  const url=new URL(value);
  const host=url.hostname.toLowerCase().replace(/\.$/,'').replace(/^\[|\]$/g,'');
  const parts=host.split('.').map(Number);
  const ipv4=parts.length===4&&parts.every(part=>Number.isInteger(part)&&
    part>=0&&part<=255);
  const reservedIP=ipv4&&(
    parts[0]===0||parts[0]===10||parts[0]===127||parts[0]>=224||
    parts[0]===169&&parts[1]===254||
    parts[0]===172&&parts[1]>=16&&parts[1]<=31||
    parts[0]===192&&parts[1]===168||
    parts[0]===100&&parts[1]>=64&&parts[1]<=127);
  if((url.protocol!=='https:'&&(!allowHttp||url.protocol!=='http:'))||
     reservedIP||host==='localhost'||host.endsWith('.localhost')||
     host.endsWith('.local')||host.endsWith('.internal')||
     host.includes(':')||!host.includes('.')||
     url.username||url.password)
    throw new Error('返回了无效的外部资源地址');
  return url;
}

function checked(data,stage){
  if(data?.code!==0)
    throw new Error(stage+'失败：code='+data?.code+' msg='+String(data?.msg||'').slice(0,200));
  return data;
}
const randomTag=(length=8)=>crypto.randomBytes(Math.ceil(length/2))
  .toString('hex').slice(0,length);

export class DoubaoCanvasClient{
  constructor({fetchImpl=globalThis.fetch,base=CANVAS_BASE,signal,onStage=()=>{},
    pollMs=8000,maxMinutes=15}={}){
    this.fetchImpl=fetchImpl;
    this.base=base;
    this.signal=signal;
    this.onStage=onStage;
    this.pollMs=pollMs;
    this.maxMinutes=maxMinutes;
    this.cookies=new Map();
  }
  checkStop(){
    if(this.signal?.aborted)throw new Error('用户已停止豆包画布任务');
  }
  async request(url,{method='GET',body,headers={},timeoutMs=45000}={}){
    this.checkStop();
    let current=new URL(url);
    for(let redirect=0;redirect<5;redirect++){
      const isDoubao=current.hostname==='www.doubao.com'||
        current.hostname.endsWith('.doubao.com');
      const cookie=isDoubao?[...this.cookies].map(([k,v])=>k+'='+v).join('; '):'';
      const requestHeaders={
        'user-agent':UA,referer:this.base+'/',accept:'*/*',
        ...(cookie?{cookie}:{}),...headers
      };
      const signal=this.signal
        ?AbortSignal.any([this.signal,AbortSignal.timeout(timeoutMs)])
        :AbortSignal.timeout(timeoutMs);
      let response;
      try{
        response=await this.fetchImpl(current,{method,body,headers:requestHeaders,
          redirect:'manual',signal});
      }catch(error){
        if(this.signal?.aborted)throw new Error('用户已停止豆包画布任务');
        throw new Error('豆包网络请求失败：'+error.message);
      }
      if(isDoubao){
        const cookies=response.headers.getSetCookie?.()||
          (response.headers.get('set-cookie')?[response.headers.get('set-cookie')]:[]);
        for(const item of cookies){
          const first=item.split(';',1)[0];
          const index=first.indexOf('=');
          if(index>0)this.cookies.set(first.slice(0,index),first.slice(index+1));
        }
      }
      if([301,302,303,307,308].includes(response.status)){
        const location=response.headers.get('location');
        if(!location)throw new Error('豆包重定向缺少地址');
        const next=externalURL(new URL(location,current).href);
        if(next.origin!==current.origin){
          if(method!=='GET')throw new Error('拒绝跨域重定向上传请求');
          for(const name of ['authorization','cookie','x-amz-security-token',
            'x-amz-date'])delete headers[name];
        }
        current=next;
        if(response.status===303||[301,302].includes(response.status)&&method==='POST'){
          method='GET';body=undefined;
        }
        continue;
      }
      return response;
    }
    throw new Error('豆包网络重定向次数过多');
  }
  async json(url,payload,{method='POST',headers={},timeoutMs=45000}={}){
    const response=await this.request(url,{method,
      body:payload===undefined?undefined:JSON.stringify(payload),timeoutMs,
      headers:{accept:'application/json, text/plain, */*',
        ...(payload===undefined?{}:{'content-type':'application/json'}),...headers}});
    const body=await response.text();
    try{
      const data=JSON.parse(body);
      if(!data||typeof data!=='object')throw new Error('not an object');
      return data;
    }catch{
      throw new Error('豆包 HTTP '+response.status+' 返回非 JSON：'+body.slice(0,160));
    }
  }
  async handshake(){
    this.onStage('建立豆包画布匿名会话',5);
    const response=await this.request(this.base+'/',{timeoutMs:25000});
    if(response.status>=400)throw new Error('匿名会话初始化失败：HTTP '+response.status);
    await response.arrayBuffer();
  }
  canvasPost(route,request,timeoutMs=45000){
    return this.json(this.base+route+'?'+QUERY,{req:request},{timeoutMs});
  }
  async uploadImages(files){
    if(!files.length)return [];
    this.onStage('正在获取参考图上传凭据',10);
    const prepared=checked(await this.json(this.base+'/alice/resource/prepare_upload?'+QUERY,
      {tenant_id:'5',scene_id:'5',resource_type:2}),'prepare_upload').data;
    const auth=prepared.upload_auth_token;
    const credentials={serviceId:prepared.service_id,
      ak:auth.access_key,sk:auth.secret_key,token:auth.session_token};
    const result=[];
    for(let i=0;i<files.length;i++){
      this.checkStop();
      const file=files[i];
      const bytes=fs.readFileSync(file);
      if(!bytes.length||bytes.length>MAX_IMAGE)
        throw new Error('单张参考图必须小于 20MB');
      const info=imageDimensions(bytes);
      const extension=path.extname(file).slice(1).toLowerCase()||
        (info.format==='jpeg'?'jpg':info.format);
      this.onStage('上传参考图 '+(i+1)+'/'+files.length,
        12+Math.round(i/files.length*24));
      const params=[['Action','ApplyImageUpload'],['Version','2018-08-01'],
        ['ServiceId',String(credentials.serviceId)],['NeedFallback','true'],
        ['FileSize',String(bytes.length)],['FileExtension','.'+extension],
        ['s',randomTag(10)]];
      const signed=signImagexRequest('GET','/top/v1',params,credentials);
      const apply=await this.json(this.base+'/top/v1?'+signed.query,undefined,
        {method:'GET',headers:{authorization:signed.authorization,
          'x-amz-date':signed.amz,'x-amz-security-token':credentials.token}});
      const address=apply?.Result?.UploadAddress;
      const store=address?.StoreInfos?.[0],host=address?.UploadHosts?.[0];
      if(!store?.StoreUri||!host)throw new Error('ApplyImageUpload 未返回上传地址');
      const target=externalURL('https://'+host+'/upload/v1/'+store.StoreUri);
      const uploaded=await this.request(target.href,{method:'POST',body:bytes,timeoutMs:180000,
        headers:{authorization:store.Auth,'content-type':'application/octet-stream',
          'content-crc32':crc32(bytes),'x-storage-u':''}});
      const response=await uploaded.text();
      if(uploaded.status!==200||!/"code"\s*:\s*2000/.test(response))
        throw new Error('上传图片失败：HTTP '+uploaded.status+' '+response.slice(0,180));
      checked(await this.json(this.base+'/alice/resource/register?'+QUERY,{
        tenant_id:'5',scene_id:'148',resource_list:[{
          uri:store.StoreUri,resource_type:2,meta:{image_meta:{
            data:{md5:'',identifier:'toolbar:'+store.StoreUri.split('/').at(-1)+':0:0'},
            parse_extra:{},image_info:{width:info.width,height:info.height,
              format:info.format,size:bytes.length,file_name:path.basename(file)}
          }}
        }]
      }),'register');
      result.push({uri:store.StoreUri,url:'',width:info.width,height:info.height});
    }
    const signed=checked(await this.json(this.base+'/alice/resource/v2/sign_url?'+QUERY,{
      params:result.map(ref=>({uri:ref.uri,resource_type:2})),encrypted:false
    }),'sign_url').data||[];
    for(const item of signed){
      const uri=item?.param?.uri||item?.uri;
      const ref=result.find(entry=>entry.uri===uri);
      if(ref)ref.url=item.main_url||'';
    }
    if(result.some(ref=>!ref.url))throw new Error('sign_url 未返回完整参考图地址');
    return result;
  }
  async createWorkspace(){
    this.onStage('正在创建豆包画布',40);
    const result=checked(await this.canvasPost('/creativity/canvas_workspace/doc/create',{
      conversation_id:'0',title:'TapNow 豆包画布生成',initial_assets:[],
      create_new_conversation:true,conversation_init_ext:'{}'
    }),'创建画布').data;
    return {workspace:result.snapshot.canvas_workspace_id,
      conversation:result.conversation_id};
  }
  async getDoc(workspace,conversation){
    const result=checked(await this.canvasPost('/creativity/canvas_workspace/doc/get',{
      conversation_id:conversation,canvas_workspace_id:workspace,
      item_ids:[],need_idgen_session:true
    }),'读取画布').data;
    return {version:Number(result.snapshot.version),
      idgen:result.idgen_session||'',items:result.snapshot.doc?.items||{}};
  }
  async addVideoNode(workspace,conversation){
    this.onStage('正在创建视频节点',45);
    const doc=await this.getDoc(workspace,conversation);
    const node={id:randomTag()+'-'+doc.idgen+'-0202',type:102,title:'视频',
      frame_id:'',transform:{x:0,y:0,width:1440,height:2560,
        rotation:0,z_index:0,flip_horizontal:false,flip_vertical:false},
      status:1,version:1,created_by:2,ext:{},
      asset:{asset_key:'',asset_short_url:'',type:2,ext:{},status:0,video_info:{}}};
    const response=checked(await this.canvasPost('/creativity/canvas_workspace/doc/actions',{
      conversation_id:conversation,canvas_workspace_id:workspace,
      base_version:String(doc.version),
      actions:[{type:101,base_version:String(doc.version),target_item:node}]
    }),'创建视频节点');
    const first=response.data?.results?.[0]||{};
    if(first.result_msg&&first.result_msg!=='success')
      throw new Error('创建视频节点被拒：'+first.result_msg);
    return first.result_item||node;
  }
  async submit(workspace,conversation,node,prompt,refs,duration,ratio){
    this.onStage('提交 Seedance 2.0 画布任务',50);
    const doc=await this.getDoc(workspace,conversation);
    const current=doc.items[node.id]||node;
    const operation={
      canvas_type:50,generate_type:1,prompt,
      attachments:refs.map((ref,i)=>({
        attachment_type:1,image:{uri:ref.uri,url:ref.url,
          width:ref.width,height:ref.height},prompt_placeholder:'{{ref:'+(i+1)+'}}'
      })),
      use_model:'seedance_v2.0',video_param:{duration,ratio}
    };
    return checked(await this.canvasPost('/creativity/canvas_workspace/tool/exec',{
      canvas_workspace_id:workspace,biding_item:current,
      execute_request:{request_id:'canvas-video:'+current.id+':'+crypto.randomUUID(),
        operation,canvas_context:{conversation_id:conversation,
          trigger_scene:'infinite_canvas_video_generator'}},
      callback_args:crypto.randomUUID(),workspace_version:String(doc.version)
    },60000),'提交生成');
  }
  async nodeStatus(workspace,conversation,nodeId){
    const doc=await this.getDoc(workspace,conversation);
    const asset=doc.items[nodeId]?.asset||{};
    const info=asset.video_info||{};
    const vid=info.vid||(
      asset.asset_key&&!String(asset.asset_key).startsWith('task:')
        ?asset.asset_key:'');
    if(vid)return {state:'done',asset};
    if(asset.status===3)return {
      state:'failed',asset,message:asset.gen_task_info?.message||''};
    return {state:'running',asset};
  }
  static videoURL(info){
    let model=info?.video_model;
    if(typeof model==='string'){try{model=JSON.parse(model);}catch{model=null;}}
    for(const value of Object.values(model?.video_list||{})){
      if(!value?.main_url)continue;
      try{
        const decoded=Buffer.from(value.main_url,'base64').toString('utf8');
        if(/^https?:\/\//.test(decoded))return decoded;
      }catch{}
    }
    return /^https?:\/\//.test(info?.download_url||'')?info.download_url:'';
  }
  async downloadVideo(url,uploadDir){
    this.onStage('下载生成视频',95);
    const destination=path.join(uploadDir,crypto.randomUUID()+'.mp4');
    const temporary=destination+'.part';
    let count=0;
    try{
      const response=await this.request(externalURL(url,{allowHttp:true}).href,
        {timeoutMs:120000});
      if(!response.ok||!response.body)
        throw new Error('视频下载失败：HTTP '+response.status);
      const expected=Number(response.headers.get('content-length')||0);
      if(expected>MAX_VIDEO)throw new Error('生成视频超过 250MB');
      const limiter=new Transform({transform(chunk,encoding,callback){
        count+=chunk.length;
        callback(count>MAX_VIDEO?new Error('生成视频超过 250MB'):null,chunk);
      }});
      await pipeline(Readable.fromWeb(response.body),limiter,
        fs.createWriteStream(temporary),...(this.signal?[{signal:this.signal}]:[]));
      if(!count||(expected&&count!==expected))
        throw new Error('视频下载不完整');
      fs.renameSync(temporary,destination);
      return '/api/uploads/'+path.basename(destination);
    }catch(error){
      fs.rmSync(temporary,{force:true});
      throw error;
    }
  }
  async generateOnce({prompt,images=[],duration,ratio,uploadDir}){
    await this.handshake();
    const refs=await this.uploadImages(images);
    const {workspace,conversation}=await this.createWorkspace();
    const node=await this.addVideoNode(workspace,conversation);
    await this.submit(workspace,conversation,node,prompt,refs,duration,ratio);
    this.onStage('画布任务运行中',60);
    const end=Date.now()+this.maxMinutes*60000;
    let failureAt=0,failedMessage='';
    while(Date.now()<end){
      this.checkStop();
      const status=await this.nodeStatus(workspace,conversation,node.id);
      if(status.state==='done'){
        const info=status.asset.video_info||{};
        const primary=DoubaoCanvasClient.videoURL(info);
        if(!primary)throw new Error('服务器已出片，但未返回视频下载地址');
        try{return await this.downloadVideo(primary,uploadDir);}
        catch(error){
          const fallback=info.download_url;
          if(!fallback||fallback===primary)throw error;
          this.onStage('主地址下载失败，尝试备用地址',95);
          return this.downloadVideo(fallback,uploadDir);
        }
      }
      if(status.state==='failed'){
        if(!failureAt){failureAt=Date.now();failedMessage=status.message;}
        else if(Date.now()-failureAt>=30000)
          throw new Error('豆包画布生成失败：'+(status.message||failedMessage||'未知原因'));
      }else failureAt=0;
      await pause(this.pollMs,undefined,{signal:this.signal});
    }
    throw new Error('豆包画布生成超时（'+this.maxMinutes+' 分钟）');
  }
}
