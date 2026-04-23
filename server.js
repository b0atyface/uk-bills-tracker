const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');
const pdfParse = require('pdf-parse');
const db = require('./db');

// Generate a PNG icon on-the-fly: dark bg, yellow circle, no npm image libs needed.
function makePng(size) {
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const b of buf) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0); }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const t = Buffer.from(type, 'ascii');
    const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([t, d])));
    return Buffer.concat([len, t, d, crcBuf]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const cx = size / 2, cy = size / 2, r = size * 0.36;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const inCircle = (x-cx)*(x-cx) + (y-cy)*(y-cy) <= r*r;
      row[1+x*3] = inCircle ? 255 : 10;
      row[2+x*3] = inCircle ? 214 : 10;
      row[3+x*3] = inCircle ? 0   : 10;
    }
    rows.push(row);
  }
  const idat = zlib.deflateSync(Buffer.concat(rows), { level: 1 });
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',ihdr), chunk('IDAT',idat), chunk('IEND',Buffer.alloc(0))]);
}

const PORT = process.env.PORT || 3457;
const ROOT = __dirname;

try {
  const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  env.split('\n').forEach((line) => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  });
} catch {}

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
if (!ANTHROPIC_KEY) console.warn('⚠︎  ANTHROPIC_API_KEY not set — /api/summary will fail');
const TWFY_KEY = process.env.TWFY_API_KEY || '';
if (!TWFY_KEY) console.warn('⚠︎  TWFY_API_KEY not set — /api/mp-statements will fail');
const ADMIN_KEY = process.env.ADMIN_KEY || '';

// Simple in-memory rate limiter for AI endpoints — max 20 calls per IP per hour.
const _aiRateLimitMap = new Map();
function checkAiRateLimit(ip) {
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const e = _aiRateLimitMap.get(ip) || { count: 0, reset: now + HOUR };
  if (now > e.reset) { e.count = 0; e.reset = now + HOUR; }
  e.count++;
  _aiRateLimitMap.set(ip, e);
  return e.count <= 20;
}

const DATA_DIR = path.join(ROOT, 'data');
const SUMMARIES_FILE = path.join(DATA_DIR, 'summaries.json');
const SUBSCRIBERS_FILE = path.join(DATA_DIR, 'subscribers.json');
const RSS_ITEMS_FILE = path.join(DATA_DIR, 'rss-items.json');
const MP_VOTES_FILE = path.join(DATA_DIR, 'mp-votes.json');
const POLLS_FILE = path.join(DATA_DIR, 'polls.json');
const PULSE_FILE = path.join(DATA_DIR, 'pulse.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const PARTY_COLORS = [
  ['labour', '#E4003B'],
  ['conservative', '#0087DC'],
  ['liberal democrat', '#FAA61A'],
  ['lib dem', '#FAA61A'],
  ['scottish national', '#FDF38E'],
  ['snp', '#FDF38E'],
  ['green', '#6AB023'],
  ['reform', '#12B6CF'],
  ['plaid cymru', '#005B54'],
  ['dup', '#D46A4C'],
  ['democratic unionist', '#D46A4C'],
  ['sdlp', '#2AA82C'],
  ['sinn', '#326760'],
  ['alliance', '#F6CB2F'],
  ['independent', '#6B6B6B'],
  ['speaker', '#333333'],
];

function partyColor(name) {
  const n = (name || '').toLowerCase();
  const match = PARTY_COLORS.find(([k]) => n.includes(k));
  return match ? match[1] : '#6B6B6B';
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'uk-bills-tracker/1.0', Accept: 'application/json' } }, (up) => {
        let data = '';
        up.on('data', (c) => (data += c));
        up.on('end', () => {
          if (up.statusCode && up.statusCode >= 400) return reject(new Error(`HTTP ${up.statusCode}`));
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      })
      .on('error', reject);
  });
}

function getBuffer(url) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects = 5) => {
      https
        .get(u, { headers: { 'User-Agent': 'uk-bills-tracker/1.0' } }, (up) => {
          if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location && redirects > 0) {
            up.resume();
            return get(up.headers.location, redirects - 1);
          }
          if (up.statusCode >= 400) return reject(new Error(`HTTP ${up.statusCode}`));
          const chunks = [];
          up.on('data', (c) => chunks.push(c));
          up.on('end', () => resolve(Buffer.concat(chunks)));
        })
        .on('error', reject);
    };
    get(url);
  });
}

// Fetches the latest published Bill PDF text. Returns '' if none available yet.
async function getBillText(billId) {
  try {
    const pubs = await getJson(`https://bills-api.parliament.uk/api/v1/Bills/${encodeURIComponent(billId)}/Publications`);
    const all = pubs.publications || [];
    const bills = all.filter((p) => ((p.publicationType || {}).name || '').toLowerCase() === 'bill');
    const pool = bills.length ? bills : all;
    pool.sort((a, b) => new Date(b.displayDate || 0) - new Date(a.displayDate || 0));
    for (const p of pool) {
      const files = p.files || [];
      const pdfFile = files.find((f) => (f.contentType || '').toLowerCase().includes('pdf'));
      if (!pdfFile || !p.id || !pdfFile.id) continue;
      const buf = await getBuffer(`https://bills-api.parliament.uk/api/v1/Publications/${p.id}/Documents/${pdfFile.id}/Download`);
      const data = await pdfParse(buf);
      let text = (data.text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
      if (text.length > 18000) text = text.slice(0, 18000) + '\n\n[TRUNCATED — bill text longer than token budget allows]';
      if (text.length > 500) return text;
    }
  } catch (e) {
    console.warn('getBillText failed:', e.message);
  }
  return '';
}

// Summaries are now backed by Postgres (with file fallback via db.js).
// loadSummaries() stays synchronous — db.js keeps an in-memory copy.
function loadSummaries() { return db.getSummaries(); }
function saveSummaries(s) {
  // Legacy bulk-save — used only when the whole object is mutated.
  // Prefer upsertSummary(billId, data) for individual writes.
  Object.entries(s).forEach(([id, data]) => {
    db.upsertSummary(id, data, SUMMARIES_FILE).catch(() => {});
  });
}

function loadRssItems() {
  try { return JSON.parse(fs.readFileSync(RSS_ITEMS_FILE, 'utf8')); } catch { return { items: [], cached_at: null }; }
}
function saveRssItems(d) {
  try { fs.writeFileSync(RSS_ITEMS_FILE, JSON.stringify(d)); } catch {}
}
async function getOrFetchRssItems() {
  const cache = loadRssItems();
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  if (cache.cached_at && (Date.now() - new Date(cache.cached_at).getTime()) < TWO_HOURS) return cache.items;
  const feeds = await Promise.allSettled(RSS_FEEDS.map(fetchRss));
  const items = [], seen = new Set();
  feeds.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      r.value.forEach((item) => {
        if (!seen.has(item.url)) { seen.add(item.url); items.push({ ...item, source: RSS_FEEDS[i].source }); }
      });
    }
  });
  saveRssItems({ items, cached_at: new Date().toISOString() });
  return items;
}

function claudeCall(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (up) => {
        let data = '';
        up.on('data', (c) => (data += c));
        up.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Civil-society sources we trust to surface real concerns about UK legislation.
// Progressive-leaning advocacy watchdogs — matches the app's skeptical editorial stance.
const TRUSTED_SOURCES = [
  'libertyhumanrights.org.uk',
  'bigbrotherwatch.org.uk',
  'stonewall.org.uk',
  'mermaidsuk.org.uk',
  'transactual.org.uk',
  'goodlawproject.org',
  'openrightsgroup.org',
  'privacyinternational.org',
  'amnesty.org.uk',
  'shelter.org.uk',
  'hansardsociety.org.uk',
  'lawsociety.org.uk',
  'stop-watch.org',
  'inquest.org.uk',
  'runnymedetrust.org',
  'disabilityrightsuk.org',
  'refugeecouncil.org.uk',
  'parliament.uk',
];

// ---- Pulse: curated UK political news sources ----
const PULSE_FEEDS = [
  { url: 'https://www.theguardian.com/politics/rss',     source: 'The Guardian' },
  { url: 'https://www.politicshome.com/news/rss.xml',    source: 'Politics Home' },
  { url: 'https://novaramedia.com/feed/',                source: 'Novara Media' },
  { url: 'https://bylinetimes.com/feed/',                source: 'Byline Times' },
  { url: 'https://www.newstatesman.com/feeds/all',       source: 'New Statesman' },
  { url: 'https://declassifieduk.org/feed/',             source: 'Declassified UK' },
  { url: 'https://tribunemag.co.uk/feed',                source: 'Tribune' },
  { url: 'https://thecanary.co/feed/',                   source: 'The Canary' },
  { url: 'https://leftfootforward.org/feed/',            source: 'Left Foot Forward' },
];

const PULSE_MUST_INCLUDE = [
  'labour', 'conservative', 'tory', 'tories', 'reform uk', 'reform party',
  'liberal democrat', 'lib dem', 'green party', 'snp', 'plaid cymru',
  'starmer', 'badenoch', 'farage', 'ed davey', 'polanski',
  'prime minister', 'chancellor', 'home secretary', 'foreign secretary',
  'downing street', 'whitehall', 'general election', 'by-election',
  'pmqs', 'parliament', 'westminster', 'shadow cabinet', 'cabinet minister',
  'the government', 'opposition party', 'budget', 'spending review',
];

const PULSE_BLOCKLIST = [
  'football', 'premier league', 'fa cup', 'transfer window', 'match report',
  'cricket', 'rugby', 'six nations', 'wimbledon', 'formula 1', ' f1 ', 'grand prix',
  'boxing match', 'ufc', 'olympic', 'strictly come', 'bafta', 'brit award',
  'x factor', 'reality tv', 'celebrity gossip', 'restaurant review', 'travel guide',
  'recipe', 'horoscope',
];

// ---- RSS news sources (international + independent UK focus) ----
const RSS_FEEDS = [
  { url: 'https://www.politicshome.com/news/rss.xml',                  source: 'Politics Home' },
  { url: 'https://novaramedia.com/feed/',                               source: 'Novara Media' },
  { url: 'https://declassifieduk.org/feed/',                            source: 'Declassified UK' },
  { url: 'https://bylinetimes.com/feed/',                               source: 'Byline Times' },
  { url: 'https://www.newstatesman.com/feeds/all',                     source: 'New Statesman' },
  { url: 'https://www.politico.eu/feed/',                               source: 'POLITICO Europe' },
  { url: 'https://tribunemag.co.uk/feed',                              source: 'Tribune' },
  { url: 'https://thecanary.co/feed/',                                  source: 'The Canary' },
];

function fetchRss(feed) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout')), 8000);
    const get = (u, redirects = 4) => {
      const mod = u.startsWith('https') ? https : require('http');
      mod.get(u, { headers: { 'User-Agent': 'uk-bills-tracker/1.0', Accept: 'application/rss+xml, application/atom+xml, text/xml, */*' } }, (up) => {
        if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location && redirects > 0) {
          up.resume(); return get(up.headers.location, redirects - 1);
        }
        if (up.statusCode >= 400) { clearTimeout(timeout); return reject(new Error(`HTTP ${up.statusCode}`)); }
        let xml = '';
        up.setEncoding('utf8');
        up.on('data', (c) => { xml += c; if (xml.length > 500000) up.destroy(); });
        up.on('end', () => { clearTimeout(timeout); resolve(parseRss(xml)); });
      }).on('error', (e) => { clearTimeout(timeout); reject(e); });
    };
    get(feed.url);
  });
}

function parseRss(xml) {
  const items = [];
  const blocks = (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []).concat(xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || []);
  for (const block of blocks) {
    const tag = (name) => {
      const re = new RegExp(`<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${name}>`, 'i');
      const m = block.match(re); return m ? m[1].trim() : null;
    };
    const attr = (pat, a) => { const m = block.match(new RegExp(`<${pat}[^>]+${a}=["']([^"']+)["']`, 'i')); return m ? m[1] : null; };

    const headline = stripHtml(tag('title') || '');
    const rawLink = tag('link') || attr('link', 'href') || '';
    const url = rawLink.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    if (!headline || !url) continue;

    const rawDesc = tag('content:encoded') || tag('description') || tag('summary') || tag('content') || '';
    const body = stripHtml(rawDesc).replace(/\s+/g, ' ').trim().slice(0, 800);
    const summary = body.slice(0, 160);

    const image_url = attr('media:thumbnail', 'url') || attr('media:content', 'url') ||
      attr('enclosure', 'url') || (rawDesc.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] || null;

    const pubRaw = tag('pubDate') || tag('published') || tag('updated') || tag('dc:date') || '';
    const published = pubRaw ? new Date(pubRaw).toISOString() : null;
    const author = stripHtml(tag('dc:creator') || tag('author') || tag('name') || '').split('<')[0].trim() || null;

    items.push({ headline, url, summary, body, image_url, published, author });
  }
  return items;
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
    .replace(/&lsquo;/g, '\u2018').replace(/&rsquo;/g, '\u2019')
    .replace(/&ldquo;/g, '\u201C').replace(/&rdquo;/g, '\u201D')
    .replace(/&hellip;/g, '…');
}

function stripHtml(s) {
  let t = (s || '');
  t = decodeEntities(t);        // decode any double-encoded entities first
  t = t.replace(/<[^>]+>/g, ' ');  // strip tags
  t = decodeEntities(t);        // decode entities that were inside attributes
  return t.replace(/\s{2,}/g, ' ').trim();
}

function approxDate(iso) {
  if (!iso) return null;
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d <= 6) return `${d} days ago`;
  return 'this week';
}

// Extract the final assistant text from a Claude response (skipping tool_use blocks).
function extractFinalText(data) {
  const blocks = data.content || [];
  const textBlocks = blocks.filter((b) => b.type === 'text').map((b) => b.text);
  return textBlocks.join('\n').trim();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function proxy(targetUrl, res) {
  https
    .get(targetUrl, { headers: { 'User-Agent': 'uk-bills-tracker/1.0', Accept: 'application/json' } }, (up) => {
      res.writeHead(up.statusCode || 200, {
        'Content-Type': up.headers['content-type'] || 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=120',
      });
      up.pipe(res);
    })
    .on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';

  if (pathname === '/icon-192.png' || pathname === '/icon-512.png') {
    const size = pathname.includes('512') ? 512 : 192;
    const png = makePng(size);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    return res.end(png);
  }

  if (pathname === '/sw.js') {
    const swPath = path.join(ROOT, 'sw.js');
    fs.readFile(swPath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, {
        'Content-Type': 'text/javascript',
        'Service-Worker-Allowed': '/',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
    return;
  }

  if (pathname === '/api/bills') {
    const qs = new URLSearchParams(parsed.query).toString();
    return proxy(`https://bills-api.parliament.uk/api/v1/Bills?${qs}`, res);
  }
  if (pathname.startsWith('/api/bill/')) {
    const id = pathname.split('/').pop();
    return proxy(`https://bills-api.parliament.uk/api/v1/Bills/${encodeURIComponent(id)}`, res);
  }
  if (pathname.startsWith('/api/bill-publications/')) {
    const id = pathname.split('/').pop();
    return proxy(`https://bills-api.parliament.uk/api/v1/Bills/${encodeURIComponent(id)}/Publications`, res);
  }
  if (pathname === '/api/petitions') {
    const qs = new URLSearchParams(parsed.query).toString();
    return proxy(`https://petition.parliament.uk/petitions.json?${qs}`, res);
  }

  if (pathname.startsWith('/api/mp-contact/')) {
    const id = pathname.split('/').pop();
    return proxy(`https://members-api.parliament.uk/api/Members/${encodeURIComponent(id)}/Contact`, res);
  }

  if (pathname === '/api/mp') {
    const postcode = (parsed.query.postcode || '').toString().replace(/\s+/g, '').toUpperCase();
    if (!postcode || !/^[A-Z0-9]{5,8}$/.test(postcode)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid postcode' }));
    }
    (async () => {
      try {
        const pc = await getJson(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
        const constituency = pc.result?.parliamentary_constituency;
        if (!constituency) throw new Error('Postcode not found');
        const c = await getJson(`https://members-api.parliament.uk/api/Location/Constituency/Search?searchText=${encodeURIComponent(constituency)}&skip=0&take=5`);
        const match = (c.items || []).find((x) => (x.value?.name || '').toLowerCase() === constituency.toLowerCase()) || c.items?.[0];
        const rep = match?.value?.currentRepresentation?.member?.value;
        if (!rep) throw new Error('No current MP found');
        const partyName = rep.latestParty?.name || '';
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' });
        res.end(JSON.stringify({
          constituency,
          postcode,
          mp: {
            id: rep.id,
            name: rep.nameDisplayAs || rep.nameListAs || '',
            party: partyName,
            partyColor: partyColor(partyName),
            thumbnailUrl: rep.thumbnailUrl || null,
          },
        }));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  if (pathname === '/api/subscribe' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 5000) req.destroy(); });
    req.on('end', () => {
      try {
        const { email, frequency, topics, mp, postcode } = JSON.parse(body);
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email');
        const subs = (() => { try { return JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf8')); } catch { return []; } })();
        const existing = subs.findIndex((s) => s.email.toLowerCase() === email.toLowerCase());
        const entry = {
          email,
          frequency: frequency || 'updates',
          topics: topics || [],
          mp: mp || null,
          postcode: postcode || null,
          updatedAt: new Date().toISOString(),
        };
        if (existing >= 0) subs[existing] = { ...subs[existing], ...entry };
        else subs.push({ ...entry, createdAt: entry.updatedAt });
        fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(subs, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (pathname === '/api/summaries' && req.method === 'GET') {
    const summaries = loadSummaries();
    // Trim for tile use — drop heavy fields.
    const slim = {};
    Object.keys(summaries).forEach((id) => {
      const s = summaries[id];
      slim[id] = {
        schema: s.schema,
        tile_summary: s.tile_summary || '',
        affected_groups: (s.affected_groups || []).map((g) => ({
          topic_id: g.topic_id,
          stance: g.stance || 'neutral',
        })),
      };
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(slim));
  }

  if (pathname === '/api/summary' && req.method === 'POST') {
    if (!ANTHROPIC_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY missing on server' }));
    }
    const clientIp = req.socket.remoteAddress || 'unknown';
    if (!checkAiRateLimit(clientIp)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Too many requests — try again in an hour' }));
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 60000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { billId, bill, topics } = JSON.parse(body);
        if (!billId || !bill) throw new Error('billId and bill required');
        const requested = (topics || []).map((t) => t.id).sort();
        const summaries = loadSummaries();
        const cached = summaries[billId];
        // Schema v8: counter_summary field added.
        if (cached && cached.schema === 8 && requested.every((id) => (cached.topics_covered || []).includes(id))) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ...cached, cached: true }));
        }

        const topicsList = (topics || []).map((t) => `- ${t.id}: ${t.label}`).join('\n');
        const billText = await getBillText(billId);

        const prompt = `You are a progressive political watchdog writing for people who care about civil liberties, marginalised communities, and holding power to account. Your readers worry about trans rights, LGBTQ+ protections, immigration policy, racial justice, and the erosion of hard-won freedoms. They want the real picture — not the government's press release.

EDITORIAL STANCE:
Governments routinely dress up harmful legislation in reassuring language. "Protecting children." "Keeping communities safe." "Restoring common sense." Your job is to cut through that framing and ask: who does this actually affect, and how?
- When a bill restricts gender-affirming care under the guise of "safeguarding", name that.
- When an immigration bill strips legal rights under "border security" framing, say who gets hurt.
- When protest rights are curtailed under "anti-terrorism" language, call it out.
- When a bill is genuinely good for marginalised groups, say that clearly too.
Be honest, not alarmist. Sharp, not partisan.

WRITING RULES:
- Plain English only. No jargon without a plain explanation.
- Short sentences. Reading age 14 max. Over 20 words — split it.
- Write directly to the reader. "This means you..." not third person.
- Never start a sentence with "This bill", "The bill", or "It".

STEP 1 — SEARCH:
Search for what UK civil-society groups have said about this specific bill. Target: Liberty, Big Brother Watch, Stonewall, Mermaids, Trans Actual, Good Law Project, Open Rights Group, Amnesty UK, Refugee Council, Runnymede Trust, Disability Rights UK, and any groups relevant to the topics below. Aim for 3–6 searches. Capture real URLs.

STEP 2 — READ THE BILL:
Bill title: ${bill.shortTitle || ''}
Long title: ${bill.longTitle || ''}
Official summary: ${bill.summary || '(none provided)'}
Current stage: ${bill.currentStage || ''}
House: ${bill.house || ''}

Topics this bill matches (by our keyword system):
${topicsList}

${billText ? `Full bill text (from the latest published PDF):\n${billText}\n` : 'No full bill text published yet. Be honest about that limitation.'}

STEP 3 — WRITE THE JSON:
Respond ONLY with valid JSON. No preamble, no markdown.

{
  "tile_summary": "ONE sentence, max 18 words. What does this bill actually do? No jargon. Write like a headline that cuts through the spin.",
  "their_framing": "ONE sentence. What do the bill's supporters and the government claim this bill is for? Capture their official justification — even if it's euphemistic.",
  "summary": "2–3 plain sentences. What does this bill actually do — especially to real people? If there's a gap between the stated purpose and the likely impact, name it. No jargon.",
  "for_you": "One short paragraph, written directly to the reader (use 'you'). What does this mean for someone who cares about civil liberties and the rights of marginalised groups? Be specific and honest.",
  "counter_summary": "2-3 plain sentences. What aren't the government acknowledging? Cut through the official framing and name what's really at stake — especially for the most affected communities. No jargon. No bullet points. Write it as a flowing paragraph.",
  "affected_groups": [
    {
      "topic_id": "<exact ID from topic list above>",
      "label": "<exact label from topic list above>",
      "stance": "positive | negative | mixed | neutral",
      "impact": "2–4 plain sentences. How does this bill affect people in this group? Be specific about harms and gains. If official 'protective' language masks a real harm, say so.",
      "sources": [
        {"organisation": "e.g. Liberty, Stonewall, Mermaids", "url": "https://real-url-from-your-search"}
      ]
    }
  ],
  "watch_for": "One short sentence. What's the next moment to watch — and why should people who care about rights pay attention?"
}

STANCE GUIDANCE (assessed from a civil liberties and rights lens):
- "positive" — the bill materially helps this group (new protections, rights, funding, legal recognition).
- "negative" — the bill materially harms this group (new restrictions, surveillance, criminalisation, loss of rights, removal of legal protections). Bills framed as "child safeguarding" or "public safety" that restrict trans healthcare, criminalise migrants, or erode protest rights are negative, not neutral.
- "mixed" — genuine, meaningful pluses AND minuses for this group.
- "neutral" — the bill genuinely doesn't affect this group.

STRICT RULES:
- affected_groups MUST have exactly one entry per topic_id in the input list. No skipping.
- Every entry must have a stance value.
- Sources must be real URLs from your search. Never invent them. Empty array if nothing found.
- summary covers the whole bill. Group-specific analysis goes in affected_groups only.
- tile_summary is ONE sentence — written like a headline someone reads in half a second.`;

        const data = await claudeCall({
          model: 'claude-sonnet-4-6',
          max_tokens: 3500,
          tools: [
            {
              type: 'web_search_20250305',
              name: 'web_search',
              max_uses: 2,
              allowed_domains: TRUSTED_SOURCES,
            },
          ],
          messages: [{ role: 'user', content: prompt }],
        });
        if (!data.content) throw new Error(data.error?.message || 'Claude API error');
        const text = extractFinalText(data);
        if (!text) throw new Error('Claude returned no text');
        const jsonStart = text.indexOf('{');
        const jsonEnd = text.lastIndexOf('}');
        if (jsonStart < 0 || jsonEnd < 0) throw new Error('No JSON in Claude response');
        const json = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
        const merged = {
          schema: 8,
          tile_summary: json.tile_summary || '',
          their_framing: json.their_framing || '',
          summary: json.summary || '',
          counter_summary: json.counter_summary || '',
          affected_groups: json.affected_groups || [],
          watch_for: json.watch_for || '',
          topics_covered: Array.from(new Set([...((cached && cached.schema === 6 ? cached.topics_covered : []) || []), ...requested])),
          has_bill_text: billText.length > 500,
          generated_at: new Date().toISOString(),
        };
        summaries[billId] = merged;
        db.upsertSummary(billId, merged, SUMMARIES_FILE).catch((e) => console.error('upsert summary:', e.message));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(merged));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (pathname === '/api/bill-press' && req.method === 'GET') {
    const title = (parsed.query.title || '').toString().toLowerCase().trim();
    if (!title) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ articles: [] })); }
    (async () => {
      try {
        const items = await getOrFetchRssItems();
        const words = title.split(/\s+/).filter((w) => w.length > 4 && !['bill','reform','amendment','act'].includes(w));
        const needed = Math.max(1, Math.min(2, words.length));
        const matches = items
          .filter((item) => {
            const hay = `${item.headline} ${item.body.slice(0, 400)}`.toLowerCase();
            return words.filter((w) => hay.includes(w)).length >= needed;
          })
          .slice(0, 5);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
        res.end(JSON.stringify({ articles: matches }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ articles: [] }));
      }
    })();
    return;
  }

  if (pathname === '/api/bill-reaction' && req.method === 'POST') {
    const clientIp = req.socket.remoteAddress || 'unknown';
    if (!checkAiRateLimit(clientIp)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Too many requests — try again in an hour' }));
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', () => {
      (async () => {
        try {
          const { billId, bill } = JSON.parse(body);
          const summaries = loadSummaries();
          if (summaries[billId]?.reaction) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ...summaries[billId].reaction, cached: true }));
          }
          const prompt = `You are a UK political analyst. Based on this bill, identify who likely supports and opposes it.

Bill: ${bill.shortTitle}
Long title: ${bill.longTitle || ''}
Summary: ${bill.summary || ''}
Stage: ${bill.currentStage || ''}

Return ONLY valid JSON:
{
  "supporting": ["2-4 organisations/parties/groups likely supporting"],
  "opposing": ["2-4 organisations/parties/groups likely opposing"],
  "debate": "One sentence on the core tension between supporters and opponents."
}`;
          const data = await claudeCall({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] });
          const text = data.content?.[0]?.text || '';
          const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
          summaries[billId] = { ...(summaries[billId] || {}), reaction: { ...json, generated_at: new Date().toISOString() } };
          db.upsertSummary(billId, summaries[billId], SUMMARIES_FILE).catch(() => {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(json));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
    });
    return;
  }

  if (pathname === '/api/mp-vote' && req.method === 'GET') {
    const mpId = parseInt(parsed.query.mpId || '0', 10);
    const billId = (parsed.query.billId || '').toString().trim();
    const billTitle = (parsed.query.billTitle || '').toString().trim();
    if (!mpId || !billId || !billTitle) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'mpId, billId and billTitle required' }));
    }
    (async () => {
      try {
        // Check cache
        let cache = {};
        try { cache = JSON.parse(fs.readFileSync(MP_VOTES_FILE, 'utf8')); } catch {}
        const cacheKey = `${billId}:${mpId}`;
        const cached = cache[cacheKey];
        if (cached && (Date.now() - cached.ts) < 86400000) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(cached));
        }

        // Build keywords from bill title — strip common words, keep 3+ char tokens
        const stopWords = new Set(['the','and','for','with','of','to','a','in','on','at','by','bill','act','no','new']);
        const keywords = billTitle.toLowerCase()
          .replace(/[^a-z0-9\s]/g, '')
          .split(/\s+/)
          .filter(w => w.length >= 3 && !stopWords.has(w));

        // Fetch up to 200 recent Commons votes for this MP (4 pages × 50)
        let matched = null;
        outer: for (let page = 1; page <= 4; page++) {
          const data = await getJson(
            `https://members-api.parliament.uk/api/Members/${mpId}/Voting?house=Commons&page=${page}&take=50`
          );
          for (const item of (data.items || [])) {
            const v = item.value;
            const divTitle = (v.title || '').toLowerCase();
            const hits = keywords.filter(kw => divTitle.includes(kw)).length;
            if (hits >= Math.min(2, keywords.length)) {
              matched = {
                vote: v.inAffirmativeLobby ? 'aye' : 'noe',
                divisionTitle: v.title.trim(),
                date: (v.date || '').slice(0, 10),
                cached: false,
              };
              break outer;
            }
          }
        }

        const result = matched || { vote: null, divisionTitle: null, date: null, cached: false };
        result.ts = Date.now();
        cache[cacheKey] = result;
        fs.writeFileSync(MP_VOTES_FILE, JSON.stringify(cache));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  if (pathname === '/api/mp-statements' && req.method === 'GET') {
    const title = (parsed.query.title || '').toString().trim();
    if (!title || !TWFY_KEY) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ statements: [] }));
    }
    (async () => {
      try {
        const query = encodeURIComponent(title);
        const [commons, lords] = await Promise.allSettled([
          getJson(`https://www.theyworkforyou.com/api/getDebates?type=commons&search=${query}&num=10&output=js&key=${TWFY_KEY}`),
          getJson(`https://www.theyworkforyou.com/api/getDebates?type=lords&search=${query}&num=5&output=js&key=${TWFY_KEY}`),
        ]);
        const rows = [];
        const addRows = (result, house) => {
          if (result.status !== 'fulfilled') return;
          const items = result.value?.rows || [];
          items.forEach((row) => {
            const speaker = row.speaker;
            if (!speaker || !speaker.name) return;
            const body = (row.body || '').replace(/<[^>]+>/g, '').trim();
            if (body.length < 60) return;
            rows.push({
              house,
              name: speaker.name,
              party: speaker.party || '',
              constituency: speaker.constituency || '',
              date: row.hdate || '',
              text: body.slice(0, 400),
              url: `https://www.theyworkforyou.com${row.url || ''}`,
              person_id: speaker.person_id || '',
            });
          });
        };
        addRows(commons, 'Commons');
        addRows(lords, 'Lords');
        rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
        res.end(JSON.stringify({ statements: rows.slice(0, 8) }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ statements: [], error: err.message }));
      }
    })();
    return;
  }

  if (pathname === '/api/polls' && req.method === 'GET') {
    (async () => {
      try {
        const TWO_HOURS = 2 * 60 * 60 * 1000;
        let cached = null;
        try { cached = JSON.parse(fs.readFileSync(POLLS_FILE, 'utf8')); } catch {}
        if (cached && cached.generated_at && (Date.now() - new Date(cached.generated_at).getTime()) < TWO_HOURS) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ...cached, cached: true }));
        }

        // Scrape Wikipedia voting intention table — live data, no AI required
        const wikiData = await getJson(
          'https://en.wikipedia.org/w/api.php?action=parse&page=Opinion_polling_for_the_next_United_Kingdom_general_election&prop=text&format=json&section=2'
        );
        const rawHtml = wikiData.parse?.text?.['*'] || '';
        if (!rawHtml) throw new Error('Empty response from Wikipedia API');

        function cellText(html) {
          return html
            .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, '')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
            .replace(/&#\d+;/g, '').replace(/&[a-z]+;/gi, '')
            .replace(/%/g, '').replace(/,/g, '')
            .replace(/\s+/g, ' ').trim();
        }

        function getCells(trHtml) {
          const cells = [];
          const re = /<t([dh])([^>]*)>([\s\S]*?)<\/t[dh]>/gi;
          let m;
          while ((m = re.exec(trHtml)) !== null) cells.push({ tag: m[1], attrs: m[2], html: m[3] });
          return cells;
        }

        // Find first wikitable using balanced <table> tag counting
        function extractFirstWikitable(html) {
          const lower = html.toLowerCase();
          const classIdx = lower.indexOf('wikitable');
          if (classIdx === -1) return null;
          let start = classIdx;
          while (start > 0 && html[start] !== '<') start--;
          let depth = 0, i = start;
          while (i < lower.length) {
            if (lower.startsWith('<table', i) && (lower[i + 6] === ' ' || lower[i + 6] === '>')) { depth++; i += 6; }
            else if (lower.startsWith('</table>', i)) { depth--; if (depth === 0) return html.slice(start, i + 8); i += 8; }
            else i++;
          }
          return null;
        }

        // Extract top-level <tr> rows only, skipping rows inside nested tables
        function extractTopLevelRows(tableHtml) {
          const rows = [];
          const lower = tableHtml.toLowerCase();
          let depth = 0, i = 0, rowStart = -1;
          while (i < lower.length) {
            if (lower.startsWith('<table', i) && (lower[i + 6] === ' ' || lower[i + 6] === '>')) { depth++; i += 6; }
            else if (lower.startsWith('</table>', i)) { depth--; i += 8; }
            else if (lower.startsWith('<tr', i) && (lower[i + 3] === ' ' || lower[i + 3] === '>') && depth === 1) { rowStart = i; i += 3; }
            else if (lower.startsWith('</tr>', i) && depth === 1 && rowStart >= 0) { rows.push(tableHtml.slice(rowStart, i + 5)); rowStart = -1; i += 5; }
            else i++;
          }
          return rows;
        }

        const tableHtml = extractFirstWikitable(rawHtml);
        if (!tableHtml) throw new Error('Wikipedia polling table not found');
        const rows = extractTopLevelRows(tableHtml);
        if (rows.length === 0) throw new Error('No rows found in Wikipedia table');

        const PARTY_MAP = { lab: 'Labour', con: 'Conservative', ref: 'Reform UK', ld: 'Liberal Democrats', grn: 'Green', snp: 'SNP', pc: 'Plaid Cymru' };

        // Discover column indices from header rows
        let colMap = {};
        for (const row of rows) {
          const cells = getCells(row);
          const found = {};
          for (let i = 0; i < cells.length; i++) {
            const t = cellText(cells[i].html).toLowerCase().replace(/[^a-z]/g, '');
            if (PARTY_MAP[t]) found[t] = i;
          }
          if (Object.keys(found).length >= 3) { colMap = found; break; }
        }
        // Fallback to known Wikipedia column layout
        if (Object.keys(colMap).length < 3) colMap = { lab: 5, con: 6, ref: 7, ld: 8, grn: 9, snp: 10, pc: 11 };

        // Parse data rows — look for cells with data-sort-value ISO date
        const polls = [];
        for (const row of rows) {
          const cells = getCells(row);
          if (cells.length < 6) continue;
          const dateAttr = (cells[0]?.attrs || '') + (cells[0]?.html || '');
          const dateMatch = dateAttr.match(/data-sort-value="(\d{4}-\d{2}-\d{2})"/);
          if (!dateMatch) continue;

          const poll = {
            date: dateMatch[1],
            pollster: cellText(cells[1]?.html || '').split(/[\[\(]/)[0].trim(),
            sample: parseInt(cellText(cells[4]?.html || '').replace(/\D/g, ''), 10) || null,
          };
          for (const [abbrev, idx] of Object.entries(colMap)) {
            if (cells[idx]) {
              const v = parseFloat(cellText(cells[idx].html));
              if (!isNaN(v) && v > 0) poll[abbrev] = v;
            }
          }
          polls.push(poll);
          if (polls.length >= 5) break;
        }

        if (polls.length === 0) throw new Error('No polling data rows found in Wikipedia table');

        const latest = polls[0];
        const prev = polls[1] || null;
        const vi = [];
        for (const [abbrev, fullName] of Object.entries(PARTY_MAP)) {
          if (latest[abbrev] != null) {
            const change = (prev && prev[abbrev] != null) ? Math.round((latest[abbrev] - prev[abbrev]) * 10) / 10 : null;
            vi.push({ party: fullName, pct: latest[abbrev], change });
          }
        }
        vi.sort((a, b) => b.pct - a.pct);

        const result = {
          voting_intention: vi,
          pollster: latest.pollster || null,
          field_dates: latest.date,
          vi_sample_size: latest.sample || null,
          source_url: 'https://en.wikipedia.org/wiki/Opinion_polling_for_the_next_United_Kingdom_general_election',
          generated_at: new Date().toISOString(),
        };
        fs.writeFileSync(POLLS_FILE, JSON.stringify(result, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  if (pathname === '/api/pulse' && req.method === 'GET') {
    (async () => {
      try {
        const FORTY_FIVE_MIN = 45 * 60 * 1000;
        let cached = null;
        try { cached = JSON.parse(fs.readFileSync(PULSE_FILE, 'utf8')); } catch {}
        if (cached && cached.cached_at && (Date.now() - new Date(cached.cached_at).getTime()) < FORTY_FIVE_MIN) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ...cached, from_cache: true }));
        }

        const feeds = await Promise.allSettled(PULSE_FEEDS.map(fetchRss));
        const allItems = [];
        feeds.forEach((r, i) => {
          if (r.status === 'fulfilled') {
            r.value.forEach((item) => { item.source = PULSE_FEEDS[i].source; allItems.push(item); });
          }
        });

        const FOUR_WEEKS = 28 * 24 * 60 * 60 * 1000;
        const articles = [];
        const seen = new Set();
        for (const item of allItems) {
          if (seen.has(item.url)) continue;
          if (item.published && (Date.now() - new Date(item.published).getTime()) > FOUR_WEEKS) continue;
          const haystack = `${item.headline} ${item.body.slice(0, 600)}`.toLowerCase();
          if (PULSE_BLOCKLIST.some((kw) => haystack.includes(kw))) continue;
          if (!PULSE_MUST_INCLUDE.some((kw) => haystack.includes(kw))) continue;
          seen.add(item.url);
          articles.push({ ...item, published_approx: approxDate(item.published) });
        }

        articles.sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0));
        const result = { articles: articles.slice(0, 60), cached_at: new Date().toISOString() };
        fs.writeFileSync(PULSE_FILE, JSON.stringify(result));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  // ── Admin: trigger background generation ──────────────────────
  if (pathname === '/api/admin/generate' && req.method === 'POST') {
    if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    runGeneratePending(); // fire and forget — non-blocking
    res.writeHead(202, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      alreadyRunning: _job.running,
      message: _job.running ? 'Job already in progress' : 'Generation started',
    }));
  }

  // ── Admin: job status ──────────────────────────────────────────
  if (pathname === '/api/admin/status' && req.method === 'GET') {
    if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ..._job,
      totalSummaries: Object.keys(db.getSummaries()).length,
    }));
  }

  let filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(ROOT + path.sep) && normalized !== ROOT) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(normalized, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(normalized).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    res.end(data);
  });
});

// ─── Auto-generation engine ───────────────────────────────────────────────────
//
// POST /api/admin/generate  — starts a background run (idempotent, safe to call while running)
// GET  /api/admin/status    — returns current job state as JSON
//
// Protected by the ADMIN_KEY env var (x-admin-key header).
// Designed to be called by a daily cron — cron-job.org hits it every night.

const BILL_TOPICS = [
  { id: 'technology',     label: 'Technology',       keywords: ['technology', 'software', 'digital', 'broadband', 'telecoms', 'semiconductor', 'online platform', 'internet', 'cybersecurity', 'data protection', 'privacy', 'personal data', 'biometric', 'online safety', 'age verification', 'ofcom', 'social media'] },
  { id: 'ai',             label: 'AI',               keywords: ['artificial intelligence', ' ai ', 'ai bill', 'algorithm', 'automated decision', 'machine learning', 'generative'] },
  { id: 'crypto',         label: 'Crypto',           keywords: ['cryptocurrency', 'crypto', 'digital asset', 'bitcoin', 'blockchain', 'stablecoin', 'cryptoasset'] },
  { id: 'economy',        label: 'Economy',          keywords: ['economy', 'gdp', 'inflation', 'fiscal', 'budget', 'public finance', 'national insurance', 'tax ', 'corporation tax', ' vat ', 'universal credit', 'benefits', 'welfare', 'pension', 'carers'] },
  { id: 'business',       label: 'Business',         keywords: ['business', 'trade', 'corporation', 'company', 'enterprise', 'competition', 'market', 'commerce', 'farming', 'agriculture', 'rural', 'fisheries'] },
  { id: 'current-affairs',label: 'Current Affairs',  keywords: ['national security', 'terrorism', 'intelligence services', 'espionage', 'surveillance', 'defence', 'armed forces', 'military', 'veterans', 'elections', 'voter', 'electoral', 'constitution', 'house of lords', 'devolution', 'foreign'] },
  { id: 'climate',        label: 'Climate',          keywords: ['climate', 'net zero', 'carbon', 'emissions', 'renewable', 'fossil fuel', 'environment'] },
  { id: 'health',         label: 'Health',           keywords: ['nhs', 'health service', 'tobacco', 'pharmacy', 'cancer', 'patient', 'healthcare', 'medicines', 'disability', 'disabled', 'accessibility', 'pip', ' sen '] },
  { id: 'mental-health',  label: 'Mental Health',    keywords: ['mental health', 'camhs', 'psychiatric', 'wellbeing'] },
  { id: 'education',      label: 'Education',        keywords: ['education', 'schools', 'teachers', 'university', 'student', 'children', 'child protection', 'safeguarding'] },
  { id: 'women',          label: "Women's Rights",   keywords: ['women', 'maternity', 'misogyny', 'domestic abuse', 'violence against women'] },
  { id: 'trans',          label: 'Trans Rights',     keywords: ['trans ', 'transgender', 'gender identity', 'gender recognition', 'non-binary', 'conversion therapy', 'single-sex', 'puberty blocker', 'gender clinic', 'gender dysphoria', 'biological sex', 'sex-based', 'toilets', 'sports ban', 'tavistock'] },
  { id: 'lgbtq',          label: 'LGBTQI+',          keywords: ['lgbt', 'gay', 'lesbian', 'bisexual', 'same-sex', 'sexual orientation', 'queer', 'civil partnership', 'conversion practice', 'homophobia', 'hate crime'] },
  { id: 'immigration',    label: 'Immigration',      keywords: ['immigration', 'asylum', 'migrant', 'refugee', 'border', 'visa', 'nationality', 'deportation', 'detention', 'hostile environment', 'rwanda', 'stateless', 'right to remain', 'leave to remain', 'undocumented'] },
  { id: 'workers',        label: "Workers' Rights",  keywords: ['workers', 'employment', 'trade union', 'minimum wage', 'zero hours', 'housing', 'renters', 'leasehold', 'tenant', 'landlord'] },
  { id: 'crime',          label: 'Crime & Justice',  keywords: ['policing', 'police', 'criminal justice', 'stop and search', 'prisons', 'sentencing', 'protest', 'public order', 'pornography', 'sex work', 'intimate image', 'obscene', 'racial', 'racism', 'ethnicity', 'discrimination', 'hate crime', 'surveillance', 'facial recognition', 'counter-terrorism', 'serious disruption', 'injunction'] },
];

function topicsForBill(bill) {
  const hay = ` ${bill.shortTitle || ''} ${bill.longTitle || ''} ${bill.summary || ''} `.toLowerCase();
  return BILL_TOPICS.filter((t) => t.keywords.some((kw) => hay.includes(kw)));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Job state — single global, only one run at a time
const _job = {
  running:   false,
  startedAt: null,
  done:      0,
  failed:    0,
  skipped:   0,
  total:     0,
  current:   '',
  lastError: '',
  finishedAt: null,
};

async function runGeneratePending() {
  if (_job.running) return; // already running — idempotent
  Object.assign(_job, { running: true, startedAt: new Date().toISOString(), done: 0, failed: 0, skipped: 0, total: 0, current: '', lastError: '', finishedAt: null });
  console.log('[generate] Starting background summary run');

  try {
    const data = await getJson('https://bills-api.parliament.uk/api/v1/Bills?SortOrder=DateUpdatedDescending&take=200');
    const bills = data.items || [];
    const summaries = db.getSummaries();

    const todo = bills.filter((b) => {
      const topics = topicsForBill(b);
      if (topics.length === 0) return false;
      const cached = summaries[String(b.billId)];
      if (!cached || cached.schema !== 8) return true;
      // Re-process if any matched topic isn't in the cached coverage list
      return !topics.every((t) => (cached.topics_covered || []).includes(t.id));
    });

    _job.skipped = bills.length - todo.length;
    _job.total   = todo.length;
    console.log(`[generate] ${todo.length} bills to process, ${_job.skipped} already cached`);

    for (let i = 0; i < todo.length; i++) {
      const bill   = todo[i];
      const topics = topicsForBill(bill);
      _job.current = bill.shortTitle || String(bill.billId);

      try {
        // Re-use the same prompt + Claude call already in the server
        // by calling our own /api/summary endpoint internally
        const existing = db.getSummaries()[String(bill.billId)];
        const requested = topics.map((t) => t.id).sort();
        if (existing && existing.schema === 8 && requested.every((id) => (existing.topics_covered || []).includes(id))) {
          _job.skipped++;
          _job.total--;
          continue;
        }

        const billText = await getBillText(bill.billId);
        const topicsList = topics.map((t) => `- ${t.id}: ${t.label}`).join('\n');

        const prompt = buildSummaryPrompt(bill, topics, topicsList, billText);
        const aiData = await claudeCall({
          model: 'claude-sonnet-4-6',
          max_tokens: 3500,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2, allowed_domains: TRUSTED_SOURCES }],
          messages: [{ role: 'user', content: prompt }],
        });

        const text = extractFinalText(aiData);
        if (!text) throw new Error('No text from Claude');
        const j = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
        const json = JSON.parse(j);

        const merged = {
          schema: 8,
          tile_summary:    json.tile_summary    || '',
          their_framing:   json.their_framing   || '',
          summary:         json.summary         || '',
          counter_summary: json.counter_summary || '',
          affected_groups: json.affected_groups || [],
          watch_for:       json.watch_for       || '',
          topics_covered:  requested,
          has_bill_text:   billText.length > 500,
          generated_at:    new Date().toISOString(),
        };

        await db.upsertSummary(bill.billId, merged, SUMMARIES_FILE);
        _job.done++;
        console.log(`[generate] ✓ ${_job.done}/${_job.total} — ${_job.current}`);
      } catch (e) {
        _job.failed++;
        _job.lastError = e.message;
        console.error(`[generate] ✗ ${_job.current}: ${e.message}`);
      }

      // Rate limit — 95s between Claude calls (30k TPM cap)
      if (i < todo.length - 1) await sleep(95000);
    }
  } catch (e) {
    _job.lastError = e.message;
    console.error('[generate] Fatal error:', e.message);
  } finally {
    _job.running    = false;
    _job.finishedAt = new Date().toISOString();
    console.log(`[generate] Done — ${_job.done} generated, ${_job.failed} failed, ${_job.skipped} skipped`);
  }
}

// Extract the prompt string so both the manual /api/summary and the auto job share identical logic
function buildSummaryPrompt(bill, topics, topicsList, billText) {
  return `You are a progressive political watchdog writing for people who care about civil liberties, marginalised communities, and holding power to account. Your readers worry about trans rights, LGBTQ+ protections, immigration policy, racial justice, and the erosion of hard-won freedoms. They want the real picture — not the government's press release.

EDITORIAL STANCE:
Governments routinely dress up harmful legislation in reassuring language. "Protecting children." "Keeping communities safe." "Restoring common sense." Your job is to cut through that framing and ask: who does this actually affect, and how?
- When a bill restricts gender-affirming care under the guise of "safeguarding", name that.
- When an immigration bill strips legal rights under "border security" framing, say who gets hurt.
- When protest rights are curtailed under "anti-terrorism" language, call it out.
- When a bill is genuinely good for marginalised groups, say that clearly too.
Be honest, not alarmist. Sharp, not partisan.

WRITING RULES:
- Plain English only. No jargon without a plain explanation.
- Short sentences. Reading age 14 max. Over 20 words — split it.
- Write directly to the reader. "This means you..." not third person.
- Never start a sentence with "This bill", "The bill", or "It".

STEP 1 — SEARCH:
Search for what UK civil-society groups have said about this specific bill. Target: Liberty, Big Brother Watch, Stonewall, Mermaids, Trans Actual, Good Law Project, Open Rights Group, Amnesty UK, Refugee Council, Runnymede Trust, Disability Rights UK, and any groups relevant to the topics below. Aim for 3–6 searches. Capture real URLs.

STEP 2 — READ THE BILL:
Bill title: ${bill.shortTitle || ''}
Long title: ${bill.longTitle || ''}
Official summary: ${bill.summary || '(none provided)'}
Current stage: ${bill.currentStage || ''}
House: ${bill.house || ''}

Topics this bill matches (by our keyword system):
${topicsList}

${billText ? `Full bill text (from the latest published PDF):\n${billText}\n` : 'No full bill text published yet. Be honest about that limitation.'}

STEP 3 — WRITE THE JSON:
Respond ONLY with valid JSON. No preamble, no markdown.

{
  "tile_summary": "ONE sentence, max 18 words. What does this bill actually do? No jargon. Write like a headline that cuts through the spin.",
  "their_framing": "ONE sentence. What do the bill's supporters and the government claim this bill is for?",
  "summary": "2–3 plain sentences. What does this bill actually do — especially to real people?",
  "for_you": "One short paragraph, written directly to the reader (use 'you').",
  "counter_summary": "2-3 plain sentences. What aren't the government acknowledging?",
  "affected_groups": [
    {
      "topic_id": "<exact ID from topic list above>",
      "label": "<exact label from topic list above>",
      "stance": "positive | negative | mixed | neutral",
      "impact": "2–4 plain sentences. How does this bill affect people in this group?",
      "sources": [{"organisation": "e.g. Liberty", "url": "https://real-url"}]
    }
  ],
  "watch_for": "One short sentence. What is the next moment to watch?"
}

STRICT RULES:
- affected_groups MUST have exactly one entry per topic_id in the input list.
- Sources must be real URLs from your search. Empty array if nothing found.
- tile_summary is ONE sentence — written like a headline.`;
}

// ─── Admin endpoints ──────────────────────────────────────────────────────────

// Init DB (loads summaries into memory) then start listening
db.init(SUMMARIES_FILE).then(() => {
  server.listen(PORT, () => {
    console.log(`→ http://localhost:${PORT}  [db: ${db.isPostgres() ? 'postgres' : 'file'}]`);
  });
}).catch((e) => {
  console.error('Startup failed:', e.message);
  process.exit(1);
});
