'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');

const DB_DIR  = path.join(os.homedir(), '.cache/todos-notion-sync');
const DB_PATH = path.join(DB_DIR, 'state.db');

let _db = null;

function db() {
  if (_db) return _db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      file_path    TEXT PRIMARY KEY,
      file_hash    TEXT,
      last_attempt TEXT,
      last_success TEXT,
      fail_count   INTEGER DEFAULT 0,
      last_error   TEXT
    )
  `);
  return _db;
}

function hashFile(absPath) {
  try {
    return crypto.createHash('md5').update(fs.readFileSync(absPath)).digest('hex');
  } catch { return null; }
}

function recordAttempt(relPath, absPath) {
  const hash = hashFile(absPath);
  const now  = new Date().toISOString();
  const existing = db().prepare('SELECT * FROM sync_state WHERE file_path = ?').get(relPath);
  if (existing) {
    db().prepare(`
      UPDATE sync_state SET file_hash=?, last_attempt=?, fail_count=fail_count+1
      WHERE file_path=?
    `).run(hash, now, relPath);
  } else {
    db().prepare(`
      INSERT INTO sync_state (file_path, file_hash, last_attempt, fail_count)
      VALUES (?, ?, ?, 1)
    `).run(relPath, hash, now);
  }
}

function recordSuccess(relPath) {
  const now = new Date().toISOString();
  db().prepare(`
    INSERT INTO sync_state (file_path, last_success, fail_count, last_error)
    VALUES (?, ?, 0, NULL)
    ON CONFLICT(file_path) DO UPDATE SET last_success=?, fail_count=0, last_error=NULL
  `).run(relPath, now, now);
}

function recordError(relPath, error) {
  const now = new Date().toISOString();
  db().prepare(`
    INSERT INTO sync_state (file_path, last_attempt, fail_count, last_error)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(file_path) DO UPDATE SET last_attempt=?, fail_count=fail_count+1, last_error=?
  `).run(relPath, now, error, now, error);
}

function clearEntry(relPath) {
  db().prepare('DELETE FROM sync_state WHERE file_path = ?').run(relPath);
}

// Returns files with fail_count >= threshold
function getFailedFiles(threshold = 3) {
  return db().prepare('SELECT * FROM sync_state WHERE fail_count >= ?').all(threshold);
}

// CLI: node deadletter.js --status
function printStatus() {
  const all = db().prepare('SELECT * FROM sync_state ORDER BY fail_count DESC, last_attempt DESC').all();
  if (all.length === 0) { console.log('No tracked files in dead-letter journal.'); return; }
  console.log('\n=== todos-notion-sync: sync state journal ===\n');
  for (const row of all) {
    const flag = row.fail_count >= 3 ? '❌' : row.last_success ? '✅' : '⏳';
    console.log(`${flag} ${row.file_path}`);
    console.log(`   attempts: ${row.fail_count}  last_attempt: ${row.last_attempt || '—'}  last_success: ${row.last_success || 'never'}`);
    if (row.last_error) console.log(`   error: ${row.last_error}`);
  }
  const dead = all.filter(r => r.fail_count >= 3);
  if (dead.length) console.log(`\n⚠️  ${dead.length} file(s) in dead-letter state (fail_count ≥ 3)`);
}

module.exports = { recordAttempt, recordSuccess, recordError, clearEntry, getFailedFiles, printStatus };

if (require.main === module && process.argv.includes('--status')) {
  printStatus();
}
