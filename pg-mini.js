/* =====================================================================
   Client PostgreSQL minimal (protocole v3, sans dépendance) : utilisé
   uniquement quand le paquet officiel `pg` n'est pas installé (voir db.js).
   Supporte : TLS, authentification SCRAM-SHA-256 / MD5 / trust, requêtes
   paramétrées ($1, $2…), conversion des types courants, une connexion à la
   fois par instance (le pool est géré dans db.js).
   ===================================================================== */
'use strict';
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const OID = { bool: 16, int8: 20, int2: 21, int4: 23, text: 25, json: 114, float4: 700, float8: 701, numeric: 1700, date: 1082, timestamp: 1114, timestamptz: 1184, jsonb: 3802, uuid: 2950 };

function parseUrl(url) {
  const u = new URL(url);
  const ssl = u.searchParams.get('sslmode');
  return { host: u.hostname, port: Number(u.port) || 5432, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: decodeURIComponent(u.pathname.slice(1)) || 'postgres', ssl: ssl ? ssl !== 'disable' : /render\.com|amazonaws|neon|supabase/.test(u.hostname) };
}

class PgError extends Error { constructor(f) { super(f.M || 'erreur PostgreSQL'); this.code = f.C; this.detail = f.D; this.severity = f.S; } }

class Client {
  constructor(url) { this.cfg = typeof url === 'string' ? parseUrl(url) : url; this.sock = null; this.buf = Buffer.alloc(0); this.queue = []; this.cur = null; this.ready = false; this.closed = false; }

  connect() {
    return new Promise((resolve, reject) => {
      const c = this.cfg; const onErr = e => { this.closed = true; reject(e); };
      const start = sock => {
        this.sock = sock; sock.on('data', d => this._data(d)); sock.on('error', e => this._fail(e)); sock.on('close', () => this._fail(new Error('connexion fermée')));
        this._startup(); this.cur = { kind: 'startup', resolve, reject };
      };
      const raw = net.connect(c.port, c.host);
      raw.once('error', onErr);
      raw.once('connect', () => {
        if (!c.ssl) return start(raw);
        raw.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])); // SSLRequest
        raw.once('data', b => {
          if (b[0] !== 0x53) return onErr(new Error('le serveur refuse TLS'));
          const s = tls.connect({ socket: raw, servername: c.host, rejectUnauthorized: c.ssl === 'verify' }, () => start(s));
          s.once('error', onErr);
        });
      });
    });
  }
  _fail(e) { this.closed = true; if (this.cur && this.cur.reject) { const r = this.cur.reject; this.cur = null; r(e); } this.queue.splice(0).forEach(q => q.reject(e)); }
  _send(type, payload) { const len = Buffer.alloc(4); len.writeInt32BE(payload.length + 4); this.sock.write(type ? Buffer.concat([Buffer.from(type), len, payload]) : Buffer.concat([len, payload])); }
  _startup() {
    const c = this.cfg, parts = [Buffer.from([0, 3, 0, 0])];
    for (const [k, v] of [['user', c.user], ['database', c.database], ['client_encoding', 'UTF8'], ['application_name', 'douira']]) parts.push(Buffer.from(k + '\0' + v + '\0'));
    parts.push(Buffer.from([0])); this._send('', Buffer.concat(parts));
  }
  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1); if (this.buf.length < len + 1) break;
      const type = String.fromCharCode(this.buf[0]), body = this.buf.subarray(5, len + 1); this.buf = this.buf.subarray(len + 1);
      try { this._msg(type, body); } catch (e) { this._fail(e); }
    }
  }
  _fields(body) { const f = {}; let i = 0; while (i < body.length && body[i] !== 0) { const t = String.fromCharCode(body[i]); const e = body.indexOf(0, i + 1); f[t] = body.toString('utf8', i + 1, e); i = e + 1; } return f; }
  _msg(t, b) {
    const q = this.cur;
    switch (t) {
      case 'R': return this._auth(b);
      case 'S': case 'K': case 'N': return; // paramètres, clé d'annulation, notice : ignorés
      case 'E': { const err = new PgError(this._fields(b)); if (q) { q.error = err; if (q.kind === 'startup') { this.cur = null; q.reject(err); } } return; }
      case 'Z': { this.ready = true; if (q) { this.cur = null; if (q.kind === 'startup') q.resolve(this); else if (q.error) q.reject(q.error); else q.resolve({ rows: q.rows, rowCount: q.rowCount, fields: q.fieldsDesc }); } return this._next(); }
      case 'T': { const n = b.readInt16BE(0); let i = 2; const fs = []; for (let k = 0; k < n; k++) { const e = b.indexOf(0, i); const name = b.toString('utf8', i, e); i = e + 1; const oid = b.readInt32BE(i + 6); i += 18; fs.push({ name, oid }); } q.fieldsDesc = fs; return; }
      case 'D': { const n = b.readInt16BE(0); let i = 2; const row = {}; for (let k = 0; k < n; k++) { const l = b.readInt32BE(i); i += 4; const f = q.fieldsDesc[k]; if (l === -1) row[f.name] = null; else { row[f.name] = convert(b.toString('utf8', i, i + l), f.oid); i += l; } } q.rows.push(row); return; }
      case 'C': { const tag = b.toString('utf8', 0, b.length - 1); const m = /(\d+)$/.exec(tag); q.rowCount = m ? Number(m[1]) : 0; return; }
      case '1': case '2': case 'n': case 's': case 'I': return; // parse/bind complete, no data, portal suspended, empty query
      default: return;
    }
  }
  _auth(b) {
    const code = b.readInt32BE(0), c = this.cfg;
    if (code === 0) return;
    if (code === 3) return this._send('p', Buffer.from(c.password + '\0'));
    if (code === 5) { const salt = b.subarray(4, 8); const inner = md5(c.password + c.user); const outer = 'md5' + md5(Buffer.concat([Buffer.from(inner), salt])); return this._send('p', Buffer.from(outer + '\0')); }
    if (code === 10) { // SASL : SCRAM-SHA-256
      this.scram = { nonce: crypto.randomBytes(18).toString('base64') };
      const first = 'n,,n=*,r=' + this.scram.nonce; this.scram.first = 'n=*,r=' + this.scram.nonce;
      const mech = Buffer.from('SCRAM-SHA-256\0'), len = Buffer.alloc(4); len.writeInt32BE(Buffer.byteLength(first));
      return this._send('p', Buffer.concat([mech, len, Buffer.from(first)]));
    }
    if (code === 11) {
      const msg = b.toString('utf8', 4), kv = Object.fromEntries(msg.split(',').map(x => [x[0], x.slice(2)]));
      if (!kv.r.startsWith(this.scram.nonce)) throw new Error('SCRAM : nonce invalide');
      const salted = crypto.pbkdf2Sync(c.password.normalize('NFKC'), Buffer.from(kv.s, 'base64'), Number(kv.i), 32, 'sha256');
      const clientKey = hmac(salted, 'Client Key'), storedKey = crypto.createHash('sha256').update(clientKey).digest();
      const withoutProof = 'c=biws,r=' + kv.r, authMsg = this.scram.first + ',' + msg + ',' + withoutProof;
      const sig = hmac(storedKey, authMsg), proof = Buffer.alloc(32); for (let i = 0; i < 32; i++) proof[i] = clientKey[i] ^ sig[i];
      this.scram.serverSig = hmac(hmac(salted, 'Server Key'), authMsg).toString('base64');
      return this._send('p', Buffer.from(withoutProof + ',p=' + proof.toString('base64')));
    }
    if (code === 12) { const v = b.toString('utf8', 4).slice(2); if (v !== this.scram.serverSig) throw new Error('SCRAM : signature du serveur invalide'); return; }
    throw new Error('méthode d\'authentification non prise en charge : ' + code);
  }
  query(text, params = []) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('connexion fermée'));
      this.queue.push({ kind: 'query', text, params, resolve, reject, rows: [], rowCount: 0, fieldsDesc: [] });
      this._next();
    });
  }
  _next() {
    if (this.cur || !this.ready || !this.queue.length) return;
    const q = this.queue.shift(); this.cur = q; this.ready = false;
    if (!q.params.length) return this._send('Q', Buffer.from(q.text + '\0')); // protocole simple : accepte plusieurs ordres (migrations)
    const ps = q.params.map(p => p === undefined || p === null ? null : Buffer.isBuffer(p) ? p : Buffer.from(typeof p === 'object' && !(p instanceof Date) ? JSON.stringify(p) : p instanceof Date ? p.toISOString() : String(p)));
    this._send('P', Buffer.concat([Buffer.from('\0' + q.text + '\0'), Buffer.from([0, 0])]));
    const parts = [Buffer.from('\0\0'), Buffer.from([0, 0]), i16(ps.length)];
    for (const p of ps) { if (p === null) parts.push(Buffer.from([255, 255, 255, 255])); else { const l = Buffer.alloc(4); l.writeInt32BE(p.length); parts.push(l, p); } }
    parts.push(Buffer.from([0, 0]));
    this._send('B', Buffer.concat(parts));
    this._send('D', Buffer.from('P\0'));
    this._send('E', Buffer.from('\0\0\0\0\0'));
    this._send('S', Buffer.alloc(0));
  }
  end() { if (this.sock && !this.closed) { this.closed = true; try { this._send('X', Buffer.alloc(0)); this.sock.end(); } catch (e) { /* ignoré */ } } }
}
const i16 = n => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const md5 = x => crypto.createHash('md5').update(x).digest('hex');
const hmac = (k, m) => crypto.createHmac('sha256', k).update(m).digest();
function convert(v, oid) {
  switch (oid) {
    case OID.bool: return v === 't';
    case OID.int2: case OID.int4: return Number(v);
    case OID.int8: return Number.isSafeInteger(Number(v)) ? Number(v) : v;
    case OID.float4: case OID.float8: return Number(v);
    case OID.json: case OID.jsonb: return JSON.parse(v);
    case OID.timestamp: case OID.timestamptz: return new Date(v);
    default: return v;
  }
}
module.exports = { Client, PgError, parseUrl };
