'use strict';
const fs    = require('fs');
const https = require('https');
const { Client } = require('@notionhq/client');
const { NotionToMarkdown } = require('notion-to-md');
const { TOKEN_PATH, DB_ID, DATA_SOURCE_ID } = require('./config');
const log = require('./log');

let token;
let notionClient;
let n2m;

function initNotion() {
  token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  notionClient = new Client({ auth: token });
  n2m = new NotionToMarkdown({ notionClient });
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.notion.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'Notion-Version': '2022-06-28',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (res.statusCode >= 400) {
            reject(new Error(`Notion API ${res.statusCode}: ${parsed.message || raw.slice(0, 200)}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Non-JSON response (${res.statusCode}): ${raw.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Validate that DB has expected Status and Horizon properties
async function validateSchema() {
  // Use REST to get the DB (via the standard v1 endpoint with the DB ID)
  const db = await request('GET', `/v1/databases/${DB_ID}`);
  // properties may be empty in newer API responses; do a soft check
  const props = db.properties || {};
  if (Object.keys(props).length > 0) {
    if (!props.Status) throw new Error('Notion DB missing "Status" property');
    if (!props.Horizon) throw new Error('Notion DB missing "Horizon" property');
    log.info('Schema valid', { statusType: props.Status?.type, horizonType: props.Horizon?.type });
  } else {
    // Newer API format — properties not returned in retrieve; do a test query to validate
    log.info('Schema check: properties not in retrieve response, doing test query');
    const testResult = await request('POST', `/v1/databases/${DB_ID}/query`, {
      page_size: 1,
      filter: { property: 'Status', status: { equals: 'Backlog' } },
    });
    if (testResult.object === 'error') {
      throw new Error(`Schema test query failed: ${testResult.message}`);
    }
    log.info('Schema valid via test query');
  }
}

// Query all in-scope items (Status = Backlog or In progress) with pagination
async function queryInScopeItems() {
  const items  = [];
  let cursor;

  do {
    const body = {
      page_size: 100,
      filter: {
        or: [
          { property: 'Status', status: { equals: 'Backlog' } },
          { property: 'Status', status: { equals: 'In progress' } },
        ],
      },
    };
    if (cursor) body.start_cursor = cursor;

    const result = await request('POST', `/v1/databases/${DB_ID}/query`, body);
    items.push(...result.results);
    cursor = result.has_more ? result.next_cursor : null;
  } while (cursor);

  return items;
}

// Query the 10 most recently edited Done items (sorted by last_edited_time)
// Note: sorted by last_edited_time — no Completed at property in this DB.
// Recently-edited Done items may float above more recently completed ones.
async function queryDoneItems(limit = 10) {
  const result = await request('POST', `/v1/databases/${DB_ID}/query`, {
    page_size: limit,
    filter: { property: 'Status', status: { equals: 'Done' } },
    sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
  });
  return result.results;
}

// Extract sync-relevant fields from a Notion page object
function extractFields(page) {
  const titleParts = page.properties.Name?.title || [];
  const title      = titleParts.map(t => t.plain_text).join('').trim() || 'Untitled';
  const status     = page.properties.Status?.status?.name  || '';
  const horizon    = page.properties.Horizon?.select?.name || '';
  const outcome    = page.properties.Outcome?.select?.name || '';
  const categories = (page.properties.Category?.multi_select || []).map(o => o.name);
  return { title, status, horizon, outcome, categories, remoteLastEdited: page.last_edited_time };
}

// Update a Notion page's title, status, horizon, outcome, and/or category
// Returns the updated page object (includes last_edited_time)
async function updatePageFields(pageId, { title, status, horizon, outcome, categories }) {
  const properties = {};

  if (title !== undefined) {
    properties.Name = { title: [{ type: 'text', text: { content: title } }] };
  }
  if (status !== undefined) {
    properties.Status = { status: { name: status } };
  }
  if (horizon !== undefined) {
    properties.Horizon = horizon ? { select: { name: horizon } } : { select: null };
  }
  if (outcome !== undefined) {
    properties.Outcome = outcome ? { select: { name: outcome } } : { select: null };
  }
  if (categories !== undefined) {
    properties.Category = { multi_select: categories.map(name => ({ name })) };
  }

  return request('PATCH', `/v1/pages/${pageId}`, { properties });
}

// Fetch just the last_edited_time for a page (used after push to update state)
async function fetchLastEditedTime(pageId) {
  const page = await request('GET', `/v1/pages/${pageId}`);
  return page.last_edited_time;
}

// Fetch the body of a Notion page as markdown (excluding title)
async function fetchPageBody(pageId) {
  try {
    const mdBlocks = await n2m.pageToMarkdown(pageId);
    const result   = n2m.toMarkdownString(mdBlocks);
    const raw      = typeof result === 'string' ? result : (result.parent || '');
    // Strip leading H1 — notion2md sometimes emits the page title as the first heading
    // Trim first so leading newlines don't prevent the match
    const body     = raw.trim().replace(/^#[^\n]*\n?/, '').trim();
    return body;
  } catch (err) {
    log.warn('fetchPageBody failed', { pageId, err: err.message });
    return '';
  }
}

// Replace the body blocks of a Notion page
async function updatePageBody(pageId, blocks) {
  // Clear existing blocks
  let cursor;
  do {
    const resp = await notionClient.blocks.children.list({ block_id: pageId, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const block of resp.results) {
      await notionClient.blocks.delete({ block_id: block.id }).catch(() => {});
    }
    cursor = resp.has_more ? resp.next_cursor : null;
  } while (cursor);

  // Append new blocks in chunks of 100
  for (let i = 0; i < blocks.length; i += 100) {
    await notionClient.blocks.children.append({ block_id: pageId, children: blocks.slice(i, i + 100) });
  }
}

// Create a new page in the Notion DB; returns the new page object
async function createPage({ title, status = 'Backlog', horizon = 'Now', outcome = '', categories = [], body = '' }) {
  const properties = {
    Name:   { title: [{ type: 'text', text: { content: title } }] },
    Status: { status: { name: status } },
  };
  if (horizon)    properties.Horizon  = { select: { name: horizon } };
  if (outcome)    properties.Outcome  = { select: { name: outcome } };
  if (categories?.length) {
    properties.Category = { multi_select: categories.map(name => ({ name })) };
  }

  const page = await request('POST', '/v1/pages', {
    parent:     { database_id: DB_ID },
    properties,
  });

  if (body) {
    const { markdownToBlocks } = require('@tryfabric/martian');
    const blocks = markdownToBlocks(body).slice(0, 100);
    if (blocks.length) {
      await notionClient.blocks.children.append({ block_id: page.id, children: blocks });
      // Body append bumps last_edited_time — fetch the final timestamp so callers
      // can store it and avoid a spurious conflict on the next poll
      const updated = await request('GET', `/v1/pages/${page.id}`);
      return updated;
    }
  }

  return page;
}

module.exports = { initNotion, validateSchema, queryInScopeItems, queryDoneItems, extractFields, updatePageFields, fetchLastEditedTime, fetchPageBody, updatePageBody, createPage };
