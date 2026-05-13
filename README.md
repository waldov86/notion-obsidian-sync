# notion-obsidian-sync

A battle-tested daemon that keeps a Notion database in two-way sync with a folder of local Markdown files, and auto-generates an Obsidian kanban board from the live state.

Built for people who want Notion as a task cockpit (mobile, sharing, rich views) while keeping a local Markdown view that plays nicely with editors like Obsidian, VS Code, or just `grep`.

---

## What it does

```
Notion database  ←→  ~/notes/todos/*.md  →  kanban.md (Obsidian board)
```

- **Pull**: new/changed Notion pages appear as `.md` files with YAML frontmatter
- **Push**: edits to `.md` files (title, status, body) sync back to Notion within 500 ms
- **Create**: drop a new `.md` file in the folder → a Notion page is created automatically
- **Kanban board**: `kanban.md` is rebuilt after every sync — `[[wikilink]]` cards grouped by Status, sortable by Horizon
- **Instant Notion→Local**: HTTP trigger endpoint + Cloudflare Tunnel lets webhook integrations (n8n, Zapier) force an immediate poll on Notion changes
- **Dead-letter journal**: failed syncs are tracked in a local SQLite database; `node deadletter.js --status` shows stuck files
- **Heartbeat alerts**: if the daemon goes silent for 30+ minutes, a Telegram message is sent (credentials via macOS Keychain or env vars)

### Safety guards (learned from a 28-task wipeout)

Two hard limits protect against bulk data loss:

1. **Empty-kanban guard** — if `kanban.md` is parsed and found to contain zero active items, but the internal state has active items, the sync aborts. This fires when Obsidian writes a blank file or the kanban plugin races with the daemon.

2. **Catastrophic-drop guard** — if removing items from the kanban would affect more than 5 items *and* more than 50% of the active board in a single pass, the drop is aborted. Status changes and new cards still go through; only the mass-drop is blocked.

3. **Concurrency guard** — a `pollInFlight` flag prevents the scheduled poll and the HTTP trigger from running simultaneously. Whichever call arrives second skips and logs a line.

All guards log a `SAFETY:` warn entry so you know what happened.

---

## Notion database schema

Create a database with these properties (exact names matter):

| Property | Type |
|---|---|
| `Name` | Title |
| `Status` | Status (options: `Backlog`, `In progress`, `Done`) |
| `Horizon` | Select (options: `Now`, `Later`) |
| `Outcome` | Select (options: `Completed`, `Dropped`) |
| `Category` | Multi-select (any tags you want) |

The daemon validates the schema on startup and exits with a clear error if `Status` or `Horizon` are missing.

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/waldov86/notion-obsidian-sync.git
cd notion-obsidian-sync
npm install
```

### 2. Create a Notion integration

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) → **New integration**
2. Copy the **Internal Integration Token** (`secret_...`)
3. Open your database → **···** → **Connections** → add your integration

### 3. Configure

Config is resolved in priority order: **env var → config.json → built-in default**.

The simplest approach — set everything via env vars (also what the launchd plist uses):

```bash
export NOTION_TOKEN=secret_YOUR_TOKEN
export NOTION_DB_ID=YOUR_DATABASE_ID
export LOCAL_ROOT=/Users/you/notes/todos
export KANBAN_PATH=/Users/you/notes/kanban.md
```

Or copy `config.example.json` to `config.json` and fill in your values:

```json
{
  "dbId": "YOUR_DATABASE_ID",
  "localRoot": "/Users/you/notes/todos",
  "kanbanPath": "/Users/you/notes/kanban.md"
}
```

The database ID is the 32-character hex string in the Notion page URL. To run with a non-default config file path: `CONFIG_PATH=/path/to/my.json node index.js`

See `config.example.json` for the full list of options.

### 4. Run

```bash
# Normal mode (watches files + polls every 5 min)
npm start

# Dry-run (shows what would happen, no writes)
npm run dry-run
```

### 5. Run as a background service

**macOS**: copy `extras/com.yourname.notion-obsidian-sync.plist` to `~/Library/LaunchAgents/`, edit the paths, then:

```bash
launchctl load ~/Library/LaunchAgents/com.yourname.notion-obsidian-sync.plist
```

**Linux (systemd)**: copy `extras/notion-obsidian-sync.service` to `~/.config/systemd/user/`, edit the paths, then:

```bash
systemctl --user enable --now notion-obsidian-sync
```

---

## Local file format

Each synced item is a `.md` file with YAML frontmatter:

```markdown
---
notion_id: abc123...
status: In progress
horizon: Now
outcome:
category: work, project-x
last_synced_at: 2026-04-30T12:00:00.000Z
---

# My task title

Optional body content that syncs to the Notion page body.

<!-- local: notes below this line are not synced to Notion -->
Private notes here — only visible locally.
```

Fields owned by **Notion** (source of truth): `notion_id`, `last_synced_at`  
Fields owned by **local** (push wins on conflict): `status`, `horizon`, `outcome`, `category`, title, body  
Fields never synced: anything below the `<!-- local: -->` marker

---

## Conflict resolution

When both sides change between polls, the daemon compares timestamps:

- **Local file mtime > Notion last_edited_time** → local wins, push to Notion
- **Notion newer** → remote wins, pull overwrites local

Both cases are logged at `warn` level.

---

## HTTP trigger endpoint

The daemon runs a local HTTP server on port 9876 (configurable via `TRIGGER_PORT`). Send a `POST /trigger-poll` to kick off an immediate poll without waiting for the interval:

```bash
curl -X POST http://127.0.0.1:9876/trigger-poll
```

Use this to make Notion→Local sync effectively instant. The pattern that works:

1. Expose the endpoint externally with [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (or similar)
2. Register a Notion webhook pointing at your n8n/Zapier/Make instance
3. Have the automation POST to your tunnel URL on every Notion change

The daemon uses `127.0.0.1` (not `localhost`) — make sure your curl command and automation use the right host.

A concurrency guard ensures that if a triggered poll arrives while the scheduled poll is already running, it skips rather than stacking. So rapid-fire Notion events are safe.

### Useful alias

```bash
alias sync-now='curl -s -X POST http://127.0.0.1:9876/trigger-poll && echo "sync triggered"'
```

---

## Configuration reference

| Env var | config.json key | Default | Description |
|---|---|---|---|
| `NOTION_TOKEN` | — | — | Notion integration token (required if `tokenPath` not set) |
| `NOTION_DB_ID` | `dbId` | — | Notion database ID (required) |
| `NOTION_TOKEN_PATH` | `tokenPath` | `~/.config/notion/token` | Path to token file |
| `LOCAL_ROOT` | `localRoot` | `~/notion-todos` | Folder for local `.md` files |
| `ARCHIVE_DIR` | `archiveDir` | `<localRoot>/.archive` | Where completed files are archived |
| `KANBAN_PATH` | `kanbanPath` | `<localRoot>/../kanban.md` | Output path for the kanban board |
| `STATE_PATH` | `statePath` | `~/.config/notion-obsidian-sync/state.json` | Sync state file |
| `LOG_PATH` | `logPath` | `~/.config/notion-obsidian-sync/sync.log` | Log file (JSON lines, 5 MB rotation) |
| `LOCK_PATH` | `lockPath` | `/tmp/notion-obsidian-sync.lock` | Lockfile (prevents duplicate instances) |
| `POLL_INTERVAL_MS` | `pollIntervalMs` | `300000` (5 min) | How often to poll Notion |
| `TRIGGER_PORT` | `triggerPort` | `9876` | Port for the HTTP trigger endpoint |
| `CONFIG_PATH` | — | `./config.json` | Path to config file |

Custom field enums (via `config.json` only):

| Key | Default |
|---|---|
| `validStatuses` | `["Backlog", "In progress", "Done"]` |
| `validHorizons` | `["Now", "Later", ""]` |
| `validOutcomes` | `["Completed", "Dropped", ""]` |
| `validCategories` | `[]` (any value accepted) |

---

## Known edge cases

- **Obsidian kanban plugin race**: if the plugin rewrites `kanban.md` while the daemon is mid-poll, the empty-kanban guard will block any drops. The next poll (or a manual `POST /trigger-poll`) resolves it cleanly.
- **`kanban.md` is output-only**: never edit it directly. The daemon overwrites it on every poll. Edit status by changing the `status:` field in the individual `.md` file, or drag the card in Obsidian — both paths sync to Notion.
- **Body sync is best-effort**: complex Notion blocks (databases, synced blocks, embeds) are flattened to markdown. The body round-trips cleanly for text, headings, bullets, and code blocks.
- **Rename detection**: if you rename a file in Obsidian (which creates a new file), the daemon detects the `notion_id` match and updates state + pushes the new title to Notion.

---

## Multi-database setup (running two instances)

You can run multiple instances of the daemon — one per Notion database — each with its own config, state file, lock file, and kanban board. This is useful when you want to keep a project-specific board separate from a personal todo board.

### Example: personal todos + project task tracker

**Instance 1 — personal todos** (`~/.config/notion/personal.json`):
```json
{
  "dbId": "YOUR_PERSONAL_DB_ID",
  "localRoot": "/Users/you/notes/todos",
  "kanbanPath": "/Users/you/notes/kanban.md",
  "statePath": "/Users/you/.config/notion/state-personal.json",
  "lockPath": "/tmp/notion-sync-personal.lock"
}
```

**Instance 2 — project board** (`~/.config/notion/project.json`):
```json
{
  "dbId": "YOUR_PROJECT_DB_ID",
  "localRoot": "/Users/you/projects/myproject/todos",
  "kanbanPath": "/Users/you/projects/myproject/kanban-project.md",
  "statePath": "/Users/you/.config/notion/state-project.json",
  "lockPath": "/tmp/notion-sync-project.lock",
  "validStatuses": ["Not started", "In progress", "Done"],
  "validCategories": []
}
```

Run each with its own config path:
```bash
CONFIG_PATH=~/.config/notion/personal.json node index.js
CONFIG_PATH=~/.config/notion/project.json  node index.js
```

Or register each as a separate launchd agent (macOS) by copying the plist template twice with different labels and env vars.

### Project-specific frontmatter

When syncing a project board, you can add custom fields to your `.md` files beyond the standard schema. Fields not in the Notion schema are ignored by the sync — they stay local-only (or you can add them as custom properties to your Notion DB).

Example WAG (Work Against Goals) ticket format for a project board:
```markdown
---
notion_id: abc123...
status: Not started
epic: Epic 1 — Telegram Connection
assignee: henrik
---

# WAG-002: Set up Telegram bot

Tasks:
- Set up bot via BotFather
- Connect to Notion workspace

<!-- local: private notes below this line are not synced -->
```

---

## Local-first pattern — reducing Notion API costs

The recommended way to work with this daemon is **local-first**: write and edit `.md` files directly, let the daemon push to Notion, rather than editing Notion and waiting for a pull.

This reduces Notion API calls significantly:

| Pattern | API calls |
|---|---|
| Edit Notion, wait for pull (every 5 min) | 1 poll + 1 page fetch per change |
| Edit local `.md`, push triggers immediately | 1 write per change, no polling needed |

For teams using Notion as a read/view layer (dashboards, mobile access, sharing) while doing all editing locally, the daemon can run with `POLL_INTERVAL_MS=3600000` (hourly) — pulling Notion changes rarely — and rely on the file watcher for near-instant pushes.

---

## License

MIT
