import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

test('内置连接测试图片是完整有效的 PNG', () => {
  const png = readFileSync('server/vision-test.png');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const typeAndData = png.subarray(offset + 4, offset + 8 + length);
    const expected = png.readUInt32BE(offset + 8 + length);
    let crc = 0xffffffff;
    for (const byte of typeAndData) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    assert.equal((crc ^ 0xffffffff) >>> 0, expected);
    offset += length + 12;
  }
  assert.equal(offset, png.length);
});

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function start(port, dir, extraArgs = []) {
  const child = spawn(process.execPath, ['bin/ai-todo.js', '--port', String(port), '--data-dir', dir, '--no-open', ...extraArgs], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error('服务未能启动');
    try { if ((await fetch(`${url}/api/health`)).ok) return { child, url }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error('等待服务超时');
}
async function stop(child) {
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
}
async function request(url, path, method = 'GET', body) {
  const response = await fetch(`${url}/api${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

test('任务和画布位置在服务重启后保留，备份包含任务', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-todo-test-'));
  const port = await freePort();
  let processInfo;
  try {
    processInfo = await start(port, dir);
    const task = await request(processInfo.url, '/tasks', 'POST', { title: '持久化验证', category: 'work', priority: 'high', tags: ['测试'], source_name: '产品群', requested_by: '小王', assignee: '我', subtasks: [{ id: 'step-1', title: '确认需求', done: false }] });
    assert.equal(task.title, '持久化验证');
    assert.equal(task.category, 'work');
    assert.equal(task.due_at.slice(0, 10), new Date().toISOString().slice(0, 10));
    await request(processInfo.url, `/tasks/${task.id}/layout`, 'PATCH', { x: 48, y: 64 });
    await stop(processInfo.child);
    processInfo = await start(port, dir);
    const tasks = await request(processInfo.url, '/tasks');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].x, 48);
    assert.equal(tasks[0].category, 'work');
    assert.deepEqual(tasks[0].tags, ['测试']);
    const moved = await request(processInfo.url, `/tasks/${task.id}`, 'PATCH', { status: 'in_progress' });
    assert.equal(moved.status, 'in_progress');
    assert.equal(tasks[0].source_name, '产品群');
    assert.equal(tasks[0].requested_by, '小王');
    assert.deepEqual(tasks[0].subtasks, [{ id: 'step-1', title: '确认需求', done: false }]);
    const updated = await request(processInfo.url, `/tasks/${task.id}`, 'PATCH', { subtasks: [{ id: 'step-1', title: '确认需求', done: true }] });
    assert.equal(updated.subtasks[0].done, true);
    const backup = await request(processInfo.url, '/export/backup');
    assert.equal(backup.tasks[0].title, '持久化验证');
    assert.equal(backup.tasks[0].category, 'work');
    assert.equal(backup.tasks[0].subtasks[0].done, true);
    await request(processInfo.url, '/import/backup', 'POST', backup);
    const restored = await request(processInfo.url, '/tasks');
    assert.equal(restored[0].status, 'in_progress');
    assert.equal(restored[0].category, 'work');
    assert.equal(restored[0].source_name, '产品群');
    assert.equal(restored[0].subtasks[0].done, true);
  } finally {
    if (processInfo?.child.exitCode === null) await stop(processInfo.child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('旧数据库升级后，已有任务默认归入其他类别', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskpaste-category-migration-'));
  const port = await freePort();
  let processInfo;
  try {
    processInfo = await start(port, dir);
    const task = await request(processInfo.url, '/tasks', 'POST', { title: '旧任务' });
    await stop(processInfo.child);
    const database = new DatabaseSync(join(dir, 'data/ai-todo.sqlite'));
    database.exec('ALTER TABLE task_details DROP COLUMN category');
    database.close();
    processInfo = await start(port, dir);
    const tasks = await request(processInfo.url, '/tasks');
    assert.equal(tasks.find(item => item.id === task.id)?.category, 'other');
  } finally {
    if (processInfo?.child.exitCode === null) await stop(processInfo.child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('日期标签可编辑并在重启与备份后保留重复方式', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskpaste-calendar-test-'));
  const port = await freePort();
  let processInfo;
  try {
    processInfo = await start(port, dir);
    const created = await request(processInfo.url, '/settings/holidays', 'PUT', [{ date: '2025-10-06', name: '妈妈', type: 'birthday', repeat: 'lunar' }]);
    assert.equal(created[0].repeat, 'lunar');
    assert.ok(created[0].id);
    const edited = await request(processInfo.url, '/settings/holidays', 'PUT', [{ ...created[0], name: '妈妈生日', repeat: 'solar' }]);
    assert.equal(edited[0].id, created[0].id);
    await stop(processInfo.child);
    processInfo = await start(port, dir);
    const settings = await request(processInfo.url, '/settings');
    assert.equal(settings.holidays[0].name, '妈妈生日');
    assert.equal(settings.holidays[0].repeat, 'solar');
    const backup = await request(processInfo.url, '/export/backup');
    assert.equal(backup.holidays[0].repeat, 'solar');
    const removed = await request(processInfo.url, '/settings/holidays', 'PUT', []);
    assert.deepEqual(removed, []);
  } finally {
    if (processInfo?.child.exitCode === null) await stop(processInfo.child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('快捷入口可增删改查，删除默认入口后重启不会恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-todo-shortcut-test-'));
  const port = await freePort();
  let processInfo;
  try {
    processInfo = await start(port, dir);
    const initial = await request(processInfo.url, '/shortcuts');
    assert.equal(initial.length, 6);
    const codex = initial.find(item => item.name === 'Codex');
    assert.equal(codex.target, '');
    assert.equal(codex.section, 'launch');
    const image = `data:image/png;base64,${readFileSync('tests/fixtures/ocr.png').toString('base64')}`;
    const edited = await request(processInfo.url, `/shortcuts/${codex.id}`, 'PATCH', { name: '我的 Codex', target: '/usr/bin/true', icon: image });
    assert.equal(edited.name, '我的 Codex');
    assert.equal(edited.icon, image);
    const created = await request(processInfo.url, '/shortcuts', 'POST', { name: '项目文档', kind: 'web', target: 'https://example.com/docs', icon: 'https://example.com/icon.png' });
    assert.equal(created.name, '项目文档');
    const tool = await request(processInfo.url, '/shortcuts', 'POST', { name: 'JSON 格式化', kind: 'web', target: 'https://example.com/json', section: 'tool', icon: image });
    assert.equal(tool.section, 'tool');
    const badIcon = await fetch(`${processInfo.url}/api/shortcuts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '坏图标', kind: 'web', target: 'https://example.com', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }) });
    assert.equal(badIcon.status, 400);
    const gemini = initial.find(item => item.name === 'Gemini');
    await request(processInfo.url, `/shortcuts/${gemini.id}`, 'DELETE');
    await stop(processInfo.child);
    processInfo = await start(port, dir);
    const remaining = await request(processInfo.url, '/shortcuts');
    assert.equal(remaining.length, 7);
    assert.equal(remaining.some(item => item.name === 'Gemini'), false);
    assert.equal(remaining.some(item => item.name === '我的 Codex' && item.target === '/usr/bin/true' && item.icon === image), true);
    assert.equal(remaining.some(item => item.name === '项目文档' && item.icon === 'https://example.com/icon.png'), true);
    assert.equal(remaining.find(item => item.id === tool.id)?.section, 'tool');
    const backup = await request(processInfo.url, '/export/backup');
    assert.equal(backup.shortcuts.find(item => item.id === tool.id)?.icon, image);
    await request(processInfo.url, '/import/backup', 'POST', backup);
    const restored = await request(processInfo.url, '/shortcuts');
    assert.equal(restored.find(item => item.id === tool.id)?.section, 'tool');
    assert.equal(restored.find(item => item.id === tool.id)?.icon, image);
  } finally {
    if (processInfo?.child.exitCode === null) await stop(processInfo.child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('旧版快捷入口升级后保留在快捷启动分组', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskpaste-shortcut-migration-'));
  const port = await freePort();
  let processInfo;
  try {
    processInfo = await start(port, dir);
    const initial = await request(processInfo.url, '/shortcuts');
    await stop(processInfo.child);
    const database = new DatabaseSync(join(dir, 'data/ai-todo.sqlite'));
    database.exec('ALTER TABLE shortcuts DROP COLUMN section');
    database.close();
    processInfo = await start(port, dir);
    const migrated = await request(processInfo.url, '/shortcuts');
    assert.equal(migrated.length, initial.length);
    assert.ok(migrated.every(item => item.section === 'launch'));
  } finally {
    if (processInfo?.child.exitCode === null) await stop(processInfo.child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('开发模式允许 Vite 页面上传截图，其他来源仍被拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-todo-origin-test-'));
  const port = await freePort();
  let processInfo;
  try {
    processInfo = await start(port, dir, ['--dev']);
    const body = new FormData();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64');
    body.append('images', new Blob([png], { type: 'image/png' }), 'test.png');
    const uploaded = await fetch(`${processInfo.url}/api/attachments`, { method: 'POST', headers: { Origin: 'http://127.0.0.1:5173' }, body });
    assert.equal(uploaded.status, 201);
    const attachment = (await uploaded.json())[0];
    const preview = await fetch(`${processInfo.url}${attachment.url}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
    const rejected = await fetch(`${processInfo.url}/api/tasks`, { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'should fail' }) });
    assert.equal(rejected.status, 403);
  } finally {
    if (processInfo?.child.exitCode === null) await stop(processInfo.child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('模型测试返回上游具体错误并隐藏密钥', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-todo-model-test-'));
  const port = await freePort();
  const providerPort = await freePort();
  const provider = createHttpServer((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { status: 'UNAUTHENTICATED', message: 'Key fake-secret is invalid' } }));
  });
  await new Promise(resolve => provider.listen(providerPort, '127.0.0.1', resolve));
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config/models.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${providerPort}`, model: 'test-model', apiKey: 'fake-secret' }));
  let processInfo;
  try {
    processInfo = await start(port, dir);
    const response = await fetch(`${processInfo.url}/api/ai/test`, { method: 'POST' });
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.match(result.error, /HTTP 401.*UNAUTHENTICATED.*invalid/);
    assert.ok(!result.error.includes('fake-secret'));
  } finally {
    if (processInfo?.child.exitCode === null) await stop(processInfo.child);
    await new Promise(resolve => provider.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gemini-FastAPI 无密钥代理可测试并识别截图', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-todo-proxy-test-'));
  const port = await freePort();
  const providerPort = await freePort();
  const received = [];
  const provider = createHttpServer(async (req, res) => {
    received.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gemini-flash' }] }));
    if (req.url === '/v1/chat/completions') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString());
      if (request.messages[0].content[0].text.includes('请简短回复')) {
        assert.equal(request.messages[0].content[1].type, 'image_url');
        return res.end(JSON.stringify({ choices: [{ message: { content: '图片已收到' } }] }));
      }
      assert.equal(request.response_format, undefined);
      assert.equal(request.model, 'gemini-flash');
      assert.equal(request.messages[0].content[1].type, 'image_url');
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tasks: [{ title: '测试截图', description: '来自代理', source_name: '测试群', requested_by: '小张', assignee: '我', priority: 'medium', due_at: null, tags: [], subtasks: ['复现问题', '提交修复'], ai_analysis: '', confidence: 0.8 }], recognized_text: '测试截图' }) } }] }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise(resolve => provider.listen(providerPort, '127.0.0.1', resolve));
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config/models.json'), JSON.stringify({ baseUrl: 'https://api.openai.com/v1', model: 'old-model', apiKey: 'old-secret' }));
  let processInfo;
  try {
    processInfo = await start(port, dir);
    const saved = await request(processInfo.url, '/settings/model', 'PUT', { provider: 'gemini-fastapi', baseUrl: `http://127.0.0.1:${providerPort}`, model: 'gemini-flash' });
    assert.equal(saved.hasKey, false);
    assert.equal(saved.baseUrl, `http://127.0.0.1:${providerPort}/v1`);
    const connection = await request(processInfo.url, '/ai/test', 'POST');
    assert.deepEqual(connection.models, ['gemini-flash']);
    assert.equal(connection.visionChecked, true);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64');
    const form = new FormData();
    form.append('images', new Blob([png], { type: 'image/png' }), 'test.png');
    const upload = await fetch(`${processInfo.url}/api/attachments`, { method: 'POST', body: form });
    assert.equal(upload.status, 201);
    const imageId = (await upload.json())[0].id;
    const result = await request(processInfo.url, '/ai/analyze', 'POST', { imageIds: [imageId] });
    assert.equal(result.drafts[0].title, '测试截图');
    assert.equal(result.drafts[0].source_name, '测试群');
    assert.equal(result.drafts[0].requested_by, '小张');
    assert.equal(result.drafts[0].subtasks.length, 2);
    assert.equal(result.drafts[0].due_explicit, 0);
    assert.ok(result.drafts[0].due_at);
    assert.ok(received.every(item => item.authorization === undefined));
  } finally {
    if (processInfo?.child.exitCode === null) await stop(processInfo.child);
    await new Promise(resolve => provider.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DeepSeek Flash 使用密钥、图片输入和 JSON 输出创建截图草稿', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-todo-deepseek-test-'));
  const port = await freePort(), providerPort = await freePort();
  const received = [];
  const provider = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    received.push({ path: req.url, auth: req.headers.authorization, payload });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/models') return res.end(JSON.stringify({ data: [{ id: 'deepseek-flash', input_modalities: ['text', 'image'] }] }));
    if (req.url === '/chat/completions') {
      if (payload.response_format) return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tasks: [{ title: '修复登录', description: '处理截图中的错误', category: 'work', source_name: '产品群', requested_by: '张三', assignee: '', priority: 'high', due_at: null, tags: ['Bug'], subtasks: ['复现', '修复'], ai_analysis: '', confidence: 0.85 }], recognized_text: '修复登录' }) } }] }));
      return res.end(JSON.stringify({ choices: [{ message: { content: '图片已收到' } }] }));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => provider.listen(providerPort, '127.0.0.1', resolve));
  let processInfo;
  try {
    processInfo = await start(port, dir);
    const initial = await request(processInfo.url, '/settings');
    assert.equal(initial.provider, 'deepseek');
    assert.equal(initial.model, 'deepseek-flash');
    await request(processInfo.url, '/settings/model', 'PUT', { provider: 'deepseek', baseUrl: `http://127.0.0.1:${providerPort}`, model: 'deepseek-flash', apiKey: 'test-secret' });
    const connected = await request(processInfo.url, '/ai/test', 'POST');
    assert.equal(connected.visionChecked, true);
    const form = new FormData();
    form.append('images', new Blob([readFileSync('tests/fixtures/ocr.png')], { type: 'image/png' }), 'ocr.png');
    const upload = await fetch(`${processInfo.url}/api/attachments`, { method: 'POST', body: form });
    const imageId = (await upload.json())[0].id;
    const result = await request(processInfo.url, '/ai/analyze', 'POST', { imageIds: [imageId] });
    assert.equal(result.drafts[0].title, '修复登录');
    assert.equal(result.drafts[0].category, 'work');
    assert.equal(result.drafts[0].source_name, '产品群');
    assert.ok(received.every(item => item.auth === 'Bearer test-secret'));
    const analysis = received.find(item => item.payload?.response_format);
    assert.equal(analysis.payload.model, 'deepseek-flash');
    assert.equal(analysis.payload.response_format.type, 'json_object');
    assert.match(analysis.payload.messages[0].content[0].text, /学习路线/);
    assert.match(analysis.payload.messages[0].content[0].text, /提醒类/);
    assert.equal(analysis.payload.messages[0].content[1].type, 'image_url');
  } finally {
    if (processInfo?.child.exitCode === null) await stop(processInfo.child);
    await new Promise(resolve => provider.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('网页代理返回无效内容时，macOS 本地识别生成待确认草稿', { skip: process.platform !== 'darwin' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-todo-ocr-test-'));
  const port = await freePort(), providerPort = await freePort();
  const provider = createHttpServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'Sorry, something went wrong.' } }] }));
  });
  await new Promise(resolve => provider.listen(providerPort, '127.0.0.1', resolve));
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config/models.json'), JSON.stringify({ provider: 'gemini-fastapi', baseUrl: `http://127.0.0.1:${providerPort}/v1`, model: 'gemini-flash', apiKey: '' }));
  let processInfo;
  try {
    processInfo = await start(port, dir);
    const form = new FormData();
    form.append('images', new Blob([readFileSync('tests/fixtures/ocr.png')], { type: 'image/png' }), 'ocr.png');
    const upload = await fetch(`${processInfo.url}/api/attachments`, { method: 'POST', body: form });
    assert.equal(upload.status, 201);
    const imageId = (await upload.json())[0].id;
    const result = await request(processInfo.url, '/ai/analyze', 'POST', { imageIds: [imageId] });
    assert.equal(result.fallback, true);
    assert.equal(result.autoCreate, false);
    assert.match(result.drafts[0].description, /Please fix login error today/);
    assert.match(result.warning, /本地文字识别/);
  } finally {
    if (processInfo?.child.exitCode === null) await stop(processInfo.child);
    await new Promise(resolve => provider.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
