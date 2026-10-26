/* =====================================================================
   Primitives de sécurité (Node intégré uniquement) :
   - mots de passe : scrypt (N = 2^15, r = 8, p = 1, 32 Mo), sel aléatoire, comparaison en temps constant ;
   - chiffrement des données sensibles (adresse, code d'accès) : AES-256-GCM, clé DATA_KEY hors base ;
   - jetons aléatoires (sessions, réinitialisation), signatures HMAC (carte de membre).
   ===================================================================== */
'use strict';
const crypto = require('crypto');

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, key] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const k = crypto.scryptSync(String(pw).normalize('NFKC'), Buffer.from(salt, 'base64'), 32, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
    return crypto.timingSafeEqual(k, Buffer.from(key, 'base64'));
  } catch (e) { return false; }
}
// Mot de passe : 10 caractères minimum, 200 maximum, pas les plus courants (liste courte ; HIBP peut être branché en plus)
const COMMON = new Set(['password', 'motdepasse', '1234567890', 'azertyuiop', 'qwertyuiop', 'douira2026', 'marrakech1', 'password1', 'admin12345']);
function passwordProblem(pw) {
  if (typeof pw !== 'string') return 'Mot de passe requis.';
  if (pw.length < 10) return 'Le mot de passe doit contenir au moins 10 caractères.';
  if (pw.length > 200) return 'Mot de passe trop long.';
  if (COMMON.has(pw.toLowerCase())) return 'Ce mot de passe est trop courant.';
  return '';
}

let DATA_KEY = null;
function dataKey() {
  if (DATA_KEY) return DATA_KEY;
  const raw = process.env.DATA_KEY || '';
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('DATA_KEY doit être une clé de 32 octets en base64 (openssl rand -base64 32)');
  DATA_KEY = k; return k;
}
function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', dataKey(), iv);
  return 'v1.' + Buffer.concat([iv, c.update(String(text), 'utf8'), c.final(), c.getAuthTag()]).toString('base64');
}
function decrypt(blob) {
  if (!blob) return '';
  const b = Buffer.from(String(blob).replace(/^v1\./, ''), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', dataKey(), b.subarray(0, 12)); d.setAuthTag(b.subarray(-16));
  return d.update(b.subarray(12, -16)) + d.final('utf8');
}

const token = (n = 32) => crypto.randomBytes(n).toString('base64url');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const hmacHex = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest('hex');
function safeEqual(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
// Clé de signature des cartes de membre : CARD_SECRET, sinon dérivée de DATA_KEY
const cardKey = () => process.env.CARD_SECRET || crypto.createHmac('sha256', dataKey()).update('douira-card').digest('hex');
const memberToken = (userId, memberNo) => hmacHex(cardKey(), `${userId}|${memberNo}`).slice(0, 16).toUpperCase();

module.exports = { hashPassword, verifyPassword, passwordProblem, encrypt, decrypt, token, sha256, hmacHex, safeEqual, memberToken };
