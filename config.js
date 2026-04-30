'use strict';
const path = require('path');
const os   = require('os');
const fs   = require('fs');

// ── Config loading ────────────────────────────────────────────────────────────
// Priority: environment variables > config.json > defaults
// See config.example.json for all available options.

function loadFileConfig() {
  const configPath = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      process.stderr.write(`Warning: could not parse config file at ${configPath}: ${err.message}\n`);
    }
  }
  return {};
}

const fileConfig = loadFileConfig();

function cfg(envKey, fileKey, defaultValue) {
  if (process.env[envKey] !== undefined) return process.env[envKey];
  if (fileConfig[fileKey] !== undefined) return fileConfig[fileKey];
  return defaultValue;
}

const LOCAL_ROOT  = cfg('LOCAL_ROOT',   'localRoot',   path.join(os.homedir(), 'notion-todos'));
const ARCHIVE_DIR = cfg('ARCHIVE_DIR',  'archiveDir',  path.join(LOCAL_ROOT, '.archive'));
const KANBAN_PATH = cfg('KANBAN_PATH',  'kanbanPath',  path.join(LOCAL_ROOT, '..', 'kanban.md'));
const STATE_PATH  = cfg('STATE_PATH',   'statePath',   path.join(os.homedir(), '.config', 'notion-obsidian-sync', 'state.json'));
const LOG_PATH    = cfg('LOG_PATH',     'logPath',     path.join(os.homedir(), '.config', 'notion-obsidian-sync', 'sync.log'));
const LOCK_PATH   = cfg('LOCK_PATH',    'lockPath',    '/tmp/notion-obsidian-sync.lock');
const TOKEN_PATH  = cfg('NOTION_TOKEN_PATH', 'tokenPath', path.join(os.homedir(), '.config', 'notion', 'token'));
const DB_ID       = cfg('NOTION_DB_ID', 'dbId',        '');
const TRIGGER_PORT = parseInt(cfg('TRIGGER_PORT', 'triggerPort', '9876'), 10);
const POLL_INTERVAL_MS = parseInt(cfg('POLL_INTERVAL_MS', 'pollIntervalMs', String(5 * 60 * 1000)), 10);

if (!DB_ID) {
  process.stderr.write('FATAL: NOTION_DB_ID env var or config.json "dbId" is required\n');
  process.exit(1);
}

// ── Notion token ──────────────────────────────────────────────────────────────
// Set NOTION_TOKEN env var directly, or store token in TOKEN_PATH file.
// Env var takes priority.
function readToken() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN;
  if (fs.existsSync(TOKEN_PATH)) return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  process.stderr.write('FATAL: Set NOTION_TOKEN env var or create a token file at ' + TOKEN_PATH + '\n');
  process.exit(1);
}

// ── Field enums ───────────────────────────────────────────────────────────────
// Customise via config.json "validStatuses" / "validHorizons" / "validOutcomes" / "validCategories"
const VALID_STATUSES   = new Set(fileConfig.validStatuses   || ['Backlog', 'In progress', 'Done']);
const VALID_HORIZONS   = new Set(fileConfig.validHorizons   || ['Now', 'Later', '']);
const VALID_OUTCOMES   = new Set(fileConfig.validOutcomes   || ['Completed', 'Dropped', '']);
const VALID_CATEGORIES = new Set(fileConfig.validCategories || []);

function buildAliasMap(validSet) {
  return new Map([...validSet].map(v => [v.toLowerCase(), v]));
}

const STATUS_ALIASES   = buildAliasMap(VALID_STATUSES);
const HORIZON_ALIASES  = buildAliasMap(VALID_HORIZONS);
const OUTCOME_ALIASES  = buildAliasMap(VALID_OUTCOMES);
const CATEGORY_ALIASES = buildAliasMap(VALID_CATEGORIES);

module.exports = {
  LOCAL_ROOT, ARCHIVE_DIR, TOKEN_PATH, STATE_PATH, LOG_PATH, LOCK_PATH, KANBAN_PATH,
  DB_ID, TRIGGER_PORT, POLL_INTERVAL_MS,
  VALID_STATUSES, VALID_HORIZONS, VALID_OUTCOMES, VALID_CATEGORIES,
  STATUS_ALIASES, HORIZON_ALIASES, OUTCOME_ALIASES, CATEGORY_ALIASES,
  readToken,
};
