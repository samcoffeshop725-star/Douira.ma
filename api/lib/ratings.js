/* =====================================================================
   Notes des activités et des services.

   Les logements gardent les leurs (lib/messaging.js, après le séjour) : les
   deux systèmes ne se mélangent pas, mais `publicSummary` les rassemble pour
   que l'appli puisse afficher des étoiles partout en une seule requête.

   Une note se mérite. Pour une ACTIVITÉ, la preuve d'usage existe déjà :
   l'offre validée en agence est enregistrée. Pour un SERVICE, aucune trace
   d'usage n'existe — on exige donc seulement un vrai client, c'est-à-dire
   quelqu'un qui a au moins une réservation confirmée. C'est plus faible, et
   mieux vaut le dire que le laisser croire.

   Règles pures en haut, accès base en bas.
   ===================================================================== */
'use strict';
const db = require('./db');

const KINDS = ['activity', 'service'];

/** En dessous, la moyenne n'est pas publiée : elle ne mesurerait rien. */
const MIN_RATINGS = 2;

function err(status, msg) { const e = new Error(msg); e.status = status; return e; }

/* ---------------- Règles pures ---------------- */

/** Une note doit être un entier de 1 à 5. */
function validRating(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5;
}

/**
 * `userId` peut-il noter cet élément ?
 *
 * @param kind      'activity' ou 'service'
 * @param preuve    { aUtilise } pour une activité, { estClient } pour un service
 * @param existing  note déjà déposée, ou null
 */
function canRateItem(kind, preuve, existing) {
  if (!KINDS.includes(kind)) return { ok: false, status: 400, reason: 'Type inconnu.' };
  if (existing) return { ok: false, status: 409, reason: 'Vous avez déjà noté.' };
  const p = preuve || {};
  if (kind === 'activity') {
    if (!p.aUtilise) {
      return { ok: false, status: 403, reason: 'La note sera possible après avoir profité de cette offre.' };
    }
    return { ok: true };
  }
  // service
  if (!p.estClient) {
    return { ok: false, status: 403, reason: 'La note est réservée aux clients ayant déjà séjourné chez nous.' };
  }
  return { ok: true };
}

/** Moyenne publiable, ou null quand elle repose sur trop peu d'avis. */
function publishable(average, count) {
  if (!count || count < MIN_RATINGS) return null;
  return { average, count };
}

/* ---------------- Distinctions ---------------- */

/** Un hôte distingué : très bien noté, et sur assez de séjours pour le prouver. */
const SUPERHOTE = { note: 4.8, avis: 5 };

/**
 * Cet hôte mérite-t-il la distinction ?
 *
 * Deux conditions, et la seconde compte autant que la première : une moyenne
 * de 5,0 sur deux avis ne distingue personne. Le seuil est volontairement
 * exigeant — une distinction que tout le monde obtient n'en est plus une.
 */
function isSuperhost(average, count) {
  if (average == null || !count) return false;
  return Number(average) >= SUPERHOTE.note && Number(count) >= SUPERHOTE.avis;
}

/** Au-delà de cette part de nuits déjà prises, le logement est dit recherché. */
const RARE_SEUIL = 0.6;

/**
 * « Perle rare » : la plupart des nuits à venir sont déjà prises.
 *
 * On le calcule sur les disponibilités réelles plutôt que sur un compteur de
 * vues : un logement très regardé mais toujours libre n'est pas rare, et le
 * dire serait un argument de vente sans fondement.
 *
 * @param nuitsPrises  nuits déjà réservées dans la fenêtre
 * @param nuitsTotal   taille de la fenêtre, en nuits
 */
function isRareFind(nuitsPrises, nuitsTotal) {
  const total = Number(nuitsTotal) || 0;
  if (total <= 0) return false;
  const prises = Math.max(0, Number(nuitsPrises) || 0);
  return prises / total >= RARE_SEUIL;
}

/* ---------------- Accès base ---------------- */

/**
 * Identifiant public d'une activité -> identifiant réel.
 *
 * Le catalogue public ampute l'identifiant de ses lettres
 * (`toCfgActivite` : « act-7 » devient « 7 »), pour la forme attendue par le
 * site. L'appli ne connaît donc que cette forme tronquée, alors que les
 * validations d'offre et la table des activités portent la vraie. Sans cette
 * traduction, une note serait écrite sous un identifiant qui ne désigne rien,
 * et la preuve d'usage ne serait jamais trouvée.
 */
const publicActivityId = (id) => String(id).replace(/\D/g, '') || String(id);

async function resolveActivityId(itemId) {
  const exact = await db.one('SELECT id FROM activities WHERE id = $1', [String(itemId)]);
  if (exact) return exact.id;
  // Forme tronquée : l'activité dont l'identifiant, réduit à ses chiffres, est
  // celui-là. En SQL — la route est publique, et charger toute la table à
  // chaque appel en faisait la plus facile à marteler.
  const r = await db.one(
    "SELECT id FROM activities WHERE NULLIF(regexp_replace(id, '\\D', '', 'g'), '') = $1 LIMIT 1",
    [String(itemId)]);
  return r ? r.id : null;
}

/** Identifiant canonique pour l'écriture et la lecture. */
async function canonical(kind, itemId) {
  if (kind === 'activity') {
    const vrai = await resolveActivityId(itemId);
    if (!vrai) throw err(404, 'Activité introuvable.');
    return vrai;
  }
  if (kind === 'service') {
    // On ne note qu'un service qui existe et que le public peut voir : sinon
    // n'importe quelle chaîne devenait une « moyenne » publiée.
    const sv = await db.one("SELECT id FROM services WHERE id = $1 AND status = 'published'", [String(itemId)]);
    if (!sv) throw err(404, 'Service introuvable.');
    return sv.id;
  }
  return String(itemId);
}

async function preuveFor(kind, itemId, userId) {
  if (kind === 'activity') {
    const r = await db.one(
      'SELECT id FROM activity_redemptions WHERE activity_id = $1 AND client_id = $2 LIMIT 1',
      [itemId, userId]);
    return { aUtilise: !!r };
  }
  const r = await db.one(
    "SELECT id FROM bookings WHERE user_id = $1 AND status = 'confirmed' LIMIT 1", [userId]);
  return { estClient: !!r };
}

async function mine(kind, itemId, userId) {
  return db.one(
    'SELECT rating, comment, at FROM item_ratings WHERE kind = $1 AND item_id = $2 AND author_id = $3',
    [kind, itemId, userId]);
}

/** État de la note pour cet utilisateur : la sienne, et s'il peut en donner une. */
async function itemRating(kind, publicId, userId) {
  if (!KINDS.includes(kind)) throw err(400, 'Type inconnu.');
  const itemId = await canonical(kind, publicId);
  const a = await db.one(
    'SELECT round(avg(rating)::numeric, 1) AS avg, count(*) AS n FROM item_ratings WHERE kind = $1 AND item_id = $2',
    [kind, itemId]);
  const n = a ? Number(a.n || 0) : 0;
  const moyenne = a && a.avg ? Number(a.avg) : null;

  const sienne = userId ? await mine(kind, itemId, userId) : null;
  const check = userId
    ? canRateItem(kind, await preuveFor(kind, itemId, userId), sienne)
    : { ok: false, status: 401, reason: 'Connectez-vous pour noter.' };

  return {
    // Le compte réel est utile à l'intéressé, la moyenne publique ne l'est que
    // si elle repose sur assez d'avis.
    public: publishable(moyenne, n),
    count: n,
    mine: sienne ? { rating: sienne.rating, comment: sienne.comment, at: sienne.at } : null,
    canRate: check.ok,
    reason: check.ok ? '' : check.reason,
  };
}

async function rateItem(kind, publicId, userId, rating, comment) {
  if (!KINDS.includes(kind)) throw err(400, 'Type inconnu.');
  if (!validRating(rating)) throw err(400, 'La note doit être comprise entre 1 et 5.');
  const itemId = await canonical(kind, publicId);
  const check = canRateItem(kind, await preuveFor(kind, itemId, userId), await mine(kind, itemId, userId));
  if (!check.ok) throw err(check.status, check.reason);
  const r = await db.one(
    `INSERT INTO item_ratings (kind, item_id, author_id, rating, comment)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, rating, comment, at`,
    [kind, itemId, userId, Number(rating),
     (typeof comment === 'string' ? comment : '').trim().slice(0, 1000)]);
  return { id: String(r.id), rating: r.rating, comment: r.comment, at: r.at };
}

/**
 * Toutes les moyennes publiables, en une seule requête.
 *
 * L'appli affiche des étoiles sur des listes entières : une requête par carte
 * serait intenable. Les logements viennent de `reviews`, les activités et les
 * services d'`item_ratings` — trois tableaux, un seul aller-retour.
 */
async function publicSummary() {
  const biens = await db.query(
    `SELECT listing_id AS id, round(avg(rating)::numeric, 1) AS avg, count(*) AS n
       FROM reviews WHERE listing_id IS NOT NULL GROUP BY listing_id`);
  const autres = await db.query(
    `SELECT kind, item_id AS id, round(avg(rating)::numeric, 1) AS avg, count(*) AS n
       FROM item_ratings GROUP BY kind, item_id`);

  // L'appli ne connaît que la forme publique : c'est elle qui sert de clé.
  const vue = (rows, filtre) => {
    const out = {};
    for (const x of rows) {
      if (filtre && x.kind !== filtre) continue;
      const p = publishable(x.avg ? Number(x.avg) : null, Number(x.n || 0));
      if (!p) continue;
      out[filtre === 'activity' ? publicActivityId(x.id) : String(x.id)] = p;
    }
    return out;
  };

  return {
    listings: vue(biens.rows, null),
    activities: vue(autres.rows, 'activity'),
    services: vue(autres.rows, 'service'),
  };
}

module.exports = {
  KINDS, MIN_RATINGS,
  // règles pures
  validRating, canRateItem, publishable, publicActivityId,
  isSuperhost, isRareFind, SUPERHOTE, RARE_SEUIL,
  // base
  itemRating, rateItem, publicSummary,
};
