'use strict';
// Native Steam Workshop browser for DayZ: search/sort/tag filtering by scraping the public browse page for item ids
// (in result order), then enriching through the public GetPublishedFileDetails API. No Steam API key needed.
const settings = require('./settings');
const mods = require('./mods');

const BROWSE = 'https://steamcommunity.com/workshop/browse/';
const DETAILS = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
const HEADERS = { 'Accept-Language': 'en', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DayZServerTool' };
const SORTS = { trend: 'trend', recent: 'mostrecent', updated: 'lastupdated', subscribers: 'totaluniquesubscribers', top: 'toprated' };
const TAGS = ['Mod', 'Server', 'Animals', 'Character', 'Environment', 'Equipment', 'Map', 'Mechanics', 'Sounds', 'Structures', 'Textures', 'UI', 'Vehicle', 'Weapons', 'Scripts', 'Misc'];

const cache = new Map(); // key -> { at, data }
const detailCache = new Map(); // id -> { at, data }
const TTL = 10 * 60 * 1000;

function stripBB(s) {
  return String(s || '')
    .replace(/\[img\][^[]*\[\/img\]/gi, '')
    .replace(/\[url=([^\]]+)\]([^[]*)\[\/url\]/gi, '$2 ($1)')
    .replace(/\[\/?(b|i|u|h1|h2|h3|list|olist|code|quote|spoiler|strike|table|tr|th|td|hr|noparse|img|url)[^\]]*\]/gi, '')
    .replace(/\[\*\]/g, '• ')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchDetails(ids) {
  ids = [...new Set(ids.map(String))];
  const now = Date.now();
  const missing = ids.filter(id => !detailCache.has(id) || now - detailCache.get(id).at > TTL);
  for (let i = 0; i < missing.length; i += 50) {
    const batch = missing.slice(i, i + 50);
    const body = new URLSearchParams();
    body.set('itemcount', String(batch.length));
    batch.forEach((id, k) => body.set(`publishedfileids[${k}]`, id));
    const res = await fetch(DETAILS, { method: 'POST', body });
    if (!res.ok) throw new Error(`Steam API HTTP ${res.status}`);
    const json = await res.json();
    for (const d of (json.response && json.response.publishedfiledetails) || []) {
      if (d.result !== 1) continue;
      detailCache.set(String(d.publishedfileid), { at: now, data: {
        id: String(d.publishedfileid), title: d.title, description: stripBB(d.description).slice(0, 4000), preview: d.preview_url || null,
        size: Number(d.file_size || 0), created: Number(d.time_created || 0) * 1000, updated: Number(d.time_updated || 0) * 1000,
        subscriptions: Number(d.subscriptions || 0), lifetimeSubscriptions: Number(d.lifetime_subscriptions || 0), favorited: Number(d.favorited || 0), views: Number(d.views || 0),
        tags: (d.tags || []).map(t => t.tag), creator: d.creator || null, banned: !!d.banned
      } });
    }
  }
  return ids.map(id => detailCache.has(id) ? detailCache.get(id).data : null).filter(Boolean);
}

// Search the workshop. Returns items in Steam's order plus paging info.
async function search({ query = '', sort = 'trend', tags = [], page = 1, perPage = 30 } = {}) {
  const key = JSON.stringify({ query, sort, tags, page });
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const params = new URLSearchParams({ appid: String(settings.load().workshopAppId || 221100), searchtext: query, browsesort: SORTS[sort] || 'trend', section: 'readytouseitems', actualsort: SORTS[sort] || 'trend', p: String(page), numperpage: String(perPage) });
  for (const t of tags) params.append('requiredtags[]', t);
  const res = await fetch(`${BROWSE}?${params}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Steam Workshop HTTP ${res.status}`);
  const html = await res.text();
  const ids = [...new Set([...html.matchAll(/filedetails\/\?id=(\d+)/g)].map(m => m[1]))];
  const totalMatch = html.match(/of\s+([\d,.]+)\s+entries/i);
  const total = totalMatch ? Number(totalMatch[1].replace(/[,.]/g, '')) : null;
  const details = ids.length ? await fetchDetails(ids) : [];
  const byId = Object.fromEntries(details.map(d => [d.id, d]));
  const items = ids.map(id => byId[id]).filter(Boolean);
  const data = { items: decorate(items), page, perPage, total, hasMore: ids.length >= perPage, query, sort, tags };
  cache.set(key, { at: Date.now(), data });
  return data;
}

// Mark which results are already in the mod list.
function decorate(items) {
  const have = new Set(settings.load().mods.map(m => m.id));
  return items.map(it => ({ ...it, added: have.has(it.id) }));
}

async function details(id) {
  const [d] = await fetchDetails([String(id)]);
  if (!d) throw new Error('Workshop item not found (private, removed, or wrong ID).');
  const required = await mods.fetchRequiredItems(id);
  const reqDetails = required.length ? await fetchDetails(required) : [];
  return { ...decorate([d])[0], required: decorate(reqDetails) };
}

// Resolve a pasted collection URL/ID to its items.
async function collection(id) {
  const res = await fetch(`https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`, { headers: HEADERS });
  const html = await res.text();
  const block = html.match(/class="collectionChildren"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/);
  const ids = [...new Set([...(block ? block[0] : html).matchAll(/sharedfiles\/filedetails\/\?id=(\d+)/g)].map(m => m[1]))].filter(x => x !== String(id));
  return decorate(await fetchDetails(ids));
}

module.exports = { search, details, collection, fetchDetails, TAGS, SORTS: Object.keys(SORTS) };
