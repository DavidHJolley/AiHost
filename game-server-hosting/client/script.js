(() => {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════
  // Config & state
  // ═══════════════════════════════════════════════════════════════════════

  const API = '';
  const WS_URL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
  const MAX_CONSOLE_LINES = 1200;
  const MAX_HISTORY = 40;

  const MOD_LOADERS = new Set(['fabric', 'forge', 'quilt', 'neoforge']);
  const PLUGIN_TYPES = new Set(['paper', 'spigot', 'purpur']);

  let servers = [];
  let selectedServerId = null;
  let currentView = 'servers';
  let currentTab = 'overview';

  let consoleWs = null;
  let consoleLineCount = 0;
  let previewWs = null;

  let currentFilesPath = '';
  let openFilePath = null;
  let fileEditorDirty = false;

  const chatHistory = [];

  // Modpack browser state
  let modpackSort = 'downloads';
  let modpackLoader = '';
  let modpackQuery = '';
  let modpackOffset = 0;
  const MODPACK_LIMIT = 12;

  // Mod tab state
  let modSearchContent = 'mods';
  let pendingModpackInstall = null;

  // ═══════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]|\u00a7[0-9a-fk-or]|\[3[0-9]m|\[0m/g, '');

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function mdLight(text) {
    return escHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

  async function apiFetch(path, opts = {}) {
    const res = await fetch(API + path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    return res.json();
  }

  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  function fmtNum(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function statusColor(s) {
    return { running: 'success', stopped: 'muted', starting: 'warning', stopping: 'warning', error: 'danger' }[s] || 'muted';
  }

  function gameIcon(g) { return g === 'minecraft' ? '⛏️' : '🎮'; }
  function gameLabel(g) { return g === 'minecraft' ? 'Minecraft' : g; }
  function srv() { return servers.find((s) => s.id === selectedServerId) || null; }

  function loaderIcon(type) {
    const icons = { fabric: '🧵', forge: '⚒️', quilt: '🪡', neoforge: '🔩', paper: '📄', spigot: '🔧', purpur: '🟣', vanilla: '🟩' };
    return icons[(type || '').toLowerCase()] || '🎮';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Navigation
  // ═══════════════════════════════════════════════════════════════════════

  function navigate(view) {
    if (currentTab === 'console') disconnectConsole();
    if (currentTab === 'overview') disconnectPreview();
    currentView = view;

    $$('.sidebar-menu .nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === view));

    $('#view-servers').classList.toggle('hidden', view !== 'servers');
    $('#view-modpacks').classList.toggle('hidden', view !== 'modpacks');
    $('#view-ai').classList.toggle('hidden', view !== 'ai');
    $('#view-detail').classList.toggle('hidden', view !== 'detail');

    $('#topbar').style.display = view === 'detail' ? '' : 'none';
    $('#sidebar-server-section').style.display = view === 'detail' ? '' : 'none';

    if (view === 'servers') {
      selectedServerId = null;
      renderSidebar();
      renderServerGrid();
    }
    if (view === 'modpacks') loadModpacks();
    if (view === 'ai') setTimeout(() => $('#chat-input').focus(), 50);
    if (view === 'detail' && selectedServerId) renderServerDetail();
  }

  function selectServer(id) {
    selectedServerId = id;
    currentTab = 'overview';
    navigate('detail');
    renderSidebar();
  }

  function switchTab(tab) {
    if (tab === currentTab) return;
    if (currentTab === 'console') disconnectConsole();
    if (currentTab === 'overview') disconnectPreview();
    currentTab = tab;

    $$('.nav-tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
    $$('#view-detail .tab-pane').forEach((el) => el.classList.add('hidden'));
    const pane = $(`#tab-${tab}`);
    if (pane) pane.classList.remove('hidden');

    if (tab === 'overview') renderOverview();
    else if (tab === 'console') initConsole();
    else if (tab === 'mods') loadModsTab();
    else if (tab === 'files') loadFiles('');
    else if (tab === 'players') loadPlayers();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Server list
  // ═══════════════════════════════════════════════════════════════════════

  async function loadServers() {
    try {
      const data = await apiFetch('/servers');
      if (data.success) {
        servers = data.servers;
        renderSidebar();
        if (currentView === 'servers') renderServerGrid();
        if (currentView === 'detail') updateTopbar();
      }
    } catch (err) {
      console.error('Failed to load servers:', err);
    }
  }

  function renderSidebar() {
    const list = $('#sidebar-servers-list');
    list.innerHTML = '';
    for (const s of servers) {
      const btn = document.createElement('button');
      btn.className = `sidebar-server${s.id === selectedServerId ? ' active' : ''}`;
      btn.innerHTML = `<span class="status-dot ${s.status}"></span><span class="sidebar-server-name">${escHtml(s.name)}</span>`;
      btn.addEventListener('click', () => selectServer(s.id));
      list.appendChild(btn);
    }
  }

  function renderServerGrid() {
    const grid = $('#server-grid');
    grid.innerHTML = '';

    if (servers.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🎮</div>
          <h3>No servers yet</h3>
          <p>Create your first game server to get started</p>
          <button class="btn btn-primary" id="btn-empty-create">+ Create Server</button>
        </div>`;
      const b = grid.querySelector('#btn-empty-create');
      if (b) b.addEventListener('click', showCreateModal);
      return;
    }

    for (const s of servers) {
      const type = s.server_type || 'vanilla';
      const card = document.createElement('div');
      card.className = 'server-card';
      card.innerHTML = `
        <div class="server-card-top">
          <span class="server-card-icon">${gameIcon(s.game)}</span>
          <div class="server-card-info">
            <h3>${escHtml(s.name)}</h3>
            <span class="badge badge-${statusColor(s.status)}">${s.status}</span>
          </div>
        </div>
        <div class="server-card-stats">
          <div class="stat"><span class="stat-label">Port</span><span>${s.port}</span></div>
          <div class="stat"><span class="stat-label">RAM</span><span>${s.ram}</span></div>
          <div class="stat"><span class="stat-label">Type</span><span>${loaderIcon(type)} ${type}</span></div>
        </div>
        <div class="server-card-actions">
          <button class="btn btn-sm btn-accent" data-a="manage">Manage</button>
          <button class="btn btn-sm btn-success-outline" data-a="start" ${s.status === 'running' ? 'disabled' : ''}>▶ Start</button>
          <button class="btn btn-sm btn-ghost" data-a="stop" ${['stopped', 'error'].includes(s.status) ? 'disabled' : ''}>⏹ Stop</button>
        </div>`;

      card.querySelector('[data-a="manage"]').addEventListener('click', () => selectServer(s.id));
      card.querySelector('[data-a="start"]').addEventListener('click', async (e) => {
        e.target.disabled = true;
        await apiFetch(`/servers/${s.id}/start`, { method: 'POST' });
        loadServers();
      });
      card.querySelector('[data-a="stop"]').addEventListener('click', async (e) => {
        e.target.disabled = true;
        await apiFetch(`/servers/${s.id}/stop`, { method: 'POST' });
        loadServers();
      });
      grid.appendChild(card);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Modpack browser
  // ═══════════════════════════════════════════════════════════════════════

  async function loadModpacks() {
    const grid = $('#modpack-grid');
    grid.innerHTML = '<div class="empty-state"><div class="empty-icon">📦</div><h3>Loading modpacks...</h3></div>';

    try {
      const params = new URLSearchParams({ sort: modpackSort, limit: MODPACK_LIMIT, offset: modpackOffset });
      if (modpackQuery) params.set('q', modpackQuery);
      if (modpackLoader) params.set('loader', modpackLoader);

      const data = await apiFetch(`/modpacks/browse?${params}`);
      renderModpackGrid(data.hits || [], data.total || 0);
    } catch (err) {
      grid.innerHTML = `<div class="empty-state"><p>Failed to load: ${escHtml(err.message)}</p></div>`;
    }
  }

  function renderModpackGrid(packs, total) {
    const grid = $('#modpack-grid');
    grid.innerHTML = '';

    if (!packs.length) {
      grid.innerHTML = '<div class="empty-state"><div class="empty-icon">📦</div><h3>No modpacks found</h3><p>Try different search terms or filters</p></div>';
      $('#modpack-pagination').style.display = 'none';
      return;
    }

    for (const pack of packs) {
      const card = document.createElement('div');
      card.className = 'modpack-card';
      const mcVer = pack.latestMcVersion || '?';
      const cats = (pack.categories || []).slice(0, 3);

      card.innerHTML = `
        <div class="modpack-card-header">
          ${pack.icon ? `<img class="modpack-icon" src="${escHtml(pack.icon)}" alt="" onerror="this.style.display='none'"/>` : '<div class="modpack-icon-placeholder">📦</div>'}
          <div class="modpack-card-info">
            <div class="modpack-title">${escHtml(pack.title)}</div>
            <div class="modpack-author">by ${escHtml(pack.author || '?')}</div>
          </div>
        </div>
        <div class="modpack-desc">${escHtml((pack.description || '').slice(0, 120))}${(pack.description || '').length > 120 ? '…' : ''}</div>
        <div class="modpack-meta">
          <span class="modpack-stat">⬇ ${fmtNum(pack.downloads)}</span>
          <span class="modpack-stat">MC ${escHtml(mcVer)}</span>
          ${cats.map(c => `<span class="modpack-tag">${escHtml(c)}</span>`).join('')}
        </div>
        <div class="modpack-actions">
          <button class="btn btn-primary btn-sm btn-install-pack" data-slug="${escHtml(pack.slug)}" data-title="${escHtml(pack.title)}">Install</button>
          <span class="modpack-slug">\`${escHtml(pack.slug)}\`</span>
        </div>`;

      card.querySelector('.btn-install-pack').addEventListener('click', () => openModpackInstallModal(pack));
      grid.appendChild(card);
    }

    const pagination = $('#modpack-pagination');
    const hasPrev = modpackOffset > 0;
    const hasNext = modpackOffset + MODPACK_LIMIT < total;
    pagination.style.display = (hasPrev || hasNext) ? 'flex' : 'none';
    $('#btn-modpack-prev').disabled = !hasPrev;
    $('#btn-modpack-next').disabled = !hasNext;
    const page = Math.floor(modpackOffset / MODPACK_LIMIT) + 1;
    const totalPages = Math.ceil(total / MODPACK_LIMIT);
    $('#modpack-page-info').textContent = `Page ${page} of ${totalPages} (${total} total)`;
  }

  function openModpackInstallModal(pack) {
    pendingModpackInstall = pack;
    $('#modpack-modal-title').textContent = `Install: ${pack.title}`;
    $('#modpack-modal-hint').textContent = `This will configure a server to run "${pack.title}". The modpack will be downloaded automatically on first start.`;

    const sel = $('#modpack-target-server');
    sel.innerHTML = '<option value="">Select a server...</option>';
    for (const s of servers) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.name} (${s.server_type || 'vanilla'}, ${s.ram})`;
      sel.appendChild(opt);
    }

    $('#modpack-install-modal').classList.remove('hidden');
  }

  async function installModpackToServer() {
    const serverId = $('#modpack-target-server').value;
    if (!serverId) { alert('Please select a server'); return; }
    const pack = pendingModpackInstall;
    if (!pack) return;

    const btn = $('#modpack-modal-install');
    btn.disabled = true;
    btn.textContent = 'Installing...';

    try {
      const data = await apiFetch(`/servers/${serverId}/modpack/install`, {
        method: 'POST',
        body: JSON.stringify({ modpackSlug: pack.slug }),
      });

      if (data.success || data.server) {
        $('#modpack-install-modal').classList.add('hidden');
        await loadServers();
        selectServer(serverId);
      } else {
        alert(`Failed: ${data.error || 'Unknown error'}`);
      }
    } catch (err) {
      alert(`Error: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Install Modpack';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Server detail
  // ═══════════════════════════════════════════════════════════════════════

  function updateTopbar() {
    const s = srv();
    if (!s) return;
    $('#topbar-name').textContent = s.name;
    $('#topbar-game').textContent = gameLabel(s.game);
    const badge = $('#topbar-status');
    badge.textContent = s.status;
    badge.className = `badge badge-${statusColor(s.status)}`;
    $('#btn-start').disabled = s.status === 'running';
    $('#btn-stop').disabled = ['stopped', 'error'].includes(s.status);
  }

  function renderServerDetail() {
    updateTopbar();
    $$('.nav-tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === currentTab));
    $$('#view-detail .tab-pane').forEach((el) => el.classList.add('hidden'));
    const pane = $(`#tab-${currentTab}`);
    if (pane) pane.classList.remove('hidden');

    if (currentTab === 'overview') renderOverview();
    else if (currentTab === 'console') initConsole();
    else if (currentTab === 'mods') loadModsTab();
    else if (currentTab === 'files') loadFiles('');
    else if (currentTab === 'players') loadPlayers();
  }

  // ── Overview ──────────────────────────────────────────────────────────

  async function renderOverview() {
    const s = srv();
    if (!s) return;

    $('#overview-game-icon').textContent = gameIcon(s.game);
    $('#overview-game').textContent = gameLabel(s.game);
    const badge = $('#overview-status');
    badge.textContent = s.status.toUpperCase();
    badge.className = `badge badge-${statusColor(s.status)}`;

    const type = s.server_type || 'vanilla';
    $('#overview-name').textContent = s.name;
    $('#overview-port').textContent = s.port;
    $('#overview-ram').textContent = s.ram;
    $('#overview-type').textContent = `${loaderIcon(type)} ${type}`;
    $('#overview-ip').textContent = `localhost:${s.port}`;

    // Modpack info
    try {
      const packData = await apiFetch(`/servers/${s.id}/modpack`);
      const modpackRow = $('#overview-modpack-row');
      if (packData.modpack) {
        $('#overview-modpack').textContent = packData.modpack.title;
        modpackRow.style.display = '';
      } else {
        modpackRow.style.display = 'none';
      }
    } catch { $('#overview-modpack-row').style.display = 'none'; }

    if (s.status === 'running') {
      try {
        const d = await apiFetch(`/servers/${s.id}/command`, { method: 'POST', body: JSON.stringify({ command: 'list' }) });
        $('#overview-players').textContent = d.success && d.result ? stripAnsi(d.result.split('\n')[0]) : '—';
      } catch { $('#overview-players').textContent = '—'; }
    } else {
      $('#overview-players').textContent = 'Server offline';
    }

    const body = $('#console-preview-body');
    body.innerHTML = '';
    disconnectPreview();

    if (s.container_id && s.status === 'running') {
      try {
        const d = await apiFetch(`/servers/${s.id}/logs?tail=20`);
        if (d.logs) {
          body.innerHTML = d.logs.split('\n').slice(-20).map(fmtLine).join('\n');
          body.scrollTop = body.scrollHeight;
        }
      } catch {}
      connectPreview(s.id, body);
    } else {
      body.innerHTML = '<span style="color:var(--text-muted)">Server is not running.</span>';
    }
  }

  function connectPreview(serverId, body) {
    disconnectPreview();
    previewWs = new WebSocket(WS_URL);
    previewWs.onopen = () => previewWs.send(JSON.stringify({ type: 'subscribe', serverId }));
    previewWs.onmessage = (ev) => {
      let data; try { data = JSON.parse(ev.data); } catch { return; }
      if (data.type === 'log' && data.data) {
        const div = document.createElement('div');
        div.innerHTML = fmtLine(data.data);
        body.appendChild(div);
        while (body.children.length > 50) body.removeChild(body.firstChild);
        body.scrollTop = body.scrollHeight;
      }
    };
    previewWs.onclose = () => { previewWs = null; };
    previewWs.onerror = () => {};
  }

  function disconnectPreview() {
    if (!previewWs) return;
    try { previewWs.send(JSON.stringify({ type: 'unsubscribe' })); previewWs.close(); } catch {}
    previewWs = null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Console
  // ═══════════════════════════════════════════════════════════════════════

  function fmtLine(line) {
    let h = escHtml(stripAnsi(line));
    h = h.replace(/\[(INFO|Info)\]/gi, '<span class="log-info">[Info]</span>');
    h = h.replace(/\[(WARN|Warning)\]/gi, '<span class="log-warn">[WARN]</span>');
    h = h.replace(/\[(ERROR|SEVERE)\]/gi, '<span class="log-error">[ERROR]</span>');
    return h;
  }

  function initConsole() {
    const out = $('#console-output');
    out.innerHTML = '<div class="console-connecting">Connecting to server console...</div>';
    consoleLineCount = 0;
    connectConsole();
  }

  function connectConsole() {
    disconnectConsole();
    const s = srv();
    if (!s || !s.container_id || s.status !== 'running') {
      $('#console-output').innerHTML = '<div class="console-info">Server is not running. Start the server to view the console.</div>';
      return;
    }
    consoleWs = new WebSocket(WS_URL);
    consoleWs.onopen = () => consoleWs.send(JSON.stringify({ type: 'subscribe', serverId: selectedServerId }));
    consoleWs.onmessage = (ev) => {
      let data; try { data = JSON.parse(ev.data); } catch { return; }
      if (data.type === 'log') addConsoleLine(data.data);
      if (data.type === 'command_result' && data.data) addConsoleLine(data.data);
      if (data.type === 'command_error') addConsoleLine(`Error: ${data.message}`, 'err');
      if (data.type === 'error') addConsoleLine(`[Connection] ${data.message}`, 'err');
    };
    consoleWs.onclose = () => { consoleWs = null; };
    consoleWs.onerror = () => {};
  }

  function disconnectConsole() {
    if (!consoleWs) return;
    try { consoleWs.send(JSON.stringify({ type: 'unsubscribe' })); consoleWs.close(); } catch {}
    consoleWs = null;
  }

  function addConsoleLine(line, cls) {
    const out = $('#console-output');
    if (!out) return;
    const connecting = out.querySelector('.console-connecting, .console-info');
    if (connecting) connecting.remove();
    const div = document.createElement('div');
    div.className = 'console-line' + (cls ? ` console-${cls}` : '');
    div.innerHTML = fmtLine(line);
    out.appendChild(div);
    consoleLineCount++;
    if (consoleLineCount > MAX_CONSOLE_LINES) { out.removeChild(out.firstChild); consoleLineCount--; }
    out.scrollTop = out.scrollHeight;
  }

  function sendCmd(input) {
    const cmd = input.value.trim();
    if (!cmd) return;
    input.value = '';
    addConsoleLine(`> ${cmd}`, 'cmd');
    if (consoleWs && consoleWs.readyState === WebSocket.OPEN) {
      consoleWs.send(JSON.stringify({ type: 'command', command: cmd }));
    } else {
      apiFetch(`/servers/${selectedServerId}/command`, { method: 'POST', body: JSON.stringify({ command: cmd }) })
        .then((d) => { if (d.result) addConsoleLine(d.result); })
        .catch((e) => addConsoleLine(`Error: ${e.message}`, 'err'));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Mods / Plugins tab
  // ═══════════════════════════════════════════════════════════════════════

  async function loadModsTab() {
    const s = srv();
    if (!s) return;

    const type = (s.server_type || 'vanilla').toLowerCase();
    const isModded = MOD_LOADERS.has(type);
    const isPlugin = PLUGIN_TYPES.has(type);

    $('#mods-panel-title').textContent = isModded ? 'Installed Mods' : isPlugin ? 'Installed Plugins' : 'Add-ons';
    $('#mods-search-title').textContent = isModded ? 'Search Mods' : 'Search Plugins';

    const searchTypeBar = $('#mods-search-type');
    searchTypeBar.style.display = isModded ? 'flex' : 'none';

    modSearchContent = isModded ? 'mods' : 'plugins';
    $$('#mods-search-type .tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.content === modSearchContent);
    });

    await refreshInstalledAddons(s, type, isModded, isPlugin);

    // Modpack info card
    try {
      const packData = await apiFetch(`/servers/${s.id}/modpack`);
      const card = $('#modpack-info-card');
      if (packData.modpack) {
        card.style.display = '';
        $('#modpack-info-body').innerHTML = `
          <div class="modpack-installed-info">
            <div class="modpack-installed-name">${escHtml(packData.modpack.title)}</div>
            <div class="modpack-installed-meta">
              <span>${escHtml(packData.modpack.loader || '?')}</span> ·
              <span>Installed ${new Date(packData.modpack.installedAt).toLocaleDateString()}</span>
            </div>
          </div>`;
      } else {
        card.style.display = 'none';
      }
    } catch { $('#modpack-info-card').style.display = 'none'; }
  }

  async function refreshInstalledAddons(s, type, isModded, isPlugin) {
    const list = $('#mods-installed-list');
    list.innerHTML = '<div class="empty-state-sm">Loading...</div>';

    try {
      if (isModded) {
        const data = await apiFetch(`/servers/${s.id}/mods`);
        const items = data.mods || [];
        if (!items.length) {
          list.innerHTML = '<div class="empty-state-sm">No mods installed. Use the search panel to add mods.</div>';
        } else {
          list.innerHTML = items.map(m => `
            <div class="addon-item">
              <span class="addon-icon">📦</span>
              <span class="addon-name">${escHtml(m.filename)}</span>
              <span class="addon-size">${fmtBytes(m.size)}</span>
              <button class="btn btn-xs btn-ghost btn-danger-text" data-remove-mod="${escHtml(m.filename)}">✕</button>
            </div>`).join('');

          list.querySelectorAll('[data-remove-mod]').forEach(btn => {
            btn.addEventListener('click', async () => {
              if (!confirm(`Remove ${btn.dataset.removeMod}?`)) return;
              btn.disabled = true;
              await apiFetch(`/servers/${s.id}/mods/remove`, { method: 'POST', body: JSON.stringify({ filename: btn.dataset.removeMod }) });
              loadModsTab();
            });
          });
        }
      } else if (isPlugin) {
        const data = await apiFetch(`/servers/${s.id}/plugins`);
        const items = data.plugins || [];
        if (!items.length) {
          list.innerHTML = '<div class="empty-state-sm">No plugins installed. Use the search panel to add plugins.</div>';
        } else {
          list.innerHTML = items.map(p => `
            <div class="addon-item">
              <span class="addon-icon">🔌</span>
              <span class="addon-name">${escHtml(p.filename)}</span>
              <span class="addon-size">${fmtBytes(p.size)}</span>
            </div>`).join('');
        }
      } else {
        list.innerHTML = `<div class="empty-state-sm">${escHtml(type)} servers don't support plugins or mods directly.</div>`;
      }
    } catch (err) {
      list.innerHTML = `<div class="empty-state-sm">Error loading: ${escHtml(err.message)}</div>`;
    }
  }

  async function searchModsOrPlugins() {
    const s = srv();
    if (!s) return;
    const query = $('#mod-search-input').value.trim();
    if (!query) return;

    const resultsEl = $('#mod-search-results');
    resultsEl.innerHTML = '<div class="empty-state-sm">Searching...</div>';

    const type = (s.server_type || 'vanilla').toLowerCase();
    const isModded = MOD_LOADERS.has(type);

    try {
      let results = [];

      if (modSearchContent === 'mods' && isModded) {
        const params = new URLSearchParams({ q: query, limit: 6, loader: type });
        const data = await apiFetch(`/mods/search?${params}`);
        results = (data.results || []).map(r => ({ ...r, _type: 'mod', _loader: type }));
      } else {
        // Plugin search via Modrinth
        const params = new URLSearchParams({ q: query, limit: 6 });
        const data = await apiFetch(`/mods/search?${params}`);
        results = (data.results || []).map(r => ({ ...r, _type: 'plugin', _loader: type }));
      }

      if (!results.length) {
        resultsEl.innerHTML = `<div class="empty-state-sm">No results for "${escHtml(query)}"</div>`;
        return;
      }

      resultsEl.innerHTML = results.map(r => `
        <div class="mod-result-item">
          <div class="mod-result-header">
            ${r.icon ? `<img class="mod-result-icon" src="${escHtml(r.icon)}" alt="" onerror="this.style.display='none'"/>` : ''}
            <div>
              <div class="mod-result-name">${escHtml(r.title)}</div>
              <div class="mod-result-meta">${escHtml(r.slug)} · ⬇ ${fmtNum(r.downloads || 0)}</div>
            </div>
          </div>
          <div class="mod-result-desc">${escHtml((r.description || '').slice(0, 100))}${(r.description || '').length > 100 ? '…' : ''}</div>
          <button class="btn btn-primary btn-xs btn-install-addon" data-slug="${escHtml(r.slug)}" data-type="${r._type}" data-loader="${escHtml(r._loader || type)}">
            Install
          </button>
        </div>`).join('');

      resultsEl.querySelectorAll('.btn-install-addon').forEach(btn => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = 'Installing...';
          try {
            let resp;
            if (btn.dataset.type === 'mod') {
              resp = await apiFetch(`/servers/${s.id}/mods/install`, {
                method: 'POST',
                body: JSON.stringify({ slug: btn.dataset.slug, loader: btn.dataset.loader }),
              });
            } else {
              resp = await apiFetch(`/servers/${s.id}/plugins/install`, {
                method: 'POST',
                body: JSON.stringify({ slug: btn.dataset.slug }),
              });
            }
            if (resp.success || resp.plugin || resp.mod) {
              btn.textContent = '✓ Installed';
              btn.classList.remove('btn-primary');
              btn.classList.add('btn-success-outline');
              const type2 = (s.server_type || 'vanilla').toLowerCase();
              await refreshInstalledAddons(s, type2, MOD_LOADERS.has(type2), PLUGIN_TYPES.has(type2));
            } else {
              btn.textContent = '✗ Failed';
              btn.disabled = false;
            }
          } catch (err) {
            btn.textContent = '✗ Error';
            btn.disabled = false;
          }
        });
      });
    } catch (err) {
      resultsEl.innerHTML = `<div class="empty-state-sm">Search failed: ${escHtml(err.message)}</div>`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // File manager
  // ═══════════════════════════════════════════════════════════════════════

  function fileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    const map = {
      yml: '⚙️', yaml: '⚙️', properties: '⚙️', json: '📋', toml: '⚙️',
      jar: '📦', zip: '📦', gz: '📦', tar: '📦',
      log: '📜', txt: '📄', md: '📝',
      png: '🖼️', jpg: '🖼️', gif: '🖼️',
      dat: '💾', mca: '🗺️', nbt: '💾',
    };
    return map[ext] || '📄';
  }

  function updateBreadcrumb() {
    const bc = $('#files-breadcrumb');
    const parts = currentFilesPath ? currentFilesPath.split('/') : [];
    let html = '<button class="breadcrumb-item" data-p="">/</button>';
    let acc = '';
    for (const p of parts) {
      acc += (acc ? '/' : '') + p;
      html += `<span class="breadcrumb-sep">/</span><button class="breadcrumb-item" data-p="${acc}">${escHtml(p)}</button>`;
    }
    bc.innerHTML = html;
    bc.querySelectorAll('.breadcrumb-item').forEach((el) =>
      el.addEventListener('click', () => loadFiles(el.dataset.p)));
  }

  async function loadFiles(dir) {
    currentFilesPath = dir;
    updateBreadcrumb();
    const list = $('#files-list');
    list.innerHTML = '<div class="files-loading">Loading...</div>';
    try {
      const d = await apiFetch(`/servers/${selectedServerId}/files?path=${encodeURIComponent(dir)}`);
      if (!d.success) { list.innerHTML = `<div class="files-error">${d.error}</div>`; return; }
      list.innerHTML = '';
      if (dir) {
        const up = document.createElement('button');
        up.className = 'file-item';
        up.innerHTML = '<span class="file-icon">📁</span><span>..</span>';
        up.addEventListener('click', () => { const parts = dir.split('/'); parts.pop(); loadFiles(parts.join('/')); });
        list.appendChild(up);
      }
      for (const entry of d.files) {
        const item = document.createElement('button');
        item.className = `file-item${entry.path === openFilePath ? ' active' : ''}`;
        item.dataset.path = entry.path;
        item.dataset.type = entry.type;
        if (entry.type === 'directory') {
          item.innerHTML = `<span class="file-icon">📁</span><span class="file-name">${escHtml(entry.name)}</span>`;
          item.addEventListener('click', () => loadFiles(entry.path));
        } else {
          item.innerHTML = `<span class="file-icon">${fileIcon(entry.name)}</span><span class="file-name">${escHtml(entry.name)}</span><span class="file-size">${fmtBytes(entry.size)}</span>`;
          item.addEventListener('click', () => openFileEditor(entry.path));
        }
        list.appendChild(item);
      }
      if (!d.files.length && !dir) list.innerHTML = '<div class="files-empty">No files yet. Start the server to generate files.</div>';
    } catch (err) {
      list.innerHTML = `<div class="files-error">Failed: ${err.message}</div>`;
    }
  }

  async function openFileEditor(filePath) {
    if (fileEditorDirty && !confirm('Unsaved changes will be lost. Continue?')) return;
    openFilePath = filePath;
    const editor = $('#files-editor-content');
    const saveBtn = $('#btn-file-save');
    $('#files-editor-name').textContent = filePath.split('/').pop();
    editor.value = 'Loading...';
    editor.readOnly = true;
    saveBtn.classList.add('hidden');
    try {
      const d = await apiFetch(`/servers/${selectedServerId}/files/read?path=${encodeURIComponent(filePath)}`);
      if (!d.success) { editor.value = `Error: ${d.error}`; return; }
      editor.value = d.content;
      editor.readOnly = false;
      fileEditorDirty = false;
      saveBtn.classList.remove('hidden');
      $$('.file-item').forEach((el) => el.classList.toggle('active', el.dataset.path === filePath));
    } catch (err) { editor.value = `Error: ${err.message}`; }
  }

  async function saveFile() {
    if (!openFilePath) return;
    const btn = $('#btn-file-save');
    const prev = btn.textContent;
    btn.textContent = 'Saving...'; btn.disabled = true;
    try {
      const d = await apiFetch(`/servers/${selectedServerId}/files/write`, {
        method: 'PUT',
        body: JSON.stringify({ path: openFilePath, content: $('#files-editor-content').value }),
      });
      btn.textContent = d.success ? '✓ Saved' : 'Error';
      fileEditorDirty = false;
    } catch { btn.textContent = 'Error'; }
    setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1400);
  }

  async function createNewFile() {
    const name = prompt('File name:');
    if (!name) return;
    const p = currentFilesPath ? `${currentFilesPath}/${name}` : name;
    try { await apiFetch(`/servers/${selectedServerId}/files/create`, { method: 'POST', body: JSON.stringify({ path: p, type: 'file' }) }); loadFiles(currentFilesPath); }
    catch (err) { alert(`Failed: ${err.message}`); }
  }

  async function createNewFolder() {
    const name = prompt('Folder name:');
    if (!name) return;
    const p = currentFilesPath ? `${currentFilesPath}/${name}` : name;
    try { await apiFetch(`/servers/${selectedServerId}/files/create`, { method: 'POST', body: JSON.stringify({ path: p, type: 'directory' }) }); loadFiles(currentFilesPath); }
    catch (err) { alert(`Failed: ${err.message}`); }
  }

  async function deleteSelectedFile() {
    const active = document.querySelector('.file-item.active');
    if (!active || !active.dataset.path) { alert('Select a file first'); return; }
    if (!confirm(`Delete "${active.dataset.path}"?`)) return;
    try {
      await apiFetch(`/servers/${selectedServerId}/files/delete`, { method: 'POST', body: JSON.stringify({ path: active.dataset.path }) });
      if (openFilePath === active.dataset.path) { openFilePath = null; $('#files-editor-content').value = ''; $('#files-editor-name').textContent = 'Select a file to edit'; $('#btn-file-save').classList.add('hidden'); }
      loadFiles(currentFilesPath);
    } catch (err) { alert(`Failed: ${err.message}`); }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Players
  // ═══════════════════════════════════════════════════════════════════════

  async function loadPlayers() {
    const el = $('#players-online');
    const s = srv();
    if (!s || s.status !== 'running') { el.innerHTML = '<div class="empty-state-sm">Server is not running</div>'; return; }
    el.innerHTML = '<div class="empty-state-sm">Loading players...</div>';
    try {
      const d = await apiFetch(`/servers/${s.id}/command`, { method: 'POST', body: JSON.stringify({ command: 'list' }) });
      if (!d.success) { el.innerHTML = `<div class="empty-state-sm">${d.error || 'Failed'}</div>`; return; }
      const result = stripAnsi(d.result || '');
      const match = result.match(/There are (\d+) of a max of (\d+) players online/i);
      if (match) {
        const [, cur, max] = match;
        const namesRaw = result.split(':').slice(1).join(':').trim();
        const names = namesRaw ? namesRaw.split(',').map((n) => n.trim()).filter(Boolean) : [];
        let html = `<div class="players-count">${cur} / ${max} players online</div>`;
        if (names.length) {
          html += '<div>';
          for (const n of names) {
            html += `<div class="player-row"><span class="player-name">🧑 ${escHtml(n)}</span><div class="player-actions"><button class="btn btn-xs btn-ghost" data-cmd="kick ${n}">Kick</button><button class="btn btn-xs btn-ghost" data-cmd="ban ${n}">Ban</button><button class="btn btn-xs btn-ghost" data-cmd="op ${n}">OP</button><button class="btn btn-xs btn-ghost" data-cmd="deop ${n}">DeOP</button></div></div>`;
          }
          html += '</div>';
        } else { html += '<div class="empty-state-sm" style="margin-top:8px">No players online right now</div>'; }
        el.innerHTML = html;
        el.querySelectorAll('[data-cmd]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            try { await apiFetch(`/servers/${s.id}/command`, { method: 'POST', body: JSON.stringify({ command: btn.dataset.cmd }) }); loadPlayers(); }
            catch {} finally { btn.disabled = false; }
          });
        });
      } else {
        el.innerHTML = `<div class="empty-state-sm">${escHtml(result) || 'Could not parse player list'}</div>`;
      }
    } catch (err) { el.innerHTML = `<div class="empty-state-sm">Error: ${err.message}</div>`; }
  }

  async function runPlayerCmd() {
    const input = $('#player-cmd');
    const cmd = input.value.trim();
    if (!cmd || !selectedServerId) return;
    input.value = '';
    const out = $('#player-cmd-result');
    out.textContent = 'Executing...';
    try {
      const d = await apiFetch(`/servers/${selectedServerId}/command`, { method: 'POST', body: JSON.stringify({ command: cmd }) });
      out.textContent = d.success ? (d.result || 'Done') : (d.error || 'Failed');
      loadPlayers();
    } catch (err) { out.textContent = `Error: ${err.message}`; }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // AI Chat
  // ═══════════════════════════════════════════════════════════════════════

  function appendChat(role, text, isThinking = false) {
    const box = $('#chat-history');
    const div = document.createElement('div');
    div.className = `chat-msg ${role}${isThinking ? ' thinking' : ''}`;
    const av = document.createElement('div');
    av.className = 'chat-avatar';
    av.textContent = role === 'user' ? '👤' : '🤖';
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.innerHTML = mdLight(text);
    div.appendChild(av);
    div.appendChild(bubble);
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  }

  async function sendChat() {
    const input = $('#chat-input');
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    input.disabled = true;
    $('#chat-send').disabled = true;

    appendChat('user', msg);
    chatHistory.push({ role: 'user', content: msg });
    const thinking = appendChat('assistant', 'Thinking...', true);

    try {
      const d = await apiFetch('/ai', { method: 'POST', body: JSON.stringify({ message: msg, history: chatHistory.slice(0, -1) }) });
      thinking.remove();
      const reply = d.reply || (d.error ? `Error: ${d.error}` : 'Done.');
      appendChat(d.success === false ? 'error' : 'assistant', reply);
      chatHistory.push({ role: 'assistant', content: reply });
      while (chatHistory.length > MAX_HISTORY) chatHistory.shift();
      await loadServers();
    } catch (err) {
      thinking.remove();
      appendChat('error', `Network error: ${err.message}`);
    }

    input.disabled = false;
    $('#chat-send').disabled = false;
    input.focus();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Create server wizard
  // ═══════════════════════════════════════════════════════════════════════

  let wzStep = 1;
  let wzType = 'paper';

  const MOD_LOADER_SET = new Set(['fabric', 'forge', 'quilt', 'neoforge']);
  const PLUGIN_TYPE_SET = new Set(['paper', 'spigot', 'purpur']);

  function showCreateModal() {
    wzStep = 1;
    wzType = 'paper';
    $('#create-modal').classList.remove('hidden');
    $('#wz-name').value = '';
    $$('.type-card').forEach((c) => c.classList.toggle('selected', c.dataset.type === 'paper'));
    $('#wz-ram').value = '2G';
    $('#wz-maxplayers').value = '20';
    $('#wz-difficulty').value = 'normal';
    $('#wz-gamemode').value = 'survival';
    $$('#wz-plugins input[type="checkbox"]').forEach((cb) => { cb.checked = cb.value === 'essentialsx' || cb.value === 'vault'; });
    $$('#wz-mods input[type="checkbox"]').forEach((cb) => { cb.checked = cb.value === 'fabric-api' || cb.value === 'jei' || cb.value === 'create'; });
    $('#creation-log').innerHTML = '';
    $('#wizard-footer').style.display = '';
    $('#wizard-steps').style.display = '';
    updateWizard();
    setTimeout(() => $('#wz-name').focus(), 50);
  }

  function hideCreateModal() { $('#create-modal').classList.add('hidden'); }

  function updateWizard() {
    $$('.wz-pane').forEach((el) => el.classList.add('hidden'));
    const pane = $(`#wz-${wzStep}`);
    if (pane) pane.classList.remove('hidden');

    $$('.wz-step').forEach((el) => {
      const s = parseInt(el.dataset.s);
      el.classList.remove('active', 'done');
      if (s === wzStep) el.classList.add('active');
      else if (s < wzStep) el.classList.add('done');
    });

    $('#wz-back').style.display = wzStep > 1 ? '' : 'none';

    const isVanilla = wzType === 'vanilla';
    const isLast = wzStep === 4 || (wzStep === 3 && isVanilla);
    $('#wz-next').textContent = isLast ? '🚀 Create Server' : 'Next →';

    const addonsTab = document.querySelector('.wz-step[data-s="4"]');
    if (addonsTab) addonsTab.style.display = isVanilla ? 'none' : '';

    // RAM hint for mod loaders
    const ramHint = $('#wz-ram-hint');
    if (ramHint && wzStep === 3) {
      if (MOD_LOADER_SET.has(wzType)) {
        ramHint.textContent = '💡 Mod servers need 4GB+. Modpacks often need 6-8GB.';
        ramHint.style.display = '';
        if (['2G', '1G'].includes($('#wz-ram').value)) $('#wz-ram').value = '4G';
      } else {
        ramHint.style.display = 'none';
      }
    }

    // Step 4: show correct add-ons section
    if (wzStep === 4) {
      const isModLoader = MOD_LOADER_SET.has(wzType);
      const isPluginType = PLUGIN_TYPE_SET.has(wzType);
      $('#wz-plugins-section').classList.toggle('hidden', !isPluginType);
      $('#wz-mods-section').classList.toggle('hidden', !isModLoader);
      $('#wz-vanilla-section').classList.toggle('hidden', isPluginType || isModLoader);

      if (isModLoader) {
        const loaderName = wzType.charAt(0).toUpperCase() + wzType.slice(1);
        const loaderNameEl = $('#wz-loader-name');
        if (loaderNameEl) loaderNameEl.textContent = loaderName;
        const isFabricLike = wzType === 'fabric' || wzType === 'quilt';
        $('#wz-fabric-mods').classList.toggle('hidden', !isFabricLike);
        $('#wz-forge-mods').classList.toggle('hidden', isFabricLike);
      }
    }
  }

  function wizardNext() {
    if (wzStep === 1) {
      if (!$('#wz-name').value.trim()) { $('#wz-name').focus(); return; }
      wzStep = 2;
    } else if (wzStep === 2) {
      wzStep = 3;
    } else if (wzStep === 3) {
      if (wzType === 'vanilla') { startCreation(); return; }
      wzStep = 4;
    } else if (wzStep === 4) {
      startCreation(); return;
    }
    updateWizard();
  }

  function wizardBack() {
    if (wzStep === 4) wzStep = 3;
    else if (wzStep === 3) wzStep = 2;
    else if (wzStep === 2) wzStep = 1;
    updateWizard();
  }

  function logItem(text, status = 'pending') {
    const el = document.createElement('div');
    el.className = `clog-item ${status}`;
    const icons = { pending: '○', active: '⟳', done: '✓', failed: '✗' };
    el.innerHTML = `<span class="clog-icon">${icons[status] || '○'}</span><span>${escHtml(text)}</span>`;
    $('#creation-log').appendChild(el);
    return el;
  }

  function logUpdate(el, status, text) {
    const icons = { pending: '○', active: '⟳', done: '✓', failed: '✗' };
    el.className = `clog-item ${status}`;
    if (text) el.querySelector('span:last-child').textContent = text;
    el.querySelector('.clog-icon').textContent = icons[status] || '○';
  }

  async function startCreation() {
    $$('.wz-pane').forEach((el) => el.classList.add('hidden'));
    $('#wz-progress').classList.remove('hidden');
    $('#wizard-footer').style.display = 'none';
    $('#wizard-steps').style.display = 'none';
    $('#creation-log').innerHTML = '';

    const name = $('#wz-name').value.trim();
    const ram = $('#wz-ram').value;
    const properties = {
      MAX_PLAYERS: $('#wz-maxplayers').value,
      DIFFICULTY: $('#wz-difficulty').value,
      GAMEMODE: $('#wz-gamemode').value,
    };

    const isModLoader = MOD_LOADER_SET.has(wzType);
    const isPluginType = PLUGIN_TYPE_SET.has(wzType);

    const selectedPlugins = [];
    if (isPluginType) {
      $$('#wz-plugins input[type="checkbox"]:checked').forEach((cb) => selectedPlugins.push(cb.value));
    }

    const selectedMods = [];
    if (isModLoader) {
      const section = (wzType === 'fabric' || wzType === 'quilt') ? '#wz-fabric-mods' : '#wz-forge-mods';
      $$(section + ' input[type="checkbox"]:checked').forEach((cb) => selectedMods.push(cb.value));
    }

    // Create server
    const createEl = logItem(`Creating server "${name}"...`, 'active');
    let serverId = null;
    try {
      const d = await apiFetch('/servers/create', {
        method: 'POST',
        body: JSON.stringify({ name, game: 'minecraft', server_type: wzType, ram, properties }),
      });
      if (d.success && d.server) {
        serverId = d.server.id;
        logUpdate(createEl, 'done', `Server "${name}" created on port ${d.server.port}`);
      } else {
        logUpdate(createEl, 'failed', `Failed: ${d.error || 'Unknown error'}`);
        addDoneButtons(null);
        return;
      }
    } catch (err) {
      logUpdate(createEl, 'failed', `Error: ${err.message}`);
      addDoneButtons(null);
      return;
    }

    // Install plugins
    for (const slug of selectedPlugins) {
      const el = logItem(`Installing plugin: ${slug}...`, 'active');
      try {
        const d = await apiFetch(`/servers/${serverId}/plugins/install`, { method: 'POST', body: JSON.stringify({ slug }) });
        const p = d.plugin;
        logUpdate(el, d.success || p ? 'done' : 'failed', p ? `${p.title || slug} v${p.version || '?'} installed` : `${slug}: ${d.error || 'Failed'}`);
      } catch (err) { logUpdate(el, 'failed', `${slug}: ${err.message}`); }
    }

    // Install mods
    for (const slug of selectedMods) {
      const el = logItem(`Installing mod: ${slug}...`, 'active');
      try {
        const d = await apiFetch(`/servers/${serverId}/mods/install`, { method: 'POST', body: JSON.stringify({ slug, loader: wzType }) });
        const m = d.mod;
        logUpdate(el, d.success || m ? 'done' : 'failed', m ? `${m.title || slug} v${m.version || '?'} installed` : `${slug}: ${d.error || 'Failed'}`);
      } catch (err) { logUpdate(el, 'failed', `${slug}: ${err.message}`); }
    }

    // Restart if we installed things
    if ((selectedPlugins.length > 0 || selectedMods.length > 0) && serverId) {
      const el = logItem('Restarting to load add-ons...', 'active');
      try {
        await apiFetch(`/servers/${serverId}/restart`, { method: 'POST' });
        logUpdate(el, 'done', 'Server restarted');
      } catch { logUpdate(el, 'failed', 'Restart failed — restart manually'); }
    }

    await loadServers();
    addDoneButtons(serverId);
  }

  function addDoneButtons(serverId) {
    const div = document.createElement('div');
    div.style.cssText = 'margin-top: 18px; display: flex; gap: 8px;';
    if (serverId) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary btn-sm';
      btn.textContent = 'Manage Server →';
      btn.addEventListener('click', () => { hideCreateModal(); selectServer(serverId); });
      div.appendChild(btn);
    }
    const close = document.createElement('button');
    close.className = 'btn btn-ghost btn-sm';
    close.textContent = 'Close';
    close.addEventListener('click', hideCreateModal);
    div.appendChild(close);
    $('#creation-log').appendChild(div);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Server actions
  // ═══════════════════════════════════════════════════════════════════════

  async function serverAction(action) {
    if (!selectedServerId) return;
    if (action === 'delete') {
      if (!confirm('Delete this server? This cannot be undone.')) return;
      await apiFetch(`/servers/${selectedServerId}/delete`, { method: 'POST' });
      selectedServerId = null;
      navigate('servers');
      await loadServers();
      return;
    }
    await apiFetch(`/servers/${selectedServerId}/${action}`, { method: 'POST' });
    await loadServers();
    if (currentView === 'detail') renderServerDetail();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Event listeners
  // ═══════════════════════════════════════════════════════════════════════

  $('#nav-servers').addEventListener('click', () => navigate('servers'));
  $('#nav-modpacks').addEventListener('click', () => navigate('modpacks'));
  $('#nav-ai').addEventListener('click', () => navigate('ai'));

  $$('.nav-tab').forEach((el) => el.addEventListener('click', () => switchTab(el.dataset.tab)));

  $('#btn-back').addEventListener('click', () => navigate('servers'));
  $('#btn-start').addEventListener('click', () => serverAction('start'));
  $('#btn-stop').addEventListener('click', () => serverAction('stop'));
  $('#btn-restart').addEventListener('click', () => serverAction('restart'));
  $('#btn-delete').addEventListener('click', () => serverAction('delete'));

  $('#console-cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendCmd($('#console-cmd')); } });
  $('#console-send').addEventListener('click', () => sendCmd($('#console-cmd')));
  $('#btn-console-clear').addEventListener('click', () => { $('#console-output').innerHTML = ''; consoleLineCount = 0; });
  $('#btn-console-reconnect').addEventListener('click', () => initConsole());

  $('#console-preview-cmd').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const cmd = e.target.value.trim();
    if (!cmd || !selectedServerId) return;
    e.target.value = '';
    const body = $('#console-preview-body');
    const cmdDiv = document.createElement('div');
    cmdDiv.className = 'console-line console-cmd';
    cmdDiv.innerHTML = fmtLine(`> ${cmd}`);
    body.appendChild(cmdDiv);
    body.scrollTop = body.scrollHeight;
    try {
      const d = await apiFetch(`/servers/${selectedServerId}/command`, { method: 'POST', body: JSON.stringify({ command: cmd }) });
      const result = d.success && d.result ? stripAnsi(d.result) : (d.error || 'Failed');
      const outDiv = document.createElement('div');
      outDiv.className = 'console-line';
      outDiv.innerHTML = fmtLine(result);
      body.appendChild(outDiv);
      body.scrollTop = body.scrollHeight;
    } catch (err) {
      const errDiv = document.createElement('div');
      errDiv.className = 'console-line console-err';
      errDiv.textContent = `Error: ${err.message}`;
      body.appendChild(errDiv);
    }
  });
  $('#btn-goto-console').addEventListener('click', () => switchTab('console'));

  // Mods tab
  $('#btn-refresh-mods').addEventListener('click', loadModsTab);
  $('#btn-mod-search').addEventListener('click', searchModsOrPlugins);
  $('#mod-search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchModsOrPlugins(); });

  $$('#mods-search-type .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      modSearchContent = btn.dataset.content;
      $$('#mods-search-type .tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      $('#mod-search-results').innerHTML = '';
    });
  });

  $('#btn-file-save').addEventListener('click', saveFile);
  $('#btn-file-newfile').addEventListener('click', createNewFile);
  $('#btn-file-newfolder').addEventListener('click', createNewFolder);
  $('#btn-file-delete').addEventListener('click', deleteSelectedFile);
  $('#files-editor-content').addEventListener('input', () => { fileEditorDirty = true; });
  $('#files-editor-content').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveFile(); } });

  $('#btn-refresh-players').addEventListener('click', loadPlayers);
  $('#player-cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') runPlayerCmd(); });
  $('#player-cmd-send').addEventListener('click', runPlayerCmd);

  $('#chat-send').addEventListener('click', sendChat);
  $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) sendChat(); });

  $('#btn-new-server').addEventListener('click', showCreateModal);
  $('#btn-new-server-2').addEventListener('click', showCreateModal);
  $('#create-modal-close').addEventListener('click', hideCreateModal);
  $('#wz-cancel').addEventListener('click', hideCreateModal);
  $('#wz-next').addEventListener('click', wizardNext);
  $('#wz-back').addEventListener('click', wizardBack);
  $('#create-modal').addEventListener('click', (e) => { if (e.target === $('#create-modal')) hideCreateModal(); });
  $('#wz-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') wizardNext(); });

  $$('.type-card').forEach((card) => {
    card.addEventListener('click', () => {
      $$('.type-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      wzType = card.dataset.type;
      updateWizard();
    });
  });

  // Modpack browser
  $$('#modpack-sort-pills .filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      $$('#modpack-sort-pills .filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      modpackSort = pill.dataset.sort;
      modpackOffset = 0;
      loadModpacks();
    });
  });

  $$('#modpack-loader-pills .filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      $$('#modpack-loader-pills .filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      modpackLoader = pill.dataset.loader;
      modpackOffset = 0;
      loadModpacks();
    });
  });

  $('#btn-modpack-search').addEventListener('click', () => { modpackQuery = $('#modpack-search').value.trim(); modpackOffset = 0; loadModpacks(); });
  $('#modpack-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { modpackQuery = e.target.value.trim(); modpackOffset = 0; loadModpacks(); } });
  $('#btn-modpack-prev').addEventListener('click', () => { modpackOffset = Math.max(0, modpackOffset - MODPACK_LIMIT); loadModpacks(); });
  $('#btn-modpack-next').addEventListener('click', () => { modpackOffset += MODPACK_LIMIT; loadModpacks(); });

  $('#modpack-modal-close').addEventListener('click', () => $('#modpack-install-modal').classList.add('hidden'));
  $('#modpack-modal-cancel').addEventListener('click', () => $('#modpack-install-modal').classList.add('hidden'));
  $('#modpack-modal-install').addEventListener('click', installModpackToServer);
  $('#modpack-install-modal').addEventListener('click', (e) => { if (e.target === $('#modpack-install-modal')) $('#modpack-install-modal').classList.add('hidden'); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideCreateModal(); $('#modpack-install-modal').classList.add('hidden'); }
  });

  // Auto-refresh
  setInterval(loadServers, 10000);

  // ═══════════════════════════════════════════════════════════════════════
  // Init
  // ═══════════════════════════════════════════════════════════════════════

  loadServers();
})();
