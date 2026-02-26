# 🎮 AI-Driven Game Server Hosting MVP

A minimal platform that lets you create and manage game servers through natural language prompts.
Type *"Create a Minecraft server with 4GB RAM"* — and a Docker container starts automatically.

---

## Quick Start

### 1. Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (running)
- An [Anthropic API key](https://console.anthropic.com/)

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env and set your ANTHROPIC_API_KEY
```

### 3. Launch

```bash
docker compose up --build
```

Then open **http://localhost:3000** in your browser.

---

## Usage

Type natural language into the chat box:

| What you type | What happens |
|---|---|
| `Create a Minecraft server with 4GB RAM called Survival` | Server created, container started |
| `Start the Survival server` | Container started |
| `Stop the Survival server` | Container gracefully stopped |
| `Delete the Survival server` | Container removed, record deleted |
| `List all servers` | Shows all servers in chat |

You can also use the **Start / Stop / Delete** buttons on each server card, and view live container logs.

---

## Architecture

```
game-server-hosting/
├── server/
│   ├── index.js      ← Express API + route handlers
│   ├── database.js   ← SQLite (better-sqlite3)
│   ├── docker.js     ← Dockerode container management
│   └── ai.js         ← Anthropic API → structured JSON intent
├── client/
│   ├── index.html    ← Single-page UI
│   ├── style.css     ← Dark theme, responsive
│   └── script.js     ← Chat + server list (vanilla JS)
├── servers/          ← Per-server data volumes + SQLite DB
├── docker-compose.yml
└── Dockerfile
```

### Request flow

```
User types message
      │
      ▼
POST /ai  →  ai.js parses intent (Anthropic API)
      │
      ▼
index.js executes action:
  create_server  →  database.js + docker.js (createContainer + start)
  start_server   →  docker.js (start)
  stop_server    →  docker.js (stop)
  delete_server  →  docker.js (remove) + database.js (delete)
  list_servers   →  database.js (getAllServers)
      │
      ▼
JSON response → script.js updates UI
```

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/servers` | List all servers |
| `POST` | `/servers/create` | Create a server `{name, game, ram}` |
| `GET` | `/servers/:id` | Get server by ID |
| `POST` | `/servers/:id/start` | Start container |
| `POST` | `/servers/:id/stop` | Stop container |
| `POST` | `/servers/:id/delete` | Remove container + record |
| `GET` | `/servers/:id/logs` | Get container logs |
| `POST` | `/ai` | Natural language → execute action |

---

## Supported Games

| Game | Image | Default Port |
|------|-------|-------------|
| Minecraft | `itzg/minecraft-server` | 25565+ |

---

## Notes

- Servers run as **sibling Docker containers** (Docker-in-Docker via socket mount).
- Ports auto-increment from 25565.
- Containers use `restart: unless-stopped` — they survive restarts automatically.
- Server data volumes are persisted in `./servers/<id>/`.
- The AI **never executes actions directly** — it only returns structured JSON; the backend validates and executes.
