import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, readdirSync, unlinkSync, chmodSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';

type Subtask = { id: string; title: string; done: boolean };
type Task = { id: string; title: string; description: string; status: string; priority: string; due_at: string | null; due_explicit: number; tags: string[]; source_type: string; source_image_id: string | null; source_name: string; requested_by: string; assignee: string; subtasks: Subtask[]; ai_analysis: string; notes: string; urgent: number; created_at: string; updated_at: string; completed_at: string | null; x: number; y: number; width: number; height: number };
const args = process.argv.slice(2);
const devMode = args.includes('--dev') || process.env.npm_lifecycle_event === 'dev';
const valueAfter = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
if (args.includes('--help')) {
  console.log('TaskPaste\n用法: taskpaste [--port 4317] [--data-dir 路径] [--no-open] [--help]');
  process.exit(0);
}
const dataDir = resolve(valueAfter('--data-dir') || process.env.AI_TODO_DATA_DIR || join(homedir(), '.ai-todo'));
const portOption = Number(valueAfter('--port') || process.env.PORT || 4317);
if (!Number.isInteger(portOption) || portOption < 1 || portOption > 65535) throw new Error('端口必须在 1–65535 之间');
for (const dir of ['data', 'attachments/screenshots', 'config', 'backups', 'logs']) mkdirSync(join(dataDir, dir), { recursive: true });
const db = new DatabaseSync(join(dataDir, 'data/ai-todo.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'medium', due_at TEXT, tags TEXT NOT NULL DEFAULT '[]', source_type TEXT NOT NULL DEFAULT 'manual', source_image_id TEXT, ai_analysis TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', urgent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, x REAL NOT NULL DEFAULT -1, y REAL NOT NULL DEFAULT -1, width REAL NOT NULL DEFAULT 260, height REAL NOT NULL DEFAULT 210);
CREATE TABLE IF NOT EXISTS task_details (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, source_name TEXT NOT NULL DEFAULT '', requested_by TEXT NOT NULL DEFAULT '', assignee TEXT NOT NULL DEFAULT '', due_explicit INTEGER NOT NULL DEFAULT 0, subtasks TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, path TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, recognized_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shortcuts (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, icon TEXT NOT NULL DEFAULT 'link', sort_order INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
if (!db.prepare("SELECT 1 FROM settings WHERE key='shortcuts_seeded_v1'").get()) {
  const defaults = [
    ['Codex','command','','⌘'],
    ['ChatGPT','web','https://chatgpt.com','◎'],
    ['Gemini','web','https://gemini.google.com','✦'],
    ['GitLab','web','https://gitlab.com','◆'],
    ['Slack','web','https://app.slack.com','✣'],
    ['Notion','web','https://notion.so','N'],
  ];
  db.exec('BEGIN');
  try {
    for (const [index, item] of defaults.entries()) {
      if (!db.prepare('SELECT 1 FROM shortcuts WHERE lower(name)=lower(?)').get(item[0])) {
        db.prepare('INSERT INTO shortcuts VALUES (?,?,?,?,?,?)').run(randomUUID(),item[0],item[1],item[2],item[3],(index+1)*10);
      }
    }
    db.prepare("INSERT INTO settings (key,value) VALUES ('shortcuts_seeded_v1','1')").run();
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
const configPath = join(dataDir, 'config/models.json');
const json = (file: string, fallback: unknown) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
type ModelProvider = 'deepseek' | 'openai' | 'gemini-fastapi';
type ModelConfig = { provider: ModelProvider; baseUrl: string; model: string; apiKey: string };
const compatibleBaseUrl = (raw: string, provider: ModelProvider = 'deepseek') => {
  const url = new URL(raw.trim());
  if (provider === 'gemini-fastapi' && url.pathname === '/') url.pathname = '/v1';
  if (provider === 'openai' && url.hostname === 'generativelanguage.googleapis.com' && url.pathname.replace(/\/$/, '') === '/v1beta') url.pathname = '/v1beta/openai';
  return url.toString().replace(/\/$/, '');
};
const modelConfig = () => {
  const saved = json(configPath, { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: '' }) as Partial<ModelConfig>;
  const provider: ModelProvider = saved.provider === 'gemini-fastapi' ? 'gemini-fastapi' : saved.provider === 'openai' ? 'openai' : 'deepseek';
  const config: ModelConfig = { provider, baseUrl: saved.baseUrl || (provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1'), model: saved.model || (provider === 'deepseek' ? 'deepseek-flash' : ''), apiKey: saved.apiKey || '' };
  try { return { ...config, baseUrl: compatibleBaseUrl(config.baseUrl, provider) }; } catch { return config; }
};
const modelReady = (c: ModelConfig) => Boolean(c.model && (c.provider === 'gemini-fastapi' || c.apiKey));
const providerHeaders = (c: ModelConfig) => ({ 'Content-Type': 'application/json', ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}) });
async function providerError(response: globalThis.Response, apiKey: string) {
  const raw = (await response.text()).slice(0, 2000);
  let detail = raw;
  try {
    const body = JSON.parse(raw) as { error?: { message?: string; status?: string; code?: string | number } | string; message?: string; detail?: string };
    if (typeof body.error === 'string') detail = body.error;
    else if (body.error) detail = [body.error.status || body.error.code, body.error.message].filter(Boolean).join('：');
    else if (body.message) detail = body.message;
    else if (body.detail) detail = body.detail;
  } catch { /* Non-JSON response from provider. */ }
  detail = (apiKey ? detail.split(apiKey).join('[已隐藏密钥]') : detail).replace(/([?&](?:key|api_key)=)[^&\s]+/gi, '$1[已隐藏密钥]').slice(0, 700);
  return `模型服务 HTTP ${response.status}${detail ? `：${detail}` : ''}`;
}
async function providerFetch(url: string, options: RequestInit, timeoutMs: number) {
  try { return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (error) {
    if ((error as Error).name === 'TimeoutError') throw new Error(`模型服务超过 ${Math.round(timeoutMs / 1000)} 秒未响应，请重试或更换模型`);
    throw new Error(`无法连接模型服务：${(error as Error).message}`);
  }
}
const now = () => new Date().toISOString();
const todayEnd = () => { const d=new Date(); d.setHours(23,59,0,0); return d.toISOString(); };
const cleanTask = (row: Record<string, unknown>) => ({ ...row, tags: JSON.parse(String(row.tags || '[]')), subtasks: JSON.parse(String(row.subtasks || '[]')), source_name: String(row.source_name || ''), requested_by: String(row.requested_by || ''), assignee: String(row.assignee || ''), due_explicit: Number(row.due_explicit || 0) });
const taskSelect = 'SELECT tasks.*, attachments.recognized_text, task_details.source_name, task_details.requested_by, task_details.assignee, task_details.due_explicit, task_details.subtasks FROM tasks LEFT JOIN attachments ON attachments.id=tasks.source_image_id LEFT JOIN task_details ON task_details.task_id=tasks.id';
const taskRows = () => db.prepare(`${taskSelect} ORDER BY tasks.created_at DESC`).all().map(r => cleanTask(r as Record<string, unknown>));
const getTask = (id: string) => { const row = db.prepare(`${taskSelect} WHERE tasks.id=?`).get(id); return row ? cleanTask(row as Record<string, unknown>) : null; };
const saveTaskDetails = (id:string, t:ReturnType<typeof taskFields>) => db.prepare('INSERT INTO task_details (task_id,source_name,requested_by,assignee,due_explicit,subtasks) VALUES (?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET source_name=excluded.source_name,requested_by=excluded.requested_by,assignee=excluded.assignee,due_explicit=excluded.due_explicit,subtasks=excluded.subtasks').run(id,t.source_name,t.requested_by,t.assignee,t.due_explicit,t.subtasks);
const validStatus = ['todo', 'in_progress', 'done'];
const validPriority = ['low', 'medium', 'high'];
function taskFields(input: Record<string, unknown>, prior?: Task) {
  const title = String(input.title ?? prior?.title ?? '').trim().slice(0, 200);
  if (!title) throw new Error('请输入任务标题');
  const status = String(input.status ?? prior?.status ?? 'todo');
  const priority = String(input.priority ?? prior?.priority ?? 'medium');
  if (!validStatus.includes(status) || !validPriority.includes(priority)) throw new Error('无效的任务状态或优先级');
  const tags = Array.isArray(input.tags) ? input.tags.map(x => String(x).trim()).filter(Boolean).slice(0, 12) : (prior?.tags || []);
  const due = input.due_at === '' || input.due_at === null ? null : (input.due_at === undefined ? prior ? prior.due_at : todayEnd() : String(input.due_at));
  if (due && Number.isNaN(Date.parse(due))) throw new Error('截止日期格式无效');
  const subtasks = Array.isArray(input.subtasks) ? input.subtasks.slice(0,100).map((s:unknown) => { const item=s as Partial<Subtask>; return { id: typeof item.id==='string'&&item.id?item.id:randomUUID(), title:String(item.title||'').trim().slice(0,300), done:Boolean(item.done) }; }).filter(s=>s.title) : prior?.subtasks || [];
  return { title, description: String(input.description ?? prior?.description ?? '').slice(0, 20000), status, priority, due_at: due, due_explicit:Number(Boolean(input.due_explicit ?? prior?.due_explicit ?? false)), tags: JSON.stringify(tags), notes: String(input.notes ?? prior?.notes ?? '').slice(0, 20000), urgent: input.urgent === undefined ? (prior?.urgent || 0) : Number(Boolean(input.urgent)), ai_analysis: String(input.ai_analysis ?? prior?.ai_analysis ?? ''), source_type: String(input.source_type ?? prior?.source_type ?? 'manual'), source_image_id: input.source_image_id === undefined ? prior?.source_image_id || null : input.source_image_id ? String(input.source_image_id) : null, source_name:String(input.source_name ?? prior?.source_name ?? '').trim().slice(0,200), requested_by:String(input.requested_by ?? prior?.requested_by ?? '').trim().slice(0,200), assignee:String(input.assignee ?? prior?.assignee ?? '').trim().slice(0,200), subtasks:JSON.stringify(subtasks) };
}
const app = express();
app.disable('x-powered-by');
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    const host = req.headers.host || '';
    let allowedOrigin = !origin;
    if (origin) {
      try {
        const parsed = new URL(origin);
        const sameOrigin = parsed.host === host && ['http:', 'https:'].includes(parsed.protocol);
        const viteProxy = devMode && parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.port === '5173' && /^127\.0\.0\.1:\d+$/.test(host);
        allowedOrigin = sameOrigin || viteProxy;
      } catch { allowedOrigin = false; }
    }
    if (!allowedOrigin) return res.status(403).json({ error: '请求来源不受信任' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: '跨站请求被拒绝' });
  }
  next();
});
app.use(express.json({ limit: '25mb' }));
const handle = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => { Promise.resolve().then(() => fn(req, res)).catch(next); };
app.get('/api/health', (_req, res) => res.json({ ok: true, dataDir }));
app.get('/api/tasks', (_req, res) => res.json(taskRows()));
app.post('/api/tasks', handle((req, res) => {
  const t = taskFields(req.body || {}), id = randomUUID(), stamp = now();
  db.prepare('INSERT INTO tasks (id,title,description,status,priority,due_at,tags,source_type,source_image_id,ai_analysis,notes,urgent,created_at,updated_at,completed_at,x,y,width,height) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,t.title,t.description,t.status,t.priority,t.due_at,t.tags,t.source_type,t.source_image_id,t.ai_analysis,t.notes,t.urgent,stamp,stamp,t.status === 'done' ? stamp : null,-1,-1,260,210);
  saveTaskDetails(id,t);
  res.status(201).json(getTask(id));
}));
app.patch('/api/tasks/:id', handle((req, res) => {
  const prior = getTask(String(req.params.id)) as Task | null;
  if (!prior) return res.status(404).json({ error: '任务不存在' });
  const t = taskFields(req.body || {}, prior), stamp = now();
  const completed = t.status === 'done' ? (prior.completed_at || stamp) : null;
  db.prepare('UPDATE tasks SET title=?,description=?,status=?,priority=?,due_at=?,tags=?,source_type=?,source_image_id=?,ai_analysis=?,notes=?,urgent=?,updated_at=?,completed_at=? WHERE id=?').run(t.title,t.description,t.status,t.priority,t.due_at,t.tags,t.source_type,t.source_image_id,t.ai_analysis,t.notes,t.urgent,stamp,completed,prior.id);
  saveTaskDetails(prior.id,t);
  res.json(getTask(prior.id));
}));
app.patch('/api/tasks/:id/layout', handle((req, res) => {
  const prior = getTask(String(req.params.id)) as Task | null;
  if (!prior) return res.status(404).json({ error: '任务不存在' });
  const n = (key: string, fallback: number) => { const value = Number(req.body[key]); return Number.isFinite(value) ? value : fallback; };
  db.prepare('UPDATE tasks SET x=?,y=?,width=?,height=? WHERE id=?').run(Math.max(0,n('x',prior.x)),Math.max(0,n('y',prior.y)),Math.max(180,n('width',prior.width)),Math.max(140,n('height',prior.height)),prior.id);
  res.json(getTask(prior.id));
}));
app.delete('/api/tasks/:id', handle((req, res) => { const old = getTask(String(req.params.id)); if (!old) return res.status(404).json({ error: '任务不存在' }); db.prepare('DELETE FROM tasks WHERE id=?').run(String(req.params.id)); res.json(old); }));
app.get('/api/shortcuts', (_req, res) => res.json(db.prepare('SELECT * FROM shortcuts ORDER BY sort_order, name').all()));
app.post('/api/shortcuts', handle((req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80), kind = String(req.body.kind || 'web'), target = String(req.body.target || '').trim();
  if (!name || !['web','command'].includes(kind)) throw new Error('请填写有效的快捷入口');
  if (kind === 'web' && !/^https?:\/\//i.test(target)) throw new Error('网页链接需要以 http:// 或 https:// 开头');
  if (kind === 'command' && target && !target.startsWith('/')) throw new Error('本地命令需要填写可执行文件的绝对路径');
  const id = randomUUID();
  const last=db.prepare('SELECT COALESCE(MAX(sort_order),0) AS value FROM shortcuts').get() as {value:number};
  db.prepare('INSERT INTO shortcuts VALUES (?,?,?,?,?,?)').run(id,name,kind,target,String(req.body.icon || 'link').slice(0,20),req.body.sort_order===undefined?last.value+10:Number(req.body.sort_order)||0);
  res.status(201).json(db.prepare('SELECT * FROM shortcuts WHERE id=?').get(id));
}));
app.patch('/api/shortcuts/:id', handle((req, res) => { const prior = db.prepare('SELECT * FROM shortcuts WHERE id=?').get(String(req.params.id)) as Record<string, unknown> | undefined; if (!prior) return res.status(404).json({ error: '入口不存在' }); const next = { ...prior, ...req.body }; const name=String(next.name||'').trim(), target=String(next.target||'').trim(), kind=String(next.kind); if (!name || !['web','command'].includes(kind) || (kind==='web' ? !/^https?:\/\//i.test(target) : Boolean(target)&&!target.startsWith('/'))) throw new Error('入口配置无效'); db.prepare('UPDATE shortcuts SET name=?,kind=?,target=?,icon=?,sort_order=? WHERE id=?').run(name,kind,target,String(next.icon||'link').slice(0,20),Number(next.sort_order)||0,String(req.params.id)); res.json(db.prepare('SELECT * FROM shortcuts WHERE id=?').get(String(req.params.id))); }));
app.delete('/api/shortcuts/:id', handle((req,res) => { db.prepare('DELETE FROM shortcuts WHERE id=?').run(String(req.params.id)); res.json({ok:true}); }));
app.post('/api/shortcuts/:id/launch', handle((req,res) => {
  const item = db.prepare('SELECT * FROM shortcuts WHERE id=?').get(String(req.params.id)) as {kind:string;target:string}|undefined;
  if (!item) return res.status(404).json({error:'入口不存在'});
  if (item.kind === 'web') return res.json({ url: item.target });
  if (!item.target) throw new Error('请先为该入口配置本地命令路径');
  if (!existsSync(item.target)) throw new Error('命令文件不存在');
  execFile(item.target, [], { cwd: homedir(), timeout: 10000, windowsHide: true }, error => { if (error) console.error('快捷命令启动失败:', error.message); });
  res.json({ ok: true });
}));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15*1024*1024, files: 10 }, fileFilter: (_req,file,cb) => cb(null,['image/png','image/jpeg','image/webp','image/gif'].includes(file.mimetype)) });
app.post('/api/attachments', upload.array('images', 10), handle((req,res) => {
  const files = req.files as Express.Multer.File[];
  if (!files?.length) throw new Error('请选择 PNG、JPEG、WebP 或 GIF 图片');
  const rows = files.map(file => { const id=randomUUID(), ext=({ 'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','image/gif':'.gif' } as Record<string,string>)[file.mimetype], relative=`attachments/screenshots/${id}${ext}`; writeFileSync(join(dataDir,relative),file.buffer); db.prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?)').run(id,relative,file.mimetype,file.size,'',now()); return {id,mime:file.mimetype,size:file.size,url:`/api/attachments/${id}`}; });
  res.status(201).json(rows);
}));
app.get('/api/attachments/:id', handle((req,res) => { const row=db.prepare('SELECT * FROM attachments WHERE id=?').get(String(req.params.id)) as {path:string;mime:string}|undefined; if(!row) return res.status(404).json({error:'截图不存在'}); const path=join(dataDir,row.path); if(!existsSync(path)) return res.status(404).json({error:'截图文件不存在'}); res.setHeader('Content-Type',row.mime); res.setHeader('Cache-Control','private, max-age=3600'); res.send(readFileSync(path)); }));
app.delete('/api/attachments/:id', handle((req,res) => {
  const id=String(req.params.id);
  const row=db.prepare('SELECT path FROM attachments WHERE id=?').get(id) as {path:string}|undefined;
  if (!row) return res.json({ok:true});
  if (db.prepare('SELECT 1 FROM tasks WHERE source_image_id=? LIMIT 1').get(id)) return res.json({ok:true,kept:true});
  db.prepare('DELETE FROM attachments WHERE id=?').run(id);
  const path=join(dataDir,row.path);
  if (existsSync(path)) unlinkSync(path);
  res.json({ok:true});
}));
app.get('/api/settings', (_req,res) => { const c=modelConfig(); res.json({provider:c.provider,baseUrl:c.baseUrl,model:c.model,hasKey:Boolean(c.apiKey),dataDir,holidays:json(join(dataDir,'config/holidays.json'),[])}); });
app.put('/api/settings/model', handle((req,res) => { const old=modelConfig(); const provider:ModelProvider=req.body.provider==='gemini-fastapi'?'gemini-fastapi':req.body.provider==='openai'?'openai':'deepseek'; let baseUrl:string; try { baseUrl=compatibleBaseUrl(String(req.body.baseUrl||old.baseUrl),provider); } catch { throw new Error('API Base URL 无效'); } const changedProvider=provider!==old.provider; const next:ModelConfig={provider,baseUrl,model:String(req.body.model||''),apiKey:req.body.removeKey?'':String(req.body.apiKey||(changedProvider?'':old.apiKey))}; if(!/^https?:\/\//.test(next.baseUrl)) throw new Error('API Base URL 无效'); writeFileSync(configPath,JSON.stringify(next,null,2),{mode:0o600}); chmodSync(configPath,0o600); res.json({provider:next.provider,baseUrl:next.baseUrl,model:next.model,hasKey:Boolean(next.apiKey)}); }));
app.put('/api/settings/holidays', handle((req,res) => {
  if (!Array.isArray(req.body)) throw new Error('日期标签必须是数组');
  const list=req.body.slice(0,200).map((h:Record<string,unknown>)=>{
    const date=String(h.date||''),name=String(h.name||'').trim().slice(0,80),parsed=new Date(`${date}T12:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(parsed.getTime())||parsed.toISOString().slice(0,10)!==date||!name) throw new Error('日期标签需要有效日期和名称');
    const type=['birthday','anniversary'].includes(String(h.type))?String(h.type):'personal';
    const repeat=['solar','lunar'].includes(String(h.repeat))?String(h.repeat):'none';
    return {id:/^[a-f0-9-]{36}$/.test(String(h.id||''))?String(h.id):randomUUID(),date,name,type,repeat};
  });
  writeFileSync(join(dataDir,'config/holidays.json'),JSON.stringify(list,null,2));
  res.json(list);
}));
app.get('/api/ai/models', handle(async (_req,res) => { const c=modelConfig(); const response=await providerFetch(`${c.baseUrl}/models`,{headers:providerHeaders(c)},15000); if(!response.ok) throw new Error(await providerError(response,c.apiKey)); const body=await response.json() as {data?:Array<{id?:string}>}; res.json({models:(body.data||[]).map(item=>item.id).filter(Boolean)}); }));
app.post('/api/ai/test', handle(async (_req,res) => {
  const c=modelConfig();
  if(!modelReady(c)) throw new Error(c.provider==='gemini-fastapi'?'请先保存代理地址和模型名称':'请先保存 API Key 和模型名称');
  const response=await providerFetch(`${c.baseUrl}/models`,{headers:providerHeaders(c)},15000);
  if(!response.ok) throw new Error(await providerError(response,c.apiKey));
  const body=await response.json() as {data?:Array<{id?:string}>};
  const models=(body.data||[]).map(item=>item.id).filter((id):id is string=>Boolean(id));
  if(c.provider!=='openai'&&models.length&&!models.includes(c.model)) throw new Error(`服务未提供模型 ${c.model}；可选：${models.join('、')}`);
  const testPng=readFileSync(join(dirname(fileURLToPath(import.meta.url)),'vision-test.png')).toString('base64');
  const vision=await providerFetch(`${c.baseUrl}/chat/completions`,{method:'POST',headers:providerHeaders(c),body:JSON.stringify({model:c.model,messages:[{role:'user',content:[{type:'text',text:'请简短回复：图片已收到。'},{type:'image_url',image_url:{url:`data:image/png;base64,${testPng}`}}]}]})},60000);
  if(!vision.ok) throw new Error(await providerError(vision,c.apiKey));
  res.json({ok:true,endpoint:`${c.baseUrl}/models`,models,visionChecked:true});
}));
async function recognizeLocally(ids: string[]): Promise<string> {
  if (process.platform !== 'darwin') return '';
  const script = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/ocr.swift');
  if (!existsSync(script)) return '';
  const texts: string[] = [];
  for (const id of ids) {
    const row=db.prepare('SELECT path FROM attachments WHERE id=?').get(id) as {path:string}|undefined;
    if (!row) continue;
    try {
      const output=await new Promise<string>((ok,fail)=>execFile('swift',[script,join(dataDir,row.path)],{timeout:30000,maxBuffer:1024*1024},(error,stdout)=>error?fail(error):ok(stdout)));
      if (output.trim()) texts.push(output.trim());
    } catch (error) { console.error('本地文字识别失败:',(error as Error).message); }
  }
  return texts.join('\n\n').slice(0,20000);
}
function ocrDraft(text: string, imageId: string) {
  const lines=text.split(/\n/).map(line=>line.trim()).filter(Boolean);
  const first=lines[0]||'';
  const speaker=first.match(/^(.{2,40}?)\s*(?:上午|下午|\d{1,2}:\d{2})/)?.[1]?.trim()||'';
  const candidate=lines.at(-1)||lines[0]||'检查截图内容';
  return {title:`待确认：${candidate}`.slice(0,200),description:text,source_name:'截图',requested_by:speaker,assignee:'',priority:'medium',due_at:todayEnd(),due_explicit:0,tags:[],subtasks:[],ai_analysis:'本地文字识别草稿；请核对任务内容。',confidence:0.3,source_type:'screenshot',source_image_id:imageId};
}
app.post('/api/ai/analyze', handle(async (req,res) => {
  const ids: string[] = Array.isArray(req.body.imageIds) ? req.body.imageIds.slice(0,8) : [];
  if(!ids.length) throw new Error('请先选择截图');
  const c=modelConfig(); if(!modelReady(c)) throw new Error('请先在设置中配置视觉模型');
  const parts: unknown[]=[{type:'text',text:`当前时间：${new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}，时区：Asia/Shanghai。阅读截图并完整提取待办。每项说明来源、谁提出需求、谁负责、具体要做什么；不明确的人名留空。把可执行步骤作为有序 subtasks 字符串数组。due_at 只填写截图明确指定的时间，使用带时区的 ISO 8601；仅有日期时设为当天 23:59；没有明确时间时填 null，系统会默认今天 23:59。只返回 JSON 对象，字段为 tasks: [{title,description,source_name,requested_by,assignee,priority,due_at,tags,subtasks,ai_analysis,confidence}] 和 recognized_text。没有任务时 tasks 为空数组。`}];
  for(const id of ids) { const row=db.prepare('SELECT * FROM attachments WHERE id=?').get(id) as {path:string;mime:string}|undefined; if(!row) throw new Error('截图不存在'); const base64=readFileSync(join(dataDir,row.path)).toString('base64'); parts.push({type:'image_url',image_url:{url:`data:${row.mime};base64,${base64}`}}); }
  try {
    const responseFormat=c.provider==='gemini-fastapi'?{}:{response_format:{type:'json_object'}};
    const response=await providerFetch(`${c.baseUrl}/chat/completions`,{method:'POST',headers:providerHeaders(c),body:JSON.stringify({model:c.model,temperature:0.2,messages:[{role:'user',content:parts}],...responseFormat})},c.provider==='gemini-fastapi'?45000:120000);
    if(!response.ok) throw new Error(await providerError(response,c.apiKey));
    const body=await response.json() as {choices?:Array<{message?:{content?:string}}>};
    const raw=body.choices?.[0]?.message?.content||'{}';
    let parsed: {tasks?:Record<string,unknown>[];recognized_text?:string};
    try { parsed=JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/gi,'')); } catch { throw new Error('模型没有返回可解析的任务数据'); }
    if(!Array.isArray(parsed.tasks)) throw new Error('模型返回的数据缺少任务列表');
    const drafts=parsed.tasks.slice(0,12).map(t=>({title:String(t.title||'').slice(0,200),description:String(t.description||''),source_name:String(t.source_name||''),requested_by:String(t.requested_by||''),assignee:String(t.assignee||''),priority:validPriority.includes(String(t.priority))?t.priority:'medium',due_at:t.due_at&& !Number.isNaN(Date.parse(String(t.due_at)))?new Date(String(t.due_at)).toISOString():todayEnd(),due_explicit:Number(Boolean(t.due_at)),tags:Array.isArray(t.tags)?t.tags.map(String):[],subtasks:Array.isArray(t.subtasks)?t.subtasks.map(sub=>({id:randomUUID(),title:String(sub),done:false})):[],ai_analysis:String(t.ai_analysis||''),confidence:Number(t.confidence)||0,source_type:'screenshot',source_image_id:ids[0]})).filter(t=>t.title);
    for(const id of ids) db.prepare('UPDATE attachments SET recognized_text=? WHERE id=?').run(String(parsed.recognized_text||''),id);
    res.json({drafts,recognized_text:parsed.recognized_text||'',autoCreate:drafts.length===1&&drafts[0].confidence>=0.92});
  } catch(error) {
    if(c.provider!=='gemini-fastapi') throw error;
    const text=await recognizeLocally(ids);
    if(!text) throw error;
    for(const id of ids) db.prepare('UPDATE attachments SET recognized_text=? WHERE id=?').run(text,id);
    res.json({drafts:[ocrDraft(text,ids[0])],recognized_text:text,autoCreate:false,fallback:true,warning:`网页代理未完成识别：${(error as Error).message}。已使用本地文字识别生成草稿，请确认后创建。`});
  }
}));
app.get('/api/export/tasks', (_req,res) => { res.setHeader('Content-Disposition','attachment; filename="ai-todo-tasks.json"'); res.json({version:1,tasks:taskRows()}); });
app.post('/api/import/tasks', handle((req,res) => { const tasks=req.body.tasks; if(!Array.isArray(tasks)) throw new Error('无效的任务 JSON'); let count=0; for(const raw of tasks.slice(0,5000)){ try{ const t=taskFields(raw); const id=randomUUID(),stamp=now(); db.prepare('INSERT INTO tasks (id,title,description,status,priority,due_at,tags,source_type,source_image_id,ai_analysis,notes,urgent,created_at,updated_at,completed_at,x,y,width,height) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,t.title,t.description,t.status,t.priority,t.due_at,t.tags,'import',null,t.ai_analysis,t.notes,t.urgent,stamp,stamp,null,-1,-1,260,210); saveTaskDetails(id,t); count++; }catch{} } res.json({count}); }));
app.get('/api/export/backup', (_req,res) => { const files=readdirSync(join(dataDir,'attachments/screenshots')).map(name=>({name,data:readFileSync(join(dataDir,'attachments/screenshots',name)).toString('base64')})); const shortcuts=db.prepare('SELECT * FROM shortcuts').all(); const holidays=json(join(dataDir,'config/holidays.json'),[]); res.setHeader('Content-Disposition','attachment; filename="ai-todo-backup.json"'); res.json({version:1,createdAt:now(),tasks:taskRows(),shortcuts,holidays,attachments:db.prepare('SELECT * FROM attachments').all(),files}); });
app.post('/api/import/backup', handle((req,res) => { const body=req.body; if(body.version!==1||!Array.isArray(body.tasks)||!Array.isArray(body.attachments)||!Array.isArray(body.files)) throw new Error('备份格式无效'); const snapshot=join(dataDir,'backups',`before-restore-${Date.now()}.json`); writeFileSync(snapshot,JSON.stringify({version:1,tasks:taskRows(),shortcuts:db.prepare('SELECT * FROM shortcuts').all(),holidays:json(join(dataDir,'config/holidays.json'),[]),attachments:db.prepare('SELECT * FROM attachments').all(),files:readdirSync(join(dataDir,'attachments/screenshots')).map(name=>({name,data:readFileSync(join(dataDir,'attachments/screenshots',name)).toString('base64')}))})); db.exec('BEGIN'); try {db.exec('DELETE FROM tasks; DELETE FROM attachments; DELETE FROM shortcuts;'); for(const t of body.tasks){ const v=taskFields(t); db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(String(t.id),v.title,v.description,v.status,v.priority,v.due_at,v.tags,v.source_type,v.source_image_id,v.ai_analysis,v.notes,v.urgent,String(t.created_at||now()),String(t.updated_at||now()),t.completed_at||null,Number(t.x)||0,Number(t.y)||0,Number(t.width)||260,Number(t.height)||210); saveTaskDetails(String(t.id),v); } for(const a of body.attachments){ if(!/^attachments\/screenshots\/[a-f0-9-]+\.(png|jpg|webp|gif)$/.test(String(a.path))) throw new Error('附件路径无效'); db.prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?)').run(String(a.id),String(a.path),String(a.mime),Number(a.size),String(a.recognized_text||''),String(a.created_at||now())); } for(const s of body.shortcuts||[]) db.prepare('INSERT INTO shortcuts VALUES (?,?,?,?,?,?)').run(String(s.id),String(s.name),String(s.kind),String(s.target),String(s.icon),Number(s.sort_order)||0); for(const f of body.files){ if(!/^[a-f0-9-]+\.(png|jpg|webp|gif)$/.test(String(f.name))) throw new Error('文件名无效'); writeFileSync(join(dataDir,'attachments/screenshots',f.name),Buffer.from(String(f.data),'base64')); } writeFileSync(join(dataDir,'config/holidays.json'),JSON.stringify(body.holidays||[])); db.exec('COMMIT'); }catch(e){db.exec('ROLLBACK');throw e;} res.json({ok:true,snapshot}); }));
app.get('/api/storage', (_req,res) => { const sizes=(path:string):number => readdirSync(path,{withFileTypes:true}).reduce((sum,item)=>sum+(item.isDirectory()?sizes(join(path,item.name)):statSync(join(path,item.name)).size),0); res.json({bytes:sizes(dataDir),dataDir}); });
app.post('/api/data-dir/open', (_req,res) => { const command=process.platform==='darwin'?'open':process.platform==='win32'?'explorer':'xdg-open'; execFile(command,[dataDir],error=>{if(error)console.error('打开数据目录失败:',error.message)}); res.json({ok:true}); });
app.use('/api', (_req,res) => res.status(404).json({error:'接口不存在'}));
const thisDir=dirname(fileURLToPath(import.meta.url));
const dist=resolve(thisDir,'../dist');
if(existsSync(dist)){app.use(express.static(dist));app.get('*splat',(_req,res)=>res.sendFile(join(dist,'index.html')));}
app.use((err:Error,_req:Request,res:Response,_next:NextFunction)=>{ console.error(err.message); res.status(400).json({error:err.message||'请求失败'}); });
async function listen(port:number,tries=0):Promise<void>{ const server=createServer(app); await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve());}).catch(async e=>{if((e as NodeJS.ErrnoException).code==='EADDRINUSE' && !valueAfter('--port') && tries<20) return listen(port+1,tries+1); throw e;}); if(!server.listening)return; const url=`http://127.0.0.1:${port}`; console.log(`TaskPaste 已启动：${url}\n数据目录：${dataDir}`); if(!args.includes('--no-open')){ const command=process.platform==='darwin'?'open':process.platform==='win32'?'cmd':'xdg-open'; const commandArgs=process.platform==='win32'?['/c','start',url]:[url]; execFile(command,commandArgs,()=>{}); } const shutdown=()=>{server.close();db.close();process.exit(0)};process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);}
listen(portOption).catch(e=>{console.error('启动失败：',e.message);process.exit(1)});
