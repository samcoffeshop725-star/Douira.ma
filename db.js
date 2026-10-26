/* =====================================================================
   Accès à PostgreSQL : pool de connexions, requêtes paramétrées uniquement
   (jamais de concaténation de valeurs dans le SQL → pas d'injection SQL),
   transactions, migrations. Utilise le paquet officiel `pg` s'il est installé
   (npm install sur l'hébergeur), sinon le client minimal pg-mini.js.
   ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

let pgLib = null;
try { pgLib = require('pg'); } catch (e) { pgLib = null; }

class MiniPool {
  constructor(url, max) { this.url = url; this.max = max; this.idle = []; this.size = 0; this.waiting = []; }
  async acquire() {
    const { Client } = require('./pg-mini');
    if (this.idle.length) return this.idle.pop();
    if (this.size < this.max) { this.size++; const c = new Client(this.url); try { await c.connect(); } catch (e) { this.size--; throw e; } return c; }
    return new Promise(res => this.waiting.push(res));
  }
  release(c) { if (c.closed) { this.size--; return; } const w = this.waiting.shift(); if (w) w(c); else this.idle.push(c); }
  async query(text, params) { const c = await this.acquire(); try { return await c.query(text, params); } finally { this.release(c); } }
  async connect() { const c = await this.acquire(); return { query: (t, p) => c.query(t, p), release: () => this.release(c) }; }
  async end() { this.idle.forEach(c => c.end()); this.idle = []; }
}

let pool = null;
function init(url) {
  if (!url) throw new Error('DATABASE_URL manquante');
  const max = Math.max(2, Number(process.env.DB_POOL_MAX) || 8);
  if (pgLib) {
    const ssl = /sslmode=disable/.test(url) || /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false };
    pool = new pgLib.Pool({ connectionString: url, max, ssl, statement_timeout: 15000, idleTimeoutMillis: 30000 });
    pool.on('error', e => console.error('Base de données : connexion perdue', e.message));
  } else pool = new MiniPool(url, max);
  return pool;
}
const query = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;

// Transaction : toutes les requêtes passent par le même client ; ROLLBACK en cas d'erreur
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn({ query: (t, p) => c.query(t, p), one: async (t, p) => (await c.query(t, p)).rows[0] || null }); await c.query('COMMIT'); return r; }
  catch (e) { try { await c.query('ROLLBACK'); } catch (x) { /* ignoré */ } throw e; }
  finally { c.release(); }
}

// Migrations : fichiers sql/NNN_*.sql appliqués une fois, dans l'ordre, consignés dans schema_migrations
async function migrate() {
  await query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const dir = path.join(__dirname, '..', 'sql');
  const done = new Set((await query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
  for (const f of fs.readdirSync(dir).filter(x => /^\d+_.*\.sql$/.test(x)).sort()) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await tx(async t => { await t.query(sql); await t.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]); });
    console.log('Migration appliquée : ' + f);
  }
}
const end = () => pool && pool.end();
module.exports = { init, query, one, tx, migrate, end, usingOfficialDriver: !!pgLib };
