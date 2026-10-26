/* =====================================================================
   Outils HTTP : routeur, lecture du corps (limité), cookies, réponses JSON,
   erreurs typées, limitation de débit (en base, partagée entre instances).
   ===================================================================== */
'use strict';
const db = require('./db');

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

function readBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', c => { size += c.length; if (size <= max) parts.push(c); else if (size > 4 * max) req.destroy(); });
    req.on('end', () => size > max ? reject(new HttpError(413, 'Demande trop longue.')) : resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
async function readJson(req, max) {
  if (!/^application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'JSON attendu.');
  const raw = await readBody(req, max);
  try { const v = JSON.parse(raw.toString('utf8') || '{}'); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; return v; }
  catch (e) { throw new HttpError(400, 'Demande invalide.'); }
}
async function readForm(req, max) {
  const raw = await readBody(req, max);
  return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
}
function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', `SameSite=${opts.sameSite || 'Lax'}`];
  if (opts.secure) parts.push('Secure');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  const prev = res.getHeader('Set-Cookie'); res.setHeader('Set-Cookie', [].concat(prev || [], parts.join('; ')));
}
function json(res, status, obj, headers = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length }, headers));
  res.end(body);
}
function html(res, status, text, headers = {}) {
  const body = Buffer.from(text);
  res.writeHead(status, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length }, headers));
  res.end(body);
}
function redirect(res, url) { res.writeHead(303, { Location: url, 'Cache-Control': 'no-store' }); res.end(); }

// Adresse du client : derrière Render/Cloudflare, premier élément de X-Forwarded-For (TRUST_PROXY=1), sinon la socket
function clientIp(req) {
  if (/^(1|true)$/i.test(process.env.TRUST_PROXY || '1')) { const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (f) return f.slice(0, 64); }
  return (req.socket && req.socket.remoteAddress) || '?';
}
const isHttps = req => req.headers['x-forwarded-proto'] === 'https' || (req.socket && req.socket.encrypted) || false;

/* Limitation de débit : fenêtre fixe par clé (ex. "login:ip:1.2.3.4"), stockée en base pour valoir sur toutes les instances.
   Lève 429 au-delà de `max` dans `windowSec`. */
async function rateLimit(key, max, windowSec) {
  const r = await db.one(
    `INSERT INTO rate_limits (key, hits, window_start) VALUES ($1, 1, now())
     ON CONFLICT (key) DO UPDATE SET
       hits = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN 1 ELSE rate_limits.hits + 1 END,
       window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN now() ELSE rate_limits.window_start END
     RETURNING hits`, [key, windowSec]);
  if (r.hits > max) throw new HttpError(429, 'Trop de tentatives. Réessayez dans quelques minutes.');
}
// Nettoyage périodique des compteurs et sessions expirés
async function housekeeping() {
  await db.query("DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'");
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  await db.query("DELETE FROM password_resets WHERE expires_at < now() - interval '1 day'");
}

/* Routeur minimal : add('GET', '/api/bookings/:id', handler) ; handler(ctx) renvoie une valeur JSON ou écrit lui-même la réponse. */
class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, opts = {}) {
    const keys = []; const re = new RegExp('^' + pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, handler, opts });
  }
  match(method, pathname) {
    for (const r of this.routes) { const m = r.re.exec(pathname); if (m && (r.method === method || r.method === '*')) { const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); return { route: r, params }; } }
    return null;
  }
}
module.exports = { HttpError, readBody, readJson, readForm, cookies, setCookie, json, html, redirect, clientIp, isHttps, rateLimit, housekeeping, Router };
