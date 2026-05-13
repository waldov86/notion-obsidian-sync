'use strict';
const fs      = require('fs');
const path    = require('path');
const chokidar = require('chokidar');
const lockfile = require('proper-lockfile');

const config   = require('./config');
const log      = require('./log');
const stateLib = require('./state');
const notion   = require('./notion');
const { toFilename, parseFile, validateFields, renderFile, bodyToBlocks, slugify } = require('./convert');
const { injectSyncError, clearSyncError } = require('./index-helpers');
const { rebuildKanban } = require('./kanban');

const http       = require('http');
const heartbeat  = require('./heartbeat');
const deadletter = require('./deadletter');

const DRY_RUN = process.argv.includes('--dry-run');

// ── Lockfile helpers ──────────────────────────────────────────────────────────
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function clearStaleLock(lockBase) {
  const lockDir = lockBase + '.lock';
  try {
    // proper-lockfile uses a companion .lock directory containing a 'pid' file
    const pidFile = require('path').join(lockDir, 'pid');
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (!isNaN(pid) && isProcessAlive(pid)) return; // still running, don't clear
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
let pollInFlight = false;

// ── Helpers ───────────────────────────────────────────────────────────────────
function absPath(relPath) { return path.join(config.LOCAL_ROOT, relPath); }
function toRelPath(absP)   { return path.relative(config.LOCAL_ROOT, absP); }
function isTrackedFile(relPath) {
  if (!relPath.endsWith('.md'))        return false;
  if (relPath === 'kanban.md')         return false;
  if (relPath.startsWith('.archive/')) return false;
  if (relPath.startsWith('.'))         return false;
  return true;
}

// Collect all filenames currently in state (used for collision detection)
function existingPaths() {
  return new Set(Object.values(state.pages_by_id).map(e => e.path).filter(Boolean));
}

// ── Write a local file (with suppression) ─────────────────────────────────────
function writeLocal(relPath, fields) {
  const abs = absPath(relPath);
  // Preserve local notes if file already exists
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
  const dest = path.join(config.ARCHIVE_DIR, path.basename(relPath));
  const final = fs.existsSync(dest)
    ? dest.replace(/\.md$/, `-${Date.now()}.md`)
    : dest;
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

  // Derive title: from parsed H1, or from filename if no frontmatter yet
  const title = (parsed?.title || path.basename(relPath, '.md').replace(/-/g, ' ')).trim();
  if (!title) { log.warn('createLocal skipped: no title', { relPath }); return; }

  // If already has a notion_id (race with poll), skip
  if (parsed?.notion_id) return;

  const status     = parsed?.status     || 'Backlog';
  const horizon    = parsed?.horizon    || 'Now';
  const outcome    = parsed?.outcome    || '';
  const categories = parsed?.categories || [];
  const body       = parsed?.body       || '';

  // Validate fields before creating in Notion — auto-corrects case variants, errors on unknown values
  const { errors, corrected } = validateFields({ status, horizon, outcome, categories });
  if (errors.length) {
    log.error('createLocal rejected: invalid fields', { relPath, errors });
    // Store with path so the startup retry loop can find and retry this file
    stateLib.setEntry(state, relPath, { path: relPath, sync_status: 'error', last_error: errors.join('; ') });
    stateLib.saveState(state);
    // Surface the error visibly in the file's local-notes section
    const raw2 = fs.readFileSync(abs, 'utf8');
    suppress(relPath);
    fs.writeFileSync(abs, injectSyncError(raw2, errors.join('; ')), 'utf8');
    return;
  }
  // Apply any case corrections back to variables used below
  Object.assign({ status, horizon, outcome, categories }, corrected);
  const { status: cs, horizon: ch, outcome: co, categories: cc } = corrected;

  // Dedup: check if a Notion page with this title already exists (any status)
  // Prevents duplicate cards when Claude re-creates a local file for a completed task.
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
    // Remove the orphan local file so it doesn't keep triggering this check
    suppress(relPath);
    try { fs.unlinkSync(absPath(relPath)); } catch {}
    return;
  }

  if (DRY_RUN) {
    console.log(`[DRY-RUN] create in Notion: "${title}" (${relPath})`);
    return;
  }

  // Suppress the file before the async API call so a concurrent poll doesn't
  // overwrite it while we're waiting for Notion to respond.
  suppress(relPath, 15000);
  deadletter.recordAttempt(relPath, abs);

  let page;
  try {
    page = await notion.createPage({ title, status: cs, horizon: ch, outcome: co, categories: cc, body });
  } catch (err) {
    log.error('createLocal: Notion createPage failed', { relPath, err: err.message });
    deadletter.recordError(relPath, err.message);
    return;
  }

  deadletter.recordSuccess(relPath);
  const notionId = page.id;
  // Rename file to canonical slug if name differs
  const canonicalRel = toFilename(notionId, title, existingPaths());
  const targetRel    = canonicalRel !== relPath && !fs.existsSync(absPath(canonicalRel))
    ? canonicalRel
    : relPath;

  suppress(relPath);
  if (targetRel !== relPath) suppress(targetRel);

  // Delete the original file first if renaming, so writeLocal isn't clobbered by a
  // subsequent renameSync moving the original on top of the notion_id-enriched file.
  if (targetRel !== relPath && fs.existsSync(abs)) {
    fs.unlinkSync(abs);
  }

  const fields = { title, status: cs, horizon: ch, outcome: co, categories: cc, body };
  writeLocal(targetRel, { notion_id: notionId, ...fields });

  stateLib.setEntry(state, notionId, {
    path:               targetRel,
    title,
    status:             cs,
    horizon:            ch,
    outcome:            co,
    categories:         cc,
    body,
    remote_last_edited: page.last_edited_time,
    local_hash:         stateLib.hashFields({ title, status: cs, horizon: ch, outcome: co, categories: cc, body }),
    sync_status:        'clean',
    last_error:         null,
  });
  stateLib.saveState(state);
  suppress('__kanban__');
  rebuildKanban(state, lastDoneTitles);
  log.info('+ created in Notion', { relPath: targetRel, notionId, title });
}

// ── Pull one Notion item to local (fetches body blocks too) ───────────────────
async function pullItem(notionId, fields, relPath) {
  if (DRY_RUN) {
    console.log(`[DRY-RUN] pull "${fields.title}" → ${relPath}`);
    return;
  }
  // Race guard: skip pull if createLocal has suppressed this file (still in flight).
  if (isSuppressed(relPath)) {
    log.info('pullItem skipped: file suppressed by createLocal in flight', { relPath, notionId });
    return;
  }
  const body = await notion.fetchPageBody(notionId);
  writeLocal(relPath, { notion_id: notionId, ...fields, body });
  stateLib.setEntry(state, notionId, {
    path:               relPath,
    title:              fields.title,
    status:             fields.status,
    horizon:            fields.horizon,
    outcome:            fields.outcome,
    categories:         fields.categories,
    body,
    remote_last_edited: fields.remoteLastEdited,
    local_hash:         stateLib.hashFields({ ...fields, body }),
    sync_status:        'clean',
    last_error:         null,
  });
  stateLib.saveState(state);
  log.info('← pull', { relPath, notionId });
}

// ── Push local changes to Notion ──────────────────────────────────────────────
async function pushLocal(relPath) {
  const notionId = stateLib.getIdByPath(state, relPath);
  if (!notionId) {
    log.warn('Push skipped: no notion_id in state for file', { relPath });
    return;
  }

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
    // Surface the error visibly in the file's local-notes section
    suppress(relPath);
    fs.writeFileSync(abs, injectSyncError(fs.readFileSync(abs, 'utf8'), errors.join('; ')), 'utf8');
    return;
  }

  // If case corrections were made, rewrite the file frontmatter so disk matches what we'll push
  const needsCorrection = corrected.status !== parsed.status
    || corrected.horizon !== parsed.horizon
    || corrected.outcome !== parsed.outcome
    || JSON.stringify(corrected.categories) !== JSON.stringify(parsed.categories);
  if (needsCorrection) {
    log.info('Push: correcting case variants in frontmatter', { relPath, corrected });
    const rewritten = renderFile({ ...parsed, ...corrected });
    suppress(relPath);
    fs.writeFileSync(abs, rewritten, 'utf8');
    Object.assign(parsed, corrected);
  }

  const newHash = stateLib.hashFields(parsed);
  const entry   = stateLib.getEntryById(state, notionId);
  if (entry?.local_hash === newHash) {
    log.info('Push skipped: no change', { relPath });
    return;
  }

  if (DRY_RUN) {
    console.log(`[DRY-RUN] push "${parsed.title}" → Notion ${notionId}`);
    return;
  }

  deadletter.recordAttempt(relPath, abs);
  try {
    const updatedPage = await notion.updatePageFields(notionId, {
      title:      parsed.title,
      status:     parsed.status,
      horizon:    parsed.horizon,
      outcome:    parsed.outcome,
      categories: parsed.categories,
    });

    // Push body blocks if body changed
    const prevBody = entry?.body || '';
    if (parsed.body !== prevBody) {
      const blocks = bodyToBlocks(parsed.body);
      await notion.updatePageBody(notionId, blocks);
    }

    // Capture the new remote timestamp so the next poll doesn't see a spurious conflict
    const newRemoteLastEdited = updatedPage?.last_edited_time
      || await notion.fetchLastEditedTime(notionId);

    // Clear any visible sync-error comment now that push succeeded
    const currentContent = fs.readFileSync(abs, 'utf8');
    const cleared = clearSyncError(currentContent);
    if (cleared !== currentContent) {
      suppress(relPath);
      fs.writeFileSync(abs, cleared, 'utf8');
    }

    deadletter.recordSuccess(relPath);
    stateLib.setEntry(state, notionId, {
      title:              parsed.title,
      status:             parsed.status,
      horizon:            parsed.horizon,
      outcome:            parsed.outcome,
      categories:         parsed.categories,
      body:               parsed.body,
      local_hash:         newHash,
      remote_last_edited: newRemoteLastEdited,
      sync_status:        'clean',
      last_error:         null,
    });
    stateLib.saveState(state);
    log.info('→ push', { relPath, notionId, title: parsed.title });
  } catch (err) {
    log.error('Push failed', { relPath, notionId, err: err.message });
    deadletter.recordError(relPath, err.message);
    stateLib.setEntry(state, notionId, { sync_status: 'error', last_error: err.message });
    stateLib.saveState(state);
  }
}

// ── Parse kanban.md and push status changes to Notion ────────────────────────
// skipIds: Set of notion IDs pulled for the first time this poll cycle — exclude
// from drop detection since the kanban hasn't been rebuilt to include them yet.
async function syncKanbanToNotion(skipIds = new Set()) {
  if (!fs.existsSync(config.KANBAN_PATH)) return;
  const raw = fs.readFileSync(config.KANBAN_PATH, 'utf8');

  // Safety: count active items in state before parsing the kanban
  const activeInState = Object.values(state.pages_by_id).filter(
    e => e.sync_status !== 'archived' && (e.status === 'Backlog' || e.status === 'In progress')
  ).length;

  // Column heading prefix → Notion status
  const COLUMN_STATUS = {
    '📥 Backlog':     'Backlog',
    '🔄 In Progress': 'In progress',
    '✅ Done':        'Done',
  };

  const changes = [];
  const newCards = [];
  let currentStatus = null;
  const kanbanFilenames = new Set(); // filenames present in Backlog + In Progress

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

    // Match checked or unchecked wikilink cards: - [ ] [[filename|title]] or - [ ] [[filename]]
    const linkMatch = line.match(/^- \[.?\] \[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
    if (linkMatch) {
      const filename = path.basename(linkMatch[1].trim()) + '.md';
      const title    = (linkMatch[2] || path.basename(linkMatch[1])).trim();
      // Track filenames seen in active columns (not Done — those are already archived)
      if (currentStatus !== 'Done') kanbanFilenames.add(filename);
      const notionId = stateLib.getIdByPath(state, filename);

      if (!notionId) {
        // Card exists in kanban but not in state — new card added via UI
        // Skip Done column: entries there are already-archived items, not new cards
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

    // Match plain-text cards (no wikilink): - [ ] Some title
    const plainMatch = line.match(/^- \[.?\] (.+)/);
    if (plainMatch && currentStatus !== 'Done') {
      const title    = plainMatch[1].trim();
      const filename = slugify(title) + '.md';
      if (!stateLib.getIdByPath(state, filename) && !fs.existsSync(absPath(filename))) {
        newCards.push({ filename, title, status: currentStatus });
      }
    }
  }

  // Safety: if kanban has zero active items but state has active items, the file
  // is corrupted (Obsidian race, truncation, etc.) — bail out entirely.
  if (kanbanFilenames.size === 0 && activeInState > 0) {
    log.warn('SAFETY: kanban has 0 active items but state has active items — skipping sync to avoid wipeout', {
      activeInState,
    });
    return;
  }

  // Detect active items removed from the kanban → mark as Done/Dropped in Notion
  const dropActions = [];
  for (const [id, entry] of Object.entries(state.pages_by_id)) {
    if (entry.sync_status === 'archived') continue;
    if (entry.status !== 'Backlog' && entry.status !== 'In progress') continue;
    if (!entry.path) continue;
    if (skipIds.has(id)) continue; // newly pulled this cycle — kanban not rebuilt yet
    const filename = path.basename(entry.path);
    if (!kanbanFilenames.has(filename)) {
      dropActions.push({ notionId: id, relPath: entry.path, entry });
    }
  }

  // Safety: abort drop pass if it would affect more than 5 items AND more than
  // 50% of the active board — protects against corrupted kanban triggering mass drops.
  if (dropActions.length > 5 && dropActions.length > kanbanFilenames.size) {
    log.warn('SAFETY: catastrophic drop detected — aborting drop pass', {
      dropCount:   dropActions.length,
      boardSize:   kanbanFilenames.size,
      activeInState,
    });
    // Still process status changes and new cards; just skip the drops.
    if (changes.length === 0 && newCards.length === 0) return;
    // Fall through with empty dropActions effectively (splice them out)
    dropActions.length = 0;
  }

  if (changes.length === 0 && newCards.length === 0 && dropActions.length === 0) return;

  // Create local files for new kanban cards and push to Notion
  for (const { filename, title, status } of newCards) {
    log.info('kanban → new card detected, creating local file', { filename, title, status });
    if (DRY_RUN) {
      console.log(`[DRY-RUN] kanban new card: "${title}" → ${filename}`);
      continue;
    }
    const abs = absPath(filename);
    suppress(filename);  // prevent chokidar 'add' from double-processing this file
    fs.writeFileSync(abs, [
      '---',
      `status: ${status}`,
      'horizon: Now',
      'outcome:',
      'category:',
      '---',
      '',
      `# ${title}`,
      '',
    ].join('\n'), 'utf8');
    await createLocal(filename).catch(err =>
      log.error('kanban new card createLocal error', { filename, err: err.message })
    );
  }

  for (const { notionId, filename, newStatus, entry } of changes) {
    log.info('kanban → push status', { filename, from: entry.status, to: newStatus, notionId });
    if (DRY_RUN) {
      console.log(`[DRY-RUN] kanban status: ${filename} ${entry.status} → ${newStatus}`);
      continue;
    }
    try {
      await notion.updatePageFields(notionId, { status: newStatus });

      // Update the local .md file's status frontmatter field
      const abs = absPath(filename);
      if (fs.existsSync(abs)) {
        const parsed = parseFile(fs.readFileSync(abs, 'utf8'));
        if (parsed) {
          suppress(filename);
          fs.writeFileSync(abs, renderFile({ ...parsed, status: newStatus }), 'utf8');
        }
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

  // Mark dropped items as Done/Dropped in Notion, archive local file
  for (const { notionId, relPath, entry } of dropActions) {
    log.info('kanban → item removed, marking Done/Dropped', { relPath, notionId, title: entry.title });
    if (DRY_RUN) {
      console.log(`[DRY-RUN] kanban drop: "${entry.title}" → Done/Dropped`);
      continue;
    }
    try {
      await notion.updatePageFields(notionId, { status: 'Done', outcome: 'Dropped' });
      archiveLocal(relPath);
      stateLib.setEntry(state, notionId, {
        status:      'Done',
        outcome:     'Dropped',
        sync_status: 'archived',
        path:        null,
        archived_path: relPath,
      });
      stateLib.saveState(state);
      log.info('kanban → dropped', { relPath, notionId, title: entry.title });
    } catch (err) {
      log.error('kanban drop failed', { relPath, notionId, err: err.message });
      stateLib.setEntry(state, notionId, { sync_status: 'error', last_error: err.message });
      stateLib.saveState(state);
    }
  }

  // Rebuild from updated state; suppress so this write doesn't re-trigger the watcher
  suppress('__kanban__');
  rebuildKanban(state, lastDoneTitles);
}

// ── Poll Notion ───────────────────────────────────────────────────────────────
async function poll() {
  pollInFlight = true;
  try {
    return await _poll();
  } finally {
    pollInFlight = false;
  }
}

async function _poll() {
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
      // Look up archived_path from state so kanban can render a wikilink
      const entry = stateLib.getEntryById(state, p.id);
      const archivedPath = entry?.archived_path || entry?.path;
      const filename = archivedPath ? path.basename(archivedPath, '.md') : null;
      return { title: fields.title, filename };
    });
  } catch (err) {
    log.warn('queryDoneItems failed, using cached value', { err: err.message });
  }

  const remoteIds = new Set(remoteItems.map(p => p.id));

  // Archive items that left scope
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

  // Process each in-scope item
  const newlyPulledIds = new Set(); // IDs seen for the first time this poll cycle
  for (const page of remoteItems) {
    const notionId = page.id;
    const fields   = notion.extractFields(page);
    const entry    = stateLib.getEntryById(state, notionId);

    if (!entry) {
      // New item — create local file
      const relPath = toFilename(notionId, fields.title, existingPaths());
      if (DRY_RUN) { console.log(`[DRY-RUN] create ${relPath} "${fields.title}"`); continue; }
      await pullItem(notionId, fields, relPath);
      newlyPulledIds.add(notionId);
    } else {
      // Known item — check if remote changed since last sync
      if (entry.remote_last_edited === fields.remoteLastEdited) continue;
      if (isSuppressed(entry.path)) continue;

      // Item may have been archived and re-entered scope (e.g. status restored)
      if (!entry.path) {
        const relPath = toFilename(notionId, fields.title, existingPaths());
        if (DRY_RUN) { console.log(`[DRY-RUN] re-pull archived item ${relPath} "${fields.title}"`); continue; }
        stateLib.setEntry(state, notionId, { sync_status: 'clean' });
        await pullItem(notionId, fields, relPath);
        newlyPulledIds.add(notionId);
        continue;
      }

      // Conflict check: if local also changed since last sync, pick most recent change
      const abs = absPath(entry.path);
      if (fs.existsSync(abs)) {
        const parsed = parseFile(fs.readFileSync(abs, 'utf8'));
        if (parsed) {
          const localHash = stateLib.hashFields(parsed);
          if (localHash !== entry.local_hash) {
            // Both sides changed — compare timestamps to pick the winner
            const localMtime   = fs.statSync(abs).mtimeMs;
            const remoteTimeMs = new Date(fields.remoteLastEdited).getTime();
            if (localMtime > remoteTimeMs) {
              // Local is newer — push local, skip pull
              log.warn('Conflict: local wins (newer mtime)', { relPath: entry.path, notionId });
              const relPath = entry.path;
              if (!DRY_RUN) await pushLocal(relPath);
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

  if (!isFirstPoll) await syncKanbanToNotion(newlyPulledIds);
  isFirstPoll = false;
  suppress('__kanban__');
  rebuildKanban(state, lastDoneTitles);
  heartbeat.touch();
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
  log.info(`todos-notion-sync starting${DRY_RUN ? ' [DRY-RUN]' : ''}`);

  fs.mkdirSync(config.LOCAL_ROOT, { recursive: true });
  fs.mkdirSync(config.ARCHIVE_DIR, { recursive: true });

  if (!DRY_RUN) {
    const lockBase = config.LOCK_PATH;
    // Clear stale lock from a previous crashed process before attempting to acquire
    clearStaleLock(lockBase);
    if (!fs.existsSync(lockBase)) fs.writeFileSync(lockBase, '');
    try {
      lockfile.lockSync(lockBase);
    } catch {
      process.stderr.write('Another instance is already running. Exiting.\n');
      process.exit(1);
    }

    // Release lock cleanly on shutdown so the next start isn't blocked
    function releaseLock() {
      try { lockfile.unlockSync(lockBase); } catch { /* best-effort */ }
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

  // One-time rename of existing files to clean names
  await renameToCleanFilenames();

  // Retry any files that were stuck in sync_status: error — fixes files broken by
  // previously invalid enum values without requiring a manual touch on each file
  for (const [id, entry] of Object.entries(state.pages_by_id)) {
    if (entry.sync_status === 'error' && entry.path) {
      log.info('Startup retry: retrying previously errored file', { path: entry.path, lastError: entry.last_error });
      // If the state key is a path (not a notion UUID), the file was never created in Notion — use createLocal
      const isLocalOnly = !id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      const retryFn = isLocalOnly ? createLocal : pushLocal;
      await retryFn(entry.path).catch(err =>
        log.error('Startup retry error', { path: entry.path, err: err.message })
      );
    }
  }

  await poll();

  if (DRY_RUN) {
    log.info('Dry-run complete, exiting');
    process.exit(0);
  }

  log.info('Startup complete. Watching for changes.');

  const watcher = chokidar.watch(config.LOCAL_ROOT, {
    ignored: [
      /(^|[/\\])\../,
      /\.archive\//,
    ],
    persistent:     true,
    ignoreInitial:  true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  watcher.on('change', absP => {
    const rel = toRelPath(absP);
    if (!isTrackedFile(rel) || isSuppressed(rel)) return;
    // If file has no state entry yet, it was never synced — treat as a new create
    const fn = stateLib.getIdByPath(state, rel) ? pushLocal : createLocal;
    debounce(rel, () => fn(rel).catch(err => log.error('watcher change error', { rel, err: err.message })));
  });

  watcher.on('add', absP => {
    const rel = toRelPath(absP);
    if (!isTrackedFile(rel) || isSuppressed(rel)) return;
    // Skip if already tracked in state (e.g. just pulled from Notion)
    if (stateLib.getIdByPath(state, rel)) return;
    // Suppress immediately so any concurrent poll doesn't overwrite the file
    // while createLocal is waiting for the Notion API response.
    suppress(rel, 15000);
    debounce(`add:${rel}`, async () => {
      // Check if the new file has a notion_id already tracked under a different path.
      // This happens when Obsidian renames a file (e.g. inline kanban title edit):
      // it creates a new file with the new name instead of editing the existing one.
      const abs = absPath(rel);
      if (!fs.existsSync(abs)) return;
      const parsed = parseFile(fs.readFileSync(abs, 'utf8'));
      if (parsed?.notion_id) {
        const existingEntry = stateLib.getEntryById(state, parsed.notion_id);
        if (existingEntry && existingEntry.sync_status === 'archived') {
          // File was previously archived but has been re-added to todos/ (e.g. marked Done locally
          // after the daemon archived the old copy). Re-register it so pushLocal can find it.
          log.info('Archived item re-added to todos/, re-registering', { rel, notionId: parsed.notion_id });
          stateLib.setEntry(state, parsed.notion_id, { sync_status: 'clean', path: rel, archived_path: null });
          stateLib.saveState(state);
          await pushLocal(rel).catch(err => log.error('resurrection push error', { rel, err: err.message }));
          return;
        }
        if (existingEntry && existingEntry.path && existingEntry.path !== rel) {
          log.info('Rename detected via new file with existing notion_id', {
            from: existingEntry.path, to: rel, notionId: parsed.notion_id,
          });
          // Remove the old file if it exists and is now empty or stale
          const oldAbs = absPath(existingEntry.path);
          if (fs.existsSync(oldAbs)) {
            const oldContent = fs.readFileSync(oldAbs, 'utf8').trim();
            if (!oldContent || oldContent.length < 10) {
              suppress(existingEntry.path);
              fs.unlinkSync(oldAbs);
              log.info('Removed stale old file after rename', { path: existingEntry.path });
            }
          }
          // Update state to point to the new path
          stateLib.setEntry(state, parsed.notion_id, { path: rel });
          stateLib.saveState(state);
          // Push the new title to Notion
          await pushLocal(rel).catch(err => log.error('rename push error', { rel, err: err.message }));
          return;
        }
      }
      createLocal(rel).catch(err => log.error('watcher add error', { rel, err: err.message }));
    }, 1000);
  });

  setInterval(async () => {
    heartbeat.check(log);
    if (pollInFlight) { log.info('Scheduled poll skipped: poll already in flight'); return; }
    try { await poll(); }
    catch (err) { log.error('Poll error', { err: err.message }); }
  }, config.POLL_INTERVAL_MS);

  // HTTP trigger server — allows external callers (e.g. Cloudflare Tunnel + n8n) to kick off an immediate poll
  const triggerServer = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/trigger-poll') {
      res.writeHead(200); res.end('ok');
      if (pollInFlight) { log.info('Triggered poll skipped: poll already in flight'); return; }
      log.info('Poll triggered via HTTP');
      try { await poll(); } catch (err) { log.error('Triggered poll error', { err: err.message }); }
    } else {
      res.writeHead(404); res.end();
    }
  });
  triggerServer.listen(config.TRIGGER_PORT, '127.0.0.1', () => log.info(`Trigger server listening on 127.0.0.1:${config.TRIGGER_PORT}`));
}

main().catch(err => {
  process.stderr.write(`FATAL: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
