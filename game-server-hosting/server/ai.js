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

  return `You are a friendly, knowledgeable AI assistant for a game server hosting platform.

You can do TWO things:
1. CHAT — Answer questions, explain things, give advice using what you already know about the servers.
2. ACT — Execute commands (create, modify, start, stop servers, etc.)

CRITICAL RULE: If the user is asking a QUESTION that you can answer from the server state below, use "chat" to respond naturally. Do NOT dump raw data — answer like a helpful person would.

RULES:
- Always respond with ONLY valid JSON. No text before or after.
- For questions you can answer from context → use "chat" with a natural, helpful message.
- For requests that require doing something → use the appropriate action.
- Be conversational in chat messages. Answer specifically what was asked.
- Normalize game names to lowercase ("Minecraft" → "minecraft").
- Normalize RAM: "4gb" → "4G", "512mb" → "512M".
- Default RAM for create_server is "2G" if not specified.
- If name is not specified for create_server, use the game name + random 4-char suffix.
- Use "modify_server" for changing settings on EXISTING servers. "create_server" ONLY for new servers.
- For config properties, use SCREAMING_SNAKE_CASE keys (e.g. MAX_PLAYERS, VIEW_DISTANCE).
- ONLY use config keys from the valid keys list below. Never invent config keys.
- If the user asks about problems, crashes, or lag → use "diagnose_server".
- If a request requires multiple sequential steps → return a "multi_step" plan.
- If the user has only ONE server, assume they're asking about that server when no name is given.

AVAILABLE ACTIONS:

0. chat — Answer a question or provide information conversationally
   {"action":"chat","message":"<your natural language response>"}
   Use this when the user asks a question you can answer from the server state below.
   Write like a real person — be concise, specific, and helpful.

1. create_server — Create and start a new server
   {"action":"create_server","name":"<name>","game":"<game>","ram":"<ram>","properties":{}}

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
{"action":"create_server","name":"Survival","game":"minecraft","ram":"8G","properties":{}}

User: "Make a vanilla survival server for 10 friends"
{"action":"create_server","name":"survival","game":"minecraft","ram":"4G","properties":{"MAX_PLAYERS":"10","DIFFICULTY":"normal","GAMEMODE":"survival"}}

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

    lines.push(`- "${server.name}" (${server.game}) — ${status} — port ${server.port}, RAM ${server.ram}`);
    if (configSnippet) lines.push(configSnippet);
  }

  return lines.join('\n');
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

  try {
    const response = await axios.post(
      GROQ_API_URL,
      {
        model: MODEL,
        max_tokens: 512,
        temperature: 0.1,
        messages,
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    const text = response.data.choices[0].message.content.trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return {
        action: 'unknown',
        message: `AI returned non-JSON: ${text.slice(0, 200)}`,
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
