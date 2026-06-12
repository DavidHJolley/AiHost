/**
 * plugins.js
 * Modrinth API client for searching, downloading, and installing plugins and mods.
 *
 * Flow for "I want a plugin where I can TP":
 *   1. searchPlugins("teleport") → finds EssentialsX, etc.
 *   2. getLatestVersion(projectId) → gets compatible jar URL
 *   3. downloadFile(url, pluginsDir) → saves to server's plugins/ folder
 *
 * Mods work the same way but target the mods/ folder and filter by the
 * server's mod loader (fabric/forge/quilt/neoforge) and Minecraft version —
 * used for servers running a Modrinth modpack.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const MODRINTH_API = 'https://api.modrinth.com/v2';
const USER_AGENT = 'AiHost/1.0 (game-server-hosting)';

const api = axios.create({
  baseURL: MODRINTH_API,
  headers: { 'User-Agent': USER_AGENT },
  timeout: 30000,
});

// ─── Filesystem helpers ────────────────────────────────────────────────────────

/**
 * Create a directory with world-writable permissions (0o777).
 * The Node.js app runs as root but Minecraft containers run as uid=1000,
 * so any directories we create must be writable by the MC process.
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
  }
  try {
    fs.chmodSync(dir, 0o777);
  } catch {
    // Windows doesn't support chmod — Docker Desktop handles permissions differently
  }
}

// ─── Search ────────────────────────────────────────────────────────────────────

/**
 * Search Modrinth for plugins compatible with Paper/Spigot/Bukkit.
 * Returns top results sorted by relevance.
 */
function mapHit(hit) {
  return {
    id: hit.project_id,
    slug: hit.slug,
    title: hit.title,
    description: hit.description,
    downloads: hit.downloads,
    icon: hit.icon_url,
    categories: hit.categories,
    versions: hit.versions,
    // hit.latest_version is a version ID — the MC versions live in hit.versions
    latestMcVersion: (hit.versions && hit.versions[hit.versions.length - 1]) || null,
  };
}

async function searchPlugins(query, options = {}) {
  const { limit = 5 } = options;

  const facets = [
    ['project_type:plugin'],
    ['categories:paper', 'categories:spigot', 'categories:bukkit'],
  ];

  const params = {
    query,
    facets: JSON.stringify(facets),
    limit,
    index: 'relevance',
  };

  const res = await api.get('/search', { params });
  return res.data.hits.map(mapHit);
}

/**
 * Search Modrinth for mods compatible with a loader (and optionally MC version).
 */
async function searchMods(query, options = {}) {
  const { limit = 5, loader, mcVersion } = options;

  const facets = [['project_type:mod']];
  if (loader) facets.push([`categories:${loader}`]);
  if (mcVersion) facets.push([`versions:${mcVersion}`]);

  const params = {
    query,
    facets: JSON.stringify(facets),
    limit,
    index: 'relevance',
  };

  const res = await api.get('/search', { params });
  return res.data.hits.map(mapHit);
}

// ─── Version lookup ────────────────────────────────────────────────────────────

/**
 * Get the latest compatible version of a project.
 * Defaults to Paper/Spigot/Bukkit loaders (plugins); pass `loaders` to override.
 */
async function getLatestVersion(projectIdOrSlug, options = {}) {
  const { gameVersion, loaders = ['paper', 'spigot', 'bukkit'] } = options;

  const params = {
    loaders: JSON.stringify(loaders),
  };
  if (gameVersion) {
    params.game_versions = JSON.stringify([gameVersion]);
  }

  const res = await api.get(`/project/${projectIdOrSlug}/version`, { params });
  const versions = res.data;

  if (!versions.length) return null;

  // Prefer stable releases, fall back to beta/alpha
  const stable = versions.find((v) => v.version_type === 'release');
  return stable || versions[0];
}

// ─── Download ──────────────────────────────────────────────────────────────────

async function downloadFile(url, destPath) {
  const dir = path.dirname(destPath);
  ensureDir(dir);

  const response = await axios.get(url, {
    responseType: 'stream',
    headers: { 'User-Agent': USER_AGENT },
    timeout: 60000,
  });

  const writer = fs.createWriteStream(destPath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// ─── Install ───────────────────────────────────────────────────────────────────

/**
 * Full install flow:
 *   1. Resolve project (by slug or search query)
 *   2. Get latest compatible version
 *   3. Download primary jar to server's plugins/ folder
 *
 * Returns { title, slug, version, filename, size }.
 */
/**
 * Resolve what an install WOULD do, without downloading anything.
 * Shared by installContent (which then downloads) and previews.
 */
async function resolveContent(serversPath, serverId, {
  slug, query, kind = 'plugin', loaders, gameVersion, folder = 'plugins',
} = {}) {
  let project;

  if (slug) {
    // Direct install by slug — verify it exists
    try {
      const res = await api.get(`/project/${slug}`);
      project = { id: res.data.id, slug: res.data.slug, title: res.data.title };
    } catch (err) {
      if (err.response && err.response.status === 404) {
        throw new Error(`${kind === 'mod' ? 'Mod' : 'Plugin'} "${slug}" not found on Modrinth.`);
      }
      throw err;
    }
  } else if (query) {
    // Search and pick the best match
    const results = kind === 'mod'
      ? await searchMods(query, { limit: 1, loader: loaders && loaders[0], mcVersion: gameVersion })
      : await searchPlugins(query, { limit: 1 });
    if (results.length === 0) {
      throw new Error(`No ${kind}s found for "${query}". Try different keywords.`);
    }
    project = results[0];
  } else {
    throw new Error(`Either "slug" or "query" is required to install a ${kind}.`);
  }

  // Get the latest compatible version
  let version = await getLatestVersion(project.id, { loaders, gameVersion });
  if (!version && gameVersion) {
    // Retry without the MC version pin — some mods lag behind patch releases
    version = await getLatestVersion(project.id, { loaders });
  }
  if (!version) {
    throw new Error(`No compatible version found for ${project.title}.`);
  }

  const file = version.files.find((f) => f.primary) || version.files[0];
  if (!file) {
    throw new Error(`No downloadable files for ${project.title} v${version.version_number}.`);
  }

  // Check for duplicates
  const destDir = path.join(serversPath, serverId, folder);
  const destPath = path.join(destDir, file.filename);

  return {
    title: project.title,
    slug: project.slug,
    version: version.version_number,
    filename: file.filename,
    size: file.size,
    url: file.url,
    destPath,
    folder,
    alreadyInstalled: fs.existsSync(destPath),
  };
}

async function installContent(serversPath, serverId, opts = {}) {
  const resolved = await resolveContent(serversPath, serverId, opts);
  const { url, destPath, ...info } = resolved;

  if (info.alreadyInstalled) return info;

  await downloadFile(url, destPath);
  return info;
}

/**
 * Dry-run: report what an install would download and where, no side effects.
 */
async function previewContent(serversPath, serverId, opts = {}) {
  const { url, destPath, ...info } = await resolveContent(serversPath, serverId, opts);
  return info;
}

async function installPlugin(serversPath, serverId, { slug, query } = {}) {
  return installContent(serversPath, serverId, { slug, query, kind: 'plugin', folder: 'plugins' });
}

/**
 * Install a mod into the server's mods/ folder, filtered by the modpack's
 * loader and Minecraft version so only compatible jars are picked.
 */
async function installMod(serversPath, serverId, { slug, query, loader, mcVersion } = {}) {
  return installContent(serversPath, serverId, {
    slug,
    query,
    kind: 'mod',
    folder: 'mods',
    loaders: loader ? [loader] : ['fabric', 'forge', 'quilt', 'neoforge'],
    gameVersion: mcVersion,
  });
}

// ─── List installed ────────────────────────────────────────────────────────────

function listJars(serversPath, serverId, folder) {
  const dir = path.join(serversPath, serverId, folder);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jar'))
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return { filename: f, size: stat.size };
    });
}

function listInstalledPlugins(serversPath, serverId) {
  return listJars(serversPath, serverId, 'plugins');
}

function listInstalledMods(serversPath, serverId) {
  return listJars(serversPath, serverId, 'mods');
}

// ─── Remove ────────────────────────────────────────────────────────────────────

function removeJar(serversPath, serverId, folder, filename) {
  // filename comes from user/AI input — never let it escape the target folder
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    throw new Error('Invalid filename.');
  }
  const filePath = path.join(serversPath, serverId, folder, filename);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File "${filename}" not found.`);
  }

  fs.unlinkSync(filePath);
  return { filename, removed: true };
}

function removePlugin(serversPath, serverId, filename) {
  return removeJar(serversPath, serverId, 'plugins', filename);
}

function removeMod(serversPath, serverId, filename) {
  return removeJar(serversPath, serverId, 'mods', filename);
}

module.exports = {
  searchPlugins,
  searchMods,
  getLatestVersion,
  installPlugin,
  installMod,
  previewContent,
  listInstalledPlugins,
  listInstalledMods,
  removePlugin,
  removeMod,
};
