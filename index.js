'use strict';
const fs       = require('fs');
const path     = require('path');
const http     = require('http');
const chokidar = require('chokidar');
const lockfile = require('proper-lockfile');

const config   = require('./config');
const log      = require('./log');
const stateLib = require('./state');
const notion   = require('./notion');
const { toFilename, parseFile, validateFields, renderFile, bodyToBlocks, slugify } = require('./convert');
const { injectSyncError, clearSyncError } = require('./index-helpers');
const { rebuildKanban } = require('./kanban');

const DRY_RUN = process.argv.includes('--dry-run');

// ── Lockfile helpers ──────────────────────────────────────────────────────────
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function clearStaleLock(lockBase) {
  const lockDir = lockBase + '.lock';
  try {
    const pidFile = path.join(lockDir, 'pid');
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (!isNaN(pid) && isProcessAlive(pid)) return;
    }
    if (fs.existsSync(lockDir)) {
      fs.rmSync(lockDir, { recursive: true, force: true });
      process.stderr.write(`Cleared stale lockfile: ${lockDir}\n`);
    }
  } catch { /* best-effort */ }
}

// ── Self-write suppression ────────────────────────────────────────────────────
const suppressTokens = new Map();
function suppress(relPath, ttlMs = 3000) {
  clearTimeout(suppressTokens.get(relPath));
  suppressTokens.set(relPath, setTimeout(() => suppressTokens.delete(relPath), ttlMs));
}
function isSuppressed(relPath) { return suppressTokens.has(relPath); }

// ── Debounce ──────────────────────────────────────────────────────────────────
const debounceTimers = new Map();
function debounce(key, fn, ms = 500) {
  clearTimeout(debounceTimers.get(key));
  debounceTimers.set(key, setTimeout(() => { debounceTimers.delete(key); fn(); }, ms));
}

// ── State ─────────────────────────────────────────────────────────────────────
let state;
let lastDoneTitles = [];
let isFirstPoll = true;

// ── Helpers ───────────────────────────────────────────────────────────────────
function absPath(relPath) { return path.join(config.LOCAL_ROOT, relPath); }
function toRelPath(absP)  { return path.relative(config.LOCAL_ROOT, absP); }

function isTrackedFile(relPath) {
  if (!relPath.endsWith('.md'))        return false;
  if (relPath === 'kanban.md')         return false;
  if (relPath.startsWith('.archive/')) return false;
  if (relPath.startsWith('.'))         return false;
  return true;
}

function existingPaths() {
  return new Set(Object.values(state.pages_by_id).map(e => e.path).filter(Boolean));
}

// ── Write a local file (with suppression) ─────────────────────────────────────
function writeLocal(relPath, fields) {
  const abs = absPath(relPath);
  let localNotes = '';
  if (fs.existsSync(abs)) {
    const parsed = parseFile(fs.readFileSync(abs, 'utf8'));
    if (parsed) localNotes = parsed.localNotes || '';
  }
  suppress(relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, renderFile({ ...fields, localNotes }), 'utf8');
}

// ── Archive a local file ──────────────────────────────────────────────────────
function archiveLocal(relPath) {
  const abs = absPath(relPath);
  if (!fs.existsSync(abs)) return;
  fs.mkdirSync(config.ARCHIVE_DIR, { recursive: true });
  const dest  = path.join(config.ARCHIVE_DIR, path.basename(relPath));
  const final = fs.existsSync(dest) ? dest.replace(/\.md$/, `-${Date.now()}.md`) : dest;
  suppress(relPath);
  fs.renameSync(abs, final);
  log.info('Archived local file', { relPath, dest: final });
}

// ── Create a new Notion page from a local file that has no notion_id ─────────
async function createLocal(relPath) {
  const abs = absPath(relPath);
  if (!fs.existsSync(abs)) return;

  const raw    = fs.readFileSync(abs, 'utf8');
  const parsed = parseFile(raw);

  const title = (parsed?.title || path.basename(relPath, '.md').replace(/-/g, ' ')).trim();
  if (!title) { log.warn('createLocal skipped: no title', { relPath }); return; }
  if (parsed?.notion_id) return;

  const status     = parsed?.status     || 'Backlog';
  const horizon    = parsed?.horizon    || 'Now';
  const outcome    = parsed?.outcome    || '';
  const categories = parsed?.categories || [];
  const body       = parsed?.body       || '';

  const { errors, corrected } = validateFields({ status, horizon, outcome, categories });
  if (errors.length) {
    log.error('createLocal rejected: invalid fields', { relPath, errors });
    stateLib.setEntry(state, relPath, { sync_status: 'error', last_error: errors.join('; ') });
    const raw2 = fs.readFileSync(abs, 'utf8');
    suppress(relPath);
    fs.writeFileSync(abs, injectSyncError(raw2, errors.join('; ')), 'utf8');
    return;
  }
  Object.assign({ status, horizon, outcome, categories }, corrected);
  const { status: cs, horizon: ch, outcome: co, categories: cc } = corrected;

  // Dedup: skip if a Notion page with this title already exists
  const titleLower = title.toLowerCase();
  const titleSlug  = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const duplicate  = Object.values(state.pages_by_id).find(e => {
    if (!e.title) return false;
    const eSlug = e.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return e.title.toLowerCase() === titleLower || eSlug === titleSlug;
  });
  if (duplicate) {
    log.warn('createLocal skipped: Notion page with same title already exists', {
      relPath, title, existingId: duplicate.notion_id || '(in state)', existingStatus: duplicate.status,
    });
    suppress(relPath);
    try { fs.unlinkSync(absPath(relPath)); } catch {}
    return;
  }

  if (DRY_RUN) { console.log(`[DRY-RUN] create in Notion: "${title}" (${relPath})`); return; }

  suppress(relPath, 15000);

  let page;
  try {
    page = await notion.createPage({ title, status: cs, horizon: ch, outcome: co, categories: cc, body });
  } catch (err) {
    log.error('createLocal: Notion createPage failed', { relPath, err: err.message });
    return;
  }

  const notionId     = page.id;
  const canonicalRel = toFilename(notionId, title, existingPaths());
  const targetRel    = canonicalRel !== relPath && !fs.existsSync(absPath(canonicalRel))
    ? canonicalRel : relPath;

  suppress(relPath);
  if (targetRel !== relPath) suppress(targetRel);
  if (targetRel !== relPath && fs.existsSync(abs)) fs.unlinkSync(abs);

  const fields = { title, status: cs, horizon: ch, outcome: co, categories: cc, body };
  writeLocal(targetRel, { notion_id: notionId, ...fields });

  stateLib.setEntry(state, notionId, {
    path: targetRel, title,
    status: cs, horizon: ch, outcome: co, categories: cc, body,
    remote_last_edited: page.last_edited_time,
    local_hash:  stateLib.hashFields({ title, status: cs, horizon: ch, outcome: co, categories: cc, body }),
    sync_status: 'clean', last_error: null,
  });
  stateLib.saveState(state);
  suppress('__kanban__');
  rebuildKanban(state, lastDoneTitles);
  log.info('+ created in Notion', { relPath: targetRel, notionId, title });
}

// ── Pull one Notion item to local ─────────────────────────────────────────────
async function pullItem(notionId, fields, relPath) {
  if (DRY_RUN) { console.log(`[DRY-RUN] pull "${fields.title}" → ${relPath}`); return; }
  if (isSuppressed(relPath)) {
    log.info('pullItem skipped: file suppressed by createLocal in flight', { relPath, notionId });
    return;
  }
  const body = await notion.fetchPageBody(notionId);
  writeLocal(relPath, { notion_id: notionId, ...fields, body });
  stateLib.setEntry(state, notionId, {
    path: relPath, title: fields.title,
    status: fields.status, horizon: fields.horizon, outcome: fields.outcome, categories: fields.categories,
    body,
    remote_last_edited: fields.remoteLastEdited,
    local_hash:  stateLib.hashFields({ ...fields, body }),
    sync_status: 'clean', last_error: null,
  });
  stateLib.saveState(state);
  log.info('← pull', { relPath, notionId });
}

// ── Push local changes to Notion ──────────────────────────────────────────────
async function pushLocal(relPath) {
  const notionId = stateLib.getIdByPath(state, relPath);
  if (!notionId) { log.warn('Push skipped: no notion_id in state for file', { relPath }); return; }

  const abs = absPath(relPath);
  if (!fs.existsSync(abs)) return;

  const parsed = parseFile(fs.readFileSync(abs, 'utf8'));
  if (!parsed) { log.warn('Push skipped: could not parse file', { relPath }); return; }
  if (!parsed.notion_id || parsed.notion_id !== notionId) {
    log.warn('Push skipped: notion_id mismatch', { relPath, parsed_id: parsed.notion_id, state_id: notionId });
    return;
  }

  const { errors, corrected } = validateFields(parsed);
  if (errors.length) {
    log.error('Push rejected: invalid fields', { relPath, errors });
    stateLib.setEntry(state, notionId, { sync_status: 'error', last_error: errors.join('; ') });
    stateLib.saveState(state);
    suppress(relPath);
    fs.writeFileSync(abs, injectSyncError(fs.readFileSync(abs, 'utf8'), errors.join('; ')), 'utf8');
    return;
  }

  const needsCorrection = corrected.status     !== parsed.status
    || corrected.horizon    !== parsed.horizon
    || corrected.outcome    !== parsed.outcome
    || JSON.stringify(corrected.categories) !== JSON.stringify(parsed.categories);
  if (needsCorrection) {
    log.info('Push: correcting case variants in frontmatter', { relPath, corrected });
    suppress(relPath);
    fs.writeFileSync(abs, renderFile({ ...parsed, ...corrected }), 'utf8');
    Object.assign(parsed, corrected);
  }

  const newHash = stateLib.hashFields(parsed);
  const entry   = stateLib.getEntryById(state, notionId);
  if (entry?.local_hash === newHash) { log.info('Push skipped: no change', { relPath }); return; }

  if (DRY_RUN) { console.log(`[DRY-RUN] push "${parsed.title}" → Notion ${notionId}`); return; }

  try {
    const updatedPage = await notion.updatePageFields(notionId, {
      title: parsed.title, status: parsed.status, horizon: parsed.horizon,
      outcome: parsed.outcome, categories: parsed.categories,
    });

    const prevBody = entry?.body || '';
    if (parsed.body !== prevBody) {
      await notion.updatePageBody(notionId, bodyToBlocks(parsed.body));
    }

    const newRemoteLastEdited = updatedPage?.last_edited_time
      || await notion.fetchLastEditedTime(notionId);

    const currentContent = fs.readFileSync(abs, 'utf8');
    const cleared = clearSyncError(currentContent);
    if (cleared !== currentContent) { suppress(relPath); fs.writeFileSync(abs, cleared, 'utf8'); }

    stateLib.setEntry(state, notionId, {
      title: parsed.title, status: parsed.status, horizon: parsed.horizon,
      outcome: parsed.outcome, categories: parsed.categories, body: parsed.body,
      local_hash: newHash, remote_last_edited: newRemoteLastEdited,
      sync_status: 'clean', last_error: null,
    });
    stateLib.saveState(state);
    log.info('→ push', { relPath, notionId, title: parsed.title });
  } catch (err) {
    log.error('Push failed', { relPath, notionId, err: err.message });
    stateLib.setEntry(state, notionId, { sync_status: 'error', last_error: err.message });
    stateLib.saveState(state);
  }
}

// ── Parse kanban.md and push status changes to Notion ────────────────────────
async function syncKanbanToNotion() {
  if (!fs.existsSync(config.KANBAN_PATH)) return;
  const raw = fs.readFileSync(config.KANBAN_PATH, 'utf8');

  const activeInState = Object.values(state.pages_by_id).filter(
    e => e.sync_status !== 'archived' && (e.status === 'Backlog' || e.status === 'In progress')
  ).length;

  const COLUMN_STATUS = {
    '📥 Backlog':     'Backlog',
    '🔄 In Progress': 'In progress',
    '✅ Done':        'Done',
  };

  const changes = [];
  const newCards = [];
  let currentStatus = null;
  const kanbanFilenames = new Set();

  for (const line of raw.split('\n')) {
    const headingMatch = line.match(/^## (.+)/);
    if (headingMatch) {
      const heading = headingMatch[1].trim();
      currentStatus = null;
      for (const [col, status] of Object.entries(COLUMN_STATUS)) {
        if (heading.startsWith(col)) { currentStatus = status; break; }
      }
      continue;
    }
    if (!currentStatus) continue;

    const linkMatch = line.match(/^- \[.?\] \[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
    if (linkMatch) {
      const filename = path.basename(linkMatch[1].trim()) + '.md';
      const title    = (linkMatch[2] || path.basename(linkMatch[1])).trim();
      if (currentStatus !== 'Done') kanbanFilenames.add(filename);
      const notionId = stateLib.getIdByPath(state, filename);

      if (!notionId) {
        if (currentStatus !== 'Done' && !fs.existsSync(absPath(filename))) {
          newCards.push({ filename, title, status: currentStatus });
        }
        continue;
      }

      const entry = stateLib.getEntryById(state, notionId);
      if (!entry || entry.sync_status === 'archived') continue;
      if (entry.status === currentStatus) continue;
      changes.push({ notionId, filename, newStatus: currentStatus, entry });
      continue;
    }

    const plainMatch = line.match(/^- \[.?\] (.+)/);
    if (plainMatch && currentStatus !== 'Done') {
      const title    = plainMatch[1].trim();
      const filename = slugify(title) + '.md';
      if (!stateLib.getIdByPath(state, filename) && !fs.existsSync(absPath(filename))) {
        newCards.push({ filename, title, status: currentStatus });
      }
    }
  }

  // Safety guard: if kanban shows 0 active items but state has active items, the file
  // is likely corrupted — abort entirely to avoid a mass wipeout
  if (kanbanFilenames.size === 0 && activeInState > 0) {
    log.warn('SAFETY: kanban has 0 active items but state has active items — skipping sync to avoid wipeout', { activeInState });
    return;
  }

  const dropActions = [];
  for (const [id, entry] of Object.entries(state.pages_by_id)) {
    if (entry.sync_status === 'archived') continue;
    if (entry.status !== 'Backlog' && entry.status !== 'In progress') continue;
    if (!entry.path) continue;
    const filename = path.basename(entry.path);
    if (!kanbanFilenames.has(filename)) {
      dropActions.push({ notionId: id, relPath: entry.path, entry });
    }
  }

  // Safety guard: abort drop pass if it would affect more than 5 items AND more
  // than 50% of the active board — protects against a corrupted kanban triggering
  // a mass-drop of all active tasks
  if (dropActions.length > 5 && dropActions.length > kanbanFilenames.size) {
    log.warn('SAFETY: catastrophic drop detected — aborting drop pass', {
      dropCount: dropActions.length, boardSize: kanbanFilenames.size, activeInState,
    });
    if (changes.length === 0 && newCards.length === 0) return;
    dropActions.length = 0;
  }

  if (changes.length === 0 && newCards.length === 0 && dropActions.length === 0) return;

  for (const { filename, title, status } of newCards) {
    log.info('kanban → new card detected, creating local file', { filename, title, status });
    if (DRY_RUN) { console.log(`[DRY-RUN] kanban new card: "${title}" → ${filename}`); continue; }
    const abs = absPath(filename);
    suppress(filename);
    fs.writeFileSync(abs, ['---', `status: ${status}`, 'horizon: Now', 'outcome:', 'category:', '---', '', `# ${title}`, ''].join('\n'), 'utf8');
    await createLocal(filename).catch(err =>
      log.error('kanban new card createLocal error', { filename, err: err.message })
    );
  }

  for (const { notionId, filename, newStatus, entry } of changes) {
    log.info('kanban → push status', { filename, from: entry.status, to: newStatus, notionId });
    if (DRY_RUN) { console.log(`[DRY-RUN] kanban status: ${filename} ${entry.status} → ${newStatus}`); continue; }
    try {
      await notion.updatePageFields(notionId, { status: newStatus });
      const abs = absPath(filename);
      if (fs.existsSync(abs)) {
        const parsed = parseFile(fs.readFileSync(abs, 'utf8'));
        if (parsed) { suppress(filename); fs.writeFileSync(abs, renderFile({ ...parsed, status: newStatus }), 'utf8'); }
      }
      const newHash = stateLib.hashFields({ ...entry, status: newStatus });
      stateLib.setEntry(state, notionId, { status: newStatus, local_hash: newHash, sync_status: 'clean', last_error: null });
      stateLib.saveState(state);
      log.info('kanban → pushed', { filename, newStatus, notionId });
    } catch (err) {
      log.error('kanban push failed', { filename, notionId, err: err.message });
      stateLib.setEntry(state, notionId, { sync_status: 'error', last_error: err.message });
      stateLib.saveState(state);
    }
  }

  for (const { notionId, relPath, entry } of dropActions) {
    log.info('kanban → item removed, marking Done/Dropped', { relPath, notionId, title: entry.title });
    if (DRY_RUN) { console.log(`[DRY-RUN] kanban drop: "${entry.title}" → Done/Dropped`); continue; }
    try {
      await notion.updatePageFields(notionId, { status: 'Done', outcome: 'Dropped' });
      archiveLocal(relPath);
      stateLib.setEntry(state, notionId, {
        status: 'Done', outcome: 'Dropped', sync_status: 'archived', path: null, archived_path: relPath,
      });
      stateLib.saveState(state);
      log.info('kanban → dropped', { relPath, notionId, title: entry.title });
    } catch (err) {
      log.error('kanban drop failed', { relPath, notionId, err: err.message });
      stateLib.setEntry(state, notionId, { sync_status: 'error', last_error: err.message });
      stateLib.saveState(state);
    }
  }

  suppress('__kanban__');
  rebuildKanban(state, lastDoneTitles);
}

// ── Poll Notion ───────────────────────────────────────────────────────────────
async function poll() {
  log.info('Poll start');

  let remoteItems;
  try {
    remoteItems = await notion.queryInScopeItems();
  } catch (err) {
    log.error('Poll failed: Notion query error', { err: err.message });
    return;
  }

  try {
    const donePages = await notion.queryDoneItems(10);
    lastDoneTitles = donePages.map(p => {
      const fields = notion.extractFields(p);
      const entry  = stateLib.getEntryById(state, p.id);
      const archivedPath = entry?.archived_path || entry?.path;
      const filename = archivedPath ? path.basename(archivedPath, '.md') : null;
      return { title: fields.title, filename };
    });
  } catch (err) {
    log.warn('queryDoneItems failed, using cached value', { err: err.message });
  }

  const remoteIds = new Set(remoteItems.map(p => p.id));

  for (const [id, entry] of Object.entries(state.pages_by_id)) {
    if (entry.sync_status === 'archived') continue;
    if (!remoteIds.has(id)) {
      log.info('Item left scope, archiving', { notionId: id, path: entry.path });
      if (DRY_RUN) { console.log(`[DRY-RUN] archive ${entry.path}`); continue; }
      if (entry.path) archiveLocal(entry.path);
      stateLib.setEntry(state, id, { sync_status: 'archived', path: null, archived_path: entry.path });
      stateLib.saveState(state);
    }
  }

  for (const page of remoteItems) {
    const notionId = page.id;
    const fields   = notion.extractFields(page);
    const entry    = stateLib.getEntryById(state, notionId);

    if (!entry) {
      const relPath = toFilename(notionId, fields.title, existingPaths());
      if (DRY_RUN) { console.log(`[DRY-RUN] create ${relPath} "${fields.title}"`); continue; }
      await pullItem(notionId, fields, relPath);
    } else {
      if (entry.remote_last_edited === fields.remoteLastEdited) continue;
      if (isSuppressed(entry.path)) continue;

      // Item may have been archived and re-entered scope (e.g. status restored)
      if (!entry.path) {
        const relPath = toFilename(notionId, fields.title, existingPaths());
        if (DRY_RUN) { console.log(`[DRY-RUN] re-pull archived item ${relPath} "${fields.title}"`); continue; }
        stateLib.setEntry(state, notionId, { sync_status: 'clean' });
        await pullItem(notionId, fields, relPath);
        continue;
      }

      const abs = absPath(entry.path);
      if (fs.existsSync(abs)) {
        const parsed = parseFile(fs.readFileSync(abs, 'utf8'));
        if (parsed) {
          const localHash = stateLib.hashFields(parsed);
          if (localHash !== entry.local_hash) {
            const localMtime   = fs.statSync(abs).mtimeMs;
            const remoteTimeMs = new Date(fields.remoteLastEdited).getTime();
            if (localMtime > remoteTimeMs) {
              log.warn('Conflict: local wins (newer mtime)', { relPath: entry.path, notionId });
              if (!DRY_RUN) await pushLocal(entry.path);
              continue;
            } else {
              log.warn('Conflict: Notion wins (newer remote)', { relPath: entry.path, notionId });
            }
          }
        }
      }

      const relPath = entry.path || toFilename(notionId, fields.title, existingPaths());
      if (DRY_RUN) { console.log(`[DRY-RUN] update ${relPath} "${fields.title}"`); continue; }
      await pullItem(notionId, fields, relPath);
    }
  }

  if (!isFirstPoll) await syncKanbanToNotion();
  isFirstPoll = false;
  suppress('__kanban__');
  rebuildKanban(state, lastDoneTitles);
  log.info('Poll done', { remoteCount: remoteItems.length });
}

// ── Rename existing files to clean names ──────────────────────────────────────
async function renameToCleanFilenames() {
  const usedPaths = new Set();
  for (const [id, entry] of Object.entries(state.pages_by_id)) {
    if (!entry.path || entry.sync_status === 'archived') continue;
    const cleanName = toFilename(id, entry.title || 'untitled', usedPaths);
    usedPaths.add(cleanName);
    if (entry.path === cleanName) continue;
    const oldAbs = absPath(entry.path);
    const newAbs = absPath(cleanName);
    if (fs.existsSync(oldAbs)) {
      suppress(entry.path);
      suppress(cleanName);
      fs.renameSync(oldAbs, newAbs);
      log.info('Renamed file', { from: entry.path, to: cleanName });
    }
    stateLib.setEntry(state, id, { path: cleanName });
  }
  stateLib.saveState(state);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log.info(`notion-obsidian-sync starting${DRY_RUN ? ' [DRY-RUN]' : ''}`);

  fs.mkdirSync(config.LOCAL_ROOT,  { recursive: true });
  fs.mkdirSync(config.ARCHIVE_DIR, { recursive: true });

  if (!DRY_RUN) {
    clearStaleLock(config.LOCK_PATH);
    if (!fs.existsSync(config.LOCK_PATH)) fs.writeFileSync(config.LOCK_PATH, '');
    try {
      lockfile.lockSync(config.LOCK_PATH);
    } catch {
      process.stderr.write('Another instance is already running. Exiting.\n');
      process.exit(1);
    }

    function releaseLock() {
      try { lockfile.unlockSync(config.LOCK_PATH); } catch { /* best-effort */ }
      process.exit(0);
    }
    process.on('SIGTERM', releaseLock);
    process.on('SIGINT',  releaseLock);
  }

  try {
    state = stateLib.loadState();
  } catch (err) {
    process.stderr.write(`FATAL: ${err.message}\n`);
    process.exit(1);
  }

  notion.initNotion();
  try {
    await notion.validateSchema();
  } catch (err) {
    process.stderr.write(`FATAL schema check: ${err.message}\n`);
    process.exit(1);
  }

  await renameToCleanFilenames();

  // Retry files stuck in sync_status: error on startup
  for (const [id, entry] of Object.entries(state.pages_by_id)) {
    if (entry.sync_status === 'error' && entry.path) {
      log.info('Startup retry: retrying previously errored file', { path: entry.path, lastError: entry.last_error });
      await pushLocal(entry.path).catch(err =>
        log.error('Startup retry push error', { path: entry.path, err: err.message })
      );
    }
  }

  await poll();

  if (DRY_RUN) { log.info('Dry-run complete, exiting'); process.exit(0); }

  log.info('Startup complete. Watching for changes.');

  const watcher = chokidar.watch(config.LOCAL_ROOT, {
    ignored:          [/(^|[/\\])\../, /\.archive\//],
    persistent:       true,
    ignoreInitial:    true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  watcher.on('change', absP => {
    const rel = toRelPath(absP);
    if (!isTrackedFile(rel) || isSuppressed(rel)) return;
    debounce(rel, () => pushLocal(rel).catch(err => log.error('watcher push error', { rel, err: err.message })));
  });

  watcher.on('add', absP => {
    const rel = toRelPath(absP);
    if (!isTrackedFile(rel) || isSuppressed(rel)) return;
    if (stateLib.getIdByPath(state, rel)) return;
    suppress(rel, 15000);
    debounce(`add:${rel}`, async () => {
      const abs = absPath(rel);
      if (!fs.existsSync(abs)) return;
      const parsed = parseFile(fs.readFileSync(abs, 'utf8'));
      if (parsed?.notion_id) {
        const existingEntry = stateLib.getEntryById(state, parsed.notion_id);
        if (existingEntry && existingEntry.path && existingEntry.path !== rel && existingEntry.sync_status !== 'archived') {
          log.info('Rename detected via new file with existing notion_id', {
            from: existingEntry.path, to: rel, notionId: parsed.notion_id,
          });
          const oldAbs = absPath(existingEntry.path);
          if (fs.existsSync(oldAbs)) {
            const oldContent = fs.readFileSync(oldAbs, 'utf8').trim();
            if (!oldContent || oldContent.length < 10) {
              suppress(existingEntry.path);
              fs.unlinkSync(oldAbs);
              log.info('Removed stale old file after rename', { path: existingEntry.path });
            }
          }
          stateLib.setEntry(state, parsed.notion_id, { path: rel });
          stateLib.saveState(state);
          await pushLocal(rel).catch(err => log.error('rename push error', { rel, err: err.message }));
          return;
        }
      }
      createLocal(rel).catch(err => log.error('watcher add error', { rel, err: err.message }));
    }, 1000);
  });

  setInterval(async () => {
    try { await poll(); }
    catch (err) { log.error('Poll error', { err: err.message }); }
  }, config.POLL_INTERVAL_MS);

  // HTTP trigger endpoint — POST /trigger-poll kicks off an immediate poll.
  // Useful for webhook integrations (e.g. expose via Cloudflare Tunnel + n8n).
  const triggerServer = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/trigger-poll') {
      res.writeHead(200); res.end('ok');
      log.info('Poll triggered via HTTP');
      try { await poll(); } catch (err) { log.error('Triggered poll error', { err: err.message }); }
    } else {
      res.writeHead(404); res.end();
    }
  });
  triggerServer.listen(config.TRIGGER_PORT, '127.0.0.1', () =>
    log.info(`Trigger server listening on 127.0.0.1:${config.TRIGGER_PORT}`)
  );
}

main().catch(err => {
  process.stderr.write(`FATAL: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
