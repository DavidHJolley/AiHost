/**
 * ai.js
 * Converts natural language into structured JSON actions using the Groq API.
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

const axios = require('axios');
const templates = require('./templates');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.1-8b-instant';

// ─── System prompt builder ────────────────────────────────────────────────────

function buildSystemPrompt(serverContext) {
  const minecraftConfigs = templates.configSummaryForPrompt('minecraft');

  return `You are a friendly, expert AI assistant for a game server hosting platform called GameHost.

You can do TWO things:
1. CHAT — Answer questions, explain things, give recommendations using server state below.
2. ACT — Execute commands (create, modify, start, stop servers, install mods, etc.)

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
- The "game" field is ALWAYS "minecraft". NEVER set game to a server type name.
- Use "server_type" field for software. Valid values: "vanilla", "paper", "spigot", "purpur", "fabric", "forge", "quilt", "neoforge".
- PLUGINS need Paper/Spigot/Purpur. MODS need Fabric/Forge/Quilt/NeoForge.
- Default RAM for create_server is "2G" if not specified. Recommend at least 4G for modpacks.
- Normalize RAM: "4gb" → "4G", "512mb" → "512M".
- If name is not specified for create_server, use a descriptive name based on context.
- Use "modify_server" for changing settings on EXISTING servers. "create_server" ONLY for new servers.
- For config properties, use SCREAMING_SNAKE_CASE keys (e.g. MAX_PLAYERS, VIEW_DISTANCE).
- ONLY use config keys from the valid keys list below. Never invent config keys.
- If the user asks about problems, crashes, or lag → use "diagnose_server".
- If the user has only ONE server, assume they're asking about that server when no name is given.
- If the user describes a USE CASE without a specific request, use "chat" to give a helpful recommendation with specific settings and then offer to create it.

SERVER TYPE GUIDE:
- vanilla  → Official Minecraft. No plugins, no mods. Pure experience.
- paper    → High-performance Paper. Supports plugins (Bukkit/Spigot/Paper API). Best for SMP servers.
- spigot   → Classic Spigot. Plugin support. Good compatibility.
- purpur   → Paper fork with extra config. Plugin support + more tweaks.
- fabric   → Fabric mod loader. Supports Fabric mods (e.g. Create, Sodium, Iris, Carpet).
- forge    → Forge mod loader. Supports Forge mods (e.g. most CurseForge packs).
- quilt    → Quilt loader. Fabric-compatible with extras.
- neoforge → NeoForge loader. Modern Forge fork for 1.20.1+.

AVAILABLE ACTIONS:

0. chat — Answer a question or provide information/recommendations
   {"action":"chat","message":"<your natural language response>"}

1. create_server — Create and start a new server
   {"action":"create_server","name":"<name>","game":"minecraft","ram":"<ram>","server_type":"<type>","properties":{}}

2. modify_server — Change config on an existing server
   {"action":"modify_server","name":"<name>","properties":{"<KEY>":"<value>"}}

3. start_server / stop_server / restart_server
   {"action":"start_server","name":"<name>"}

4. delete_server
   {"action":"delete_server","name":"<name>"}

5. list_servers
   {"action":"list_servers"}

6. server_status — Full status + config dump
   {"action":"server_status","name":"<name>"}

7. diagnose_server — Analyze logs for issues
   {"action":"diagnose_server","name":"<name>"}

8. install_plugin — Install a plugin from Modrinth (Paper/Spigot servers)
   {"action":"install_plugin","name":"<server>","query":"<search terms>"}
   {"action":"install_plugin","name":"<server>","slug":"<modrinth-slug>"}

9. search_plugins — Browse plugins without installing
   {"action":"search_plugins","query":"<search terms>"}

10. list_plugins / remove_plugin
    {"action":"list_plugins","name":"<server>"}
    {"action":"remove_plugin","name":"<server>","pluginName":"<filename or partial name>"}

11. search_mods — Search for mods (Fabric/Forge/Quilt/NeoForge)
    {"action":"search_mods","query":"<search terms>","loader":"<fabric|forge|quilt|neoforge>"}

12. install_mod — Install a mod from Modrinth onto a Fabric/Forge server
    {"action":"install_mod","name":"<server>","query":"<search terms>","loader":"<fabric|forge>"}
    {"action":"install_mod","name":"<server>","slug":"<modrinth-slug>"}
    The server MUST be running Fabric, Forge, Quilt, or NeoForge.

13. list_mods / remove_mod
    {"action":"list_mods","name":"<server>"}
    {"action":"remove_mod","name":"<server>","modName":"<filename or partial name>"}

14. browse_modpacks — Browse popular modpacks from Modrinth
    {"action":"browse_modpacks","sort":"downloads","query":"<optional search>","loader":"<optional loader>"}
    sort options: "downloads" (popular), "follows", "newest", "updated", "relevance"

15. install_modpack — Install a Modrinth modpack on a server
    {"action":"install_modpack","name":"<server>","modpackSlug":"<modrinth-slug>","loader":"<fabric|forge>"}
    This reconfigures the server to use the modpack's loader and installs everything automatically.

Multi-step plan format (for complex requests needing sequential actions):
{"action":"multi_step","steps":[{"action":"..."},{"action":"..."}]}

PLUGIN RULES:
- teleport/tp/homes → "essentials", economy/money → "vault economy", permissions/ranks → "luckperms"
- world edit/building → "worldedit", protection/claims → "griefprevention"
- Vanilla servers will be auto-upgraded to Paper for plugin support.

MOD RULES:
- Mods require a mod loader server (fabric, forge, quilt, neoforge).
- Common Fabric mods: sodium (performance), iris (shaders), create-fabric (Create mod), carpet (technical)
- Common Forge mods: jei (item info), tinkers-construct, thermal-expansion, biomes-o-plenty
- If user wants mods on a Paper/vanilla server, suggest creating a new Fabric or Forge server.
- For "Create mod" → use fabric + slug "create-fabric" OR forge + slug "create"
- For "Sodium" → fabric only, slug "sodium"

MODPACK RULES:
- When user asks for "a server like Hermitcraft" → suggest Paper + EssentialsX + LuckPerms + WorldEdit
- When user asks for "a modded server" → ask what mods/modpack, then recommend fabric or forge
- When user mentions a specific modpack name → use install_modpack with that slug
- Popular Fabric modpacks: "fabulously-optimized", "create-above-and-beyond", "all-the-fabric"
- Popular Forge modpacks: "prominence-ii-rpg", "better-minecraft"
- Default RAM for modpacks: 4G minimum, recommend 6-8G

UNDERSTANDING MODE — When user describes a vague use case:
- "I want a server like Hermitcraft" → chat: recommend Paper, 6G, max-players 15, view-distance 10, key plugins
- "I want a modded survival server" → chat: recommend Fabric/Forge, key mods, then offer to create
- "What do I need for a PvP server?" → chat: recommend Paper, relevant plugins
- Always be specific with settings, then ask if they want to create it.

VALID CONFIG KEYS (Minecraft — use SCREAMING_SNAKE_CASE in JSON):
${minecraftConfigs}

CURRENT SERVER STATE:
${serverContext || 'No servers exist yet.'}

EXAMPLES:

User: "What is my view distance?"
{"action":"chat","message":"Your view distance is currently set to 10."}

User: "Create a Minecraft server with 8GB RAM called Survival"
{"action":"create_server","name":"Survival","game":"minecraft","ram":"8G","server_type":"vanilla","properties":{}}

User: "Make a Fabric server called Modded"
{"action":"create_server","name":"Modded","game":"minecraft","ram":"4G","server_type":"fabric","properties":{}}

User: "Install the Create mod on my server"
{"action":"install_mod","name":"minecraft-abc","slug":"create-fabric"}

User: "Search for performance mods for Fabric"
{"action":"search_mods","query":"performance optimization","loader":"fabric"}

User: "Show me popular modpacks"
{"action":"browse_modpacks","sort":"downloads"}

User: "Show me new Fabric modpacks"
{"action":"browse_modpacks","sort":"newest","loader":"fabric"}

User: "Install the Prominence modpack on my server"
{"action":"install_modpack","name":"minecraft-abc","modpackSlug":"prominence-ii-rpg","loader":"forge"}

User: "I want a server like Hermitcraft"
{"action":"chat","message":"For a Hermitcraft-style server, I'd recommend:\\n\\n**Recommended Setup:**\\n• Server type: Paper (best performance + plugin support)\\n• RAM: 6GB\\n• View distance: 10\\n• Max players: 15\\n\\n**Key Plugins:**\\n• EssentialsX (teleport, homes, economy)\\n• LuckPerms (permissions/ranks)\\n• WorldEdit (building tools)\\n• CoreProtect (block logging)\\n\\nWant me to create this server? Just say \\"yes, create it\\" and I'll set everything up!"}

User: "I want a modded survival server with Create mod"
{"action":"multi_step","steps":[{"action":"create_server","name":"Create-Survival","game":"minecraft","ram":"4G","server_type":"fabric","properties":{"MAX_PLAYERS":"10"}},{"action":"install_mod","name":"Create-Survival","slug":"create-fabric"}]}

User: "Make a creative server with worldedit"
{"action":"multi_step","steps":[{"action":"create_server","name":"creative","game":"minecraft","ram":"2G","server_type":"paper","properties":{"GAMEMODE":"creative"}},{"action":"install_plugin","name":"creative","slug":"worldedit"}]}

User: "List mods on my server"
{"action":"list_mods","name":"minecraft-abc"}

User: "My server is lagging"
{"action":"diagnose_server","name":"minecraft-abc"}

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

    const type = server.server_type || 'vanilla';
    lines.push(`- "${server.name}" (${server.game}, ${type}) — ${status} — port ${server.port}, RAM ${server.ram}`);
    if (configSnippet) lines.push(configSnippet);

    // Include installed plugins
    try {
      const pluginsMod = require('./plugins');
      const installed = pluginsMod.listInstalledPlugins(serversPath, server.id);
      if (installed.length > 0) {
        lines.push(`  Plugins: ${installed.map((p) => p.filename).join(', ')}`);
      }
    } catch {}

    // Include installed mods
    try {
      const modsMod = require('./mods');
      const installed = modsMod.listInstalledMods(serversPath, server.id);
      if (installed.length > 0) {
        lines.push(`  Mods: ${installed.map((m) => m.filename).join(', ')}`);
      }
    } catch {}

    // Include modpack info
    try {
      const modpacksMod = require('./modpacks');
      const pack = modpacksMod.loadModpackConfig(serversPath, server.id);
      if (pack) {
        lines.push(`  Modpack: ${pack.title} (${pack.slug})`);
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
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return {
      action: 'error',
      message: 'GROQ_API_KEY is not set. Please add it to your .env file.',
    };
  }

  const systemPrompt = buildSystemPrompt(serverContext);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];

  const callGroq = async (msgs, attempt = 1) => {
    const response = await axios.post(
      GROQ_API_URL,
      {
        model: MODEL,
        max_tokens: 1024,
        temperature: 0.05,
        response_format: { type: 'json_object' },
        messages: msgs,
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );

    const text = response.data.choices[0].message.content.trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = parseAIResponse(cleaned);

    if (!parsed && attempt < 2) {
      console.log('[AI] Non-JSON response, retrying...');
      const retry = [...msgs, { role: 'assistant', content: text }, { role: 'user', content: 'Respond ONLY with a valid JSON object. No prose.' }];
      return callGroq(retry, attempt + 1);
    }

    return parsed;
  };

  try {
    const parsed = await callGroq(messages);

    if (!parsed) {
      return {
        action: 'unknown',
        message: 'I had trouble understanding that. Could you rephrase?',
      };
    }

    return parsed;
  } catch (err) {
    if (err.response) {
      return {
        action: 'error',
        message: `Groq API error ${err.response.status}: ${JSON.stringify(err.response.data)}`,
      };
    }
    return {
      action: 'error',
      message: `Network error calling Groq API: ${err.message}`,
    };
  }
}

// ─── Diagnosis second pass ────────────────────────────────────────────────────

/**
 * When the pattern-matching diagnosis finds no known issues,
 * send the logs to the AI for deeper analysis.
 */
async function analyzeLogs(serverName, logs, config, serverContext) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return 'Could not analyze logs — API key not set.';

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
    const response = await axios.post(
      GROQ_API_URL,
      {
        model: MODEL,
        max_tokens: 512,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );
    return response.data.choices[0].message.content.trim();
  } catch {
    return 'Could not complete log analysis.';
  }
}

module.exports = { parseMessage, buildServerContext, analyzeLogs };
