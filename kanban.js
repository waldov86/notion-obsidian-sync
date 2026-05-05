'use strict';
const fs   = require('fs');
const path = require('path');
const { KANBAN_PATH } = require('./config');
const log = require('./log');

// Horizon rank for Backlog ordering: Now=0, Later=1, anything else=2
function horizonRank(horizon) {
  if (horizon === 'Now')   return 0;
  if (horizon === 'Later') return 1;
  return 2;
}

function rebuildKanban(state, doneTitles = []) {
  const backlogEntries = [];
  const inProgress = [];

  for (const [, entry] of Object.entries(state.pages_by_id)) {
    if (entry.sync_status === 'archived') continue;
    if (!entry.path || !entry.title) continue;

    const filename = path.basename(entry.path, '.md');
    const link = `[[AI-projects-personal/todos/${filename}|${entry.title}]]`;

    if (entry.status === 'In progress') {
      inProgress.push({ link, title: entry.title, lastEdited: entry.remote_last_edited || '' });
    } else if (entry.status === 'Backlog') {
      backlogEntries.push({ link, title: entry.title, rank: horizonRank(entry.horizon), lastEdited: entry.remote_last_edited || '', path: entry.path });
    }
  }

  backlogEntries.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    // Within same horizon: most recently edited first
    return b.lastEdited.localeCompare(a.lastEdited);
  });

  inProgress.sort((a, b) => b.lastEdited.localeCompare(a.lastEdited));

  const toCards     = entries => entries.map(e => `- [ ] ${e.link}`).join('\n') || '';
  // Done items: use wikilink if we have the archived filename, else plain title
  const toDoneCards = items => items.map(item => {
    const card = item.filename ? `[[AI-projects-personal/todos/${item.filename}|${item.title}]]` : item.title;
    return `- [ ] ${card}`;
  }).join('\n') || '';

  const sections = [
    `## 📥 Backlog\n\n${toCards(backlogEntries)}`,
    `## 🔄 In Progress\n\n${toCards(inProgress)}`,
    `## ✅ Done (last 10)\n\n${toDoneCards(doneTitles)}`,
  ];

  const content = [
    '---',
    'kanban-plugin: board',
    '---',
    '',
    '<!-- AUTO-GENERATED — do not edit. To change a task status, edit its status: field in todos/<filename>.md -->',
    '',
    sections.join('\n\n\n'),
    '',
    '',
    '%% kanban:settings',
    '```',
    '{"kanban-plugin":"board","metadata-keys":[{"metadataKey":"category","label":"","shouldHideLabel":true,"containsMarkdown":false}]}',
    '```',
    '%%',
    '',
  ].join('\n');

  try {
    fs.mkdirSync(path.dirname(KANBAN_PATH), { recursive: true });
    fs.writeFileSync(KANBAN_PATH, content, 'utf8');
    log.info('kanban.md rebuilt', {
      backlog:    backlogEntries.length,
      inProgress: inProgress.length,
      done:       doneTitles.length,
    });
  } catch (err) {
    log.error('Failed to write kanban.md', { err: err.message });
  }
}

module.exports = { rebuildKanban };
