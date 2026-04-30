'use strict';
const fs    = require('fs');
const https = require('https');
const { Client } = require('@notionhq/client');
const { NotionToMarkdown } = require('notion-to-md');
const { DB_ID, readToken } = require('./config');
const log = require('./log');

let token;
let notionClient;
let n2m;

function initNotion() {
  token = readToken();
  notionClient = new Client({ auth: token });
  n2m = new NotionToMarkdown({ notionClient });
}

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.notion.com',
      path: urlPath,
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

// Validate that the DB has the expected Status and Horizon properties
async function validateSchema() {
  const db = await request('GET', `/v1/databases/${DB_ID}`);
  const props = db.properties || {};
  if (Object.keys(props).length > 0) {
    if (!props.Status)  throw new Error('Notion DB missing "Status" property');
    if (!props.Horizon) throw new Error('Notion DB missing "Horizon" property');
    log.info('Schema valid', { statusType: props.Status?.type, horizonType: props.Horizon?.type });
  } else {
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
  const items = [];
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

// Query the N most recently edited Done items
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
async function updatePageFields(pageId, { title, status, horizon, outcome, categories }) {
  const properties = {};
  if (title      !== undefined) properties.Name     = { title: [{ type: 'text', text: { content: title } }] };
  if (status     !== undefined) properties.Status   = { status: { name: status } };
  if (horizon    !== undefined) properties.Horizon  = horizon ? { select: { name: horizon } } : { select: null };
  if (outcome    !== undefined) properties.Outcome  = outcome ? { select: { name: outcome } } : { select: null };
  if (categories !== undefined) properties.Category = { multi_select: categories.map(name => ({ name })) };
  return request('PATCH', `/v1/pages/${pageId}`, { properties });
}

async function fetchLastEditedTime(pageId) {
  const page = await request('GET', `/v1/pages/${pageId}`);
  return page.last_edited_time;
}

async function fetchPageBody(pageId) {
  try {
    const mdBlocks = await n2m.pageToMarkdown(pageId);
    const result   = n2m.toMarkdownString(mdBlocks);
    const raw      = typeof result === 'string' ? result : (result.parent || '');
    const body     = raw.trim().replace(/^#[^\n]*\n?/, '').trim();
    return body;
  } catch (err) {
    log.warn('fetchPageBody failed', { pageId, err: err.message });
    return '';
  }
}

async function updatePageBody(pageId, blocks) {
  let cursor;
  do {
    const resp = await notionClient.blocks.children.list({ block_id: pageId, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const block of resp.results) {
      await notionClient.blocks.delete({ block_id: block.id }).catch(() => {});
    }
    cursor = resp.has_more ? resp.next_cursor : null;
  } while (cursor);

  for (let i = 0; i < blocks.length; i += 100) {
    await notionClient.blocks.children.append({ block_id: pageId, children: blocks.slice(i, i + 100) });
  }
}

async function createPage({ title, status = 'Backlog', horizon = 'Now', outcome = '', categories = [], body = '' }) {
  const properties = {
    Name:   { title: [{ type: 'text', text: { content: title } }] },
    Status: { status: { name: status } },
  };
  if (horizon)          properties.Horizon  = { select: { name: horizon } };
  if (outcome)          properties.Outcome  = { select: { name: outcome } };
  if (categories?.length) properties.Category = { multi_select: categories.map(name => ({ name })) };

  const page = await request('POST', '/v1/pages', {
    parent:     { database_id: DB_ID },
    properties,
  });

  if (body) {
    const { markdownToBlocks } = require('@tryfabric/martian');
    const blocks = markdownToBlocks(body).slice(0, 100);
    if (blocks.length) {
      await notionClient.blocks.children.append({ block_id: page.id, children: blocks });
      const updated = await request('GET', `/v1/pages/${page.id}`);
      return updated;
    }
  }
  return page;
}

module.exports = {
  initNotion, validateSchema,
  queryInScopeItems, queryDoneItems,
  extractFields, updatePageFields,
  fetchLastEditedTime, fetchPageBody, updatePageBody,
  createPage,
};
