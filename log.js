'use strict';
const fs   = require('fs');
const path = require('path');
const { LOG_PATH } = require('./config');

const LOG_MAX_BYTES = 5 * 1024 * 1024;

function rotateLogs() {
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    const { size } = fs.statSync(LOG_PATH);
    if (size < LOG_MAX_BYTES) return;
    const bak1 = LOG_PATH + '.1';
    const bak2 = LOG_PATH + '.2';
    if (fs.existsSync(bak2)) fs.unlinkSync(bak2);
    if (fs.existsSync(bak1)) fs.renameSync(bak1, bak2);
    fs.renameSync(LOG_PATH, bak1);
  } catch { /* rotation failure is non-fatal */ }
}

function write(level, msg, meta = {}) {
  rotateLogs();
  const entry = { ts: new Date().toISOString(), level, msg, ...meta };
  const line  = JSON.stringify(entry) + '\n';
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line);
  } catch { /* log failure must not crash daemon */ }
  if (level === 'error') process.stderr.write(line);
  else if (process.env.DEBUG) process.stdout.write(line);
}

module.exports = {
  info:  (msg, meta) => write('info',  msg, meta),
  warn:  (msg, meta) => write('warn',  msg, meta),
  error: (msg, meta) => write('error', msg, meta),
};
