'use strict';
const path = require('path');
const os   = require('os');

const LOCAL_ROOT  = path.join(os.homedir(), 'notes/todos');
const ARCHIVE_DIR = path.join(os.homedir(), 'notes/todos/.archive');
const TOKEN_PATH  = path.join(os.homedir(), '.config/notion/token');
const STATE_PATH  = path.join(os.homedir(), '.config/notion/todos_sync_state.json');
const LOG_PATH    = path.join(os.homedir(), 'Library/Logs/todos-notion-sync.log');
const LOCK_PATH   = '/tmp/todos-notion-sync.lock';
const KANBAN_PATH = path.join(os.homedir(), 'Documents/AI-projects-personal/kanban.md');

const DB_ID         = 'YOUR_DB_ID';
const DATA_SOURCE_ID = 'YOUR_DATA_SOURCE_ID';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const VALID_STATUSES   = new Set(['Backlog', 'In progress', 'Done']);
const VALID_HORIZONS   = new Set(['Now', 'Later', '']);
const VALID_OUTCOMES   = new Set(['Completed', 'Dropped', '']);
const VALID_CATEGORIES = new Set(['EXAMPLE_CATEGORY_1', 'EXAMPLE_CATEGORY_2']);

// Maps lowercased input → canonical value, so case variants are auto-corrected
// rather than hard-failing. ABnB, KA, ME etc. are preserved via explicit keys.
function buildAliasMap(validSet) {
  return new Map([...validSet].map(v => [v.toLowerCase(), v]));
}

const STATUS_ALIASES   = buildAliasMap(VALID_STATUSES);
const HORIZON_ALIASES  = buildAliasMap(VALID_HORIZONS);
const OUTCOME_ALIASES  = buildAliasMap(VALID_OUTCOMES);
const CATEGORY_ALIASES = buildAliasMap(VALID_CATEGORIES);

module.exports = {
  LOCAL_ROOT, ARCHIVE_DIR, TOKEN_PATH, STATE_PATH, LOG_PATH, LOCK_PATH, KANBAN_PATH,
  DB_ID, DATA_SOURCE_ID, POLL_INTERVAL_MS,
  VALID_STATUSES, VALID_HORIZONS, VALID_OUTCOMES, VALID_CATEGORIES,
  STATUS_ALIASES, HORIZON_ALIASES, OUTCOME_ALIASES, CATEGORY_ALIASES,
};
