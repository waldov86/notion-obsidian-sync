'use strict';
const { LOCAL_MARKER } = require('./convert');

const SYNC_ERROR_RE = /<!--\s*sync-error:.*?-->\n?/g;

function injectSyncError(content, errorMsg) {
  const markerIdx = content.indexOf(LOCAL_MARKER);
  if (markerIdx === -1) {
    return content.trimEnd() + '\n\n' + LOCAL_MARKER + '\n' +
      `<!-- sync-error: ${errorMsg} Fix the frontmatter and save to retry. -->\n`;
  }
  const before = content.slice(0, markerIdx + LOCAL_MARKER.length);
  const after  = content.slice(markerIdx + LOCAL_MARKER.length).replace(SYNC_ERROR_RE, '');
  const errorLine = `\n<!-- sync-error: ${errorMsg} Fix the frontmatter and save to retry. -->`;
  return before + errorLine + (after.startsWith('\n') ? after : '\n' + after);
}

function clearSyncError(content) {
  return content.replace(SYNC_ERROR_RE, '');
}

module.exports = { injectSyncError, clearSyncError };
