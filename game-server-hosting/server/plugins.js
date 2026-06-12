/**
 * plugins.js
 * Modrinth API client for searching, downloading, and installing plugins.
 *
 * Flow for "I want a plugin where I can TP":
 *   1. searchPlugins("teleport") → finds EssentialsX, etc.
 *   2. getLatestVersion(projectId) → gets compatible jar URL
 *   3. downloadFile(url, pluginsDir) → saves to server's plugins/ folder
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

  return res.data.hits.map((hit) => ({
    id: hit.project_id,
    slug: hit.slug,
    title: hit.title,
    description: hit.description,
    downloads: hit.downloads,
    icon: hit.icon_url,
    categories: hit.categories,
    versions: hit.versions,
    latestMcVersion: hit.latest_version,
  }));
}

// ─── Version lookup ────────────────────────────────────────────────────────────

/**
 * Get the latest compatible version of a project.
 * Filters by Paper/Spigot/Bukkit loaders.
 */
async function getLatestVersion(projectIdOrSlug, options = {}) {
  const { gameVersion } = options;

  const params = {
    loaders: JSON.stringify(['paper', 'spigot', 'bukkit']),
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
async function installPlugin(serversPath, serverId, { slug, query } = {}) {
  let project;

  if (slug) {
    // Direct install by slug — verify it exists
    try {
      const res = await api.get(`/project/${slug}`);
      project = { id: res.data.id, slug: res.data.slug, title: res.data.title };
    } catch (err) {
      if (err.response && err.response.status === 404) {
        throw new Error(`Plugin "${slug}" not found on Modrinth.`);
      }
      throw err;
    }
  } else if (query) {
    // Search and pick the best match
    const results = await searchPlugins(query, { limit: 1 });
    if (results.length === 0) {
      throw new Error(`No plugins found for "${query}". Try different keywords.`);
    }
    project = results[0];
  } else {
    throw new Error('Either "slug" or "query" is required to install a plugin.');
  }

  // Get the latest compatible version
  const version = await getLatestVersion(project.id);
  if (!version) {
    throw new Error(`No compatible version found for ${project.title}.`);
  }

  const file = version.files.find((f) => f.primary) || version.files[0];
  if (!file) {
    throw new Error(`No downloadable files for ${project.title} v${version.version_number}.`);
  }

  // Check for duplicates
  const pluginsDir = path.join(serversPath, serverId, 'plugins');
  const destPath = path.join(pluginsDir, file.filename);

  if (fs.existsSync(destPath)) {
    return {
      title: project.title,
      slug: project.slug,
      version: version.version_number,
      filename: file.filename,
      size: file.size,
      alreadyInstalled: true,
    };
  }

  await downloadFile(file.url, destPath);

  return {
    title: project.title,
    slug: project.slug,
    version: version.version_number,
    filename: file.filename,
    size: file.size,
    alreadyInstalled: false,
  };
}

// ─── List installed ────────────────────────────────────────────────────────────

function listInstalledPlugins(serversPath, serverId) {
  const pluginsDir = path.join(serversPath, serverId, 'plugins');
  if (!fs.existsSync(pluginsDir)) return [];

  return fs.readdirSync(pluginsDir)
    .filter((f) => f.endsWith('.jar'))
    .map((f) => {
      const stat = fs.statSync(path.join(pluginsDir, f));
      return { filename: f, size: stat.size };
    });
}

// ─── Remove ────────────────────────────────────────────────────────────────────

function removePlugin(serversPath, serverId, filename) {
  const pluginsDir = path.join(serversPath, serverId, 'plugins');
  const filePath = path.join(pluginsDir, filename);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Plugin file "${filename}" not found.`);
  }

  fs.unlinkSync(filePath);
  return { filename, removed: true };
}

module.exports = {
  searchPlugins,
  getLatestVersion,
  installPlugin,
  listInstalledPlugins,
  removePlugin,
};
