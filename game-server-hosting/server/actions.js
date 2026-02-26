/**
 * actions.js
 * Structured action executor — validates and runs each action the AI produces.
 *
 * Every action goes through:
 *   1. Schema validation (required fields present?)
 *   2. Template validation (config keys valid? values in range?)
 *   3. Execution (actual Docker/DB/filesystem work)
 *   4. Structured result (success/failure + human-readable reply)
 *
 * Supports single actions and multi-step plans.
 */

const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const templates = require('./templates');

// ─── Action schemas ────────────────────────────────────────────────────────────

const ACTION_SCHEMAS = {
  chat: {
    required: ['message'],
    optional: [],
  },
  create_server: {
    required: [],
    optional: ['name', 'game', 'ram', 'properties'],
  },
  modify_server: {
    required: ['name'],
    optional: ['properties'],
  },
  start_server: {
    required: ['name'],
    optional: [],
  },
  stop_server: {
    required: ['name'],
    optional: [],
  },
  restart_server: {
    required: ['name'],
    optional: [],
  },
  delete_server: {
    required: ['name'],
    optional: [],
  },
  list_servers: {
    required: [],
    optional: [],
  },
  server_status: {
    required: ['name'],
    optional: [],
  },
  diagnose_server: {
    required: ['name'],
    optional: [],
  },
};

// ─── Validation ────────────────────────────────────────────────────────────────

function validateAction(action) {
  if (!action || !action.action) {
    return { valid: false, reason: 'Missing "action" field' };
  }

  const schema = ACTION_SCHEMAS[action.action];
  if (!schema) {
    return { valid: false, reason: `Unknown action "${action.action}"` };
  }

  for (const field of schema.required) {
    if (!action[field]) {
      return { valid: false, reason: `Action "${action.action}" requires "${field}"` };
    }
  }

  return { valid: true };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function normaliseRam(ram) {
  if (!ram) return '2G';
  const str = String(ram).trim().toUpperCase();
  if (/^\d+(\.\d+)?[GM]$/.test(str)) return str;
  if (/^\d+(\.\d+)?GB$/.test(str)) return str.replace('GB', 'G');
  if (/^\d+(\.\d+)?MB$/.test(str)) return str.replace('MB', 'M');
  return str || '2G';
}

function findServerByName(db, name) {
  if (!name) return null;
  const servers = db.getAllServers();
  const lower = name.toLowerCase().trim();
  return (
    servers.find((s) => s.name.toLowerCase() === lower) ||
    servers.find((s) => s.name.toLowerCase().includes(lower)) ||
    null
  );
}

function readServerProperties(serverDir) {
  const propsFile = path.join(serverDir, 'server.properties');
  if (!fs.existsSync(propsFile)) return null;

  const content = fs.readFileSync(propsFile, 'utf8');
  const props = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    props[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  return props;
}

function writeServerProperties(serverDir, properties) {
  const propsFile = path.join(serverDir, 'server.properties');
  if (!fs.existsSync(propsFile)) {
    throw new Error('server.properties not found — has the server been started at least once?');
  }

  let content = fs.readFileSync(propsFile, 'utf8');
  const changes = [];

  for (const [envKey, value] of Object.entries(properties)) {
    const propKey = templates.envKeyToPropertyKey(envKey);
    const regex = new RegExp(`^${propKey}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${propKey}=${value}`);
    } else {
      content += `\n${propKey}=${value}`;
    }
    changes.push(`${propKey}=${value}`);
  }

  fs.writeFileSync(propsFile, content, 'utf8');
  return changes;
}

// ─── Individual action executors ───────────────────────────────────────────────

const executors = {
  async chat(action, _ctx) {
    return { success: true, reply: action.message };
  },

  async create_server(action, ctx) {
    const name = action.name || `${action.game || 'minecraft'}-${uuidv4().slice(0, 4)}`;
    const game = (action.game || 'minecraft').toLowerCase();
    const ram = normaliseRam(action.ram || '2G');
    const properties = action.properties || {};

    const supported = ['minecraft'];
    if (!supported.includes(game)) {
      return { success: false, reply: `Unsupported game "${game}". Supported: ${supported.join(', ')}` };
    }

    if (Object.keys(properties).length > 0) {
      const validation = templates.validateProperties(game, properties);
      if (!validation.valid) {
        return {
          success: false,
          reply: `Invalid config values:\n${validation.errors.map((e) => `• ${e}`).join('\n')}`,
        };
      }
    }

    const id = uuidv4();
    let server;
    try {
      server = ctx.db.createServer({ id, name, game, ram });
    } catch (err) {
      if (err.message.includes('UNIQUE constraint')) {
        return { success: false, reply: 'A server with that port already exists. Try again.' };
      }
      throw err;
    }

    try {
      const containerId = await ctx.docker.createContainer(server, properties);
      ctx.db.updateServerStatus(id, 'starting', containerId);
      await ctx.docker.startContainer(containerId);
      ctx.db.updateServerStatus(id, 'running', containerId);
      server = ctx.db.getServerById(id);
      return {
        success: true,
        reply: `Server **${name}** created and started on port ${server.port} with ${ram} RAM.`,
        server,
      };
    } catch (err) {
      ctx.db.updateServerStatus(id, 'error');
      return {
        success: false,
        reply: `Server record created but Docker failed: ${err.message}`,
        server: ctx.db.getServerById(id),
      };
    }
  },

  async modify_server(action, ctx) {
    const server = findServerByName(ctx.db, action.name);
    if (!server) {
      return { success: false, reply: `No server found with name "${action.name}".` };
    }

    const props = action.properties || {};
    if (Object.keys(props).length === 0) {
      return { success: true, reply: `No properties specified to change on **${server.name}**.`, server };
    }

    const validation = templates.validateProperties(server.game, props);
    if (!validation.valid) {
      return {
        success: false,
        reply: `Invalid config values:\n${validation.errors.map((e) => `• ${e}`).join('\n')}`,
        server,
      };
    }

    try {
      const serverDir = path.join(ctx.serversPath, server.id);
      const changes = writeServerProperties(serverDir, props);
      const needsRestart = server.status === 'running';
      let reply = `Updated **${server.name}**:\n${changes.map((c) => `• ${c}`).join('\n')}`;
      if (needsRestart) {
        reply += `\n\n**Restart required** for changes to take effect. Say "restart ${server.name}" to apply.`;
      }
      return { success: true, reply, server };
    } catch (err) {
      return { success: false, reply: `Failed to modify properties: ${err.message}`, server };
    }
  },

  async start_server(action, ctx) {
    const server = findServerByName(ctx.db, action.name);
    if (!server) {
      return { success: false, reply: `No server found with name "${action.name}".` };
    }
    if (server.status === 'running') {
      return { success: true, reply: `**${server.name}** is already running.`, server };
    }

    try {
      if (!server.container_id) {
        const containerId = await ctx.docker.createContainer(server);
        ctx.db.updateServerStatus(server.id, 'starting', containerId);
        await ctx.docker.startContainer(containerId);
      } else {
        ctx.db.updateServerStatus(server.id, 'starting');
        await ctx.docker.startContainer(server.container_id);
      }
      ctx.db.updateServerStatus(server.id, 'running');
      return {
        success: true,
        reply: `**${server.name}** started on port ${server.port}.`,
        server: ctx.db.getServerById(server.id),
      };
    } catch (err) {
      ctx.db.updateServerStatus(server.id, 'error');
      return { success: false, reply: `Failed to start server: ${err.message}` };
    }
  },

  async stop_server(action, ctx) {
    const server = findServerByName(ctx.db, action.name);
    if (!server) {
      return { success: false, reply: `No server found with name "${action.name}".` };
    }
    if (server.status === 'stopped') {
      return { success: true, reply: `**${server.name}** is already stopped.`, server };
    }
    if (!server.container_id) {
      return { success: false, reply: `No container associated with **${server.name}**.` };
    }

    ctx.db.updateServerStatus(server.id, 'stopping');
    await ctx.docker.stopContainer(server.container_id);
    ctx.db.updateServerStatus(server.id, 'stopped');
    return {
      success: true,
      reply: `**${server.name}** stopped.`,
      server: ctx.db.getServerById(server.id),
    };
  },

  async restart_server(action, ctx) {
    const server = findServerByName(ctx.db, action.name);
    if (!server) {
      return { success: false, reply: `No server found with name "${action.name}".` };
    }
    if (!server.container_id) {
      return { success: false, reply: `No container associated with **${server.name}**.` };
    }

    ctx.db.updateServerStatus(server.id, 'stopping');
    try { await ctx.docker.stopContainer(server.container_id); } catch {}
    ctx.db.updateServerStatus(server.id, 'starting');
    await ctx.docker.startContainer(server.container_id);
    ctx.db.updateServerStatus(server.id, 'running');

    return {
      success: true,
      reply: `**${server.name}** restarted.`,
      server: ctx.db.getServerById(server.id),
    };
  },

  async delete_server(action, ctx) {
    const server = findServerByName(ctx.db, action.name);
    if (!server) {
      return { success: false, reply: `No server found with name "${action.name}".` };
    }
    if (server.container_id) {
      await ctx.docker.removeContainer(server.container_id);
    }
    ctx.db.deleteServer(server.id);
    return { success: true, reply: `Server **${server.name}** has been deleted.` };
  },

  async list_servers(_action, ctx) {
    const servers = ctx.db.getAllServers();
    if (servers.length === 0) {
      return { success: true, reply: 'No servers yet. Say "create a Minecraft server" to get started.', servers: [] };
    }
    const lines = servers.map(
      (s) => `• **${s.name}** (${s.game}) — ${s.status} — port ${s.port}, RAM ${s.ram}`
    );
    return { success: true, reply: `**Your servers:**\n${lines.join('\n')}`, servers };
  },

  async server_status(action, ctx) {
    const server = findServerByName(ctx.db, action.name);
    if (!server) {
      return { success: false, reply: `No server found with name "${action.name}".` };
    }

    let dockerStatus = 'unknown';
    if (server.container_id) {
      try {
        const info = await ctx.docker.inspectContainer(server.container_id);
        dockerStatus = info.status;
      } catch {
        dockerStatus = 'container not found';
      }
    }

    const serverDir = path.join(ctx.serversPath, server.id);
    const config = readServerProperties(serverDir);
    const configSummary = config
      ? Object.entries(config)
          .filter(([k]) => !k.startsWith('#'))
          .slice(0, 15)
          .map(([k, v]) => `  ${k}=${v}`)
          .join('\n')
      : '(not yet generated — start the server first)';

    return {
      success: true,
      reply: [
        `**${server.name}** status:`,
        `• Game: ${server.game}`,
        `• Status: ${server.status} (Docker: ${dockerStatus})`,
        `• Port: ${server.port}`,
        `• RAM: ${server.ram}`,
        `• Created: ${server.created_at}`,
        ``,
        `**Config (server.properties):**`,
        configSummary,
      ].join('\n'),
      server,
    };
  },

  async diagnose_server(action, ctx) {
    const server = findServerByName(ctx.db, action.name);
    if (!server) {
      return { success: false, reply: `No server found with name "${action.name}".` };
    }

    let logs = '(no logs available)';
    if (server.container_id) {
      try {
        logs = await ctx.docker.getContainerLogs(server.container_id, 300);
      } catch {
        logs = '(could not retrieve logs)';
      }
    }

    const serverDir = path.join(ctx.serversPath, server.id);
    const config = readServerProperties(serverDir);

    const patternMatches = templates.diagnoseFromLogs(server.game, logs);

    if (patternMatches.length > 0) {
      const lines = patternMatches.map(
        (m) => `**Issue:** ${m.diagnosis}\n  **Fix:** ${m.fix}`
      );
      return {
        success: true,
        reply: [
          `**Diagnosis for ${server.name}:**`,
          '',
          ...lines,
          '',
          config ? `Current RAM: ${server.ram}, max-players: ${config['max-players'] || '?'}, view-distance: ${config['view-distance'] || '?'}` : '',
        ].join('\n'),
        server,
        logs: logs.slice(-2000),
        issues: patternMatches,
      };
    }

    // No known patterns matched — return logs for AI second-pass analysis
    return {
      success: true,
      reply: `No known issues detected in **${server.name}** logs. The server appears healthy.`,
      server,
      logs: logs.slice(-2000),
      config,
      needsAiAnalysis: true,
    };
  },
};

// ─── Main executor ─────────────────────────────────────────────────────────────

/**
 * Execute a single action. Returns { success, reply, ...extra }.
 */
async function executeAction(action, ctx) {
  const validation = validateAction(action);
  if (!validation.valid) {
    return { success: false, reply: validation.reason, action };
  }

  const executor = executors[action.action];
  if (!executor) {
    return { success: false, reply: `No executor for action "${action.action}"`, action };
  }

  const result = await executor(action, ctx);
  result.action = action;
  return result;
}

/**
 * Execute a multi-step plan. Stops on first failure.
 * Returns { success, reply, results[] }.
 */
async function executePlan(steps, ctx) {
  const results = [];
  const replies = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepLabel = `**Step ${i + 1}/${steps.length}** — ${step.action}`;

    const result = await executeAction(step, ctx);
    results.push(result);

    if (result.success) {
      replies.push(`${stepLabel}: ${result.reply}`);
    } else {
      replies.push(`${stepLabel} FAILED: ${result.reply}`);
      return {
        success: false,
        reply: replies.join('\n\n'),
        results,
        stoppedAtStep: i + 1,
      };
    }
  }

  return {
    success: true,
    reply: replies.join('\n\n'),
    results,
  };
}

module.exports = {
  ACTION_SCHEMAS,
  validateAction,
  executeAction,
  executePlan,
  readServerProperties,
  findServerByName,
};
