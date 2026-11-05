import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountDoubaoRoutes } from './doubao.mjs';
import { preserveCompletedVideoMedia } from './doubao-project.mjs';
import {mountMuseRoutes} from './muse.mjs';
import {preserveMuseCompletedMedia} from './muse-project.mjs';
import {extractVideoLastFrame,extractVideoFrameAt} from './video-last-frame.mjs';
import {mountH3Routes} from './yuanbo-h3.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
const uploadDir = path.join(root, 'uploads');
const dbFile = path.join(dataDir, 'projects.json');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, '[]', 'utf8');
const app = express();
app.use(express.json({ limit: '15mb' }));
app.disable('x-powered-by');
// Prevent unrelated web pages from issuing credential-related requests against
// this loopback API using the logged-in user's browser.
app.use(['/api/doubao','/api/muse'],(req,res,next)=>{
  const host=req.headers.host||'';
  if(!['127.0.0.1:3701','localhost:3701'].includes(host))
    return res.status(403).json({error:'仅允许本机访问账号接口'});
  if(req.headers['sec-fetch-site']==='cross-site')
    return res.status(403).json({error:'拒绝跨站访问账号接口'});
  if(['POST','PUT','PATCH','DELETE'].includes(req.method)){
    const origin=req.headers.origin;
    if(origin&&!['http://127.0.0.1:5173','http://localhost:5173',
      'http://127.0.0.1:3701'].includes(origin))return res.status(403).json({error:'不允许跨站调用本地账号接口'});
  }
  next();
});
const read = () => JSON.parse(fs.readFileSync(dbFile, 'utf8'));
const write = items => {
  const temporary = dbFile + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(items, null, 2));
  fs.renameSync(temporary, dbFile);
};
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12);
      cb(null, crypto.randomUUID() + ext);
    }
  }),
  limits: { fileSize: 250 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^(image|video|audio)\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image, video and audio uploads are supported'));
  }
});

app.get('/api/health', (_req, res) => res.json({
  ok:true,mode:'local-canvas',aiProviders:0,
  browserBridges:['doubao-seedance-v2','muse-edge-chat'],
  museBridgeRevision:'quota-auto-v6-image-resolution',
  museMediaRevision:'fresh-chat-media-v2',
  audioReferenceRevision:'mixed-media-v1',
  audioMp4Revision:'mp3-to-mp4-v1',
  referenceSelectionRevision:'at-order-v2',
  multiImageUploadRevision:'v3-prompt-first',
  videoModelRevision:'mini-fast-v1',
  videoStartRevision:'reply-prefix-v1',
  videoDownloadRevision:'completed-card-v1',
  liveVideoGenerationVerified:false,
  workspaceId:crypto.createHash('sha256').update(
    process.platform==='win32'?path.resolve(root,'..').toLowerCase():
      path.resolve(root,'..')
  ).digest('hex').slice(0,16)
}));
app.get('/api/projects', (_req, res) => {
  res.json(read().map(({ id, title, updatedAt }) => ({ id, title, updatedAt })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
});
app.post('/api/projects', (req, res) => {
  const project = {
    id: crypto.randomUUID(),
    title: String(req.body.title || '未命名画布').slice(0, 100),
    nodes: Array.isArray(req.body.nodes) ? req.body.nodes : [],
    edges: Array.isArray(req.body.edges) ? req.body.edges : [],
    viewport: req.body.viewport || { x: 0, y: 0, zoom: 1 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const items = read();
  items.push(project);
  write(items);
  res.status(201).json(project);
});
app.get('/api/projects/:id', (req, res) => {
  const found = read().find(x => x.id === req.params.id);
  if (!found) return res.status(404).json({ error: 'Project not found' });
  res.json(found);
});
app.put('/api/projects/:id', (req, res) => {
  const items = read();
  const idx = items.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Project not found' });
  const old = items[idx];
  const updated = {
    ...old,
    title: typeof req.body.title === 'string' ? req.body.title.slice(0, 100) : old.title,
    nodes: Array.isArray(req.body.nodes)
      ?preserveMuseCompletedMedia(old,preserveCompletedVideoMedia(old,req.body.nodes))
      :old.nodes,
    edges: Array.isArray(req.body.edges) ? req.body.edges : old.edges,
    viewport: req.body.viewport || old.viewport,
    updatedAt: new Date().toISOString()
  };
  items[idx] = updated;
  write(items);
  res.json({ id: updated.id, updatedAt: updated.updatedAt });
});
app.delete('/api/projects/:id', (req, res) => {
  const items = read();
  if (!items.some(x => x.id === req.params.id)) return res.status(404).json({ error: 'Project not found' });
  write(items.filter(x => x.id !== req.params.id));
  res.status(204).end();
});
app.post('/api/assets', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.status(201).json({
    id: crypto.randomUUID(),
    name: req.file.originalname,
    mime: req.file.mimetype,
    url: '/api/uploads/' + req.file.filename,
    size: req.file.size
  });
});
app.post('/api/videos/extract-last-frame',async(req,res,next)=>{
  const origin=req.headers.origin;
  if(req.headers['sec-fetch-site']==='cross-site'||
    (origin&&!['http://127.0.0.1:5173','http://localhost:5173',
      'http://127.0.0.1:3701'].includes(origin)))
    return res.status(403).json({error:'不允许跨站提取视频尾帧'});
  try{
    res.status(201).json(await extractVideoLastFrame(req.body?.mediaUrl,{uploadDir}));
  }catch(error){
    const message=error instanceof Error?error.message:'尾帧提取失败';
    if(/请先生成|不存在|为空或不可读取/.test(message))
      return res.status(400).json({error:message});
    next(error);
  }
});
app.post('/api/videos/extract-frame',async(req,res,next)=>{
  const origin=req.headers.origin;
  if(req.headers['sec-fetch-site']==='cross-site'||
    (origin&&!['http://127.0.0.1:5173','http://localhost:5173',
      'http://127.0.0.1:3701'].includes(origin)))
    return res.status(403).json({error:'不允许跨站提取视频帧'});
  try{
    res.status(201).json(await extractVideoFrameAt(
      req.body?.mediaUrl,req.body?.seconds,{uploadDir}
    ));
  }catch(error){
    const message=error instanceof Error?error.message:'指定帧提取失败';
    if(/请先生成|不存在|为空或不可读取|时间点无效|所选时间点/.test(message))
      return res.status(400).json({error:message});
    next(error);
  }
});
app.use('/api/uploads', express.static(uploadDir, { dotfiles: 'deny' }));
mountDoubaoRoutes(app,read,write);
mountMuseRoutes(app,read,write);
mountH3Routes(app,read,write,{dataDir,uploadDir});
function planWorkflow(nodes, edges) {
  const lookup = new Map(nodes.map(x => [x.id, x]));
  const indegree = new Map(nodes.map(x => [x.id, 0]));
  const next = new Map(nodes.map(x => [x.id, []]));
  for (const e of edges) {
    if (!lookup.has(e.source) || !lookup.has(e.target)) continue;
    indegree.set(e.target, indegree.get(e.target) + 1);
    next.get(e.source).push(e.target);
  }
  const queue = [...nodes.filter(x => indegree.get(x.id) === 0).map(x => x.id)];
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const to of next.get(id)) {
      indegree.set(to, indegree.get(to) - 1);
      if (indegree.get(to) === 0) queue.push(to);
    }
  }
  if (order.length !== nodes.length) return { valid: false, error: '工作流包含循环依赖，请先删除循环连线。' };
  return {
    valid: true,
    order,
    steps: order.filter(id => !lookup.get(id).data?.bypass).map(id => ({ id, kind: lookup.get(id).data?.kind })),
    skipped: order.filter(id => lookup.get(id).data?.bypass)
  };
}
app.post('/api/workflow/plan', (req, res) => {
  const nodes = Array.isArray(req.body.nodes) ? req.body.nodes : [];
  const edges = Array.isArray(req.body.edges) ? req.body.edges : [];
  const plan = planWorkflow(nodes, edges);
  res.status(plan.valid ? 200 : 422).json(plan);
});
app.use((err, _req, res, _next) => res.status(400).json({ error: err.message || 'Request failed' }));
app.listen(3701, '127.0.0.1', () => console.log('Local API ready: http://127.0.0.1:3701'));
