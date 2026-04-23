/**
 * db.js — Postgres persistence layer with JSON-file fallback for local dev.
 *
 * If DATABASE_URL is set, all reads/writes go to Postgres.
 * If not, it falls back to the same JSON files the server always used,
 * so local development needs zero changes.
 *
 * Schema:
 *   summaries  (bill_id TEXT PK, data JSONB, updated_at TIMESTAMPTZ)
 *   kv_store   (key TEXT PK,     value JSONB, updated_at TIMESTAMPTZ)
 *
 * kv_store keys used:
 *   'subscribers'   — email subscriber list
 *   'polls'         — user poll votes
 *   'topic-polls'   — topic-level poll data
 *   'mp-votes'      — cached MP voting records
 *   'rss-items'     — RSS news cache (re-generated anyway)
 *   'pulse'         — processed pulse feed cache
 */

const fs   = require('fs');
const path = require('path');

let _pg    = null;   // pg Client, or null if using file fallback
let _mem   = {};     // in-memory summary cache (always used, regardless of backend)

// ─── Internal helpers ────────────────────────────────────────────

async function query(sql, params = []) {
  try {
    const res = await _pg.query(sql, params);
    return res;
  } catch (e) {
    console.error('[db] query error:', e.message, sql.slice(0, 80));
    throw e;
  }
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Call once at server startup, before listening.
 * Connects to Postgres (if DATABASE_URL set), creates tables, loads
 * all summaries into memory so loadSummaries() stays synchronous.
 */
async function init(summariesFilePath) {
  if (process.env.DATABASE_URL) {
    try {
      const { Client } = require('pg');
      _pg = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      });
      await _pg.connect();

      // Create tables (idempotent)
      await _pg.query(`
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

      // Load all summaries into the in-memory cache
      const { rows } = await _pg.query('SELECT bill_id, data FROM summaries ORDER BY updated_at');
      _mem = {};
      rows.forEach((r) => { _mem[r.bill_id] = r.data; });
      console.log(`[db] Postgres ready — ${rows.length} summaries loaded`);
    } catch (e) {
      console.error('[db] Postgres init failed, falling back to file:', e.message);
      _pg = null;
      _loadFromFile(summariesFilePath);
    }
  } else {
    console.log('[db] No DATABASE_URL — using JSON file fallback');
    _loadFromFile(summariesFilePath);
  }
}

function _loadFromFile(filePath) {
  try {
    _mem = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log(`[db] Loaded ${Object.keys(_mem).length} summaries from file`);
  } catch {
    _mem = {};
  }
}

// ── Summaries ───────────────────────────────────────────────────

/** Synchronous — returns the in-memory cache (always up-to-date). */
function getSummaries() {
  return _mem;
}

/**
 * Upsert a single bill summary.
 * Updates memory immediately; persists to Postgres or file async.
 */
async function upsertSummary(billId, data, summariesFilePath) {
  _mem[String(billId)] = data;

  if (_pg) {
    await query(
      `INSERT INTO summaries (bill_id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (bill_id) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
      [String(billId), JSON.stringify(data)],
    );
  } else if (summariesFilePath) {
    // File fallback — write the whole cache back (small file, fine)
    try { fs.writeFileSync(summariesFilePath, JSON.stringify(_mem, null, 2)); } catch {}
  }
}

// ── Generic KV store ────────────────────────────────────────────

/**
 * Read a value from the KV store.
 * Falls back to reading from the provided filePath if no DB.
 */
async function getKV(key, filePath) {
  if (_pg) {
    try {
      const { rows } = await query('SELECT value FROM kv_store WHERE key = $1', [key]);
      return rows.length ? rows[0].value : _readFile(filePath);
    } catch {
      return _readFile(filePath);
    }
  }
  return _readFile(filePath);
}

/**
 * Write a value to the KV store.
 * Also writes to the file so local dev works transparently.
 */
async function setKV(key, value, filePath) {
  if (_pg) {
    try {
      await query(
        `INSERT INTO kv_store (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
        [key, JSON.stringify(value)],
      );
    } catch (e) {
      console.error('[db] setKV failed:', e.message);
    }
  }
  // Always mirror to file for local-dev and as a safe backup
  if (filePath) {
    try { fs.writeFileSync(filePath, JSON.stringify(value, null, 2)); } catch {}
  }
}

function _readFile(filePath) {
  if (!filePath) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

/** True if connected to Postgres (for diagnostic logging). */
function isPostgres() { return !!_pg; }

module.exports = { init, getSummaries, upsertSummary, getKV, setKV, isPostgres };
