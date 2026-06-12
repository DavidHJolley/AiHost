/**
 * modpacks.js
 * Modrinth API client + install orchestration for modpacks.
 *
 * Installing a pack does NOT download files ourselves — the itzg/minecraft-server
 * image natively supports TYPE=MODRINTH and handles downloading the .mrpack,
 * installing the right mod loader (Forge/Fabric/Quilt/NeoForge), and pinning
 * the Minecraft version. So an "install" here is:
 *   1. Resolve the pack on Modrinth (by slug or search query)
 *   2. Record it on the server row (db.setModpack)
 *   3. Recreate the container — docker.js sees the modpack and sets the env
 *
 * Removing a pack clears the record and recreates the container with the
 * server's plain server_type. The world and other /data files are kept.
 */

const axios = require('axios');

const MODRINTH_API = 'https://api.modrinth.com/v2';
const USER_AGENT = 'AiHost/1.0 (game-server-hosting)';

// Loaders the itzg image can install from an .mrpack
const SUPPORTED_LOADERS = ['forge', 'fabric', 'quilt', 'neoforge'];

// Modpacks are heavy — never run one under this much RAM
const MIN_PACK_RAM = '4G';

const api = axios.create({
  baseURL: MODRINTH_API,
  headers: { 'User-Agent': USER_AGENT },
  timeout: 30000,
});

// ─── Search ────────────────────────────────────────────────────────────────────

async function searchModpacks(query, options = {}) {
  const { limit = 5 } = options;

  const params = {
    query,
    facets: JSON.stringify([['project_type:modpack']]),
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
    // hit.latest_version is a version ID — the MC versions live in hit.versions
    latestMcVersion: (hit.versions && hit.versions[hit.versions.length - 1]) || null,
  }));
}

// ─── Resolve ───────────────────────────────────────────────────────────────────

async function resolveModpack({ slug, query } = {}) {
  if (slug) {
    try {
      const res = await api.get(`/project/${slug}`);
      if (res.data.project_type !== 'modpack') {
        throw new Error(`"${slug}" is not a modpack (it's a ${res.data.project_type}).`);
      }
      return { id: res.data.id, slug: res.data.slug, title: res.data.title };
    } catch (err) {
      if (err.response && err.response.status === 404) {
        throw new Error(`Modpack "${slug}" not found on Modrinth.`);
      }
      throw err;
    }
  }

  if (query) {
    const results = await searchModpacks(query, { limit: 1 });
    if (results.length === 0) {
      throw new Error(`No modpacks found for "${query}". Try different keywords.`);
    }
    return results[0];
  }

  throw new Error('Either "slug" or "query" is required to install a modpack.');
}

/**
 * Latest pack version with a loader the container image can actually install.
 * Returns the Modrinth version object.
 */
async function getLatestPackVersion(projectIdOrSlug) {
  const res = await api.get(`/project/${projectIdOrSlug}/version`);
  const versions = res.data.filter(
    (v) => v.loaders.some((l) => SUPPORTED_LOADERS.includes(l))
  );

  if (!versions.length) return null;

  const stable = versions.find((v) => v.version_type === 'release');
  return stable || versions[0];
}

// ─── RAM helper ────────────────────────────────────────────────────────────────

function ramToMb(ram) {
  const upper = String(ram).toUpperCase();
  const num = parseFloat(upper);
  if (isNaN(num)) return 0;
  if (upper.includes('G')) return num * 1024;
  return num; // assume M
}

// ─── Install ───────────────────────────────────────────────────────────────────

/**
 * Install a modpack onto an existing server. Stops/removes the old container
 * and recreates it running the pack. Returns details for the reply, including
 * whether RAM was auto-bumped.
 *
 * ctx = { db, docker }
 */
async function installModpack(ctx, server, { slug, query } = {}) {
  const project = await resolveModpack({ slug, query });

  const version = await getLatestPackVersion(project.id);
  if (!version) {
    throw new Error(
      `${project.title} has no server-compatible version (supported loaders: ${SUPPORTED_LOADERS.join(', ')}).`
    );
  }

  const loader = version.loaders.find((l) => SUPPORTED_LOADERS.includes(l)) || version.loaders[0];
  const mcVersion = version.game_versions[version.game_versions.length - 1] || null;

  // Tear down the existing container — the pack needs a fresh one
  if (server.container_id) {
    try { await ctx.docker.stopContainer(server.container_id); } catch {}
    try { await ctx.docker.removeContainer(server.container_id); } catch {}
  }

  // Modpacks under 4G OOM constantly — bump quietly and tell the user
  let ramBumped = false;
  if (ramToMb(server.ram) < ramToMb(MIN_PACK_RAM)) {
    ctx.db.updateServerRam(server.id, MIN_PACK_RAM);
    ramBumped = true;
  }

  const modpack = {
    slug: project.slug,
    title: project.title,
    versionId: version.id,
    versionNumber: version.version_number,
    loader,
    mcVersion,
  };
  ctx.db.setModpack(server.id, modpack);
  ctx.db.updateServerStatus(server.id, 'stopped', null);

  // Recreate and start with the pack
  const updated = ctx.db.getServerById(server.id);
  const containerId = await ctx.docker.createContainer(updated);
  ctx.db.updateServerStatus(server.id, 'starting', containerId);
  await ctx.docker.startContainer(containerId);
  ctx.db.updateServerStatus(server.id, 'running', containerId);

  return { modpack, ramBumped, server: ctx.db.getServerById(server.id) };
}

// ─── Remove ────────────────────────────────────────────────────────────────────

/**
 * Remove the installed modpack and recreate the container as a plain
 * server of the server's original server_type. World data is kept.
 */
async function removeModpack(ctx, server) {
  const previous = ctx.db.getModpack(server);
  if (!previous) {
    throw new Error('No modpack is installed on this server.');
  }

  if (server.container_id) {
    try { await ctx.docker.stopContainer(server.container_id); } catch {}
    try { await ctx.docker.removeContainer(server.container_id); } catch {}
  }

  ctx.db.setModpack(server.id, null);
  ctx.db.updateServerStatus(server.id, 'stopped', null);

  const updated = ctx.db.getServerById(server.id);
  const containerId = await ctx.docker.createContainer(updated);
  ctx.db.updateServerStatus(server.id, 'starting', containerId);
  await ctx.docker.startContainer(containerId);
  ctx.db.updateServerStatus(server.id, 'running', containerId);

  return { removed: previous, server: ctx.db.getServerById(server.id) };
}

module.exports = {
  searchModpacks,
  resolveModpack,
  getLatestPackVersion,
  installModpack,
  removeModpack,
  SUPPORTED_LOADERS,
};
