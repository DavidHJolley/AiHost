/**
 * ai.js
 * Parses natural language game-server requests into structured JSON actions
 * using the Groq API.
 *
 * Supported actions:
 *   create_server   → { action, name, game, ram, properties }
 *   modify_server   → { action, name, properties }
 *   start_server    → { action, name }
 *   stop_server     → { action, name }
 *   delete_server   → { action, name }
 *   list_servers    → { action }
 *
 * The AI NEVER executes anything — it only returns a JSON intent object.
 * Execution is handled by the route layer in index.js.
 */

const axios = require('axios');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.1-8b-instant';

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI controller for a game server hosting platform.

Your ONLY job is to convert the user's natural language request into a structured JSON action object.

Rules:
- Always respond with ONLY valid JSON. No text before or after it.
- Never execute commands yourself. Only return JSON.
- Normalize game names to lowercase (e.g. "Minecraft" → "minecraft").
- Normalize RAM to uppercase with unit suffix: "4gb" → "4G", "512mb" → "512M", "2 GB" → "2G".
- If RAM is not specified for create_server, default to "2G".
- If name is not specified for create_server, use the game name + a random 4-char suffix like "minecraft-a3f2".
- For actions referencing an existing server (start/stop/delete/modify), extract the server name as provided.
- IMPORTANT: If the user wants to change settings on an EXISTING server, use "modify_server" NOT "create_server".
- Use "create_server" ONLY when the user explicitly asks to create/make/spin up a NEW server.
- Use "modify_server" when the user asks to change/set/update any property on a server that already exists.

Supported actions and their JSON shape:

Create a server:
{"action":"create_server","name":"<server name>","game":"<game>","ram":"<ram>","properties":{}}

The "properties" field is optional. Use it when the user requests custom server settings.
Valid property keys (use SCREAMING_SNAKE_CASE):
VIEW_DISTANCE, MAX_PLAYERS, DIFFICULTY, MOTD, GAMEMODE, PVP, SPAWN_PROTECTION,
ALLOW_NETHER, ENABLE_COMMAND_BLOCK, MAX_WORLD_SIZE, LEVEL_TYPE, LEVEL_SEED,
SIMULATION_DISTANCE, MAX_TICK_TIME, SPAWN_MONSTERS, SPAWN_ANIMALS, GENERATE_STRUCTURES,
WHITE_LIST, HARDCORE, ALLOW_FLIGHT, OPS

Modify an existing server's settings:
{"action":"modify_server","name":"<server name>","properties":{"<KEY>":"<value>"}}

Start a server:
{"action":"start_server","name":"<server name>"}

Stop a server:
{"action":"stop_server","name":"<server name>"}

Delete a server:
{"action":"delete_server","name":"<server name>"}

List all servers:
{"action":"list_servers"}

If the request is unclear or not related to server management, return:
{"action":"unknown","message":"<brief explanation>"}

Examples:
User: "Create a Minecraft server with 8GB RAM called Survival"
Response: {"action":"create_server","name":"Survival","game":"minecraft","ram":"8G","properties":{}}

User: "Create a Minecraft server called Creative with 4GB, creative mode, 10 view distance, and 50 max players"
Response: {"action":"create_server","name":"Creative","game":"minecraft","ram":"4G","properties":{"GAMEMODE":"creative","VIEW_DISTANCE":"10","MAX_PLAYERS":"50"}}

User: "Change the view distance to 10 on Survival"
Response: {"action":"modify_server","name":"Survival","properties":{"VIEW_DISTANCE":"10"}}

User: "Set max players to 50 and enable command blocks on Creative"
Response: {"action":"modify_server","name":"Creative","properties":{"MAX_PLAYERS":"50","ENABLE_COMMAND_BLOCK":"true"}}

User: "Start the Survival server"
Response: {"action":"start_server","name":"Survival"}

User: "Show me all servers"
Response: {"action":"list_servers"}

User: "Delete the server named Test"
Response: {"action":"delete_server","name":"Test"}`;

// ─── Parse message ────────────────────────────────────────────────────────────

async function parseMessage(userMessage, history = []) {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return {
      action: 'error',
      message: 'GROQ_API_KEY is not set. Please add it to your .env file.',
    };
  }

  // Build messages: system prompt + conversation history + current message
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userMessage },
  ];

  try {
    const response = await axios.post(
      GROQ_API_URL,
      {
        model: MODEL,
        max_tokens: 256,
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

    // Strip markdown code fences if present
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

module.exports = { parseMessage };
