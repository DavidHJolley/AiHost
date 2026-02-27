/**
 * index.js
 * Main Express + WebSocket server for AI-Driven Game Server Hosting.
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const db = require('./database');
const docker = require('./docker');
const ai = require('./ai');
const actions = require('./actions');
const modsModule = require('./mods');
const modpacksModule = require('./modpacks');

const app = express();
const httpServer = http.createServer(app);
const PORT = process.env.PORT || 3000;
const SERVERS_PATH = path.join(process.cwd(), 'servers');

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'client')));

// ─── Utility ──────────────────────────────────────────────────────────────────

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function ok(res, data) {
  return res.json({ success: true, ...data });
}

function fail(res, message, status = 400) {
  return res.status(status).json({ success: false, error: message });
}

function normaliseRam(ram) {
  if (!ram) return '2G';
  const str = String(ram).trim().toUpperCase();
  if (/^\d+(\.\d+)?[GM]$/.test(str)) return str;
  if (/^\d+(\.\d+)?GB$/.test(str)) return str.replace('GB', 'G');
  if (/^\d+(\.\d+)?MB$/.test(str)) return str.replace('MB', 'M');
  return str || '2G';
}

function findServerByName(name) {
  if (!name) return null;
  const servers = db.getAllServers();
  const lower = name.toLowerCase().trim();
  return (
    servers.find((s) => s.name.toLowerCase() === lower) ||
    servers.find((s) => s.name.toLowerCase().includes(lower)) ||
    null
  );
}

function safePath(serverDir, relativePath) {
  if (!relativePath) return serverDir;
  const resolved = path.resolve(serverDir, relativePath);
  const normalizedBase = path.resolve(serverDir);
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    throw new Error('Path outside server directory');
  }
  return resolved;
}

const BINARY_EXTS = new Set([
  '.jar', '.zip', '.gz', '.tar', '.png', '.jpg', '.jpeg', '.gif',
  '.dat', '.mca', '.nbt', '.db', '.db-shm', '.db-wal', '.lock',
  '.so', '.dll', '.exe', '.class', '.bak',
]);

function isBinary(p) {
  return BINARY_EXTS.has(path.extname(p).toLowerCase());
}

const executionCtx = { db, docker, serversPath: SERVERS_PATH };

// ─── Server list ──────────────────────────────────────────────────────────────

app.get('/servers', asyncHandler(async (_req, res) => {
  const servers = db.getAllServers();
  for (const server of servers) {
    if (server.container_id) {
      try {
        const info = await docker.inspectContainer(server.container_id);
        const liveStatus = info.running ? 'running' : 'stopped';
        if (liveStatus !== server.status) {
          db.updateServerStatus(server.id, liveStatus);
          server.status = liveStatus;
        }
      } catch {
        if (server.status !== 'stopped') {
          db.updateServerStatus(server.id, 'stopped');
          server.status = 'stopped';
        }
      }
    }
  }
  ok(res, { servers });
}));

// ─── Create server ────────────────────────────────────────────────────────────

app.post('/servers/create', asyncHandler(async (req, res) => {
  let { name, game = 'minecraft', ram = '2G', server_type = 'vanilla', properties = {} } = req.body;
  if (!name || !name.trim()) return fail(res, 'Server name is required');
  name = name.trim();
  game = game.toLowerCase().trim();
  ram = normaliseRam(ram);
  server_type = (server_type || 'vanilla').toLowerCase().trim();

  const supported = ['minecraft'];
  if (!supported.includes(game)) {
    return fail(res, `Unsupported game "${game}". Supported: ${supported.join(', ')}`);
  }

  const validTypes = ['vanilla', 'paper', 'spigot', 'purpur', 'fabric', 'forge', 'quilt', 'neoforge'];
  if (!validTypes.includes(server_type)) {
    return fail(res, `Unsupported server type "${server_type}". Supported: ${validTypes.join(', ')}`);
  }

  const id = uuidv4();
  let server;
  try {
    server = db.createServer({ id, name, game, ram, server_type });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return fail(res, 'A server with that port already exists. Try again.');
    }
    throw err;
  }

  try {
    const containerId = await docker.createContainer(server, properties);
    db.updateServerStatus(id, 'starting', containerId);
    await docker.startContainer(containerId);
    db.updateServerStatus(id, 'running', containerId);
    server = db.getServerById(id);
  } catch (err) {
    db.updateServerStatus(id, 'error');
    console.error('[Docker] Create/start failed:', err.message);
    server = db.getServerById(id);
    return res.status(500).json({
      success: false,
      error: `Server record created but Docker failed: ${err.message}`,
      server,
    });
  }

  ok(res, { server });
}));

// ─── Get single server ────────────────────────────────────────────────────────

app.get('/servers/:id', asyncHandler(async (req, res) => {
  const server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);
  ok(res, { server });
}));

// ─── Detailed server status ──────────────────────────────────────────────────

app.get('/servers/:id/status', asyncHandler(async (req, res) => {
  const server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);

  let dockerInfo = { status: 'no container' };
  if (server.container_id) {
    try {
      dockerInfo = await docker.inspectContainer(server.container_id);
    } catch {
      dockerInfo = { status: 'container not found', running: false };
    }
  }

  const serverDir = path.join(SERVERS_PATH, server.id);
  const config = actions.readServerProperties(serverDir);
  ok(res, { server, docker: dockerInfo, config });
}));

// ─── File management ──────────────────────────────────────────────────────────

app.get('/servers/:id/files', asyncHandler(async (req, res) => {
  const server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);

  const serverDir = path.join(SERVERS_PATH, server.id);
  if (!fs.existsSync(serverDir)) return ok(res, { files: [], currentPath: '' });

  const subpath = req.query.path || '';
  let targetDir;
  try { targetDir = safePath(serverDir, subpath); }
  catch (e) { return fail(res, e.message); }

  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    return fail(res, 'Directory not found', 404);
  }

  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  const files = entries.map((entry) => {
    const fullPath = path.join(targetDir, entry.name);
    const rel = path.relative(serverDir, fullPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      return { name: entry.name, path: rel, type: 'directory' };
    }
    try {
      const stat = fs.statSync(fullPath);
      return { name: entry.name, path: rel, type: 'file', size: stat.size };
    } catch {
      return { name: entry.name, path: rel, type: 'file', size: 0 };
    }
  });

  files.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  ok(res, { files, currentPath: subpath });
}));

app.get('/servers/:id/files/read', asyncHandler(async (req, res) => {
  const server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);

  const serverDir = path.join(SERVERS_PATH, server.id);
  let filePath;
  try { filePath = safePath(serverDir, req.query.path); }
  catch (e) { return fail(res, e.message); }

  if (!fs.existsSync(filePath)) return fail(res, 'File not found', 404);
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return fail(res, 'Path is a directory');
  if (stat.size > 2 * 1024 * 1024) return fail(res, 'File too large (max 2 MB)');
  if (isBinary(filePath)) return fail(res, 'Binary files cannot be displayed');

  const content = fs.readFileSync(filePath, 'utf8');
  ok(res, { content, path: req.query.path, size: stat.size });
}));

app.put('/servers/:id/files/write', asyncHandler(async (req, res) => {
  const server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);

  const { path: fPath, content } = req.body;
  if (!fPath) return fail(res, 'Path is required');

  const serverDir = path.join(SERVERS_PATH, server.id);
  let fullPath;
  try { fullPath = safePath(serverDir, fPath); }
  catch (e) { return fail(res, e.message); }

  fs.writeFileSync(fullPath, content ?? '', 'utf8');
  ok(res, { message: 'File saved' });
}));

app.post('/servers/:id/files/create', asyncHandler(async (req, res) => {
  const server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);

  const { path: fPath, type = 'file' } = req.body;
  if (!fPath) return fail(res, 'Path is required');

  const serverDir = path.join(SERVERS_PATH, server.id);
  let fullPath;
  try { fullPath = safePath(serverDir, fPath); }
  catch (e) { return fail(res, e.message); }

  if (fs.existsSync(fullPath)) return fail(res, 'Path already exists');

  if (type === 'directory') {
    fs.mkdirSync(fullPath, { recursive: true });
  } else {
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, '', 'utf8');
  }

  ok(res, { message: `${type === 'directory' ? 'Directory' : 'File'} created` });
}));

app.post('/servers/:id/files/delete', asyncHandler(async (req, res) => {
  const server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);

  const { path: fPath } = req.body;
  if (!fPath) return fail(res, 'Path is required');

  const serverDir = path.join(SERVERS_PATH, server.id);
  let fullPath;
  try { fullPath = safePath(serverDir, fPath); }
  catch (e) { return fail(res, e.message); }

  if (!fs.existsSync(fullPath)) return fail(res, 'Path not found', 404);

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    fs.rmSync(fullPath, { recursive: true, force: true });
  } else {
    fs.unlinkSync(fullPath);
  }

  ok(res, { message: 'Deleted' });
}));

// ─── Plugin management ────────────────────────────────────────────────────────

const plugins = require('./plugins');

app.get('/servers/:id/plugins', asyncHandler(async (req, res) => {
  const server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);

  const installed = plugins.listInstalledPlugins(SERVERS_PATH, server.id);
  ok(res, { plugins: installed });
}));

app.post('/servers/:id/plugins/install', asyncHandler(async (req, res) => {
  const server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);

  const { slug, query } = req.body;
  if (!slug && !query) return fail(res, 'slug or query is required');

  try {
    const result = await plugins.installPlugin(SERVERS_PATH, server.id, { slug, query });
    ok(res, { plugin: result });
  } catch (err) {
    fail(res, err.message, 500);
  }
}));

// ─── Mod management ───────────────────────────────────────────────────────────

app.get('/mods/search', asyncHandler(async (req, res) => {
  const { q, loader, limit = 8 } = req.query;
  if (!q) return fail(res, 'q (query) is required');
  try {
    const results = await modsModule.searchMods(q, { loader: loader || null, limit: parseInt(limit) });
    ok(res, { results });
  } catch (err) {
    fail(res, err.message, 500);
  }
}));

app.get('/servers/:id/mods', asyncHandler(async (req, res) => {
  const server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);

  const installed = modsModule.listInstalledMods(SERVERS_PATH, server.id);
  ok(res, { mods: installed });
}));

app.post('/servers/:id/mods/install', asyncHandler(async (req, res) => {
  const server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);

  const { slug, query, loader } = req.body;
  if (!slug && !query) return fail(res, 'slug or query is required');

  const serverType = (server.server_type || 'vanilla').toLowerCase();
  const resolvedLoader = loader || (docker.MOD_LOADER_TYPES.has(serverType) ? serverType : null);

  if (!resolvedLoader || !modsModule.MOD_LOADERS.includes(resolvedLoader)) {
    return fail(res, `Server type "${serverType}" does not support mods. Use fabric, forge, quilt, or neoforge.`);
  }

  try {
    const result = await modsModule.installMod(SERVERS_PATH, server.id, resolvedLoader, { slug, query });
    ok(res, { mod: result });
  } catch (err) {
    fail(res, err.message, 500);
  }
}));

app.post('/servers/:id/mods/remove', asyncHandler(async (req, res) => {
  const server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);

  const { filename } = req.body;
  if (!filename) return fail(res, 'filename is required');

  try {
    const result = modsModule.removeMod(SERVERS_PATH, server.id, filename);
    ok(res, result);
  } catch (err) {
    fail(res, err.message, 500);
  }
}));

// ─── Modpack management ───────────────────────────────────────────────────────

app.get('/modpacks/browse', asyncHandler(async (req, res) => {
  const { q, sort = 'downloads', loader, limit = 12, offset = 0 } = req.query;
  try {
    const result = await modpacksModule.browseModpacks({
      query: q || '',
      sort,
      loader: loader || null,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
    ok(res, result);
  } catch (err) {
    fail(res, err.message, 500);
  }
}));

app.get('/modpacks/:slug', asyncHandler(async (req, res) => {
  try {
    const details = await modpacksModule.getModpackDetails(req.params.slug);
    ok(res, { modpack: details });
  } catch (err) {
    fail(res, err.message, 500);
  }
}));

app.post('/servers/:id/modpack/install', asyncHandler(async (req, res) => {
  const server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);

  const { modpackSlug, loader } = req.body;
  if (!modpackSlug) return fail(res, 'modpackSlug is required');

  let packDetails;
  try {
    packDetails = await modpacksModule.getModpackDetails(modpackSlug);
  } catch (err) {
    return fail(res, `Modpack not found: ${err.message}`, 404);
  }

  const packLoader = loader || (packDetails.loaders && packDetails.loaders[0]) || 'fabric';

  // Stop and remove existing container
  if (server.container_id) {
    try { await docker.stopContainer(server.container_id); } catch {}
    try { await docker.removeContainer(server.container_id); } catch {}
  }

  db.updateServerType(server.id, packLoader);
  db.updateServerStatus(server.id, 'stopped', null);

  modpacksModule.saveModpackConfig(SERVERS_PATH, server.id, {
    slug: packDetails.slug,
    title: packDetails.title,
    loader: packLoader,
    installedAt: new Date().toISOString(),
  });

  try {
    const updatedServer = db.getServerById(server.id);
    const extra = { MODRINTH_MODPACK: packDetails.slug };
    const containerId = await docker.createContainer(updatedServer, extra);
    db.updateServerStatus(server.id, 'starting', containerId);
    await docker.startContainer(containerId);
    db.updateServerStatus(server.id, 'running', containerId);

    ok(res, { server: db.getServerById(server.id), modpack: packDetails });
  } catch (err) {
    db.updateServerStatus(server.id, 'error');
    fail(res, `Failed to start server with modpack: ${err.message}`, 500);
  }
}));

app.get('/servers/:id/modpack', asyncHandler(async (req, res) => {
  const server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);

  const config = modpacksModule.loadModpackConfig(SERVERS_PATH, server.id);
  ok(res, { modpack: config });
}));

// ─── Server config ────────────────────────────────────────────────────────────

app.get('/servers/:id/configs', asyncHandler(async (req, res) => {
  const server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);

  const serverDir = path.join(SERVERS_PATH, server.id);
  const config = actions.readServerProperties(serverDir);

  if (!config) {
    return ok(res, {
      config: null,
      message: 'server.properties not found — start the server at least once to generate it.',
    });
  }

  ok(res, { config });
}));

// ─── Start server ─────────────────────────────────────────────────────────────

app.post('/servers/:id/start', asyncHandler(async (req, res) => {
  let server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);
  if (server.status === 'running') return fail(res, 'Server is already running');

  try {
    if (!server.container_id) {
      // Re-apply MODRINTH_MODPACK if this server has a modpack installed
      const modpackConfig = modpacksModule.loadModpackConfig(SERVERS_PATH, server.id);
      const extra = modpackConfig ? { MODRINTH_MODPACK: modpackConfig.slug } : {};
      const containerId = await docker.createContainer(server, extra);
      db.updateServerStatus(server.id, 'starting', containerId);
      await docker.startContainer(containerId);
    } else {
      db.updateServerStatus(server.id, 'starting');
      await docker.startContainer(server.container_id);
    }
    db.updateServerStatus(server.id, 'running');
    server = db.getServerById(server.id);
    ok(res, { server });
  } catch (err) {
    db.updateServerStatus(server.id, 'error');
    throw err;
  }
}));

// ─── Stop server ──────────────────────────────────────────────────────────────

app.post('/servers/:id/stop', asyncHandler(async (req, res) => {
  let server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);
  if (server.status === 'stopped') return fail(res, 'Server is already stopped');
  if (!server.container_id) return fail(res, 'No container associated with this server');

  db.updateServerStatus(server.id, 'stopping');
  await docker.stopContainer(server.container_id);
  db.updateServerStatus(server.id, 'stopped');

  server = db.getServerById(server.id);
  ok(res, { server });
}));

// ─── Restart server ───────────────────────────────────────────────────────────

app.post('/servers/:id/restart', asyncHandler(async (req, res) => {
  let server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);
  if (!server.container_id) return fail(res, 'No container associated with this server');

  db.updateServerStatus(server.id, 'stopping');
  try { await docker.stopContainer(server.container_id); } catch {}
  db.updateServerStatus(server.id, 'starting');
  await docker.startContainer(server.container_id);
  db.updateServerStatus(server.id, 'running');

  server = db.getServerById(server.id);
  ok(res, { server });
}));

// ─── Delete server ────────────────────────────────────────────────────────────

app.post('/servers/:id/delete', asyncHandler(async (req, res) => {
  const server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);

  if (server.container_id) {
    await docker.removeContainer(server.container_id);
  }

  db.deleteServer(server.id);
  ok(res, { message: `Server "${server.name}" deleted.` });
}));

// ─── Container logs ───────────────────────────────────────────────────────────

app.get('/servers/:id/logs', asyncHandler(async (req, res) => {
  const server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);
  if (!server.container_id) return fail(res, 'No container for this server');

  const tail = parseInt(req.query.tail) || 200;
  const logs = await docker.getContainerLogs(server.container_id, tail);
  ok(res, { logs });
}));

// ─── Send command to server ───────────────────────────────────────────────────

app.post('/servers/:id/command', asyncHandler(async (req, res) => {
  const server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);
  if (!server.container_id) return fail(res, 'No container');
  if (server.status !== 'running') return fail(res, 'Server is not running');

  const { command } = req.body;
  if (!command || !command.trim()) return fail(res, 'Command is required');

  try {
    const result = await docker.execCommand(server.container_id, command.trim());
    ok(res, { result });
  } catch (err) {
    fail(res, `Command failed: ${err.message}`, 500);
  }
}));

// ─── AI endpoint ──────────────────────────────────────────────────────────────

app.post('/ai', asyncHandler(async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message || !message.trim()) return fail(res, 'Message is required');

  console.log(`[AI] User: "${message}"`);

  const serverContext = await ai.buildServerContext(db, docker, SERVERS_PATH);
  const intent = await ai.parseMessage(message, history, serverContext);
  console.log('[AI] Intent:', JSON.stringify(intent));

  if (intent.action === 'error') {
    return res.status(500).json({ success: false, reply: intent.message, action: intent });
  }
  if (intent.action === 'unknown') {
    return ok(res, {
      reply: intent.message || "I didn't understand that. Try something like: \"Create a Minecraft server with 4GB RAM\"",
      action: intent,
    });
  }

  if (intent.action === 'multi_step' && Array.isArray(intent.steps)) {
    console.log(`[AI] Executing multi-step plan: ${intent.steps.length} steps`);
    const result = await actions.executePlan(intent.steps, executionCtx);
    return ok(res, { reply: result.reply, action: intent, results: result.results });
  }

  const result = await actions.executeAction(intent, executionCtx);

  if (intent.action === 'diagnose_server' && result.needsAiAnalysis && result.logs) {
    console.log('[AI] Running second-pass log analysis');
    const analysis = await ai.analyzeLogs(
      intent.name, result.logs, result.config, serverContext,
    );
    result.reply += `\n\n**AI Analysis:**\n${analysis}`;
  }

  return ok(res, {
    reply: result.reply,
    action: intent,
    server: result.server,
    servers: result.servers,
  });
}));

// ─── Catch-all: serve index.html ──────────────────────────────────────────────

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ success: false, error: err.message });
});

// ─── WebSocket server ─────────────────────────────────────────────────────────

const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  let logStream = null;
  let subscribedId = null;

  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === 'subscribe' && data.serverId) {
      if (logStream) { logStream.destroy(); logStream = null; }

      const srv = db.getServerById(data.serverId);
      if (!srv || !srv.container_id) {
        ws.send(JSON.stringify({ type: 'error', message: 'Server not found or no container' }));
        return;
      }

      subscribedId = data.serverId;

      try {
        logStream = await docker.streamContainerLogs(srv.container_id, (line) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'log', data: line }));
          }
        });
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    }

    if (data.type === 'command' && data.command) {
      const sid = data.serverId || subscribedId;
      if (!sid) return;
      const srv = db.getServerById(sid);
      if (!srv || !srv.container_id) {
        ws.send(JSON.stringify({ type: 'error', message: 'Server not available' }));
        return;
      }
      try {
        const result = await docker.execCommand(srv.container_id, data.command);
        ws.send(JSON.stringify({ type: 'command_result', data: result, command: data.command }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'command_error', message: err.message, command: data.command }));
      }
    }

    if (data.type === 'unsubscribe') {
      if (logStream) { logStream.destroy(); logStream = null; }
      subscribedId = null;
    }
  });

  ws.on('close', () => { if (logStream) logStream.destroy(); });
  ws.on('error', () => { if (logStream) logStream.destroy(); });
});

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`Game Server Hosting running at http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`  AI model: ${process.env.GROQ_API_KEY ? 'Groq API key loaded' : 'GROQ_API_KEY not set'}`);
});
