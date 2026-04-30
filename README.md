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

### Safety guards (learned from a 28-task wipeout)

Two hard limits protect against bulk data loss:

1. **Empty-kanban guard** — if `kanban.md` is parsed and found to contain zero active items, but the internal state has active items, the sync aborts. This fires when Obsidian writes a blank file or the kanban plugin races with the daemon.

2. **Catastrophic-drop guard** — if removing items from the kanban would affect more than 5 items *and* more than 50% of the active board in a single pass, the drop is aborted. Status changes and new cards still go through; only the mass-drop is blocked.

Both guards log a `SAFETY:` warn entry so you know what happened.

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

Copy `config.example.json` to `config.json` and fill in:

```json
{
  "dbId": "YOUR_DATABASE_ID",
  "localRoot": "/Users/you/notes/todos",
  "kanbanPath": "/Users/you/notes/kanban.md"
}
```

The database ID is the 32-character hex string in the Notion page URL.

Set your token via env var (recommended) or `tokenPath`:

```bash
export NOTION_TOKEN=secret_YOUR_TOKEN
```

All config options can also be set via environment variables — see `config.example.json` for the full list.

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
curl -X POST http://localhost:9876/trigger-poll
```

Useful for webhook integrations — expose with [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or similar and trigger from n8n, Zapier, etc.

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

## License

MIT
