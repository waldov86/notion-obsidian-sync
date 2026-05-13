'use strict';
const path = require('path');
const os   = require('os');
const fs   = require('fs');

// Load optional config.json (CONFIG_PATH env var or ./config.json next to the script)
let fileConfig = {};
const configFilePath = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
if (fs.existsSync(configFilePath)) {
  try { fileConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8')); }
  catch (e) { process.stderr.write(`Warning: could not parse ${configFilePath}: ${e.message}\n`); }
}

// Priority: env var > config.json > hardcoded default
function c(envKey, jsonKey, fallback) {
  if (process.env[envKey] !== undefined) return process.env[envKey];
  if (fileConfig[jsonKey]  !== undefined) return fileConfig[jsonKey];
  return typeof fallback === 'function' ? fallback() : fallback;
}

const pathOf = (...parts) => path.join(os.homedir(), ...parts);

const LOCAL_ROOT  = c('LOCAL_ROOT',               'localRoot',    pathOf('notes/todos'));
const ARCHIVE_DIR = c('ARCHIVE_DIR',              'archiveDir',   pathOf('notes/todos/.archive'));
const TOKEN_PATH  = c('NOTION_TOKEN_PATH',        'tokenPath',    pathOf('.config/notion/token'));
const STATE_PATH  = c('STATE_PATH',               'statePath',    pathOf('.config/notion/todos_sync_state.json'));
const LOG_PATH    = c('LOG_PATH',                 'logPath',      pathOf('Library/Logs/todos-notion-sync.log'));
const LOCK_PATH   = c('LOCK_PATH',                'lockPath',     '/tmp/todos-notion-sync.lock');
const KANBAN_PATH = c('KANBAN_PATH',              'kanbanPath',   pathOf('Documents/AI-projects-personal/kanban.md'));
const DB_ID       = c('NOTION_DB_ID',             'dbId',         '');
const DATA_SOURCE_ID = c('NOTION_DATA_SOURCE_ID', 'dataSourceId', '');

const POLL_INTERVAL_MS = parseInt(c('POLL_INTERVAL_MS', 'pollIntervalMs', 5 * 60 * 1000), 10);
const TRIGGER_PORT     = parseInt(c('TRIGGER_PORT',     'triggerPort',    9876),            10);

// Enum validation — configurable, with sensible defaults
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
  DB_ID, DATA_SOURCE_ID, POLL_INTERVAL_MS, TRIGGER_PORT,
  VALID_STATUSES, VALID_HORIZONS, VALID_OUTCOMES, VALID_CATEGORIES,
  STATUS_ALIASES, HORIZON_ALIASES, OUTCOME_ALIASES, CATEGORY_ALIASES,
};
