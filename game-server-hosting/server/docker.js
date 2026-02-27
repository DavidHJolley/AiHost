/**
 * docker.js
 * Wraps Dockerode to manage game server containers.
 * Supports: create, start, stop, remove, inspect, logs.
 *
 * Game images supported:
 *   minecraft → itzg/minecraft-server
 */

const Dockerode = require('dockerode');
const { PassThrough } = require('stream');
const path = require('path');
const fs = require('fs');

// Connect to Docker via Unix socket (works inside Docker when socket is mounted)
const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });

// ─── Game image registry ──────────────────────────────────────────────────────

const GAME_IMAGES = {
  minecraft: 'itzg/minecraft-server',
};

const GAME_PORTS = {
  minecraft: '25565/tcp',
};

const RCON_PASSWORD = 'gaming';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\u00a7[0-9a-fk-or]/g;
function stripAnsi(s) { return s.replace(ANSI_RE, ''); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function containerName(serverId) {
  return `game-server-${serverId}`;
}

function serverVolumePath(serverId) {
  // When running via docker-compose the /app/servers path is mapped to ./servers on host
  // Sibling containers need the HOST path, so we use /servers/<id> relative to compose context.
  // We resolve from env var if set (useful for non-compose local dev).
  const base = process.env.SERVERS_HOST_PATH || path.join(process.cwd(), 'servers');
  const dir = path.join(base, serverId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
  }
  try { fs.chmodSync(dir, 0o777); } catch {}
  return dir;
}

// Mod loader server types — these use /data/mods/ instead of /data/plugins/
const MOD_LOADER_TYPES = new Set(['fabric', 'forge', 'quilt', 'neoforge']);

function buildEnvVars(game, ram, extra = {}, serverType = 'vanilla') {
  const env = { ...extra };

  if (game === 'minecraft') {
    env.EULA = 'TRUE';
    env.MEMORY = ram;
    env.VERSION = 'LATEST';
    env.ONLINE_MODE = 'FALSE';
    env.OVERRIDE_SERVER_PROPERTIES = 'false';
    env.ENABLE_RCON = 'true';
    env.RCON_PASSWORD = RCON_PASSWORD;
    if (extra.SERVER_PORT) env.SERVER_PORT = extra.SERVER_PORT;

    // When MODRINTH_MODPACK is set, use TYPE=MODRINTH so the itzg image
    // downloads and installs the .mrpack (mods, configs, etc.) on first start.
    // Using TYPE=FABRIC/FORGE instead would boot a plain loader server and
    // ignore the modpack entirely.
    if (extra.MODRINTH_MODPACK) {
      env.TYPE = 'MODRINTH';
    } else {
      const type = (serverType || 'vanilla').toLowerCase();

      if (type === 'vanilla') {
        env.TYPE = 'VANILLA';
      } else if (type === 'paper') {
        env.TYPE = 'PAPER';
      } else if (type === 'spigot') {
        env.TYPE = 'SPIGOT';
      } else if (type === 'purpur') {
        env.TYPE = 'PURPUR';
      } else if (type === 'fabric') {
        env.TYPE = 'FABRIC';
      } else if (type === 'forge') {
        env.TYPE = 'FORGE';
      } else if (type === 'quilt') {
        env.TYPE = 'QUILT';
      } else if (type === 'neoforge') {
        env.TYPE = 'NEOFORGE';
      } else {
        env.TYPE = type.toUpperCase();
      }
    }
  }

  // Strip internal keys that shouldn't be passed as Docker env vars
  delete env.MODRINTH_MODPACK_INTERNAL;

  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

// ─── Pull image if missing ────────────────────────────────────────────────────

async function ensureImage(image) {
  return new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) {
        // Image might already exist locally — try to inspect first
        docker.getImage(image).inspect((inspectErr) => {
          if (inspectErr) return reject(err);
          return resolve(); // already exists
        });
        return;
      }
      docker.modem.followProgress(stream, (progressErr) => {
        if (progressErr) return reject(progressErr);
        resolve();
      });
    });
  });
}

// ─── Create container (does NOT start it) ────────────────────────────────────

async function createContainer(server, properties = {}) {
  const { id, game, ram, port, server_type } = server;
  const image = GAME_IMAGES[game];

  if (!image) throw new Error(`Unsupported game: ${game}`);

  await ensureImage(image);

  const volumePath = serverVolumePath(id);
  const containerPort = GAME_PORTS[game];

  const extra = { SERVER_PORT: String(port), ...properties };

  const container = await docker.createContainer({
    name: containerName(id),
    Image: image,
    Env: buildEnvVars(game, ram, extra, server_type),
    HostConfig: {
      Binds: [`${volumePath}:/data`],
      NetworkMode: 'host',
      RestartPolicy: { Name: 'unless-stopped' },
      Memory: parseRamToBytes(ram),
    },
    Labels: {
      'managed-by': 'game-hosting',
      'server-id': id,
    },
  });

  return container.id;
}

// ─── Start ────────────────────────────────────────────────────────────────────

async function startContainer(containerId) {
  const container = docker.getContainer(containerId);
  await container.start();
}

// ─── Stop ─────────────────────────────────────────────────────────────────────

async function stopContainer(containerId) {
  const container = docker.getContainer(containerId);
  try {
    await container.stop({ t: 10 }); // 10s graceful timeout
  } catch (err) {
    if (err.statusCode === 304) return; // already stopped
    throw err;
  }
}

// ─── Remove ───────────────────────────────────────────────────────────────────

async function removeContainer(containerId) {
  const container = docker.getContainer(containerId);
  try {
    await container.remove({ force: true });
  } catch (err) {
    if (err.statusCode === 404) return; // already gone
    throw err;
  }
}

// ─── Inspect (get runtime status) ────────────────────────────────────────────

async function inspectContainer(containerId) {
  try {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    return {
      running: info.State.Running,
      status: info.State.Status,
      startedAt: info.State.StartedAt,
    };
  } catch (err) {
    if (err.statusCode === 404) return { running: false, status: 'removed' };
    throw err;
  }
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

async function getContainerLogs(containerId, tail = 100) {
  try {
    const container = docker.getContainer(containerId);
    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: false,
    });
    const lines = logs.toString('utf8').split('\n').map((line) => (line.length > 8 ? line.slice(8) : line));
    const filtered = lines.filter((l) => !/Thread RCON Client .* (started|shutting down)/.test(stripAnsi(l)));
    return stripAnsi(filtered.join('\n'));
  } catch (err) {
    if (err.statusCode === 404) return '(container not found)';
    throw err;
  }
}

// ─── RAM parser ───────────────────────────────────────────────────────────────

function parseRamToBytes(ram) {
  const upper = ram.toUpperCase();
  const num = parseFloat(upper);
  if (upper.endsWith('G')) return Math.floor(num * 1024 * 1024 * 1024);
  if (upper.endsWith('M')) return Math.floor(num * 1024 * 1024);
  return Math.floor(num); // assume bytes
}

// ─── Find container by server id label ───────────────────────────────────────

async function findContainerByServerId(serverId) {
  const containers = await docker.listContainers({ all: true });
  return containers.find(
    (c) => c.Labels && c.Labels['server-id'] === serverId
  );
}

// ─── Execute command via RCON ────────────────────────────────────────────────

async function execCommand(containerId, command) {
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: ['rcon-cli', '--password', RCON_PASSWORD, ...command.split(/\s+/)],
    AttachStdout: true,
    AttachStderr: true,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };

    exec.start({ hijack: true }, (err, stream) => {
      if (err) return reject(err);

      let stdout = '';
      let stderr = '';
      const outStream = new PassThrough();
      const errStream = new PassThrough();

      outStream.on('data', (c) => { stdout += c.toString('utf8'); });
      errStream.on('data', (c) => { stderr += c.toString('utf8'); });

      docker.modem.demuxStream(stream, outStream, errStream);

      stream.on('end', () => done(stripAnsi((stdout + stderr).trim())));
      stream.on('error', (e) => { if (!settled) { settled = true; reject(e); } });

      setTimeout(() => {
        try { stream.destroy(); } catch {}
        done(stripAnsi((stdout + stderr).trim()));
      }, 8000);
    });
  });
}

// ─── Stream container logs in real-time ──────────────────────────────────────

async function streamContainerLogs(containerId, onData) {
  const container = docker.getContainer(containerId);
  const logStream = await container.logs({
    stdout: true,
    stderr: true,
    follow: true,
    tail: 200,
    timestamps: false,
  });

  const outStream = new PassThrough();
  const errStream = new PassThrough();
  docker.modem.demuxStream(logStream, outStream, errStream);

  let buffer = '';
  function processChunk(chunk) {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const clean = stripAnsi(line);
      if (!clean.trim()) continue;
      if (/Thread RCON Client .* (started|shutting down)/.test(clean)) continue;
      onData(clean);
    }
  }

  outStream.on('data', processChunk);
  errStream.on('data', processChunk);

  return {
    destroy() { try { logStream.destroy(); } catch {} },
  };
}

module.exports = {
  createContainer,
  startContainer,
  stopContainer,
  removeContainer,
  inspectContainer,
  getContainerLogs,
  findContainerByServerId,
  containerName,
  execCommand,
  streamContainerLogs,
  MOD_LOADER_TYPES,
};
