(() => {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════
  // Config & state
  // ═══════════════════════════════════════════════════════════════════════

  const API = '';
  const WS_URL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
  const MAX_CONSOLE_LINES = 1200;
  const MAX_HISTORY = 40;

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

  // ═══════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]|\u00a7[0-9a-fk-or]|\[3[0-9]m|\[0m/g, '');

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function mdLight(text) {
    return escHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

  async function api(path, opts = {}) {
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

  function statusColor(s) {
    return { running: 'success', stopped: 'muted', starting: 'warning', stopping: 'warning', error: 'danger' }[s] || 'muted';
  }

  function gameIcon(g) { return g === 'minecraft' ? '⛏️' : '🎮'; }
  function gameLabel(g) { return g === 'minecraft' ? 'Minecraft' : g; }
  function srv() { return servers.find((s) => s.id === selectedServerId) || null; }

  function serverModpack(s) {
    if (!s || !s.modpack) return null;
    try { return JSON.parse(s.modpack); } catch { return null; }
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
    $('#view-ai').classList.toggle('hidden', view !== 'ai');
    $('#view-detail').classList.toggle('hidden', view !== 'detail');

    $('#topbar').style.display = view === 'detail' ? '' : 'none';
    $('#sidebar-server-section').style.display = view === 'detail' ? '' : 'none';

    if (view === 'servers') {
      selectedServerId = null;
      renderSidebar();
      renderServerGrid();
    }
    if (view === 'ai') {
      setTimeout(() => $('#chat-input').focus(), 50);
    }
    if (view === 'detail' && selectedServerId) {
      renderServerDetail();
    }
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
    else if (tab === 'files') loadFiles('');
    else if (tab === 'plugins') loadPluginsTab();
    else if (tab === 'modpack') loadModpackTab();
    else if (tab === 'players') loadPlayers();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Server list
  // ═══════════════════════════════════════════════════════════════════════

  async function loadServers() {
    try {
      const data = await api('/servers');
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
          <div class="stat"><span class="stat-label">Type</span><span>${(() => { const p = serverModpack(s); return p ? escHtml(p.title) : (s.server_type || 'vanilla'); })()}</span></div>
        </div>
        <div class="server-card-actions">
          <button class="btn btn-sm btn-accent" data-a="manage">Manage</button>
          <button class="btn btn-sm btn-success-outline" data-a="start" ${s.status === 'running' ? 'disabled' : ''}>▶ Start</button>
          <button class="btn btn-sm btn-ghost" data-a="stop" ${['stopped', 'error'].includes(s.status) ? 'disabled' : ''}>⏹ Stop</button>
        </div>`;

      card.querySelector('[data-a="manage"]').addEventListener('click', () => selectServer(s.id));
      card.querySelector('[data-a="start"]').addEventListener('click', async (e) => {
        e.target.disabled = true;
        await api(`/servers/${s.id}/start`, { method: 'POST' });
        loadServers();
      });
      card.querySelector('[data-a="stop"]').addEventListener('click', async (e) => {
        e.target.disabled = true;
        await api(`/servers/${s.id}/stop`, { method: 'POST' });
        loadServers();
      });
      grid.appendChild(card);
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
    $('#nav-tab-plugins-label').textContent = serverModpack(s) ? 'Mods' : 'Plugins';
  }

  function renderServerDetail() {
    updateTopbar();
    $$('.nav-tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === currentTab));
    $$('#view-detail .tab-pane').forEach((el) => el.classList.add('hidden'));
    const pane = $(`#tab-${currentTab}`);
    if (pane) pane.classList.remove('hidden');

    if (currentTab === 'overview') renderOverview();
    else if (currentTab === 'console') initConsole();
    else if (currentTab === 'files') loadFiles('');
    else if (currentTab === 'plugins') loadPluginsTab();
    else if (currentTab === 'modpack') loadModpackTab();
    else if (currentTab === 'players') loadPlayers();
  }

  // ── Overview ───────────────────────────────────────────────────────────

  async function renderOverview() {
    const s = srv();
    if (!s) return;

    $('#overview-game-icon').textContent = gameIcon(s.game);
    $('#overview-game').textContent = gameLabel(s.game);
    const badge = $('#overview-status');
    badge.textContent = s.status.toUpperCase();
    badge.className = `badge badge-${statusColor(s.status)}`;

    $('#overview-name').textContent = s.name;
    $('#overview-port').textContent = s.port;
    $('#overview-ram').textContent = s.ram;
    const pack = serverModpack(s);
    $('#overview-type').textContent = pack ? `Modpack — ${pack.title}` : (s.server_type || 'vanilla');
    $('#overview-ip').textContent = `localhost:${s.port}`;

    if (s.status === 'running') {
      try {
        const d = await api(`/servers/${s.id}/command`, { method: 'POST', body: JSON.stringify({ command: 'list' }) });
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
        const d = await api(`/servers/${s.id}/logs?tail=20`);
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
    previewWs.onopen = () => {
      previewWs.send(JSON.stringify({ type: 'subscribe', serverId }));
    };
    previewWs.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }
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

    consoleWs.onopen = () => {
      consoleWs.send(JSON.stringify({ type: 'subscribe', serverId: selectedServerId }));
    };

    consoleWs.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }

      if (data.type === 'log') addConsoleLine(data.data);
      if (data.type === 'command_result') {
        if (data.data) addConsoleLine(data.data);
      }
      if (data.type === 'command_error') {
        addConsoleLine(`Error: ${data.message}`, 'err');
      }
      if (data.type === 'error') addConsoleLine(`[Connection] ${data.message}`, 'err');
    };

    consoleWs.onclose = () => { consoleWs = null; };
    consoleWs.onerror = () => {};
  }

  function disconnectConsole() {
    if (!consoleWs) return;
    try {
      consoleWs.send(JSON.stringify({ type: 'unsubscribe' }));
      consoleWs.close();
    } catch {}
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
    if (consoleLineCount > MAX_CONSOLE_LINES) {
      out.removeChild(out.firstChild);
      consoleLineCount--;
    }

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
      api(`/servers/${selectedServerId}/command`, { method: 'POST', body: JSON.stringify({ command: cmd }) })
        .then((d) => { if (d.result) addConsoleLine(d.result); })
        .catch((e) => addConsoleLine(`Error: ${e.message}`, 'err'));
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
      const d = await api(`/servers/${selectedServerId}/files?path=${encodeURIComponent(dir)}`);
      if (!d.success) { list.innerHTML = `<div class="files-error">${d.error}</div>`; return; }

      list.innerHTML = '';

      if (dir) {
        const up = document.createElement('button');
        up.className = 'file-item';
        up.innerHTML = '<span class="file-icon">📁</span><span>..</span>';
        up.addEventListener('click', () => {
          const parts = dir.split('/');
          parts.pop();
          loadFiles(parts.join('/'));
        });
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
          item.innerHTML = `
            <span class="file-icon">${fileIcon(entry.name)}</span>
            <span class="file-name">${escHtml(entry.name)}</span>
            <span class="file-size">${fmtBytes(entry.size)}</span>`;
          item.addEventListener('click', () => openFileEditor(entry.path));
        }
        list.appendChild(item);
      }

      if (!d.files.length && !dir) {
        list.innerHTML = '<div class="files-empty">No files yet. Start the server to generate files.</div>';
      }
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
      const d = await api(`/servers/${selectedServerId}/files/read?path=${encodeURIComponent(filePath)}`);
      if (!d.success) { editor.value = `Error: ${d.error}`; return; }

      editor.value = d.content;
      editor.readOnly = false;
      fileEditorDirty = false;
      saveBtn.classList.remove('hidden');

      $$('.file-item').forEach((el) => el.classList.toggle('active', el.dataset.path === filePath));
    } catch (err) {
      editor.value = `Error: ${err.message}`;
    }
  }

  async function saveFile() {
    if (!openFilePath) return;
    const btn = $('#btn-file-save');
    const prev = btn.textContent;
    btn.textContent = 'Saving...';
    btn.disabled = true;

    try {
      const d = await api(`/servers/${selectedServerId}/files/write`, {
        method: 'PUT',
        body: JSON.stringify({ path: openFilePath, content: $('#files-editor-content').value }),
      });
      btn.textContent = d.success ? '✓ Saved' : 'Error';
      fileEditorDirty = false;
    } catch {
      btn.textContent = 'Error';
    }

    setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1400);
  }

  async function createNewFile() {
    const name = prompt('File name:');
    if (!name) return;
    const p = currentFilesPath ? `${currentFilesPath}/${name}` : name;
    try {
      await api(`/servers/${selectedServerId}/files/create`, { method: 'POST', body: JSON.stringify({ path: p, type: 'file' }) });
      loadFiles(currentFilesPath);
    } catch (err) { alert(`Failed: ${err.message}`); }
  }

  async function createNewFolder() {
    const name = prompt('Folder name:');
    if (!name) return;
    const p = currentFilesPath ? `${currentFilesPath}/${name}` : name;
    try {
      await api(`/servers/${selectedServerId}/files/create`, { method: 'POST', body: JSON.stringify({ path: p, type: 'directory' }) });
      loadFiles(currentFilesPath);
    } catch (err) { alert(`Failed: ${err.message}`); }
  }

  async function deleteSelectedFile() {
    const active = document.querySelector('.file-item.active');
    if (!active || !active.dataset.path) { alert('Select a file first'); return; }
    if (!confirm(`Delete "${active.dataset.path}"?`)) return;

    try {
      await api(`/servers/${selectedServerId}/files/delete`, { method: 'POST', body: JSON.stringify({ path: active.dataset.path }) });
      if (openFilePath === active.dataset.path) {
        openFilePath = null;
        $('#files-editor-content').value = '';
        $('#files-editor-name').textContent = 'Select a file to edit';
        $('#btn-file-save').classList.add('hidden');
      }
      loadFiles(currentFilesPath);
    } catch (err) { alert(`Failed: ${err.message}`); }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Plugins / Mods tab
  // ═══════════════════════════════════════════════════════════════════════

  let addonsKind = 'plugin'; // 'plugin' | 'mod' — set from the server's modpack state

  function addonRow({ icon, title, subtitle, meta, btnLabel, btnClass = 'btn-primary', onClick, danger = false }) {
    const row = document.createElement('div');
    row.className = 'addon-row';
    row.innerHTML = `
      ${icon ? `<img class="addon-icon" src="${icon}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '<div class="addon-icon addon-icon-blank">📦</div>'}
      <div class="addon-body">
        <div class="addon-title">${escHtml(title)}</div>
        ${subtitle ? `<div class="addon-sub">${escHtml(subtitle)}</div>` : ''}
        ${meta ? `<div class="addon-meta">${escHtml(meta)}</div>` : ''}
      </div>
      <button class="btn btn-sm ${danger ? 'btn-danger-outline' : btnClass} addon-btn">${escHtml(btnLabel)}</button>`;

    const btn = row.querySelector('.addon-btn');
    btn.addEventListener('click', async () => {
      const prev = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⟳ ...';
      try {
        await onClick(btn);
      } finally {
        btn.disabled = false;
        btn.textContent = prev;
      }
    });
    return row;
  }

  async function loadPluginsTab() {
    const box = $('#plugins-installed');
    box.innerHTML = '<div class="empty-state-sm">Loading...</div>';

    try {
      const d = await api(`/servers/${selectedServerId}/plugins`);
      if (!d.success) { box.innerHTML = `<div class="empty-state-sm">${escHtml(d.error || 'Failed')}</div>`; return; }

      addonsKind = d.kind === 'mod' ? 'mod' : 'plugin';
      const label = addonsKind === 'mod' ? 'Mods' : 'Plugins';
      $('#plugins-installed-title').textContent = `Installed ${label}`;
      $('#nav-tab-plugins-label').textContent = label;
      $('#plugins-browse-title').textContent = `Browse Modrinth ${label}`;
      $('#plugins-search-input').placeholder = addonsKind === 'mod'
        ? 'Search mods... e.g. minimap, storage, performance'
        : 'Search plugins... e.g. teleport, economy, worldedit';

      if (!d.plugins.length) {
        box.innerHTML = `<div class="empty-state-sm">No ${label.toLowerCase()} installed yet. Search Modrinth on the right →</div>`;
        return;
      }

      box.innerHTML = '';
      for (const p of d.plugins) {
        box.appendChild(addonRow({
          title: p.filename,
          meta: fmtBytes(p.size),
          btnLabel: 'Remove',
          danger: true,
          onClick: async () => {
            if (!confirm(`Remove ${p.filename}?`)) return;
            const r = await api(`/servers/${selectedServerId}/plugins/remove`, {
              method: 'POST',
              body: JSON.stringify({ filename: p.filename }),
            });
            if (!r.success) alert(r.error || 'Failed to remove');
            loadPluginsTab();
          },
        }));
      }
    } catch (err) {
      box.innerHTML = `<div class="empty-state-sm">Error: ${escHtml(err.message)}</div>`;
    }
  }

  async function searchPluginsUI() {
    const q = $('#plugins-search-input').value.trim();
    if (!q) return;
    const out = $('#plugins-search-results');
    out.innerHTML = '<div class="empty-state-sm">Searching Modrinth...</div>';

    try {
      const d = await api(`/plugins/search?q=${encodeURIComponent(q)}&serverId=${encodeURIComponent(selectedServerId)}`);
      if (!d.success) { out.innerHTML = `<div class="empty-state-sm">${escHtml(d.error || 'Search failed')}</div>`; return; }
      if (!d.results.length) { out.innerHTML = '<div class="empty-state-sm">No results. Try different keywords.</div>'; return; }

      out.innerHTML = '';
      for (const p of d.results) {
        out.appendChild(addonRow({
          icon: p.icon,
          title: p.title,
          subtitle: p.description,
          meta: `${p.downloads.toLocaleString()} downloads`,
          btnLabel: 'Install',
          onClick: async (btn) => {
            const r = await api(`/servers/${selectedServerId}/plugins/install`, {
              method: 'POST',
              body: JSON.stringify({ slug: p.slug }),
            });
            if (r.success) {
              btn.textContent = r.plugin.alreadyInstalled ? '✓ Installed' : '✓ Done';
              loadPluginsTab();
              await loadServers();
            } else {
              alert(r.error || 'Install failed');
            }
          },
        }));
      }
    } catch (err) {
      out.innerHTML = `<div class="empty-state-sm">Error: ${escHtml(err.message)}</div>`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Modpack tab
  // ═══════════════════════════════════════════════════════════════════════

  async function loadModpackTab() {
    const box = $('#modpack-current');
    const s = srv();
    if (!s) return;

    const pack = serverModpack(s);
    if (!pack) {
      box.innerHTML = `
        <div class="empty-state-sm">
          No modpack installed — this is a plain <strong>${escHtml(s.server_type || 'vanilla')}</strong> server.<br>
          Search on the right to install one, or ask the AI assistant (e.g. <em>"install All the Mods 9"</em>).
        </div>`;
      return;
    }

    box.innerHTML = '';
    box.appendChild(addonRow({
      title: pack.title,
      subtitle: `v${pack.versionNumber} · ${pack.loader} · Minecraft ${pack.mcVersion}`,
      meta: `Slug: ${pack.slug}`,
      btnLabel: 'Remove',
      danger: true,
      onClick: async () => {
        if (!confirm(`Remove "${pack.title}"?\n\nThe server will restart as a plain ${s.server_type} server. World files are kept.`)) return;
        const r = await api(`/servers/${selectedServerId}/modpack/remove`, { method: 'POST' });
        if (!r.success) { alert(r.error || 'Failed to remove modpack'); return; }
        await loadServers();
        loadModpackTab();
        loadPluginsTab();
      },
    }));
  }

  async function searchModpacksUI() {
    const q = $('#modpack-search-input').value.trim();
    if (!q) return;
    const out = $('#modpack-search-results');
    out.innerHTML = '<div class="empty-state-sm">Searching Modrinth...</div>';

    try {
      const d = await api(`/modpacks/search?q=${encodeURIComponent(q)}`);
      if (!d.success) { out.innerHTML = `<div class="empty-state-sm">${escHtml(d.error || 'Search failed')}</div>`; return; }
      if (!d.results.length) { out.innerHTML = '<div class="empty-state-sm">No modpacks found. Try different keywords.</div>'; return; }

      out.innerHTML = '';
      for (const p of d.results) {
        out.appendChild(addonRow({
          icon: p.icon,
          title: p.title,
          subtitle: p.description,
          meta: `${p.downloads.toLocaleString()} downloads · MC ${p.latestMcVersion || '?'}`,
          btnLabel: 'Install',
          onClick: async (btn) => {
            const msg = `Install "${p.title}"?\n\n` +
              `• The server will be converted to run this pack and restarted\n` +
              `• First boot downloads all mods — it can take several minutes\n` +
              `• RAM below 4G is raised to 4G automatically\n` +
              `• World files are kept`;
            if (!confirm(msg)) return;

            btn.textContent = '⟳ Installing...';
            const r = await api(`/servers/${selectedServerId}/modpack/install`, {
              method: 'POST',
              body: JSON.stringify({ slug: p.slug }),
            });
            if (r.success) {
              btn.textContent = '✓ Installed';
              await loadServers();
              loadModpackTab();
            } else {
              alert(r.error || 'Install failed');
            }
          },
        }));
      }
    } catch (err) {
      out.innerHTML = `<div class="empty-state-sm">Error: ${escHtml(err.message)}</div>`;
    }
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
      const d = await api(`/servers/${s.id}/command`, { method: 'POST', body: JSON.stringify({ command: 'list' }) });
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
            html += `
              <div class="player-row">
                <span class="player-name">🧑 ${escHtml(n)}</span>
                <div class="player-actions">
                  <button class="btn btn-xs btn-ghost" data-cmd="kick ${n}">Kick</button>
                  <button class="btn btn-xs btn-ghost" data-cmd="ban ${n}">Ban</button>
                  <button class="btn btn-xs btn-ghost" data-cmd="op ${n}">OP</button>
                  <button class="btn btn-xs btn-ghost" data-cmd="deop ${n}">DeOP</button>
                </div>
              </div>`;
          }
          html += '</div>';
        } else {
          html += '<div class="empty-state-sm" style="margin-top:8px">No players online right now</div>';
        }

        el.innerHTML = html;

        el.querySelectorAll('[data-cmd]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
              await api(`/servers/${s.id}/command`, { method: 'POST', body: JSON.stringify({ command: btn.dataset.cmd }) });
              loadPlayers();
            } catch {} finally { btn.disabled = false; }
          });
        });
      } else {
        el.innerHTML = `<div class="empty-state-sm">${escHtml(result) || 'Could not parse player list'}</div>`;
      }
    } catch (err) {
      el.innerHTML = `<div class="empty-state-sm">Error: ${err.message}</div>`;
    }
  }

  async function runPlayerCmd() {
    const input = $('#player-cmd');
    const cmd = input.value.trim();
    if (!cmd || !selectedServerId) return;
    input.value = '';

    const out = $('#player-cmd-result');
    out.textContent = 'Executing...';

    try {
      const d = await api(`/servers/${selectedServerId}/command`, { method: 'POST', body: JSON.stringify({ command: cmd }) });
      out.textContent = d.success ? (d.result || 'Done') : (d.error || 'Failed');
      loadPlayers();
    } catch (err) {
      out.textContent = `Error: ${err.message}`;
    }
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

  /**
   * Render a change preview with Apply / Cancel buttons. The pending action is
   * only sent to /ai/execute if the user approves — otherwise nothing runs.
   */
  function appendConfirm(previewText, pendingAction) {
    const msgDiv = appendChat('assistant', previewText);
    const bubble = msgDiv.querySelector('.chat-bubble');

    const row = document.createElement('div');
    row.className = 'chat-confirm-row';
    row.innerHTML = `
      <button class="btn btn-primary btn-sm" data-c="apply">✓ Apply changes</button>
      <button class="btn btn-ghost btn-sm" data-c="cancel">✕ Cancel</button>`;
    bubble.appendChild(row);

    const applyBtn = row.querySelector('[data-c="apply"]');
    const cancelBtn = row.querySelector('[data-c="cancel"]');
    const disable = () => { applyBtn.disabled = true; cancelBtn.disabled = true; };

    applyBtn.addEventListener('click', async () => {
      disable();
      applyBtn.textContent = '⟳ Applying...';
      const thinking = appendChat('assistant', 'Applying changes', true);
      try {
        const d = await api('/ai/execute', { method: 'POST', body: JSON.stringify({ action: pendingAction }) });
        thinking.remove();
        const reply = d.reply || (d.error ? `Error: ${d.error}` : 'Done.');
        appendChat(d.success === false ? 'error' : 'assistant', reply);
        chatHistory.push({ role: 'assistant', content: `[User approved the changes] ${reply}` });
        await loadServers();
      } catch (err) {
        thinking.remove();
        appendChat('error', `Network error: ${err.message}`);
      }
      applyBtn.textContent = '✓ Applied';
    });

    cancelBtn.addEventListener('click', () => {
      disable();
      appendChat('assistant', 'Cancelled — no changes were made.');
      chatHistory.push({ role: 'assistant', content: '[User cancelled the proposed changes — nothing was executed]' });
    });

    const box = $('#chat-history');
    box.scrollTop = box.scrollHeight;
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
    const thinking = appendChat('assistant', 'Thinking', true);

    try {
      const d = await api('/ai', { method: 'POST', body: JSON.stringify({ message: msg, history: chatHistory.slice(0, -1) }) });
      thinking.remove();
      const reply = d.reply || (d.error ? `Error: ${d.error}` : 'Done.');

      if (d.requiresConfirmation && d.pendingAction) {
        appendConfirm(reply, d.pendingAction);
        chatHistory.push({ role: 'assistant', content: `[Proposed changes awaiting user approval]\n${reply}` });
      } else {
        appendChat(d.success === false ? 'error' : 'assistant', reply);
        chatHistory.push({ role: 'assistant', content: reply });
      }

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
    $$('#wz-plugins input[type="checkbox"]').forEach((cb) => {
      cb.checked = cb.value === 'essentialsx' || cb.value === 'vault';
    });
    $('#creation-log').innerHTML = '';
    $('#wizard-footer').style.display = '';
    $('#wizard-steps').style.display = '';
    updateWizard();
    setTimeout(() => $('#wz-name').focus(), 50);
  }

  function hideCreateModal() {
    $('#create-modal').classList.add('hidden');
  }

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

    const isLast = wzStep === 4 || (wzStep === 3 && wzType === 'vanilla');
    $('#wz-next').textContent = isLast ? '🚀 Create Server' : 'Next →';

    const pluginTab = document.querySelector('.wz-step[data-s="4"]');
    if (pluginTab) pluginTab.style.display = wzType === 'vanilla' ? 'none' : '';
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
      startCreation();
      return;
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
    el.innerHTML = `<span class="clog-icon">${icons[status] || '○'}</span><span>${text}</span>`;
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

    const selectedPlugins = [];
    if (wzType !== 'vanilla') {
      $$('#wz-plugins input[type="checkbox"]:checked').forEach((cb) => selectedPlugins.push(cb.value));
    }

    // Step 1: Create server
    const createEl = logItem(`Creating server "${name}"...`, 'active');
    let serverId = null;

    try {
      const d = await api('/servers/create', {
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

    // Step 2: Install plugins
    for (const slug of selectedPlugins) {
      const el = logItem(`Installing ${slug}...`, 'active');
      try {
        const d = await api(`/servers/${serverId}/plugins/install`, {
          method: 'POST',
          body: JSON.stringify({ slug }),
        });
        if (d.success && d.plugin) {
          const p = d.plugin;
          logUpdate(el, p.alreadyInstalled ? 'done' : 'done', `${p.title || slug}${p.version ? ' v' + p.version : ''} installed`);
        } else {
          logUpdate(el, 'failed', `${slug}: ${d.error || 'Failed'}`);
        }
      } catch (err) {
        logUpdate(el, 'failed', `${slug}: ${err.message}`);
      }
    }

    // Step 3: Restart to load plugins
    if (selectedPlugins.length > 0 && serverId) {
      const el = logItem('Restarting to load plugins...', 'active');
      try {
        await api(`/servers/${serverId}/restart`, { method: 'POST' });
        logUpdate(el, 'done', 'Server restarted with plugins');
      } catch {
        logUpdate(el, 'failed', 'Restart failed — restart manually');
      }
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
      await api(`/servers/${selectedServerId}/delete`, { method: 'POST' });
      selectedServerId = null;
      navigate('servers');
      await loadServers();
      return;
    }
    await api(`/servers/${selectedServerId}/${action}`, { method: 'POST' });
    await loadServers();
    if (currentView === 'detail') renderServerDetail();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Event listeners
  // ═══════════════════════════════════════════════════════════════════════

  // Sidebar nav
  $('#nav-servers').addEventListener('click', () => navigate('servers'));
  $('#nav-ai').addEventListener('click', () => navigate('ai'));

  // Sidebar tabs (server detail)
  $$('.nav-tab').forEach((el) => el.addEventListener('click', () => switchTab(el.dataset.tab)));

  // Topbar actions
  $('#btn-back').addEventListener('click', () => navigate('servers'));
  $('#btn-start').addEventListener('click', () => serverAction('start'));
  $('#btn-stop').addEventListener('click', () => serverAction('stop'));
  $('#btn-restart').addEventListener('click', () => serverAction('restart'));
  $('#btn-delete').addEventListener('click', () => serverAction('delete'));

  // Console
  $('#console-cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendCmd($('#console-cmd')); } });
  $('#console-send').addEventListener('click', () => sendCmd($('#console-cmd')));
  $('#btn-console-clear').addEventListener('click', () => { $('#console-output').innerHTML = ''; consoleLineCount = 0; });
  $('#btn-console-reconnect').addEventListener('click', () => initConsole());

  // Overview console preview
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
      const d = await api(`/servers/${selectedServerId}/command`, { method: 'POST', body: JSON.stringify({ command: cmd }) });
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
      body.scrollTop = body.scrollHeight;
    }
  });
  $('#btn-goto-console').addEventListener('click', () => switchTab('console'));

  // Files
  $('#btn-file-save').addEventListener('click', saveFile);
  $('#btn-file-newfile').addEventListener('click', createNewFile);
  $('#btn-file-newfolder').addEventListener('click', createNewFolder);
  $('#btn-file-delete').addEventListener('click', deleteSelectedFile);
  $('#files-editor-content').addEventListener('input', () => { fileEditorDirty = true; });
  $('#files-editor-content').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveFile(); }
  });

  // Plugins / Mods
  $('#btn-plugins-refresh').addEventListener('click', loadPluginsTab);
  $('#plugins-search-btn').addEventListener('click', searchPluginsUI);
  $('#plugins-search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchPluginsUI(); });

  // Modpack
  $('#modpack-search-btn').addEventListener('click', searchModpacksUI);
  $('#modpack-search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchModpacksUI(); });

  // Players
  $('#btn-refresh-players').addEventListener('click', loadPlayers);
  $('#player-cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') runPlayerCmd(); });
  $('#player-cmd-send').addEventListener('click', runPlayerCmd);

  // AI Chat
  $('#chat-send').addEventListener('click', sendChat);
  $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) sendChat(); });

  // Create modal
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

  // Global
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCreateModal(); });

  // Auto-refresh
  setInterval(loadServers, 10000);

  // ═══════════════════════════════════════════════════════════════════════
  // Init
  // ═══════════════════════════════════════════════════════════════════════

  loadServers();
})();
