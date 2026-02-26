/**
 * index.js
 * Main Express server for AI-Driven Game Server Hosting.
 *
 * Routes:
 *   GET    /                          → serves client/index.html
 *   GET    /servers                   → list all servers (syncs Docker status)
 *   POST   /servers/create            → create a new server
 *   GET    /servers/:id               → get server info
 *   GET    /servers/:id/status        → detailed status + config + Docker info
 *   GET    /servers/:id/files         → list files in server directory
 *   GET    /servers/:id/configs       → parsed server.properties
 *   POST   /servers/:id/start         → start server container
 *   POST   /servers/:id/stop          → stop server container
 *   POST   /servers/:id/restart       → restart server container
 *   POST   /servers/:id/delete        → remove server + container
 *   GET    /servers/:id/logs          → get container logs
 *   POST   /ai                        → natural language → structured actions → execute
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const db = require('./database');
const docker = require('./docker');
const ai = require('./ai');
const actions = require('./actions');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVERS_PATH = path.join(process.cwd(), 'servers');

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());
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

// Shared context object passed to the action executor
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
  let { name, game = 'minecraft', ram = '2G', properties = {} } = req.body;

  if (!name || !name.trim()) return fail(res, 'Server name is required');

  name = name.trim();
  game = game.toLowerCase().trim();
  ram = normaliseRam(ram);

  const supported = ['minecraft'];
  if (!supported.includes(game)) {
    return fail(res, `Unsupported game "${game}". Supported: ${supported.join(', ')}`);
  }

  const id = uuidv4();
  let server;
  try {
    server = db.createServer({ id, name, game, ram });
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

// ─── Detailed server status (Step 2 — Server Awareness) ──────────────────────

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

// ─── List server files (Step 2 — Server Awareness) ───────────────────────────

app.get('/servers/:id/files', asyncHandler(async (req, res) => {
  const server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);

  const serverDir = path.join(SERVERS_PATH, server.id);
  if (!fs.existsSync(serverDir)) {
    return ok(res, { files: [] });
  }

  function listDir(dir, prefix = '') {
    const entries = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        entries.push({ name: relativePath, type: 'directory' });
        // Only go one level deep to avoid huge responses
        if (!prefix) {
          entries.push(...listDir(path.join(dir, entry.name), relativePath));
        }
      } else {
        const stat = fs.statSync(path.join(dir, entry.name));
        entries.push({ name: relativePath, type: 'file', size: stat.size });
      }
    }
    return entries;
  }

  ok(res, { files: listDir(serverDir) });
}));

// ─── Get server config (Step 2 — Server Awareness) ──────────────────────────

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
      const containerId = await docker.createContainer(server);
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

// ─── AI endpoint ──────────────────────────────────────────────────────────────

app.post('/ai', asyncHandler(async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message || !message.trim()) return fail(res, 'Message is required');

  console.log(`[AI] User: "${message}"`);

  // Step 2 — Build server awareness context
  const serverContext = await ai.buildServerContext(db, docker, SERVERS_PATH);

  // Step 1/3/4 — Parse natural language into structured action(s)
  const intent = await ai.parseMessage(message, history, serverContext);
  console.log('[AI] Intent:', JSON.stringify(intent));

  // Handle error/unknown from the AI itself
  if (intent.action === 'error') {
    return res.status(500).json({ success: false, reply: intent.message, action: intent });
  }
  if (intent.action === 'unknown') {
    return ok(res, {
      reply: intent.message || "I didn't understand that. Try something like: \"Create a Minecraft server with 4GB RAM\"",
      action: intent,
    });
  }

  // Step 4 — Multi-step plan execution
  if (intent.action === 'multi_step' && Array.isArray(intent.steps)) {
    console.log(`[AI] Executing multi-step plan: ${intent.steps.length} steps`);
    const result = await actions.executePlan(intent.steps, executionCtx);
    return ok(res, { reply: result.reply, action: intent, results: result.results });
  }

  // Single action execution
  const result = await actions.executeAction(intent, executionCtx);

  // Step 5 — If diagnose came back with no pattern matches, do AI log analysis
  if (intent.action === 'diagnose_server' && result.needsAiAnalysis && result.logs) {
    console.log('[AI] Running second-pass log analysis');
    const analysis = await ai.analyzeLogs(
      intent.name,
      result.logs,
      result.config,
      serverContext
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

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Game Server Hosting running at http://localhost:${PORT}`);
  console.log(`  AI model: ${process.env.GROQ_API_KEY ? 'Groq API key loaded' : 'GROQ_API_KEY not set'}`);
});
