/* =====================================================================
   Parrainage et bons de réduction.

   Règle du produit (demandée) :
   - chaque membre a un code d'invitation unique ;
   - un filleul qui s'inscrit avec ce code fait gagner au parrain un bon de 5 %
     applicable à une FUTURE location (le déclencheur est l'inscription) ;
   - le parrain ne peut détenir que CAP bons NON UTILISÉS à la fois : c'est la
     « jauge » montrée dans l'appli (« 3 obtenues sur 5 maximum »).

   Garde-fous (le déclencheur « à l'inscription » est sinon trivial à abuser) :
   - un filleul ne crédite qu'UN parrain, une seule fois (UNIQUE referred_id) ;
   - on ne se parraine pas soi-même ;
   - un code inconnu est ignoré en silence (l'inscription réussit quand même) ;
   - au plafond, le filleul est compté mais aucun nouveau bon n'est émis.

   Le bon RÉDUIT le montant réellement facturé : il passe par le devis du serveur
   (jamais par le navigateur) et est consommé DANS la transaction de réservation,
   puis rendu si la réservation échoue, expire ou est annulée. L'argent n'est
   donc jamais réduit deux fois ni perdu.

   Module à état minimal : il lit et écrit la base, mais sa logique de plafond et
   de code est testable (voir api/test/referrals.test.js).
   ===================================================================== */
'use strict';
const db = require('./db');

const PCT = 5;      // réduction par filleul, en pourcentage
const CAP = 5;      // bons non utilisés détenus en même temps (la « jauge »)
// Alphabet sans les caractères qui se confondent (0/O, 1/I/L) : un code se lit et
// se dicte sans erreur.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const crypto = require('crypto');

/** Forme canonique d'un code saisi (majuscules, sans espaces ni tirets). */
function normCode(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
}

/** Un code aléatoire bien distribué, dans l'alphabet lisible. */
function genCode(n = CODE_LEN) {
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Donne (et mémorise) le code d'invitation du membre, en garantissant l'unicité. */
async function ensureCode(userId) {
  const row = await db.one('SELECT referral_code FROM users WHERE id = $1', [userId]);
  if (row && row.referral_code) return row.referral_code;
  for (let i = 0; i < 6; i++) {
    const code = genCode();
    const saved = await db.one(
      'UPDATE users SET referral_code = $2 WHERE id = $1 AND referral_code IS NULL RETURNING referral_code',
      [userId, code]).catch(e => {
        if (/unique|duplicate/i.test(e.message)) return null;   // collision : on réessaie
        throw e;
      });
    if (saved) return saved.referral_code;
    // Soit la ligne avait déjà un code (course), soit collision : on relit.
    const again = await db.one('SELECT referral_code FROM users WHERE id = $1', [userId]);
    if (again && again.referral_code) return again.referral_code;
  }
  throw new Error('Attribution du code d’invitation impossible, réessayez.');
}

/**
 * Crédite le parrain à l'inscription d'un filleul. À appeler DANS la transaction
 * d'inscription (t), juste après la création du filleul.
 * Retourne { credited: bool, capped: bool } ; n'échoue jamais l'inscription.
 */
async function creditOnRegister(t, referredId, rawCode) {
  const code = normCode(rawCode);
  if (!code) return { credited: false };
  const parrain = await t.one('SELECT id FROM users WHERE referral_code = $1 AND deleted_at IS NULL', [code]);
  if (!parrain) return { credited: false };                 // code inconnu : silencieux
  if (parrain.id === referredId) return { credited: false }; // pas d'auto-parrainage
  // Un filleul ne crédite qu'une fois : l'UNIQUE(referred_id) le garantit, le
  // ON CONFLICT évite l'erreur si l'inscription est rejouée.
  const ref = await t.one(
    'INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2) ON CONFLICT (referred_id) DO NOTHING RETURNING id',
    [parrain.id, referredId]);
  if (!ref) return { credited: false };
  // Plafond : on n'émet un bon que si le parrain en détient moins de CAP non utilisés.
  const dispo = await t.one('SELECT count(*)::int AS n FROM referral_rewards WHERE user_id = $1 AND used_at IS NULL', [parrain.id]);
  if (dispo && dispo.n >= CAP) return { credited: true, capped: true };
  await t.query('INSERT INTO referral_rewards (user_id, pct, source_referral_id) VALUES ($1, $2, $3)', [parrain.id, PCT, ref.id]);
  return { credited: true, capped: false };
}

/** Nombre de bons disponibles (non utilisés) pour ce membre. */
async function availableCount(userId) {
  const r = await db.one('SELECT count(*)::int AS n FROM referral_rewards WHERE user_id = $1 AND used_at IS NULL', [userId]);
  return r ? r.n : 0;
}

/**
 * Réserve UN bon disponible dans la transaction t, sans encore l'attacher à une
 * réservation. Le verrou (FOR UPDATE SKIP LOCKED) fait qu'un double clic n'en
 * prend pas deux. Retourne { id, pct } ou null. À suivre de markUsed() une fois
 * la réservation créée, dans la MÊME transaction.
 */
async function peek(t, userId) {
  return t.one(
    `SELECT id, pct FROM referral_rewards
      WHERE user_id = $1 AND used_at IS NULL
      ORDER BY created_at
      LIMIT 1 FOR UPDATE SKIP LOCKED`, [userId]);
}

/** Attache un bon réservé par peek() à la réservation qui l'a utilisé. */
async function markUsed(t, rewardId, bookingId) {
  await t.query('UPDATE referral_rewards SET used_at = now(), booking_id = $2 WHERE id = $1', [rewardId, bookingId]);
}

/**
 * Applique un bon de `pct` % à un devis (fonction PURE, unités de la devise).
 * La réduction porte sur le total à payer après la remise saisonnière éventuelle.
 * Renvoie un NOUVEAU devis : total réduit, et deux champs pour la facture.
 */
function applyReferral(quote, pct) {
  const q = Object.assign({}, quote);
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  if (!p) { q.referralPct = 0; q.referralDiscount = 0; return q; }
  const base = Math.max(0, Number(q.total) || 0);
  const reduc = Math.round(base * p) / 100;
  q.referralPct = p;
  q.referralDiscount = reduc;
  q.total = Math.max(0, base - reduc);
  return q;
}

/** Rend les bons attachés à une réservation qui n'aboutit pas (échec, expiration, annulation). */
async function release(t, bookingId) {
  await t.query('UPDATE referral_rewards SET used_at = NULL, booking_id = NULL WHERE booking_id = $1 AND used_at IS NOT NULL', [bookingId]);
}

/** Tableau de bord : code, nombre de filleuls, bons disponibles, plafond. */
async function summary(userId) {
  const code = await ensureCode(userId);
  const [inv, dispo] = await Promise.all([
    db.one('SELECT count(*)::int AS n FROM referrals WHERE referrer_id = $1', [userId]),
    availableCount(userId),
  ]);
  return { code, pct: PCT, cap: CAP, invited: inv ? inv.n : 0, available: dispo };
}

module.exports = { PCT, CAP, normCode, genCode, ensureCode, creditOnRegister, availableCount, peek, markUsed, applyReferral, release, summary };
