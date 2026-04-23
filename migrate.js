/**
 * migrate.js — One-time migration from JSON files → Postgres.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node migrate.js
 *
 * Safe to re-run — uses upsert so nothing is duplicated.
 */

const fs   = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  // Try loading .env manually
  try {
    fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
      .split('\n').forEach((line) => {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
      });
  } catch {}
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set. Add it to your .env or export it first.');
  process.exit(1);
}

const { Client } = require('pg');
const DATA_DIR = path.join(__dirname, 'data');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch { return fallback; }
}

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log('Connected to Postgres');

  // Create tables
  await client.query(`
    CREATE TABLE IF NOT EXISTS summaries (
      bill_id    TEXT PRIMARY KEY,
      data       JSONB        NOT NULL,
      updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS kv_store (
      key        TEXT PRIMARY KEY,
      value      JSONB        NOT NULL,
      updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  `);
  console.log('Tables ready');

  // ── Summaries ──────────────────────────────────────────────────
  const summaries = readJson('summaries.json', {});
  const billIds = Object.keys(summaries);
  console.log(`Migrating ${billIds.length} summaries...`);
  let done = 0;
  for (const billId of billIds) {
    await client.query(
      `INSERT INTO summaries (bill_id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (bill_id) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
      [billId, JSON.stringify(summaries[billId])],
    );
    done++;
    if (done % 10 === 0) process.stdout.write(`  ${done}/${billIds.length}\r`);
  }
  console.log(`✓ ${done} summaries migrated`);

  // ── KV store items ─────────────────────────────────────────────
  const kvFiles = [
    { key: 'subscribers',  file: 'subscribers.json',  fallback: [] },
    { key: 'polls',        file: 'polls.json',         fallback: [] },
    { key: 'topic-polls',  file: 'topic-polls.json',   fallback: [] },
    { key: 'mp-votes',     file: 'mp-votes.json',      fallback: {} },
    { key: 'rss-items',    file: 'rss-items.json',     fallback: { items: [], cached_at: null } },
    { key: 'pulse',        file: 'pulse.json',         fallback: { items: [], cached_at: null } },
  ];
  for (const { key, file, fallback } of kvFiles) {
    const value = readJson(file, fallback);
    await client.query(
      `INSERT INTO kv_store (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
      [key, JSON.stringify(value)],
    );
    console.log(`✓ ${key} migrated`);
  }

  await client.end();
  console.log('\nAll done. Your Railway Postgres is fully populated.');
  console.log('Set DATABASE_URL in Railway and redeploy the server — it will use Postgres automatically.');
}

run().catch((e) => { console.error('Migration failed:', e.message); process.exit(1); });
