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
const plugins = require('./plugins');
const modpacks = require('./modpacks');

// ─── Action schemas ────────────────────────────────────────────────────────────

const ACTION_SCHEMAS = {
  chat: {
    required: ['message'],
    optional: [],
  },
  create_server: {
    required: [],
    optional: ['name', 'game', 'ram', 'properties', 'server_type'],
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
  search_plugins: {
    required: ['query'],
    optional: [],
  },
  install_plugin: {
    required: ['name'],
    optional: ['query', 'slug'],
  },
  remove_plugin: {
    required: ['name', 'pluginName'],
    optional: [],
  },
  list_plugins: {
    required: ['name'],
    optional: [],
  },
  search_mods: {
    required: ['query'],
    optional: ['name'],
  },
  search_modpacks: {
    required: ['query'],
    optional: [],
  },
  install_modpack: {
    required: ['name'],
    optional: ['query', 'slug'],
  },
  remove_modpack: {
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
    const serverType = (action.server_type || 'vanilla').toLowerCase();

    const supported = ['minecraft'];
    if (!supported.includes(game)) {
      return { success: false, reply: `Unsupported game "${game}". Supported: ${supported.join(', ')}` };
    }

    const validTypes = ['vanilla', 'paper', 'spigot', 'purpur'];
    if (!validTypes.includes(serverType)) {
      return { success: false, reply: `Unsupported server type "${serverType}". Supported: ${validTypes.join(', ')}` };
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
      server = ctx.db.createServer({ id, name, game, ram, server_type: serverType });
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
        reply: `Server **${name}** (${serverType}) created and started on port ${server.port} with ${ram} RAM.`,
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

    let patternMatches = templates.diagnoseFromLogs(server.game, logs);
    const configLagHints = templates.getConfigLagHints(server.game, config, server.ram);

    if (configLagHints.length > 0) {
      patternMatches = patternMatches.filter(
        (m) => !/shutting down|Stopping the server/i.test(m.diagnosis)
      );
    }

    const parts = [`**Diagnosis for ${server.name}:**`, ''];
    if (patternMatches.length > 0) {
      parts.push(...patternMatches.map((m) => `**Issue:** ${m.diagnosis}\n  **Fix:** ${m.fix}`), '');
    }
    if (configLagHints.length > 0) {
      parts.push('**Likely lag causes:**', '', ...configLagHints, '');
    }
    if (config) {
      parts.push(`Current: RAM ${server.ram}, max-players: ${config['max-players'] || '?'}, view-distance: ${config['view-distance'] || '?'}`);
    }

    if (patternMatches.length > 0 || configLagHints.length > 0) {
      return {
        success: true,
        reply: parts.join('\n'),
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

  async search_plugins(action, _ctx) {
    try {
      const results = await plugins.searchPlugins(action.query, { limit: 5 });
      if (results.length === 0) {
        return { success: true, reply: `No plugins found for "${action.query}". Try different keywords.` };
      }
      const lines = results.map((p, i) =>
        `${i + 1}. **${p.title}** (\`${p.slug}\`) — ${p.description}\n   ${p.downloads.toLocaleString()} downloads`
      );
      return {
        success: true,
        reply: `**Plugins matching "${action.query}":**\n\n${lines.join('\n\n')}\n\nSay "install <name> on <server>" to install one.`,
        results,
      };
    } catch (err) {
      return { success: false, reply: `Plugin search failed: ${err.message}` };
    }
  },

  async install_plugin(action, ctx) {
    const server = findServerByName(ctx.db, action.name);
    if (!server) {
      return { success: false, reply: `No server found with name "${action.name}".` };
    }

    // Modpack servers take mods (Fabric/Forge), not Bukkit plugins — route there.
    const pack = ctx.db.getModpack(server);
    if (pack) {
      try {
        const modInfo = await plugins.installMod(ctx.serversPath, server.id, {
          slug: action.slug,
          query: action.query,
          loader: pack.loader,
          mcVersion: pack.mcVersion,
        });

        if (modInfo.alreadyInstalled) {
          return {
            success: true,
            reply: `**${modInfo.title}** v${modInfo.version} is already installed on **${server.name}**.`,
            server,
            plugin: modInfo,
          };
        }

        const restartHint = server.status === 'running'
          ? `\n\n**Restart required** to load the mod. Say "restart ${server.name}" to apply.`
          : '';
        return {
          success: true,
          reply: `**${modInfo.title}** v${modInfo.version} (${pack.loader} mod) installed on **${server.name}**.${restartHint}`,
          server,
          plugin: modInfo,
        };
      } catch (err) {
        return { success: false, reply: `Mod install failed: ${err.message}`, server };
      }
    }

    const PLUGIN_LOADERS = ['paper', 'spigot', 'purpur'];
    const needsUpgrade = !PLUGIN_LOADERS.includes(server.server_type);
    let upgraded = false;

    // Auto-upgrade vanilla → Paper for plugin support
    if (needsUpgrade) {
      try {
        // Stop and remove the vanilla container
        if (server.container_id) {
          try { await ctx.docker.stopContainer(server.container_id); } catch {}
          try { await ctx.docker.removeContainer(server.container_id); } catch {}
        }

        // Update DB to paper
        ctx.db.updateServerType(server.id, 'paper');
        ctx.db.updateServerStatus(server.id, 'stopped', null);
        upgraded = true;
      } catch (err) {
        return { success: false, reply: `Failed to upgrade server to Paper: ${err.message}`, server };
      }
    }

    // Install the plugin
    let pluginInfo;
    try {
      pluginInfo = await plugins.installPlugin(ctx.serversPath, server.id, {
        slug: action.slug,
        query: action.query,
      });
    } catch (err) {
      return { success: false, reply: `Plugin install failed: ${err.message}`, server };
    }

    if (pluginInfo.alreadyInstalled) {
      return {
        success: true,
        reply: `**${pluginInfo.title}** v${pluginInfo.version} is already installed on **${server.name}**.`,
        server,
        plugin: pluginInfo,
      };
    }

    // If we upgraded, recreate and start the Paper container
    if (upgraded) {
      try {
        const updatedServer = ctx.db.getServerById(server.id);
        const containerId = await ctx.docker.createContainer(updatedServer);
        ctx.db.updateServerStatus(server.id, 'starting', containerId);
        await ctx.docker.startContainer(containerId);
        ctx.db.updateServerStatus(server.id, 'running', containerId);

        return {
          success: true,
          reply: [
            `**${pluginInfo.title}** v${pluginInfo.version} installed on **${server.name}**.`,
            ``,
            `Server was automatically upgraded from vanilla to **Paper** (required for plugins).`,
            `The server is now restarting with Paper — the plugin will load automatically.`,
          ].join('\n'),
          server: ctx.db.getServerById(server.id),
          plugin: pluginInfo,
        };
      } catch (err) {
        return {
          success: false,
          reply: `Plugin downloaded but failed to restart server with Paper: ${err.message}`,
          server: ctx.db.getServerById(server.id),
          plugin: pluginInfo,
        };
      }
    }

    // Server already supports plugins — just needs a restart
    const restartHint = server.status === 'running'
      ? `\n\n**Restart required** to load the plugin. Say "restart ${server.name}" to apply.`
      : '';

    return {
      success: true,
      reply: `**${pluginInfo.title}** v${pluginInfo.version} installed on **${server.name}**.${restartHint}`,
      server,
      plugin: pluginInfo,
    };
  },

  async remove_plugin(action, ctx) {
    const server = findServerByName(ctx.db, action.name);
    if (!server) {
      return { success: false, reply: `No server found with name "${action.name}".` };
    }

    const pack = ctx.db.getModpack(server);
    const folderLabel = pack ? 'Mod' : 'Plugin';

    try {
      // Try exact match first, then fuzzy match on filename
      const installed = pack
        ? plugins.listInstalledMods(ctx.serversPath, server.id)
        : plugins.listInstalledPlugins(ctx.serversPath, server.id);
      const target = action.pluginName.toLowerCase();
      const match = installed.find((p) => p.filename.toLowerCase() === target)
        || installed.find((p) => p.filename.toLowerCase().includes(target));

      if (!match) {
        const names = installed.map((p) => p.filename).join(', ') || 'none';
        return { success: false, reply: `${folderLabel} "${action.pluginName}" not found. Installed: ${names}`, server };
      }

      if (pack) {
        plugins.removeMod(ctx.serversPath, server.id, match.filename);
      } else {
        plugins.removePlugin(ctx.serversPath, server.id, match.filename);
      }

      const restartHint = server.status === 'running'
        ? ` Restart the server to unload it.`
        : '';

      return {
        success: true,
        reply: `Removed **${match.filename}** from **${server.name}**.${restartHint}`,
        server,
      };
    } catch (err) {
      return { success: false, reply: `Failed to remove ${folderLabel.toLowerCase()}: ${err.message}`, server };
    }
  },

  async list_plugins(action, ctx) {
    const server = findServerByName(ctx.db, action.name);
    if (!server) {
      return { success: false, reply: `No server found with name "${action.name}".` };
    }

    const pack = ctx.db.getModpack(server);
    const installed = pack
      ? plugins.listInstalledMods(ctx.serversPath, server.id)
      : plugins.listInstalledPlugins(ctx.serversPath, server.id);
    const label = pack ? 'mods' : 'plugins';

    if (installed.length === 0) {
      return {
        success: true,
        reply: `No ${label} installed on **${server.name}**. Say "install <name>" to add one.`,
        server,
      };
    }

    const lines = installed.map((p) => {
      const sizeMB = (p.size / 1024 / 1024).toFixed(1);
      return `• **${p.filename}** (${sizeMB} MB)`;
    });

    const packLine = pack ? `Modpack: **${pack.title}** v${pack.versionNumber} (${pack.loader}, MC ${pack.mcVersion})\n\n` : '';

    return {
      success: true,
      reply: `${packLine}**${pack ? 'Mods' : 'Plugins'} on ${server.name}:**\n${lines.join('\n')}`,
      server,
      plugins: installed,
    };
  },

  async search_mods(action, ctx) {
    // If a server is named and runs a modpack, scope results to its loader/version
    let loader; let mcVersion;
    if (action.name) {
      const server = findServerByName(ctx.db, action.name);
      const pack = server ? ctx.db.getModpack(server) : null;
      if (pack) { loader = pack.loader; mcVersion = pack.mcVersion; }
    }

    try {
      const results = await plugins.searchMods(action.query, { limit: 5, loader, mcVersion });
      if (results.length === 0) {
        return { success: true, reply: `No mods found for "${action.query}". Try different keywords.` };
      }
      const lines = results.map((p, i) =>
        `${i + 1}. **${p.title}** (\`${p.slug}\`) — ${p.description}\n   ${p.downloads.toLocaleString()} downloads`
      );
      return {
        success: true,
        reply: `**Mods matching "${action.query}":**\n\n${lines.join('\n\n')}\n\nSay "install <name> on <server>" to install one.`,
        results,
      };
    } catch (err) {
      return { success: false, reply: `Mod search failed: ${err.message}` };
    }
  },

  async search_modpacks(action, _ctx) {
    try {
      const results = await modpacks.searchModpacks(action.query, { limit: 5 });
      if (results.length === 0) {
        return { success: true, reply: `No modpacks found for "${action.query}". Try different keywords.` };
      }
      const lines = results.map((p, i) =>
        `${i + 1}. **${p.title}** (\`${p.slug}\`) — ${p.description}\n   ${p.downloads.toLocaleString()} downloads · MC ${p.latestMcVersion || '?'}`
      );
      return {
        success: true,
        reply: `**Modpacks matching "${action.query}":**\n\n${lines.join('\n\n')}\n\nSay "install <pack> on <server>" to set one up.`,
        results,
      };
    } catch (err) {
      return { success: false, reply: `Modpack search failed: ${err.message}` };
    }
  },

  async install_modpack(action, ctx) {
    const server = findServerByName(ctx.db, action.name);
    if (!server) {
      return { success: false, reply: `No server found with name "${action.name}".` };
    }

    try {
      const { modpack, ramBumped, server: updated } = await modpacks.installModpack(
        { db: ctx.db, docker: ctx.docker },
        server,
        { slug: action.slug, query: action.query },
      );

      const parts = [
        `**${modpack.title}** v${modpack.versionNumber} is installing on **${server.name}**.`,
        ``,
        `• Loader: ${modpack.loader} · Minecraft ${modpack.mcVersion}`,
        `• The server is restarting now — first boot downloads all the mods, so give it a few minutes.`,
      ];
      if (ramBumped) {
        parts.push(`• RAM was raised to 4G (modpacks need more memory).`);
      }

      return { success: true, reply: parts.join('\n'), server: updated, modpack };
    } catch (err) {
      return { success: false, reply: `Modpack install failed: ${err.message}`, server };
    }
  },

  async remove_modpack(action, ctx) {
    const server = findServerByName(ctx.db, action.name);
    if (!server) {
      return { success: false, reply: `No server found with name "${action.name}".` };
    }

    try {
      const { removed, server: updated } = await modpacks.removeModpack(
        { db: ctx.db, docker: ctx.docker },
        server,
      );
      return {
        success: true,
        reply: `Removed **${removed.title}** from **${server.name}**. The server is restarting as a ${updated.server_type} server. World data was kept.`,
        server: updated,
      };
    } catch (err) {
      return { success: false, reply: `Modpack removal failed: ${err.message}`, server };
    }
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
 * Execute a multi-step plan.
 * Only stops on critical failures (create_server). Other failures are
 * reported but the plan continues — e.g. one plugin install failing
 * shouldn't block the rest.
 */
async function executePlan(steps, ctx) {
  const results = [];
  const replies = [];
  let hasFailure = false;

  const CRITICAL_ACTIONS = new Set(['create_server']);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepLabel = `**Step ${i + 1}/${steps.length}** — ${step.action}`;

    const result = await executeAction(step, ctx);
    results.push(result);

    if (result.success) {
      replies.push(`✓ ${stepLabel}: ${result.reply}`);
    } else {
      hasFailure = true;
      replies.push(`✗ ${stepLabel}: ${result.reply}`);

      if (CRITICAL_ACTIONS.has(step.action)) {
        return {
          success: false,
          reply: replies.join('\n\n'),
          results,
          stoppedAtStep: i + 1,
        };
      }
    }
  }

  return {
    success: !hasFailure,
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
