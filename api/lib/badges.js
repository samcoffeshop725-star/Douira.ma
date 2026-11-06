/* =====================================================================
   Badge d'équipe : la carte d'identité de la société.

   Qui en porte un : l'administrateur, les chefs d'équipe et les
   collaborateurs. Pas les clients, pas les propriétaires, pas les agences —
   un badge dit « cette personne travaille ici », et c'est une affirmation
   qu'on ne distribue pas.

   Deux règles tiennent tout le reste :

     LE NUMÉRO 1 EST CELUI DE L'ADMINISTRATION. Il lui est réservé ; s'il est
     déjà pris, l'administrateur suivant reçoit un numéro ordinaire.

     UN NUMÉRO NE SE RÉUTILISE JAMAIS. On prend toujours au-dessus du plus
     grand attribué, même si des numéros ont été libérés entre-temps : sinon
     on ne saurait plus qui a présenté quel badge.

   Règles pures : voir api/test/badges.test.js.
   ===================================================================== */
'use strict';
const db = require('./db');
const sec = require('./security');

function err(status, msg) { const e = new Error(msg); e.status = status; return e; }

/** Rôles qui portent un badge. */
const ROLES_BADGE = ['admin', 'collaborator'];

/** Numéro réservé à l'administration. */
const BADGE_ADMIN = 1;

/** Cette personne a-t-elle droit à un badge ? */
function porteBadge(user) {
  return !!user && ROLES_BADGE.includes(user.role);
}

/**
 * Libellé de la fonction, tel qu'il s'imprime sur le badge.
 *
 * Un chef d'équipe est un collaborateur à qui l'on a confié la répartition :
 * c'est le drapeau `team_lead` qui le distingue, pas son rôle.
 */
function fonction(user) {
  if (!user) return '';
  if (user.role === 'admin') return 'Administration';
  if (user.team_lead) return 'Chef d’équipe';
  return 'Collaborateur';
}

/**
 * Prochain numéro à attribuer.
 *
 * @param role        rôle du titulaire
 * @param maxAttribue plus grand numéro déjà attribué (0 si aucun)
 * @param unLibre     le numéro 1 est-il encore libre ?
 */
function prochainNumero(role, maxAttribue, unLibre) {
  if (role === 'admin' && unLibre) return BADGE_ADMIN;
  return Math.max(BADGE_ADMIN, Math.trunc(Number(maxAttribue) || 0)) + 1;
}

/** Habillage : noir pour l'administration, livrée d'équipe pour les autres. */
function livree(user) {
  return user && user.role === 'admin' ? 'black' : 'equipe';
}

/* ---------------- Accès base ---------------- */

/**
 * Badge du titulaire, attribué au premier affichage.
 *
 * L'attribution est tentée deux fois : entre la lecture du plus grand numéro
 * et l'écriture, un autre badge a pu être créé — l'index unique le refuse, et
 * on recommence avec le nouveau maximum plutôt que d'échouer.
 */
async function forUser(user) {
  if (!porteBadge(user)) throw err(403, 'Le badge est réservé à l’équipe Douira.');

  let numero = user.badge_no || null;
  for (let essai = 0; !numero && essai < 2; essai += 1) {
    const max = await db.one('SELECT COALESCE(MAX(badge_no), 0) AS n FROM users WHERE badge_no IS NOT NULL');
    const un = await db.one('SELECT id FROM users WHERE badge_no = $1', [BADGE_ADMIN]);
    const vise = prochainNumero(user.role, max ? max.n : 0, !un);
    const r = await db.one(
      'UPDATE users SET badge_no = $2, updated_at = now() WHERE id = $1 AND badge_no IS NULL RETURNING badge_no',
      [user.id, vise],
    ).catch(() => null); // conflit d'unicité : on repasse avec un maximum à jour
    if (r) numero = r.badge_no;
  }
  if (!numero) throw err(503, 'Numéro de badge indisponible, réessayez.');

  const jeton = sec.badgeToken(user.id, numero, user.card_version);
  return {
    badgeNo: numero,
    holder: String(user.name || '').trim(),
    fonction: fonction(user),
    livree: livree(user),
    qr: `DOUIRA|B|${numero}|${jeton}`,
    since: user.created_at,
  };
}

module.exports = { ROLES_BADGE, BADGE_ADMIN, porteBadge, fonction, prochainNumero, livree, forUser };
