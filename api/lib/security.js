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
/* Jeton de carte de membre. La VERSION entre dans le message signé : incrémenter
   `users.card_version` révoque la carte précédente de ce seul membre, sans
   toucher à celles des autres. La version 1 reprend exactement l'ancien message,
   pour que les cartes déjà en circulation restent valables. */
const memberToken = (userId, memberNo, version) => {
  const v = Number(version) || 1;
  const msg = v === 1 ? `${userId}|${memberNo}` : `${userId}|${memberNo}|v${v}`;
  return hmacHex(cardKey(), msg).slice(0, 16).toUpperCase();
};
/* Jeton d'un badge d'équipe.

   Signé avec la même clé mais sur un message préfixé « badge| » : un badge
   d'équipe ne peut donc jamais être présenté comme une carte de membre, ni
   l'inverse, même si les deux numéros coïncidaient. */
const badgeToken = (userId, badgeNo, version) => {
  const v = Number(version) || 1;
  return hmacHex(cardKey(), `badge|${userId}|${badgeNo}|v${v}`).slice(0, 16).toUpperCase();
};
/* Lien de téléchargement du pass Wallet : le navigateur qui ouvre le .pkpass n'a
   pas la session de l'appli, donc le lien se porte lui-même — signé et bref. */
function walletLink(userId, expMs) { return `${expMs}.${hmacHex(cardKey(), `wallet|${userId}|${expMs}`).slice(0, 32)}`; }
function walletLinkUser(userId, value, nowMs) {
  const m = /^(\d{1,15})\.([a-f0-9]{32})$/.exec(String(value || ''));
  if (!m) return false;
  const exp = Number(m[1]);
  if (!(exp > (nowMs == null ? Date.now() : nowMs))) return false; // périmé
  return safeEqual(walletLink(userId, exp), `${exp}.${m[2]}`);
}

module.exports = { hashPassword, verifyPassword, passwordProblem, encrypt, decrypt, token, sha256, hmacHex, safeEqual, memberToken, badgeToken, walletLink, walletLinkUser };
