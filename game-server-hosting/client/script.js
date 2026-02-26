/**
 * script.js
 * Vanilla JS client for the Game Server Hosting MVP.
 *
 * Responsibilities:
 *   - Chat interface → POST /ai → display AI reply
 *   - Server list → GET /servers → render cards
 *   - Per-card buttons → start / stop / delete / logs
 *   - Auto-refresh server list every 10s
 */

const API = '';  // same origin

// Conversation history for AI context (keeps last 20 exchanges to stay within token limits)
const MAX_HISTORY = 40; // 20 user + 20 assistant messages
const conversationHistory = [];

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const chatHistory  = document.getElementById('chat-history');
const chatInput    = document.getElementById('chat-input');
const chatSend     = document.getElementById('chat-send');
const serverList   = document.getElementById('server-list');
const emptyState   = document.getElementById('empty-state');
const refreshBtn   = document.getElementById('refresh-btn');
const logsModal    = document.getElementById('logs-modal');
const logsBody     = document.getElementById('logs-body');
const logsClose    = document.getElementById('logs-close');
const logsTitle    = document.getElementById('logs-modal-title');
const cardTemplate = document.getElementById('server-card-tpl');

// ─── Game metadata ────────────────────────────────────────────────────────────

const GAME_META = {
  minecraft: { icon: '⛏️', label: 'Minecraft' },
};

function getGameMeta(game) {
  return GAME_META[game] || { icon: '🎮', label: game };
}

// ─── Status helpers ───────────────────────────────────────────────────────────

function statusClass(status) {
  return `status-${status}`;
}

function statusLabel(status) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  return data;
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

function appendMessage(role, text, isThinking = false) {
  const wrapper = document.createElement('div');
  wrapper.className = `chat-message ${role}${isThinking ? ' thinking' : ''}`;

  const avatar = document.createElement('span');
  avatar.className = 'chat-avatar';
  avatar.textContent = role === 'user' ? '👤' : '🤖';

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  // Support basic markdown bold **text**
  bubble.innerHTML = markdownLight(text);

  wrapper.appendChild(avatar);
  wrapper.appendChild(bubble);
  chatHistory.appendChild(wrapper);
  chatHistory.scrollTop = chatHistory.scrollHeight;
  return wrapper;
}

/** Very minimal markdown: **bold** and newlines → <br> */
function markdownLight(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br/>');
}

async function sendMessage() {
  const msg = chatInput.value.trim();
  if (!msg) return;

  chatInput.value = '';
  chatSend.disabled = true;
  chatInput.disabled = true;

  appendMessage('user', msg);
  conversationHistory.push({ role: 'user', content: msg });
  const thinking = appendMessage('assistant', 'Thinking', true);

  try {
    const data = await apiFetch('/ai', {
      method: 'POST',
      body: JSON.stringify({ message: msg, history: conversationHistory.slice(0, -1) }),
    });

    // Remove thinking bubble
    thinking.remove();

    const reply = data.reply || (data.error ? `Error: ${data.error}` : 'Done.');
    const role = data.success === false ? 'error' : 'assistant';
    appendMessage(role, reply);

    // Add assistant response to history
    conversationHistory.push({ role: 'assistant', content: reply });

    // Trim history to stay within limits
    while (conversationHistory.length > MAX_HISTORY) {
      conversationHistory.shift();
    }

    // Refresh server list after any AI action
    await loadServers();
  } catch (err) {
    thinking.remove();
    appendMessage('error', `Network error: ${err.message}`);
  }

  chatSend.disabled = false;
  chatInput.disabled = false;
  chatInput.focus();
}

chatSend.addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) sendMessage();
});

// ─── Server list ──────────────────────────────────────────────────────────────

async function loadServers() {
  try {
    const data = await apiFetch('/servers');
    if (data.success) {
      renderServers(data.servers);
    }
  } catch (err) {
    console.error('Failed to load servers:', err);
  }
}

function renderServers(servers) {
  // Remove existing cards (keep empty-state node)
  const existing = serverList.querySelectorAll('.server-card');
  existing.forEach((el) => el.remove());

  if (!servers || servers.length === 0) {
    emptyState.style.display = '';
    return;
  }

  emptyState.style.display = 'none';

  servers.forEach((server) => {
    const card = buildCard(server);
    serverList.appendChild(card);
  });
}

function buildCard(server) {
  const tpl = cardTemplate.content.cloneNode(true);
  const card = tpl.querySelector('.server-card');

  card.dataset.id = server.id;

  const meta = getGameMeta(server.game);
  card.querySelector('.server-game-icon').textContent = meta.icon;
  card.querySelector('.server-name').textContent = server.name;
  card.querySelector('.server-ram').textContent = server.ram;
  card.querySelector('.server-port').textContent = server.port;

  const badge = card.querySelector('.server-status-badge');
  badge.textContent = statusLabel(server.status);
  badge.classList.add(statusClass(server.status));

  const btnStart  = card.querySelector('.btn-start');
  const btnStop   = card.querySelector('.btn-stop');
  const btnLogs   = card.querySelector('.btn-logs');
  const btnDelete = card.querySelector('.btn-delete');

  // Disable buttons based on status
  if (server.status === 'running') {
    btnStart.disabled = true;
  }
  if (server.status === 'stopped' || server.status === 'error') {
    btnStop.disabled = true;
  }

  btnStart.addEventListener('click', () => serverAction(server.id, 'start'));
  btnStop.addEventListener('click',  () => serverAction(server.id, 'stop'));
  btnDelete.addEventListener('click', () => serverAction(server.id, 'delete'));
  btnLogs.addEventListener('click',  () => showLogs(server.id, server.name));

  return card;
}

async function serverAction(id, action) {
  const card = serverList.querySelector(`[data-id="${id}"]`);
  if (card) {
    const btns = card.querySelectorAll('.btn');
    btns.forEach((b) => (b.disabled = true));
  }

  try {
    let data;
    if (action === 'delete') {
      if (!confirm('Delete this server? This cannot be undone.')) {
        if (card) card.querySelectorAll('.btn').forEach((b) => (b.disabled = false));
        return;
      }
      data = await apiFetch(`/servers/${id}/delete`, { method: 'POST' });
    } else {
      data = await apiFetch(`/servers/${id}/${action}`, { method: 'POST' });
    }

    if (!data.success) {
      alert(data.error || 'Action failed');
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }

  await loadServers();
}

// ─── Logs modal ───────────────────────────────────────────────────────────────

async function showLogs(id, name) {
  logsTitle.textContent = `Logs — ${name}`;
  logsBody.textContent = 'Loading…';
  logsModal.classList.remove('hidden');

  try {
    const data = await apiFetch(`/servers/${id}/logs`);
    logsBody.textContent = data.logs || '(no logs)';
    logsBody.scrollTop = logsBody.scrollHeight;
  } catch (err) {
    logsBody.textContent = `Error: ${err.message}`;
  }
}

logsClose.addEventListener('click', () => logsModal.classList.add('hidden'));
logsModal.addEventListener('click', (e) => {
  if (e.target === logsModal) logsModal.classList.add('hidden');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') logsModal.classList.add('hidden');
});

// ─── Refresh ──────────────────────────────────────────────────────────────────

refreshBtn.addEventListener('click', () => {
  refreshBtn.textContent = '↻';
  loadServers().then(() => { refreshBtn.textContent = '⟳'; });
});

// Auto-refresh every 10 seconds
setInterval(loadServers, 10_000);

// ─── Init ─────────────────────────────────────────────────────────────────────

loadServers();
chatInput.focus();
