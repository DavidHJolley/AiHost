/**
 * templates.js
 * Game config templates — defines every known config key per game,
 * valid values/ranges, and known log error patterns for diagnosis.
 *
 * The AI validates edits against these templates so it can never
 * hallucinate config keys or write out-of-range values.
 */

// ─── Minecraft ────────────────────────────────────────────────────────────────

const MINECRAFT = {
  name: 'Minecraft',
  image: 'itzg/minecraft-server',

  configs: {
    'max-players':          { type: 'integer', default: 20,   min: 1,   max: 1000,  description: 'Maximum player slots' },
    'difficulty':           { type: 'enum',    default: 'easy', values: ['peaceful', 'easy', 'normal', 'hard'], description: 'Game difficulty' },
    'gamemode':             { type: 'enum',    default: 'survival', values: ['survival', 'creative', 'adventure', 'spectator'], description: 'Default game mode' },
    'view-distance':        { type: 'integer', default: 10,   min: 2,   max: 32,    description: 'Render distance in chunks' },
    'simulation-distance':  { type: 'integer', default: 10,   min: 2,   max: 32,    description: 'Simulation distance in chunks' },
    'motd':                 { type: 'string',  default: 'A Minecraft Server',        description: 'Server list message of the day' },
    'pvp':                  { type: 'boolean', default: true,                         description: 'Allow player vs player combat' },
    'hardcore':             { type: 'boolean', default: false,                        description: 'Hardcore mode — permanent death' },
    'allow-nether':         { type: 'boolean', default: true,                         description: 'Enable the Nether dimension' },
    'allow-flight':         { type: 'boolean', default: false,                        description: 'Allow flying in survival mode' },
    'spawn-protection':     { type: 'integer', default: 16,   min: 0,   max: 100,   description: 'Spawn protection radius in blocks' },
    'enable-command-block': { type: 'boolean', default: false,                        description: 'Enable command blocks' },
    'max-world-size':       { type: 'integer', default: 29999984, min: 1, max: 29999984, description: 'Maximum world border radius' },
    'level-type':           { type: 'enum',    default: 'minecraft\\:normal', values: ['minecraft\\:normal', 'minecraft\\:flat', 'minecraft\\:large_biomes', 'minecraft\\:amplified'], description: 'World generation type' },
    'level-seed':           { type: 'string',  default: '',                           description: 'World generation seed' },
    'max-tick-time':        { type: 'integer', default: 60000, min: -1, max: 300000, description: 'Max tick time in ms (-1 disables watchdog)' },
    'spawn-monsters':       { type: 'boolean', default: true,                         description: 'Spawn hostile mobs' },
    'spawn-animals':        { type: 'boolean', default: true,                         description: 'Spawn passive mobs' },
    'generate-structures':  { type: 'boolean', default: true,                         description: 'Generate villages, temples, etc.' },
    'white-list':           { type: 'boolean', default: false,                        description: 'Enable server whitelist' },
    'online-mode':          { type: 'boolean', default: true,                         description: 'Verify accounts with Mojang' },
    'server-port':          { type: 'integer', default: 25565, min: 1, max: 65535,   description: 'Server port (managed automatically)' },
  },

  ram: { min: '512M', max: '16G', recommended: '2G' },

  knownErrors: [
    {
      pattern: 'Failed to bind to port',
      diagnosis: 'Port conflict — another process is already using this port.',
      fix: 'Stop the conflicting process or change the server port.',
    },
    {
      pattern: 'FAILED TO BIND TO PORT',
      diagnosis: 'Port is already in use by another server or application.',
      fix: 'Check for other running servers on the same port.',
    },
    {
      pattern: 'java.lang.OutOfMemoryError',
      diagnosis: 'Server ran out of allocated memory.',
      fix: 'Increase RAM allocation. Current recommended minimum is 2G for vanilla.',
    },
    {
      pattern: "Can't keep up! Is the server overloaded?",
      diagnosis: 'Server is lagging — tick time is exceeding 50ms.',
      fix: 'Reduce view-distance and simulation-distance, reduce max-players, or increase RAM.',
    },
    {
      pattern: 'io.netty.channel.AbstractChannel$AnnotatedConnectException',
      diagnosis: 'Network binding failed.',
      fix: 'Check firewall settings and ensure the port is not blocked.',
    },
    {
      pattern: 'Exception in thread',
      diagnosis: 'An unhandled Java exception occurred.',
      fix: 'Check the full stack trace. May require updating the server version.',
    },
    {
      pattern: 'Could not load \'plugins/',
      diagnosis: 'A plugin failed to load.',
      fix: 'Verify plugin compatibility with the current server version.',
    },
    {
      pattern: 'World file is corrupted',
      diagnosis: 'World data corruption detected.',
      fix: 'Restore from backup if available, or delete the affected region files.',
    },
    {
      pattern: 'Connection reset',
      diagnosis: 'A player disconnected unexpectedly.',
      fix: 'Usually a client-side network issue. No server action needed.',
    },
    {
      pattern: 'Stopping the server',
      diagnosis: 'Server is shutting down gracefully.',
      fix: 'This is normal behavior during a stop command.',
    },
    {
      pattern: 'Unable to access jarfile',
      diagnosis: 'The server jar file is missing or inaccessible.',
      fix: 'Re-download the server jar or recreate the server.',
    },
    {
      pattern: 'You need to agree to the EULA',
      diagnosis: 'The Minecraft EULA has not been accepted.',
      fix: 'This should be handled automatically. Try recreating the server.',
    },
  ],
};

// ─── Registry ──────────────────────────────────────────────────────────────────

const GAME_TEMPLATES = {
  minecraft: MINECRAFT,
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert SCREAMING_SNAKE_CASE (AI format) → kebab-case (server.properties format).
 */
function envKeyToPropertyKey(key) {
  return key.toLowerCase().replace(/_/g, '-');
}

/**
 * Convert kebab-case → SCREAMING_SNAKE_CASE.
 */
function propertyKeyToEnvKey(key) {
  return key.toUpperCase().replace(/-/g, '_');
}

function getTemplate(game) {
  return GAME_TEMPLATES[game] || null;
}

function getConfigSchema(game, propertyKey) {
  const tpl = getTemplate(game);
  if (!tpl) return null;
  return tpl.configs[propertyKey] || null;
}

/**
 * Validate a single config value against the template schema.
 * Returns { valid: true } or { valid: false, reason: '...' }.
 */
function validateConfigValue(game, propertyKey, value) {
  const schema = getConfigSchema(game, propertyKey);

  if (!schema) {
    const tpl = getTemplate(game);
    const validKeys = tpl ? Object.keys(tpl.configs).join(', ') : '(unknown game)';
    return { valid: false, reason: `Unknown config key "${propertyKey}". Valid keys: ${validKeys}` };
  }

  const strVal = String(value).toLowerCase();

  switch (schema.type) {
    case 'integer': {
      const num = parseInt(value, 10);
      if (isNaN(num)) return { valid: false, reason: `"${propertyKey}" must be an integer, got "${value}"` };
      if (schema.min !== undefined && num < schema.min) return { valid: false, reason: `"${propertyKey}" minimum is ${schema.min}, got ${num}` };
      if (schema.max !== undefined && num > schema.max) return { valid: false, reason: `"${propertyKey}" maximum is ${schema.max}, got ${num}` };
      return { valid: true };
    }
    case 'boolean': {
      if (!['true', 'false'].includes(strVal)) return { valid: false, reason: `"${propertyKey}" must be true or false, got "${value}"` };
      return { valid: true };
    }
    case 'enum': {
      if (!schema.values.includes(strVal)) return { valid: false, reason: `"${propertyKey}" must be one of [${schema.values.join(', ')}], got "${value}"` };
      return { valid: true };
    }
    case 'string':
      return { valid: true };
    default:
      return { valid: true };
  }
}

/**
 * Validate all properties in a batch. Returns { valid, errors[] }.
 */
function validateProperties(game, properties) {
  const errors = [];
  for (const [envKey, value] of Object.entries(properties)) {
    const propKey = envKeyToPropertyKey(envKey);
    const result = validateConfigValue(game, propKey, value);
    if (!result.valid) errors.push(result.reason);
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Match log text against known error patterns for a game.
 * Returns array of { pattern, diagnosis, fix } for each match.
 */
function diagnoseFromLogs(game, logText) {
  const tpl = getTemplate(game);
  if (!tpl) return [];

  return tpl.knownErrors.filter((entry) =>
    logText.includes(entry.pattern)
  );
}

/**
 * Build a summary of valid config keys for a game (used in AI prompts).
 */
function configSummaryForPrompt(game) {
  const tpl = getTemplate(game);
  if (!tpl) return '';

  const lines = Object.entries(tpl.configs).map(([key, schema]) => {
    let info = `${key} (${schema.type})`;
    if (schema.type === 'enum') info += ` — values: [${schema.values.join(', ')}]`;
    if (schema.type === 'integer' && schema.min !== undefined) info += ` — range: ${schema.min}–${schema.max}`;
    if (schema.type === 'boolean') info += ` — true/false`;
    info += ` — ${schema.description}`;
    return `  ${info}`;
  });

  return lines.join('\n');
}

module.exports = {
  GAME_TEMPLATES,
  getTemplate,
  getConfigSchema,
  validateConfigValue,
  validateProperties,
  diagnoseFromLogs,
  configSummaryForPrompt,
  envKeyToPropertyKey,
  propertyKeyToEnvKey,
};
