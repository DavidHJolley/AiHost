/**
 * index.js
 * Main Express server for Game Server Hosting MVP.
 *
 * Routes:
 *   GET    /                     → serves client/index.html
 *   GET    /servers              → list all servers
 *   POST   /servers/create       → create a new server
 *   GET    /servers/:id          → get server info
 *   POST   /servers/:id/start    → start server container
 *   POST   /servers/:id/stop     → stop server container
 *   POST   /servers/:id/delete   → remove server + container
 *   GET    /servers/:id/logs     → get container logs
 *   POST   /ai                   → natural language → action → execute
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const fs = require('fs');

const db = require('./database');
const docker = require('./docker');
const ai = require('./ai');

// ─── Property key mapping (SCREAMING_SNAKE_CASE → server.properties key) ─────

function envKeyToPropertyKey(key) {
  return key.toLowerCase().replace(/_/g, '-');
}

function modifyServerProperties(serverDir, properties) {
  const propsFile = path.join(serverDir, 'server.properties');
  if (!fs.existsSync(propsFile)) {
    throw new Error('server.properties not found — has the server been started at least once?');
  }
  let content = fs.readFileSync(propsFile, 'utf8');
  const changes = [];

  for (const [envKey, value] of Object.entries(properties)) {
    const propKey = envKeyToPropertyKey(envKey);
    const regex = new RegExp(`^${propKey}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${propKey}=${value}`);
      changes.push(`${propKey}=${value}`);
    } else {
      content += `\n${propKey}=${value}`;
      changes.push(`${propKey}=${value}`);
    }
  }

  fs.writeFileSync(propsFile, content, 'utf8');
  return changes;
}

const app = express();
const PORT = process.env.PORT || 3000;

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

// ─── Server list ──────────────────────────────────────────────────────────────

app.get('/servers', asyncHandler(async (_req, res) => {
  const servers = db.getAllServers();

  // Sync live Docker status for each server
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
        // Container gone
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

  if (!name || !name.trim()) {
    return fail(res, 'Server name is required');
  }

  // Validate / normalise
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

  // Create and start container
  try {
    const containerId = await docker.createContainer(server, properties);
    db.updateServerStatus(id, 'starting', containerId);
    await docker.startContainer(containerId);
    db.updateServerStatus(id, 'running', containerId);
    server = db.getServerById(id);
  } catch (err) {
    db.updateServerStatus(id, 'error');
    console.error('[Docker] Create/start failed:', err.message);
    // Return the server record even on Docker error so UI can show it
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

// ─── Start server ─────────────────────────────────────────────────────────────

app.post('/servers/:id/start', asyncHandler(async (req, res) => {
  let server = db.getServerById(req.params.id);
  if (!server) return fail(res, 'Server not found', 404);

  if (server.status === 'running') {
    return fail(res, 'Server is already running');
  }

  try {
    if (!server.container_id) {
      // Container was never created or was deleted — recreate it
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

  if (server.status === 'stopped') {
    return fail(res, 'Server is already stopped');
  }

  if (!server.container_id) return fail(res, 'No container associated with this server');

  db.updateServerStatus(server.id, 'stopping');
  await docker.stopContainer(server.container_id);
  db.updateServerStatus(server.id, 'stopped');

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

  const logs = await docker.getContainerLogs(server.container_id, 200);
  ok(res, { logs });
}));

// ─── AI endpoint ──────────────────────────────────────────────────────────────

app.post('/ai', asyncHandler(async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message || !message.trim()) {
    return fail(res, 'Message is required');
  }

  console.log(`[AI] User message: "${message}"`);

  const intent = await ai.parseMessage(message, history);
  console.log('[AI] Intent:', JSON.stringify(intent));

  // Execute intent ──────────────────────────────────────────────────────────

  switch (intent.action) {
    case 'create_server': {
      const name = intent.name || `${intent.game || 'minecraft'}-${uuidv4().slice(0, 4)}`;
      const game = (intent.game || 'minecraft').toLowerCase();
      const ram = normaliseRam(intent.ram || '2G');
      const properties = intent.properties || {};

      const id = uuidv4();
      let server = db.createServer({ id, name, game, ram });

      try {
        const containerId = await docker.createContainer(server, properties);
        db.updateServerStatus(id, 'starting', containerId);
        await docker.startContainer(containerId);
        db.updateServerStatus(id, 'running', containerId);
        server = db.getServerById(id);
        return ok(res, {
          reply: `✅ Server **${name}** created and started on port ${server.port}.`,
          action: intent,
          server,
        });
      } catch (err) {
        db.updateServerStatus(id, 'error');
        return res.status(500).json({
          success: false,
          reply: `⚠️ Server record created but Docker failed: ${err.message}`,
          action: intent,
          server: db.getServerById(id),
        });
      }
    }

    case 'modify_server': {
      const server = findServerByName(intent.name);
      if (!server) {
        return ok(res, {
          reply: `❌ No server found with name "${intent.name}".`,
          action: intent,
        });
      }
      const props = intent.properties || {};
      if (Object.keys(props).length === 0) {
        return ok(res, {
          reply: `ℹ️ No properties specified to change.`,
          action: intent,
          server,
        });
      }
      try {
        const serverDir = path.join(process.cwd(), 'servers', server.id);
        const changes = modifyServerProperties(serverDir, props);
        return ok(res, {
          reply: `✅ Updated **${server.name}**:\n${changes.map(c => `• ${c}`).join('\n')}\n\n⚠️ **Restart the server for changes to take effect.** Say "restart Survival" to apply.`,
          action: intent,
          server,
        });
      } catch (err) {
        return res.status(500).json({
          success: false,
          reply: `⚠️ Failed to modify server properties: ${err.message}`,
          action: intent,
          server,
        });
      }
    }

    case 'start_server': {
      const server = findServerByName(intent.name);
      if (!server) {
        return ok(res, {
          reply: `❌ No server found with name "${intent.name}".`,
          action: intent,
        });
      }
      if (server.status === 'running') {
        return ok(res, {
          reply: `ℹ️ Server "${server.name}" is already running.`,
          action: intent,
          server,
        });
      }
      try {
        if (!server.container_id) {
          const containerId = await docker.createContainer(server);
          db.updateServerStatus(server.id, 'starting', containerId);
          await docker.startContainer(containerId);
        } else {
          await docker.startContainer(server.container_id);
        }
        db.updateServerStatus(server.id, 'running');
        return ok(res, {
          reply: `▶️ Server "${server.name}" started on port ${server.port}.`,
          action: intent,
          server: db.getServerById(server.id),
        });
      } catch (err) {
        db.updateServerStatus(server.id, 'error');
        throw err;
      }
    }

    case 'stop_server': {
      const server = findServerByName(intent.name);
      if (!server) {
        return ok(res, {
          reply: `❌ No server found with name "${intent.name}".`,
          action: intent,
        });
      }
      if (server.status === 'stopped') {
        return ok(res, {
          reply: `ℹ️ Server "${server.name}" is already stopped.`,
          action: intent,
          server,
        });
      }
      if (server.container_id) {
        await docker.stopContainer(server.container_id);
      }
      db.updateServerStatus(server.id, 'stopped');
      return ok(res, {
        reply: `⏹️ Server "${server.name}" stopped.`,
        action: intent,
        server: db.getServerById(server.id),
      });
    }

    case 'delete_server': {
      const server = findServerByName(intent.name);
      if (!server) {
        return ok(res, {
          reply: `❌ No server found with name "${intent.name}".`,
          action: intent,
        });
      }
      if (server.container_id) {
        await docker.removeContainer(server.container_id);
      }
      db.deleteServer(server.id);
      return ok(res, {
        reply: `🗑️ Server "${server.name}" has been deleted.`,
        action: intent,
      });
    }

    case 'list_servers': {
      const servers = db.getAllServers();
      const lines = servers.length
        ? servers.map((s) => `• **${s.name}** (${s.game}) — ${s.status} — port ${s.port}`)
        : ['No servers yet.'];
      return ok(res, {
        reply: `📋 **Your servers:**\n${lines.join('\n')}`,
        action: intent,
        servers,
      });
    }

    case 'unknown':
      return ok(res, {
        reply: intent.message || "I didn't understand that. Try: \"Create a Minecraft server with 4GB RAM\"",
        action: intent,
      });

    case 'error':
      return res.status(500).json({
        success: false,
        reply: intent.message,
        action: intent,
      });

    default:
      return ok(res, {
        reply: "I didn't understand that action. Try: \"Create a Minecraft server with 4GB RAM\"",
        action: intent,
      });
  }
}));

// ─── Catch-all: serve index.html for unknown routes ───────────────────────────

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
  console.log(`🎮 Game Server Hosting running at http://localhost:${PORT}`);
  console.log(`   Docker socket: /var/run/docker.sock`);
  console.log(`   AI: ${process.env.ANTHROPIC_API_KEY ? 'Anthropic API key loaded ✓' : '⚠ ANTHROPIC_API_KEY not set'}`);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normaliseRam(ram) {
  if (!ram) return '2G';
  const str = String(ram).trim().toUpperCase();
  // Already normalised e.g. "4G" or "512M"
  if (/^\d+(\.\d+)?[GM]$/.test(str)) return str;
  // Handle "4GB" → "4G", "512MB" → "512M"
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
