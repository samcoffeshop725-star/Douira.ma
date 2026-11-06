/* =====================================================================
   Connexion Google / Apple : vérification du jeton d'identité.

   Le téléphone obtient un « jeton d'identité » (ID token) signé par Google ou
   Apple, et nous l'envoie. NOTRE serveur le VÉRIFIE avant de faire confiance à
   quoi que ce soit : signature RS256 contre les clés publiques du fournisseur
   (JWKS), puis émetteur (iss), destinataire (aud = notre identifiant client) et
   expiration. On ne lit JAMAIS l'e-mail d'un jeton non vérifié.

   Aucune dépendance : tout tient avec le module `crypto` de Node (import d'une
   clé JWK, vérification RS256). Les clés publiques sont mises en cache une heure.

   Variables d'environnement (identifiants client OAuth, séparés par des virgules) :
     GOOGLE_OAUTH_AUDIENCES   ex. 1234-ios.apps.googleusercontent.com,1234-web.apps.googleusercontent.com
     APPLE_OAUTH_AUDIENCES    ex. ma.douira.appli   (l'identifiant de l'app, et/ou un Services ID pour le web)
   ===================================================================== */
'use strict';
const crypto = require('crypto');

const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const APPLE_JWKS = 'https://appleid.apple.com/auth/keys';
const GOOGLE_ISS = ['https://accounts.google.com', 'accounts.google.com'];
const APPLE_ISS = ['https://appleid.apple.com'];

/** Audiences acceptées pour un fournisseur, depuis l'environnement. */
const auds = name => String(process.env[name] || '').split(',').map(s => s.trim()).filter(Boolean);

const decodePart = s => JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));

/* Cache des clés publiques par URL JWKS. Les fournisseurs tournent leurs clés :
   une heure de cache suffit, et une clé inconnue force un rafraîchissement. */
const cache = new Map(); // url -> { at, keys: { kid: KeyObject } }
async function jwks(url, forcer = false) {
  const hit = cache.get(url);
  if (!forcer && hit && Date.now() - hit.at < 3600_000) return hit.keys;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('clés du fournisseur indisponibles (' + r.status + ')');
    const j = await r.json();
    const keys = {};
    for (const k of (j.keys || [])) {
      try { keys[k.kid] = crypto.createPublicKey({ key: k, format: 'jwk' }); } catch (e) { /* clé ignorée */ }
    }
    cache.set(url, { at: Date.now(), keys });
    return keys;
  } finally { clearTimeout(t); }
}

async function cleFor(jwksUrl, kid) {
  let keys = await jwks(jwksUrl);
  if (!keys[kid]) keys = await jwks(jwksUrl, true); // clé récente pas encore en cache
  return keys[kid] || null;
}

/**
 * Vérifie un jeton d'identité RS256 et renvoie sa charge utile, ou lève.
 * @param idToken  le jeton reçu du téléphone
 * @param jwksUrl  l'URL des clés publiques du fournisseur
 * @param issuers  émetteurs acceptés (iss)
 * @param audiences identifiants client acceptés (aud) — jamais vide
 */
async function verifyIdToken(idToken, { jwksUrl, issuers, audiences }) {
  if (!audiences.length) throw new Error('aucune audience configurée (variable d’environnement manquante)');
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('jeton mal formé');
  const [h, p, sig] = parts;
  const header = decodePart(h);
  if (header.alg !== 'RS256') throw new Error('algorithme de signature refusé');
  const key = await cleFor(jwksUrl, header.kid);
  if (!key) throw new Error('clé de signature inconnue');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), key, Buffer.from(sig, 'base64url'));
  if (!ok) throw new Error('signature invalide');
  const payload = decodePart(p);
  const now = Math.floor(Date.now() / 1000);
  if (!issuers.includes(payload.iss)) throw new Error('émetteur inattendu');
  if (payload.exp && payload.exp + 60 < now) throw new Error('jeton expiré');
  if (payload.nbf && payload.nbf - 60 > now) throw new Error('jeton pas encore valide');
  // aud peut être une chaîne ou un tableau ; au moins une doit être des nôtres.
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.some(a => audiences.includes(a))) throw new Error('jeton émis pour une autre application');
  return payload;
}

/** Vérifie un jeton Google et renvoie { provider, sub, email, name, avatar }. */
async function google(idToken) {
  const p = await verifyIdToken(idToken, { jwksUrl: GOOGLE_JWKS, issuers: GOOGLE_ISS, audiences: auds('GOOGLE_OAUTH_AUDIENCES') });
  if (p.email_verified !== true && String(p.email_verified) !== 'true') throw new Error('e-mail Google non vérifié');
  return { provider: 'google', sub: String(p.sub), email: String(p.email || '').toLowerCase(), name: p.name || '', avatar: p.picture || '' };
}

/** Vérifie un jeton Apple. Apple ne met l'e-mail dans le jeton que s'il a été
    partagé ; le nom, lui, ne vient jamais du jeton (seulement à la 1ʳᵉ
    autorisation, côté appli). */
async function apple(idToken) {
  const p = await verifyIdToken(idToken, { jwksUrl: APPLE_JWKS, issuers: APPLE_ISS, audiences: auds('APPLE_OAUTH_AUDIENCES') });
  return { provider: 'apple', sub: String(p.sub), email: String(p.email || '').toLowerCase(), name: '', avatar: '' };
}

module.exports = { verifyIdToken, google, apple };
