/**
 * mods.js
 * Modrinth API client for searching, downloading, and installing mods.
 * Supports Fabric, Forge, Quilt, and NeoForge mod loaders.
 *
 * Mods are placed in the server's /mods directory, which the itzg/minecraft-server
 * image maps to /data/mods inside the container.
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

const MOD_LOADERS = ['fabric', 'forge', 'quilt', 'neoforge'];

// ─── Filesystem helpers ────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
  }
  try { fs.chmodSync(dir, 0o777); } catch {
    // Windows doesn't support chmod
  }
}

// ─── Search ────────────────────────────────────────────────────────────────────

/**
 * Search Modrinth for mods.
 * Optionally filter by loader (fabric, forge, quilt, neoforge).
 */
async function searchMods(query, options = {}) {
  const { limit = 6, loader = null, gameVersion = null } = options;

  const facets = [['project_type:mod']];
  if (loader && MOD_LOADERS.includes(loader)) {
    facets.push([`categories:${loader}`]);
  }
  if (gameVersion) {
    facets.push([`versions:${gameVersion}`]);
  }

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
    loaders: hit.categories.filter((c) => MOD_LOADERS.includes(c)),
    latestMcVersion: hit.latest_version,
    author: hit.author,
  }));
}

// ─── Version lookup ────────────────────────────────────────────────────────────

/**
 * Get the latest compatible version of a mod for a specific loader.
 */
async function getLatestModVersion(projectIdOrSlug, loader, options = {}) {
  const { gameVersion } = options;

  const params = { loaders: JSON.stringify([loader]) };
  if (gameVersion) params.game_versions = JSON.stringify([gameVersion]);

  const res = await api.get(`/project/${projectIdOrSlug}/version`, { params });
  const versions = res.data;

  if (!versions.length) return null;
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
 * Full mod install flow:
 *   1. Resolve project (by slug or search query)
 *   2. Get latest compatible version for the loader
 *   3. Download primary jar to server's mods/ folder
 */
async function installMod(serversPath, serverId, loader, { slug, query } = {}) {
  if (!MOD_LOADERS.includes(loader)) {
    throw new Error(`Unsupported loader "${loader}". Use: ${MOD_LOADERS.join(', ')}`);
  }

  let project;

  if (slug) {
    try {
      const res = await api.get(`/project/${slug}`);
      project = { id: res.data.id, slug: res.data.slug, title: res.data.title };
    } catch (err) {
      if (err.response && err.response.status === 404) {
        throw new Error(`Mod "${slug}" not found on Modrinth.`);
      }
      throw err;
    }
  } else if (query) {
    const results = await searchMods(query, { loader, limit: 1 });
    if (!results.length) throw new Error(`No mods found for "${query}". Try different keywords.`);
    project = results[0];
  } else {
    throw new Error('Either "slug" or "query" is required to install a mod.');
  }

  const version = await getLatestModVersion(project.id, loader);
  if (!version) {
    throw new Error(`No compatible ${loader} version found for ${project.title}.`);
  }

  const file = version.files.find((f) => f.primary) || version.files[0];
  if (!file) {
    throw new Error(`No downloadable files for ${project.title} v${version.version_number}.`);
  }

  const modsDir = path.join(serversPath, serverId, 'mods');
  const destPath = path.join(modsDir, file.filename);

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

function listInstalledMods(serversPath, serverId) {
  const modsDir = path.join(serversPath, serverId, 'mods');
  if (!fs.existsSync(modsDir)) return [];

  return fs.readdirSync(modsDir)
    .filter((f) => f.endsWith('.jar'))
    .map((f) => {
      const stat = fs.statSync(path.join(modsDir, f));
      return { filename: f, size: stat.size };
    });
}

// ─── Remove ────────────────────────────────────────────────────────────────────

function removeMod(serversPath, serverId, filename) {
  const modsDir = path.join(serversPath, serverId, 'mods');
  const filePath = path.join(modsDir, filename);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Mod file "${filename}" not found.`);
  }

  fs.unlinkSync(filePath);
  return { filename, removed: true };
}

module.exports = {
  searchMods,
  getLatestModVersion,
  installMod,
  listInstalledMods,
  removeMod,
  MOD_LOADERS,
};
