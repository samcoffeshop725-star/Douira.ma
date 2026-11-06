/* =====================================================================
   Niveaux de la carte de membre.

   Quatre niveaux : classique, bronze, gold, black. Le niveau est posé par
   l'administration — c'est une décision commerciale, pas un calcul — et il
   décide de ce à quoi le membre a droit.

   Ce que ce module affirme, et seulement cela :

     L'ORDRE. black > gold > bronze > classique. Toute comparaison de droits
     passe par `auMoins()` : on n'écrit jamais `tier === 'black'` ailleurs,
     sinon ajouter un niveau demanderait de relire toute l'application.

     LA DISPONIBILITÉ DU SERVICE CLIENT, qui monte avec le niveau. C'est la
     seule contrepartie décidée à ce jour ; les engagements chiffrés (délai de
     réponse, ligne directe) restent à fixer par l'équipe et sont rassemblés
     ici pour n'avoir qu'un endroit à modifier.

   Ce module n'invente AUCUN pourcentage de réduction : les offres par niveau
   n'ont pas encore été arrêtées, et une remise annoncée puis démentie coûte
   plus cher qu'une remise absente.

   Fonctions pures : voir api/test/cards.test.js.
   ===================================================================== */
'use strict';

/** Du plus courant au plus rare. L'ordre du tableau EST la hiérarchie. */
const NIVEAUX = [
  {
    key: 'classique',
    label: 'Classique',
    // Niveau de disponibilité du service client, 0 = base.
    support: 0,
    supportLabel: 'Service client par message',
  },
  {
    key: 'bronze',
    label: 'Bronze',
    support: 1,
    supportLabel: 'Service client par message',
  },
  {
    key: 'gold',
    label: 'Gold',
    support: 2,
    supportLabel: 'Service client prioritaire',
  },
  {
    key: 'black',
    label: 'Black',
    support: 3,
    supportLabel: 'Service client dédié, à toute heure',
  },
];

const DEFAUT = 'classique';

const PAR_CLE = new Map(NIVEAUX.map((n) => [n.key, n]));

/** Le niveau, ou « classique » si la valeur est inconnue ou absente. */
function niveau(v) {
  return PAR_CLE.get(String(v || '').trim().toLowerCase()) || PAR_CLE.get(DEFAUT);
}

/** La clé seule, assainie. Utilisé avant d'écrire en base. */
function cleValide(v) {
  return niveau(v).key;
}

/** Rang hiérarchique : 0 pour classique, 3 pour black. */
function rang(v) {
  return NIVEAUX.findIndex((n) => n.key === niveau(v).key);
}

/**
 * Ce niveau vaut-il au moins celui demandé ?
 *
 * Tout droit réservé à un niveau s'écrit avec ceci : `auMoins(u.card_tier,
 * 'gold')`. Ajouter un niveau entre deux autres ne demande alors que de le
 * glisser dans NIVEAUX.
 */
function auMoins(v, minimum) {
  return rang(v) >= rang(minimum);
}

/** Vue publique du niveau, telle que l'appli l'affiche. */
function vue(v) {
  const n = niveau(v);
  return {
    key: n.key,
    label: n.label,
    rang: rang(n.key),
    support: n.support,
    supportLabel: n.supportLabel,
    // Un seul endroit décide de ce qui est « prioritaire » : l'appli ne
    // recompte pas les niveaux de son côté.
    supportPrioritaire: n.support >= 2,
  };
}

/* ---------------- Offres : prix et avantages, par niveau ----------------

   Décidés dans l'administration, pas ici. Ce module ne fait que les lire, les
   assainir et les rendre dans l'ordre de la hiérarchie.                     */

const db = require('./db');

/** Au plus ce nombre d'avantages par carte : au-delà, personne ne lit. */
const AVANTAGES_MAX = 10;

function err(status, msg) { const e = new Error(msg); e.status = status; return e; }

/** Liste JSON gardée en texte ; jamais d'exception sur une colonne abîmée. */
function avantages(v) {
  if (Array.isArray(v)) return v.map(String);
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}

/**
 * Nettoie une liste d'avantages saisie par l'administration.
 *
 * Lignes vides écartées, longueur bornée, nombre borné : une carte qui
 * promet trente choses n'en promet aucune.
 *
 * Fonction pure : voir api/test/card-offers.test.js.
 */
function normaliserAvantages(liste) {
  // Un avantage est une phrase. Ce qui n'est pas du texte n'en est pas un, et
  // se jette plutôt que de se convertir — « 0 » n'a jamais été un avantage.
  const brut = Array.isArray(liste)
    ? liste.filter((x) => typeof x === 'string')
    : String(liste || '').split('\n');
  return brut
    .map((x) => x.trim().slice(0, 140))
    .filter(Boolean)
    .slice(0, AVANTAGES_MAX);
}

/**
 * Prix en centimes, ou null.
 *
 * NULL n'est pas zéro : « pas encore fixé » et « gratuit » sont deux
 * promesses différentes, et confondre les deux ferait annoncer la gratuité
 * d'une carte dont personne n'a décidé le prix.
 */
function prixValide(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0) throw err(400, 'Prix invalide.');
  return n;
}

/** Vue d'une offre, prête à afficher. */
function vueOffre(row) {
  const n = niveau(row && row.key);
  return {
    key: n.key,
    label: n.label,
    rang: rang(n.key),
    // Ce qui est décidé depuis toujours : le service client monte avec le niveau.
    supportLabel: n.supportLabel,
    supportPrioritaire: n.support >= 2,
    prix: row && row.price != null ? Number(row.price) : null,
    devise: (row && row.currency) || 'MAD',
    periode: (row && row.period) || '',
    accroche: (row && row.tagline) || '',
    avantages: avantages(row && row.benefits),
    enAvant: !!(row && row.featured),
  };
}

/** Les quatre offres, dans l'ordre de la hiérarchie. */
async function listOffres() {
  const r = await db.query('SELECT * FROM card_offers').catch(() => ({ rows: [] }));
  const parCle = new Map((r.rows || []).map((x) => [x.key, x]));
  return NIVEAUX.map((n) => vueOffre(parCle.get(n.key) || { key: n.key }));
}

/** Enregistre l'offre d'un niveau. Réservé à l'administration. */
async function saveOffre(user, data) {
  if (!user || user.role !== 'admin') throw err(403, 'Accès refusé.');
  const d = data || {};
  const key = cleValide(d.key);
  // Une seule carte mise en avant : on efface l'ancienne plutôt que d'en
  // laisser deux se disputer la place.
  if (d.enAvant) await db.query('UPDATE card_offers SET featured = false WHERE featured');
  const r = await db.one(
    `INSERT INTO card_offers (key, price, currency, period, tagline, benefits, featured, updated_at, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now(), $8)
     ON CONFLICT (key) DO UPDATE SET price = EXCLUDED.price, currency = EXCLUDED.currency,
       period = EXCLUDED.period, tagline = EXCLUDED.tagline, benefits = EXCLUDED.benefits,
       featured = EXCLUDED.featured, updated_at = now(), updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [key, prixValide(d.prix), String(d.devise || 'MAD').slice(0, 8),
     String(d.periode || '').trim().slice(0, 40), String(d.accroche || '').trim().slice(0, 200),
     JSON.stringify(normaliserAvantages(d.avantages)), !!d.enAvant, user.id]);
  return vueOffre(r);
}

module.exports = {
  NIVEAUX, DEFAUT, niveau, cleValide, rang, auMoins, vue,
  AVANTAGES_MAX, normaliserAvantages, prixValide, vueOffre, listOffres, saveOffre,
};
