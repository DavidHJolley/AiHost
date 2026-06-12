/**
 * ai.js
 * Converts natural language into structured JSON actions using the Anthropic API.
 *
 * Key capabilities:
 *   - Server awareness: AI knows what servers exist, their status, and configs
 *   - Template knowledge: only suggests valid config keys and value ranges
 *   - Multi-step plans: can return sequential actions for complex requests
 *   - Log diagnosis: analyzes server logs against known error patterns
 *
 * The AI NEVER executes anything — it only returns JSON intent objects.
 * Execution is handled by actions.js.
 */

const Anthropic = require('@anthropic-ai/sdk');
const templates = require('./templates');

const MODEL = 'claude-haiku-4-5-20251001';

// ─── System prompt builder ────────────────────────────────────────────────────

function buildSystemPrompt(serverContext) {
  const minecraftConfigs = templates.configSummaryForPrompt('minecraft');

  return `You are a friendly, knowledgeable AI assistant for a game server hosting platform.

You can do TWO things:
1. CHAT — Answer questions, explain things, give advice using what you already know about the servers.
2. ACT — Execute commands (create, modify, start, stop servers, etc.)

CRITICAL RULES:
- You MUST respond with ONLY a single valid JSON object. NEVER include text, explanations, or prose outside the JSON.
- Do NOT describe what you are about to do. Just return the JSON action.
- If the user is asking a QUESTION that you can answer from the server state below, use "chat" with a natural message inside the JSON.

RULES:
- ALWAYS respond with exactly ONE JSON object. No text before or after. Never output multiple JSON objects.
- If the user asks for multiple things, use "multi_step" to combine them into ONE JSON response.
- For questions you can answer from context → use "chat" with a natural, helpful message.
- For requests that require doing something → use the appropriate action.
- Be conversational in chat messages. Answer specifically what was asked.
- The "game" field is ALWAYS "minecraft". NEVER set game to "paper", "spigot", "purpur", or "vanilla". Those are SERVER TYPES, not games.
- Paper, Spigot, Purpur, and Vanilla are server SOFTWARE types. Use the "server_type" field on create_server to set this. Valid values: "vanilla", "paper", "spigot", "purpur". Default is "vanilla".
- If the user asks for Paper, plugins, or modded features → set "server_type":"paper" on create_server.
- Normalize RAM: "4gb" → "4G", "512mb" → "512M".
- Default RAM for create_server is "2G" if not specified.
- If name is not specified for create_server, use the game name + random 4-char suffix.
- Use "modify_server" for changing settings on EXISTING servers. "create_server" ONLY for new servers.
- For config properties, use SCREAMING_SNAKE_CASE keys (e.g. MAX_PLAYERS, VIEW_DISTANCE).
- ONLY use config keys from the valid keys list below. Never invent config keys.
- If the user asks about problems, crashes, or lag → use "diagnose_server".
- If the user has only ONE server, assume they're asking about that server when no name is given.

AVAILABLE ACTIONS:

0. chat — Answer a question or provide information conversationally
   {"action":"chat","message":"<your natural language response>"}
   Use this when the user asks a question you can answer from the server state below.
   Write like a real person — be concise, specific, and helpful.

1. create_server — Create and start a new server
   {"action":"create_server","name":"<name>","game":"minecraft","ram":"<ram>","server_type":"<vanilla|paper|spigot|purpur>","properties":{}}
   IMPORTANT: "game" is ALWAYS "minecraft". Use "server_type" for Paper/Spigot/Purpur/Vanilla.

2. modify_server — Change config on an existing server
   {"action":"modify_server","name":"<name>","properties":{"<KEY>":"<value>"}}

3. start_server — Start a stopped server
   {"action":"start_server","name":"<name>"}

4. stop_server — Stop a running server
   {"action":"stop_server","name":"<name>"}

5. restart_server — Restart a running server (stop + start)
   {"action":"restart_server","name":"<name>"}

6. delete_server — Permanently remove a server
   {"action":"delete_server","name":"<name>"}

7. list_servers — Show all servers
   {"action":"list_servers"}

8. server_status — Get detailed status and full config dump of a server
   {"action":"server_status","name":"<name>"}
   Only use this when the user explicitly asks for full status or a full config dump.

9. diagnose_server — Analyze logs and diagnose issues
   {"action":"diagnose_server","name":"<name>"}

10. install_plugin — Search for and install a plugin from Modrinth
    {"action":"install_plugin","name":"<server>","query":"<search terms>"}
    OR install a specific plugin by slug:
    {"action":"install_plugin","name":"<server>","slug":"<modrinth-slug>"}
    If the server is vanilla, it will be auto-upgraded to Paper.

11. search_plugins — Search Modrinth for plugins (browse without installing)
    {"action":"search_plugins","query":"<search terms>"}

12. list_plugins — Show installed plugins on a server
    {"action":"list_plugins","name":"<server>"}

13. remove_plugin — Remove an installed plugin (or mod, on modpack servers)
    {"action":"remove_plugin","name":"<server>","pluginName":"<filename or partial name>"}

14. search_modpacks — Search Modrinth for modpacks (browse without installing)
    {"action":"search_modpacks","query":"<search terms>"}

15. install_modpack — Install a modpack from Modrinth onto a server
    {"action":"install_modpack","name":"<server>","query":"<search terms>"}
    OR by exact slug:
    {"action":"install_modpack","name":"<server>","slug":"<modrinth-slug>"}

16. remove_modpack — Remove the installed modpack (reverts to a plain server, world is kept)
    {"action":"remove_modpack","name":"<server>"}

17. search_mods — Search Modrinth for mods (for modpack/modded servers)
    {"action":"search_mods","query":"<search terms>","name":"<server, optional>"}
    Include "name" when a server is known so results match its loader and MC version.

PLUGIN RULES:
- When the user asks for a feature/functionality (e.g. "I want teleportation"), translate that into a plugin search query.
- Common mappings: teleport/tp/homes → "essentials", economy/money → "vault economy", permissions/ranks → "luckperms", world edit/building → "worldedit", protection/claims → "griefprevention"
- Use "install_plugin" with a "query" when the user describes what they want. Use "slug" when they name a specific plugin.
- If the user just wants to browse, use "search_plugins".
- Vanilla servers will be auto-upgraded to Paper for plugin support — no need to warn about this.

MODPACK RULES:
- A modpack REPLACES the server software (the system installs the pack's mod loader automatically). Use "install_modpack" when the user names a pack (e.g. "Cobblemon", "Better MC", "Prominence") or asks for "a modpack".
- Packs come from Modrinth. CurseForge-exclusive packs (e.g. "All the Mods", "RLCraft") are NOT available — if a search finds nothing, say so and suggest searching for a similar pack instead.
- Do NOT guess slugs — when the user names a pack, pass it as "query" and the system picks the top match. Only use "slug" if the user gives an exact Modrinth slug/URL. Use "search_modpacks" to show options first when they're browsing.
- Installing a modpack restarts the server and the first boot takes several minutes. RAM below 4G is raised to 4G automatically — no need to warn, just mention it happened if asked.
- On a server that HAS a modpack, "install_plugin" installs MODS (matched to the pack's loader and MC version) — use it exactly the same way. Use "search_mods" for browsing mods.
- If the user wants a modpack on a brand-new server, use multi_step: create_server (any type, 4G+ RAM) then install_modpack.
- Use "remove_modpack" when they want to go back to a normal/vanilla server.

Multi-step plan format (for complex requests needing sequential actions):
{"action":"multi_step","steps":[{"action":"..."},{"action":"..."}]}

VALID CONFIG KEYS (Minecraft — use SCREAMING_SNAKE_CASE in JSON):
${minecraftConfigs}

CURRENT SERVER STATE:
${serverContext || 'No servers exist yet.'}

EXAMPLES:

User: "What is my view distance?"
{"action":"chat","message":"Your view distance is currently set to 10."}

User: "How many players can join?"
{"action":"chat","message":"Your server allows up to 20 players (max-players=20)."}

User: "Is PvP on?"
{"action":"chat","message":"Yes, PvP is enabled on your server."}

User: "What difficulty is my server on?"
{"action":"chat","message":"Your server is set to easy difficulty."}

User: "What are my server settings?"
{"action":"server_status","name":"minecraft-cace"}

User: "Create a Minecraft server with 8GB RAM called Survival"
{"action":"create_server","name":"Survival","game":"minecraft","ram":"8G","server_type":"vanilla","properties":{}}

User: "Make a Paper server called SMP"
{"action":"create_server","name":"SMP","game":"minecraft","ram":"2G","server_type":"paper","properties":{}}

User: "I want a Paper server with worldedit"
{"action":"multi_step","steps":[{"action":"create_server","name":"creative","game":"minecraft","ram":"2G","server_type":"paper","properties":{}},{"action":"install_plugin","name":"creative","slug":"worldedit"}]}

User: "Make a vanilla survival server for 10 friends"
{"action":"create_server","name":"survival","game":"minecraft","ram":"4G","server_type":"vanilla","properties":{"MAX_PLAYERS":"10","DIFFICULTY":"normal","GAMEMODE":"survival"}}

User: "Change view distance to 12"
{"action":"modify_server","name":"minecraft-cace","properties":{"VIEW_DISTANCE":"12"}}

User: "Stop the server, set difficulty to hard, then start it again"
{"action":"multi_step","steps":[{"action":"stop_server","name":"minecraft-cace"},{"action":"modify_server","name":"minecraft-cace","properties":{"DIFFICULTY":"hard"}},{"action":"start_server","name":"minecraft-cace"}]}

User: "My server is lagging"
{"action":"diagnose_server","name":"minecraft-cace"}

User: "Restart my server"
{"action":"restart_server","name":"minecraft-cace"}

User: "Show me all servers"
{"action":"list_servers"}

User: "I want a plugin where I can TP"
{"action":"install_plugin","name":"minecraft-cace","query":"essentials teleport homes"}

User: "Install worldedit"
{"action":"install_plugin","name":"minecraft-cace","slug":"worldedit"}

User: "I need a permissions plugin"
{"action":"install_plugin","name":"minecraft-cace","query":"luckperms permissions"}

User: "Show me economy plugins"
{"action":"search_plugins","query":"economy vault money"}

User: "What plugins do I have installed?"
{"action":"list_plugins","name":"minecraft-cace"}

User: "Remove essentials from my server"
{"action":"remove_plugin","name":"minecraft-cace","pluginName":"essentials"}

User: "I want land claims and teleporting"
{"action":"multi_step","steps":[{"action":"install_plugin","name":"minecraft-cace","query":"griefprevention land claims"},{"action":"install_plugin","name":"minecraft-cace","query":"essentials teleport homes"}]}

User: "Install the Cobblemon modpack on my server"
{"action":"install_modpack","name":"minecraft-cace","query":"Cobblemon"}

User: "Show me some tech modpacks"
{"action":"search_modpacks","query":"tech modpack"}

User: "Set up a server running the Prominence modpack"
{"action":"multi_step","steps":[{"action":"create_server","name":"prominence","game":"minecraft","ram":"6G","server_type":"vanilla","properties":{}},{"action":"install_modpack","name":"prominence","query":"Prominence"}]}

User: "Add a minimap mod" (server has a modpack installed)
{"action":"install_plugin","name":"minecraft-cace","query":"minimap"}

User: "What mods are there for storage?" (server has a modpack installed)
{"action":"search_mods","query":"storage","name":"minecraft-cace"}

User: "Get rid of the modpack, I want vanilla back"
{"action":"remove_modpack","name":"minecraft-cace"}

User: "Install common plugins" or "Install the most popular plugins"
{"action":"multi_step","steps":[{"action":"install_plugin","name":"minecraft-cace","slug":"essentialsx"},{"action":"install_plugin","name":"minecraft-cace","slug":"luckperms"},{"action":"install_plugin","name":"minecraft-cace","slug":"worldedit"}]}

User: "Create a Minecraft server called Survival with 4GB and I want a teleport plugin"
{"action":"multi_step","steps":[{"action":"create_server","name":"Survival","game":"minecraft","ram":"4G","server_type":"paper","properties":{}},{"action":"install_plugin","name":"Survival","query":"essentials teleport homes"}]}

User: "Make a creative server with worldedit"
{"action":"multi_step","steps":[{"action":"create_server","name":"creative","game":"minecraft","ram":"2G","server_type":"paper","properties":{"GAMEMODE":"creative"}},{"action":"install_plugin","name":"creative","slug":"worldedit"}]}

If the request is unclear or unrelated, return:
{"action":"unknown","message":"<brief explanation>"}`;
}

// ─── Server context builder ───────────────────────────────────────────────────

/**
 * Build a text summary of all servers for injection into the AI prompt.
 * This gives the AI awareness of what exists, so it can reference servers by name
 * and make informed suggestions.
 */
async function buildServerContext(db, docker, serversPath) {
  const path = require('path');
  const servers = db.getAllServers();

  if (servers.length === 0) return 'No servers exist yet.';

  const lines = [];
  for (const server of servers) {
    let status = server.status;
    if (server.container_id) {
      try {
        const info = await docker.inspectContainer(server.container_id);
        status = info.running ? 'running' : 'stopped';
        if (status !== server.status) {
          db.updateServerStatus(server.id, status);
        }
      } catch {
        if (server.status !== 'stopped') {
          db.updateServerStatus(server.id, 'stopped');
          status = 'stopped';
        }
      }
    }

    let configSnippet = '';
    try {
      const { readServerProperties } = require('./actions');
      const serverDir = path.join(serversPath, server.id);
      const config = readServerProperties(serverDir);
      if (config) {
        const tpl = templates.getTemplate(server.game);
        const knownKeys = tpl ? Object.keys(tpl.configs) : [];
        const parts = knownKeys
          .filter((k) => config[k] !== undefined)
          .map((k) => `${k}=${config[k]}`);
        if (parts.length > 0) configSnippet = `  Config: ${parts.join(', ')}`;
      }
    } catch {}

    let pack = null;
    try { pack = server.modpack ? JSON.parse(server.modpack) : null; } catch {}

    const type = pack ? `modpack: ${pack.title}` : (server.server_type || 'vanilla');
    lines.push(`- "${server.name}" (${server.game}, ${type}) — ${status} — port ${server.port}, RAM ${server.ram}`);
    if (pack) {
      lines.push(`  Modpack: ${pack.title} v${pack.versionNumber} (${pack.loader}, MC ${pack.mcVersion}) — plugin requests on this server install MODS`);
    }
    if (configSnippet) lines.push(configSnippet);

    // Include installed plugins/mods
    try {
      const pluginsMod = require('./plugins');
      if (pack) {
        const mods = pluginsMod.listInstalledMods(serversPath, server.id);
        if (mods.length > 0) {
          lines.push(`  Extra mods: ${mods.map((p) => p.filename).join(', ')}`);
        }
      } else {
        const installed = pluginsMod.listInstalledPlugins(serversPath, server.id);
        if (installed.length > 0) {
          lines.push(`  Plugins: ${installed.map((p) => p.filename).join(', ')}`);
        }
      }
    } catch {}
  }

  return lines.join('\n');
}

// ─── Response parser ──────────────────────────────────────────────────────────

/**
 * Parse the AI's raw text into a structured action.
 * Handles edge cases where the LLM returns:
 *   - A single JSON object (normal)
 *   - Multiple JSON objects on separate lines (wraps into multi_step)
 *   - A JSON array of objects (wraps into multi_step)
 */
function parseAIResponse(text) {
  // Try direct parse first (happy path)
  try {
    const obj = JSON.parse(text);
    // If it's an array of actions, wrap into multi_step
    if (Array.isArray(obj)) {
      return { action: 'multi_step', steps: obj };
    }
    return obj;
  } catch {
    // Not valid JSON as-is — try to recover
  }

  // Try splitting on newlines and parsing each line as a JSON object
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const objects = [];
  for (const line of lines) {
    try {
      objects.push(JSON.parse(line));
    } catch {
      // skip non-JSON lines
    }
  }

  if (objects.length === 1) return objects[0];
  if (objects.length > 1) return { action: 'multi_step', steps: objects };

  // Try extracting JSON from surrounding text (LLM sometimes adds prose)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // fall through
    }
  }

  return null;
}

// ─── Parse message ────────────────────────────────────────────────────────────

async function parseMessage(userMessage, history = [], serverContext = '') {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return {
      action: 'error',
      message: 'ANTHROPIC_API_KEY is not set. Please add it to your .env file.',
    };
  }

  const client = new Anthropic({ apiKey });
  const systemPrompt = buildSystemPrompt(serverContext);

  const callAnthropic = async (msgs, attempt = 1) => {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: msgs,
    });

    const text = response.content[0].text.trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = parseAIResponse(cleaned);

    if (!parsed && attempt < 2) {
      console.log('[AI] Non-JSON response, retrying...');
      const retry = [...msgs, { role: 'assistant', content: text }, { role: 'user', content: 'Respond ONLY with a valid JSON object. No prose.' }];
      return callAnthropic(retry, attempt + 1);
    }

    return parsed;
  };

  const messages = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  try {
    const parsed = await callAnthropic(messages);

    if (!parsed) {
      return {
        action: 'unknown',
        message: 'I had trouble understanding that. Could you rephrase?',
      };
    }

    return parsed;
  } catch (err) {
    return {
      action: 'error',
      message: `Anthropic API error: ${err.message}`,
    };
  }
}

// ─── Diagnosis second pass ────────────────────────────────────────────────────

/**
 * When the pattern-matching diagnosis finds no known issues,
 * send the logs to the AI for deeper analysis.
 */
async function analyzeLogs(serverName, logs, config, serverContext) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return 'Could not analyze logs — API key not set.';

  const client = new Anthropic({ apiKey });

  const configSummary = config
    ? Object.entries(config).map(([k, v]) => `${k}=${v}`).join('\n')
    : '(no config available)';

  const prompt = `You are a game server diagnostic assistant. Analyze these server logs and config to identify any issues.

Server: ${serverName}

Current config:
${configSummary}

Recent logs (last 300 lines):
${logs.slice(-3000)}

Respond with a clear, concise diagnosis. If you see issues, explain:
1. What the problem is
2. What's causing it
3. How to fix it (specific config changes or actions)

If the logs look healthy, say so. Be specific and actionable.`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.content[0].text.trim();
  } catch {
    return 'Could not complete log analysis.';
  }
}

module.exports = { parseMessage, buildServerContext, analyzeLogs };
