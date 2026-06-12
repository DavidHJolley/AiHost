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

// Connect to Docker. Inside the docker-compose container (Linux) the socket is
// mounted at /var/run/docker.sock. On a Windows host (e.g. `npm run dev` with
// Docker Desktop) the engine is exposed as a named pipe instead. Honour an
// explicit DOCKER_HOST if the user sets one, otherwise pick by platform.
const docker = process.env.DOCKER_HOST
  ? new Dockerode()
  : new Dockerode({
      socketPath:
        process.platform === 'win32'
          ? '//./pipe/docker_engine'
          : '/var/run/docker.sock',
    });

// ─── Game image registry ──────────────────────────────────────────────────────

const GAME_IMAGES = {
  minecraft: 'itzg/minecraft-server',
};

/**
 * Pick the image tag (= bundled Java version) for a Minecraft version.
 * The `latest` tag ships the newest JVM (Java 25 as of mid-2026), which breaks
 * older modded servers — e.g. 1.20.1 Fabric's mixin can't read Java 25 class
 * files and dies with a bogus "ClassNotFoundException: java.util.Optional".
 *
 *   ≤1.16.5          → java8   (legacy Forge/Fabric era)
 *   1.17 – 1.20.4    → java17
 *   1.20.5+ / 1.21+  → java21
 *   unknown          → latest
 */
function minecraftImageTag(mcVersion) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(mcVersion || '').trim());
  if (!m) return 'latest';
  const minor = parseInt(m[2], 10);
  const patch = parseInt(m[3] || '0', 10);
  if (minor <= 16) return 'java8-multiarch';
  if (minor < 20 || (minor === 20 && patch <= 4)) return 'java17';
  return 'java21';
}

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

function buildEnvVars(game, ram, extra = {}, serverType = 'vanilla', modpack = null) {
  const env = { ...extra };

  if (game === 'minecraft') {
    env.EULA = 'TRUE';
    env.MEMORY = ram;
    env.ONLINE_MODE = 'FALSE';
    env.OVERRIDE_SERVER_PROPERTIES = 'false';
    env.ENABLE_RCON = 'true';
    env.RCON_PASSWORD = RCON_PASSWORD;
    if (extra.SERVER_PORT) env.SERVER_PORT = extra.SERVER_PORT;

    if (modpack && modpack.slug) {
      // itzg/minecraft-server installs the Modrinth pack (and its mod loader)
      // automatically. The pack pins the MC version, so VERSION must NOT be set.
      env.TYPE = 'MODRINTH';
      env.MODRINTH_MODPACK = modpack.slug;
      if (modpack.versionId) env.MODRINTH_VERSION = modpack.versionId;
      env.MODRINTH_DEFAULT_VERSION_TYPE = 'release';
    } else {
      env.TYPE = (serverType || 'vanilla').toUpperCase();
      env.VERSION = 'LATEST';
    }
  }

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
  let image = GAME_IMAGES[game];

  if (!image) throw new Error(`Unsupported game: ${game}`);

  let modpack = null;
  if (server.modpack) {
    try { modpack = JSON.parse(server.modpack); } catch {}
  }

  // Modpacks pin an MC version — match the container's Java to it.
  // Plain vanilla/paper servers run VERSION=LATEST, so `latest` is correct.
  if (game === 'minecraft' && modpack && modpack.mcVersion) {
    image = `${image}:${minecraftImageTag(modpack.mcVersion)}`;
  }

  await ensureImage(image);

  const volumePath = serverVolumePath(id);
  const containerPort = GAME_PORTS[game];

  const extra = { SERVER_PORT: String(port), ...properties };

  const container = await docker.createContainer({
    name: containerName(id),
    Image: image,
    Env: buildEnvVars(game, ram, extra, server_type, modpack),
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
  minecraftImageTag,
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
};
