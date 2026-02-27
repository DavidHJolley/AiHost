/**
 * modpacks.js
 * Modrinth API client for browsing and installing modpacks.
 *
 * Modpacks are installed using the itzg/minecraft-server image's built-in
 * Modrinth modpack support: set MODRINTH_MODPACK=<slug> as an env var when
 * creating the container, and the image downloads + installs the pack automatically.
 *
 * Supported sort indexes:
 *   downloads  — most downloaded (= most popular)
 *   follows    — most followed
 *   newest     — most recently created
 *   updated    — most recently updated
 *   relevance  — best match for a search query
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

// ─── Browse / search ──────────────────────────────────────────────────────────

/**
 * Browse Modrinth modpacks with optional search and sorting.
 *
 * @param {object} options
 * @param {string} options.query    - Search query (empty = browse all)
 * @param {string} options.sort     - 'downloads' | 'follows' | 'newest' | 'updated' | 'relevance'
 * @param {number} options.limit    - Results per page (default 12)
 * @param {number} options.offset   - Pagination offset (default 0)
 * @param {string} options.loader   - Filter by loader: 'fabric' | 'forge' | 'quilt' | 'neoforge'
 * @param {string} options.gameVersion - Filter by MC version e.g. '1.20.1'
 */
async function browseModpacks(options = {}) {
  const { query = '', sort = 'downloads', limit = 12, offset = 0, loader = null, gameVersion = null } = options;

  // Only show modpacks that can run on a server (exclude client-only packs like
  // shader/resource pack bundles).  The OR condition inside one facet array means
  // "server_side is required OR optional" — both are fine for a dedicated server.
  const facets = [
    ['project_type:modpack'],
    ['server_side:required', 'server_side:optional'],
  ];
  if (loader) facets.push([`categories:${loader}`]);
  if (gameVersion) facets.push([`versions:${gameVersion}`]);

  const params = {
    facets: JSON.stringify(facets),
    limit,
    offset,
    index: sort,
  };

  if (query.trim()) params.query = query.trim();

  const res = await api.get('/search', { params });

  return {
    hits: res.data.hits.map((hit) => ({
      id: hit.project_id,
      slug: hit.slug,
      title: hit.title,
      description: hit.description,
      downloads: hit.downloads,
      follows: hit.follows,
      icon: hit.icon_url,
      categories: hit.categories,
      latestMcVersion: hit.latest_version,
      versions: hit.versions,
      author: hit.author,
      dateModified: hit.date_modified,
      dateCreated: hit.date_created,
    })),
    total: res.data.total_hits,
    offset,
    limit,
  };
}

// ─── Project details ──────────────────────────────────────────────────────────

async function getModpackDetails(projectIdOrSlug) {
  const res = await api.get(`/project/${projectIdOrSlug}`);
  const p = res.data;
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    description: p.description,
    body: p.body,
    downloads: p.downloads,
    follows: p.follows,
    icon: p.icon_url,
    categories: p.categories,
    loaders: p.loaders || [],
    gameVersions: p.game_versions || [],
    author: p.team,
    dateModified: p.updated,
    dateCreated: p.published,
    status: p.status,
  };
}

// ─── Latest version ───────────────────────────────────────────────────────────

async function getLatestModpackVersion(projectIdOrSlug) {
  const res = await api.get(`/project/${projectIdOrSlug}/version`);
  const versions = res.data;
  if (!versions.length) return null;
  const stable = versions.find((v) => v.version_type === 'release');
  return stable || versions[0];
}

// ─── Server pack resolution ───────────────────────────────────────────────────

/**
 * Resolve the best source to pass as MODRINTH_MODPACK to the itzg container.
 *
 * Priority:
 *   1. A dedicated server pack .zip file in the version's files list
 *      (many modpack authors ship a separate server bundle alongside the .mrpack)
 *   2. A direct URL to the primary .mrpack file — itzg/mc-image-helper will
 *      read modrinth.index.json and skip any file where env.server = "unsupported",
 *      so only server-compatible mods are installed.
 *   3. The slug as a last resort (itzg fetches latest version automatically)
 *
 * @param {string} projectIdOrSlug
 * @returns {Promise<string>} URL or slug to assign to MODRINTH_MODPACK
 */
async function resolveServerPackSource(projectIdOrSlug) {
  let versions;
  try {
    const res = await api.get(`/project/${projectIdOrSlug}/version`);
    versions = res.data;
  } catch {
    return projectIdOrSlug; // API error — fall back to slug
  }

  if (!versions.length) return projectIdOrSlug;

  // Prefer a stable release; fall back to the newest version
  const version = versions.find((v) => v.version_type === 'release') || versions[0];
  const files = version.files || [];

  // 1. Dedicated server pack: non-.mrpack file with "server" in the name
  const serverZip = files.find(
    (f) => !f.filename.endsWith('.mrpack') && /server/i.test(f.filename)
  );
  if (serverZip) return serverZip.url;

  // 2. Primary .mrpack — itzg filters client-only mods via modrinth.index.json
  const primary = files.find((f) => f.primary) || files.find((f) => f.filename.endsWith('.mrpack'));
  if (primary) return primary.url;

  // 3. Fallback: slug (itzg resolves it automatically)
  return projectIdOrSlug;
}

// ─── Modpack config persistence ────────────────────────────────────────────────

/**
 * Save modpack metadata alongside the server data.
 * Used to remember which modpack a server is running.
 */
function saveModpackConfig(serversPath, serverId, config) {
  const configPath = path.join(serversPath, serverId, '.modpack.json');
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function loadModpackConfig(serversPath, serverId) {
  const configPath = path.join(serversPath, serverId, '.modpack.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

function removeModpackConfig(serversPath, serverId) {
  const configPath = path.join(serversPath, serverId, '.modpack.json');
  if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
}

module.exports = {
  browseModpacks,
  getModpackDetails,
  getLatestModpackVersion,
  resolveServerPackSource,
  saveModpackConfig,
  loadModpackConfig,
  removeModpackConfig,
};
