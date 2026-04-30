'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { STATE_PATH } = require('./config');

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { pages_by_id: {}, path_index: {} };
  }
  try {
    const raw    = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    parsed.path_index = {};
    for (const [id, entry] of Object.entries(parsed.pages_by_id || {})) {
      if (entry.path) parsed.path_index[entry.path] = id;
    }
    return parsed;
  } catch (err) {
    const bakPath = STATE_PATH + '.bak';
    fs.copyFileSync(STATE_PATH, bakPath);
    throw new Error(`State file corrupt (${err.message}). Backup at: ${bakPath}`);
  }
}

function saveState(state) {
  state.path_index = {};
  for (const [id, entry] of Object.entries(state.pages_by_id)) {
    if (entry.path) state.path_index[entry.path] = id;
  }
  const tmp = STATE_PATH + '.tmp';
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  if (fs.existsSync(STATE_PATH)) fs.copyFileSync(STATE_PATH, STATE_PATH + '.bak');
  fs.renameSync(tmp, STATE_PATH);
}

function hashContent(content) {
  return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
}

function hashFields({ title, status, horizon, outcome = '', categories = [], body = '' }) {
  const cats = [...categories].sort().join(',');
  return hashContent(`${title}|${status}|${horizon || ''}|${outcome || ''}|${cats}|${body.trim()}`);
}

function getEntryById(state, id)    { return state.pages_by_id[id] || null; }
function getIdByPath(state, relPath) { return state.path_index[relPath] || null; }

function setEntry(state, id, fields) {
  state.pages_by_id[id] = { ...(state.pages_by_id[id] || {}), ...fields };
  if (fields.path !== undefined) {
    for (const [p, eid] of Object.entries(state.path_index)) {
      if (eid === id) delete state.path_index[p];
    }
    if (fields.path) state.path_index[fields.path] = id;
  }
}

function removeEntry(state, id) {
  const entry = state.pages_by_id[id];
  if (entry?.path) delete state.path_index[entry.path];
  delete state.pages_by_id[id];
}

module.exports = {
  loadState, saveState,
  hashContent, hashFields,
  getEntryById, getIdByPath, setEntry, removeEntry,
};
