'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execSync } = require('child_process');
const deadletter = require('./deadletter');

const HEARTBEAT_DIR  = path.join(os.homedir(), '.cache/todos-notion-sync');
const HEARTBEAT_FILE = path.join(HEARTBEAT_DIR, 'heartbeat');
const STALE_MS       = 30 * 60 * 1000; // 30 minutes

let alertSent = false; // avoid flooding; reset on recovery

function touch() {
  fs.mkdirSync(HEARTBEAT_DIR, { recursive: true });
  fs.writeFileSync(HEARTBEAT_FILE, String(Date.now()), 'utf8');
  if (alertSent) {
    alertSent = false;
    sendTelegram('✅ todos-notion-sync is healthy again (heartbeat recovered)').catch(() => {});
  }
}

function check(log) {
  if (!fs.existsSync(HEARTBEAT_FILE)) return; // first run, no heartbeat yet
  const last = parseInt(fs.readFileSync(HEARTBEAT_FILE, 'utf8').trim(), 10);
  if (isNaN(last)) return;
  const ageMs = Date.now() - last;
  if (ageMs > STALE_MS && !alertSent) {
    alertSent = true;
    const ageMin = Math.round(ageMs / 60000);
    const dead = deadletter.getFailedFiles(3);
    const deadInfo = dead.length > 0 ? `\n💀 ${dead.length} file(s) in dead-letter state: ${dead.map(f => f.file_path).join(', ')}` : '';
    const msg = `⚠️ todos-notion-sync: no successful sync in ${ageMin} min. Tasks may be stuck in ~/todos/ unsynced.${deadInfo}`;
    if (log) log.warn('Heartbeat stale — sending Telegram alert', { ageMin, deadLetterCount: dead.length });
    sendTelegram(msg).catch(() => {});
  }
  // Also alert on dead-letter files even when heartbeat is healthy
  const dead = deadletter.getFailedFiles(3);
  if (dead.length > 0 && !alertSent) {
    const msg = `💀 todos-notion-sync: ${dead.length} file(s) stuck in dead-letter state (≥3 failed sync attempts):\n${dead.map(f => `• ${f.file_path}: ${f.last_error || 'unknown error'}`).join('\n')}`;
    if (log) log.warn('Dead-letter files detected', { count: dead.length, files: dead.map(f => f.file_path) });
    sendTelegram(msg).catch(() => {});
  }
}

async function sendTelegram(text) {
  let token, chatId;
  try {
    token  = execSync('security find-generic-password -s "telegram-bot-token" -w', { stdio: ['pipe','pipe','pipe'] }).toString().trim();
    chatId = execSync('security find-generic-password -s "telegram-chat-id" -w',   { stdio: ['pipe','pipe','pipe'] }).toString().trim();
  } catch {
    // Keychain unavailable — try env vars (e.g. in CI or non-GUI launchd sessions)
    token  = process.env.TELEGRAM_BOT_TOKEN;
    chatId = process.env.TELEGRAM_CHAT_ID;
  }
  if (!token || !chatId) return; // no credentials available, fail silently

  const url  = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });

  // Use native fetch (Node 18+)
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
}

module.exports = { touch, check };
