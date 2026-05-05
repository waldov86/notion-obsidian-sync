'use strict';
const { markdownToBlocks } = require('@tryfabric/martian');
const {
  VALID_STATUSES, VALID_HORIZONS, VALID_OUTCOMES, VALID_CATEGORIES,
  STATUS_ALIASES, HORIZON_ALIASES, OUTCOME_ALIASES, CATEGORY_ALIASES,
} = require('./config');
const log = require('./log');

const LOCAL_MARKER = '<!-- local: notes below this line are not synced to Notion -->';
// Keep old marker name working for existing files
const SYNC_MARKER = LOCAL_MARKER;

// Slugify a title into a filename-safe string
function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^\w\s\-]/g, '')   // strip non-word chars (incl emoji)
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);                // cap length
}

// Build filename from title only — clean human-readable names.
// Collisions are resolved by state (notion_id is identity, not filename).
function toFilename(notionId, title, existingPaths = new Set()) {
  const slug = slugify(title) || 'untitled';
  let candidate = `${slug}.md`;
  if (!existingPaths.has(candidate)) return candidate;
  // Collision: append last 6 chars of notion_id
  const suffix = notionId.replace(/-/g, '').slice(-6);
  return `${slug}-${suffix}.md`;
}

// Parse a local .md file into { notion_id, title, status, horizon, body, localNotes }
// body = synced markdown content (below H1, above local marker)
// localNotes = local-only content (below local marker)
function parseFile(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;

  const fm = {};
  for (const line of fmMatch[1].split('\n')) {
    const m = line.match(/^(\w[\w_-]*):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }

  const afterFm = fmMatch[2];

  // Split on local marker (support both old and new marker text)
  const oldMarker = '<!-- sync: content below this line is local-only and not pushed to Notion -->';
  const markerIdx = afterFm.indexOf(LOCAL_MARKER) >= 0
    ? afterFm.indexOf(LOCAL_MARKER)
    : afterFm.indexOf(oldMarker);

  const syncPart  = markerIdx >= 0 ? afterFm.slice(0, markerIdx) : afterFm;
  const localNotes = markerIdx >= 0
    ? afterFm.slice(markerIdx + (afterFm.indexOf(LOCAL_MARKER) >= 0 ? LOCAL_MARKER.length : oldMarker.length)).trim()
    : '';

  // Extract H1 title — first line of synced part
  const h1Match = syncPart.match(/^#\s+(.+)$/m);
  const title = h1Match ? h1Match[1].trim() : '';

  // Body = synced part minus the H1 line (m flag so ^ matches after \n)
  const body = syncPart.replace(/^#\s+.+\n?/m, '').trim();

  const categories = fm.category
    ? fm.category.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  return {
    notion_id:  fm.notion_id || null,
    title,
    status:     fm.status   || '',
    horizon:    fm.horizon  || '',
    outcome:    fm.outcome  || '',
    categories,
    body,
    localNotes,
  };
}

// Validate parsed fields against allowed enums.
// Returns { errors: string[], corrected: object } where corrected has case-normalised values.
// Unknown values that differ only in case are silently corrected; genuinely unknown values error.
function validateFields({ status, horizon, outcome = '', categories = [] }) {
  const errors = [];

  const correctedStatus = STATUS_ALIASES.get(status.toLowerCase()) ?? status;
  if (!VALID_STATUSES.has(correctedStatus)) {
    errors.push(`Invalid status "${status}" — allowed: ${[...VALID_STATUSES].join(', ')}`);
  }

  const correctedHorizon = HORIZON_ALIASES.get(horizon.toLowerCase()) ?? horizon;
  if (!VALID_HORIZONS.has(correctedHorizon)) {
    errors.push(`Invalid horizon "${horizon}" — allowed: ${[...VALID_HORIZONS].join(', ')}`);
  }

  const correctedOutcome = OUTCOME_ALIASES.get(outcome.toLowerCase()) ?? outcome;
  if (!VALID_OUTCOMES.has(correctedOutcome)) {
    errors.push(`Invalid outcome "${outcome}" — allowed: ${[...VALID_OUTCOMES].join(', ')}`);
  }

  const correctedCategories = categories.map(cat => {
    const canonical = CATEGORY_ALIASES.get(cat.toLowerCase()) ?? cat;
    if (!VALID_CATEGORIES.has(canonical)) {
      errors.push(`Invalid category "${cat}" — allowed: ${[...VALID_CATEGORIES].join(', ')}`);
    }
    return canonical;
  });

  return {
    errors,
    corrected: {
      status:     correctedStatus,
      horizon:    correctedHorizon,
      outcome:    correctedOutcome,
      categories: correctedCategories,
    },
  };
}

// Convert body markdown to Notion blocks
function bodyToBlocks(body) {
  if (!body || !body.trim()) return [];
  try {
    return markdownToBlocks(body);
  } catch (err) {
    log.error('markdownToBlocks failed', { err: err.message });
    return [];
  }
}

// Render a local .md file from a Notion item
function renderFile({ notion_id, title, status, horizon, outcome = '', categories = [], body = '', localNotes = '' }) {
  const bodySection = body ? `\n\n${body}` : '';
  const notes = localNotes
    ? `\n\n${LOCAL_MARKER}\n${localNotes}`
    : `\n\n${LOCAL_MARKER}`;
  return [
    '---',
    `notion_id: ${notion_id}`,
    `status: ${status}`,
    `horizon: ${horizon || ''}`,
    `outcome: ${outcome || ''}`,
    `category: ${categories.join(', ')}`,
    `last_synced_at: ${new Date().toISOString()}`,
    '---',
    '',
    `# ${title}`,
    bodySection,
    notes,
    '',
  ].join('\n');
}

module.exports = { slugify, toFilename, parseFile, validateFields, renderFile, bodyToBlocks, LOCAL_MARKER, SYNC_MARKER };
