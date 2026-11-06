/* =====================================================================
   Répartition des tâches dans l'équipe.

   L'administrateur confie des PÉRIMÈTRES (« scopes ») aux collaborateurs : il
   peut les répartir, ou tout confier à une seule personne. Un collaborateur
   peut être désigné CHEF D'ÉQUIPE : il répartit alors à son tour, mais
   uniquement les périmètres qu'il détient lui-même (pas d'élévation de
   privilège), et peut désigner un autre chef d'équipe.

   Règles pures (sans base ni HTTP) en haut, accès base en bas.
   ===================================================================== */
'use strict';
const db = require('./db');

/** Périmètres délégables. */
const SCOPES = ['listings', 'activities', 'services', 'support', 'bookings', 'team', 'destinations', 'vehicles'];

const SCOPE_LABEL = {
  listings: 'Logements',
  activities: 'Expériences',
  services: 'Services',
  support: 'Service client',
  bookings: 'Réservations',
  team: 'Équipe',
  destinations: 'Destinations',
  vehicles: 'Voitures et motos',
};

function err(status, msg) { const e = new Error(msg); e.status = status; return e; }

/* ---------------- Règles pures ---------------- */

const isAdmin = u => !!u && u.role === 'admin';
const isLead = u => !!u && u.role === 'collaborator' && !!u.team_lead;

/** L'acteur détient-il ce périmètre ? L'administrateur les détient tous. */
function hasScope(actor, scopes, scope) {
  if (isAdmin(actor)) return true;
  if (!actor || actor.role !== 'collaborator') return false;
  return Array.isArray(scopes) && scopes.includes(scope);
}

/**
 * L'acteur peut-il CONFIER ce périmètre à quelqu'un ?
 * - l'administrateur : tout ;
 * - un chef d'équipe : uniquement ce qu'il détient déjà ;
 * - les autres : rien.
 */
function canGrant(actor, actorScopes, scope) {
  if (!SCOPES.includes(scope)) return false;
  if (isAdmin(actor)) return true;
  if (!isLead(actor)) return false;
  return Array.isArray(actorScopes) && actorScopes.includes(scope);
}

/**
 * Filtre appliqué AUX ROUTES EXISTANTES, qui gardent par ailleurs leur contrôle de
 * rôle. Il ne fait que RESTREINDRE les collaborateurs : un propriétaire ou une
 * agence n'est pas concerné (sa propre logique de rôle décide), et l'administrateur
 * passe toujours. On ne peut donc jamais élargir un accès par mégarde.
 */
function scopeGate(actor, scopes, scope) {
  if (!actor) return false;
  if (actor.role === 'admin') return true;
  if (actor.role === 'collaborator') return Array.isArray(scopes) && scopes.includes(scope);
  return true; // propriétaire, agence… : la règle de rôle existante s'applique
}

/** L'acteur peut-il désigner (ou retirer) un chef d'équipe ? */
function canDesignateLead(actor) {
  return isAdmin(actor) || isLead(actor);
}

/**
 * L'acteur peut-il agir sur ce compte ?
 * On ne touche ni à un compte administrateur, ni au sien propre.
 */
function canManage(actor, target) {
  if (!actor || !target) return false;
  if (target.role === 'admin') return false;
  if (target.id === actor.id) return false;
  if (target.role !== 'collaborator') return false;
  return isAdmin(actor) || isLead(actor);
}

/**
 * Un service est-il proposé à ce rôle ?
 * Les clients et les propriétaires ne voient pas les mêmes services, sauf ceux
 * marqués « both » par l'équipe.
 */
function audienceFor(role) {
  if (role === 'owner' || role === 'agency') return 'owner';
  return 'client';
}
function serviceVisibleTo(service, role) {
  if (!service) return false;
  if (service.status !== 'published') return false;
  const mine = audienceFor(role);
  return service.audience === 'both' || service.audience === mine;
}

/* ---------------- Accès base ---------------- */

async function scopesOf(userId) {
  const r = await db.query('SELECT scope FROM collaborator_scopes WHERE user_id = $1', [userId]);
  return r.rows.map(x => x.scope);
}

/** Acteur + ses périmètres, pour les contrôles d'accès des routes. */
async function actorWithScopes(user) {
  if (!user) return { actor: null, scopes: [] };
  if (user.role !== 'collaborator') return { actor: user, scopes: [] };
  return { actor: user, scopes: await scopesOf(user.id) };
}

/** Garde-fou de route : exige un périmètre (l'admin passe toujours). */
async function requireScope(user, scope) {
  const { actor, scopes } = await actorWithScopes(user);
  if (!hasScope(actor, scopes, scope)) throw err(403, 'Ce périmètre ne vous a pas été confié.');
  return { actor, scopes };
}

/** Variante pour les routes existantes : ne restreint que les collaborateurs. */
async function requireGate(user, scope) {
  const { actor, scopes } = await actorWithScopes(user);
  if (!scopeGate(actor, scopes, scope)) {
    throw err(403, `Le périmètre « ${SCOPE_LABEL[scope] || scope} » ne vous a pas été confié.`);
  }
  return { actor, scopes };
}

/** L'équipe : collaborateurs, leurs périmètres et leur qualité de chef d'équipe. */
async function listTeam() {
  const r = await db.query(
    `SELECT u.id, u.name, u.email, u.status, u.team_lead,
            COALESCE(array_agg(cs.scope ORDER BY cs.scope) FILTER (WHERE cs.scope IS NOT NULL), '{}') AS scopes
       FROM users u LEFT JOIN collaborator_scopes cs ON cs.user_id = u.id
      WHERE u.role = 'collaborator' AND u.deleted_at IS NULL
   GROUP BY u.id ORDER BY u.team_lead DESC, u.name`);
  return r.rows.map(x => ({
    id: x.id, name: x.name, email: x.email, status: x.status,
    teamLead: !!x.team_lead, scopes: x.scopes || [],
  }));
}

/** Remplace les périmètres d'un collaborateur par ceux demandés. */
async function setScopes(user, targetId, wanted) {
  const { actor, scopes } = await actorWithScopes(user);
  const target = await db.one("SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL", [targetId]);
  if (!target) throw err(404, 'Compte introuvable.');
  if (!canManage(actor, target)) throw err(403, 'Vous ne pouvez pas modifier ce compte.');

  const list = Array.isArray(wanted) ? [...new Set(wanted.filter(s => SCOPES.includes(s)))] : [];
  const current = await scopesOf(targetId);
  const toAdd = list.filter(s => !current.includes(s));
  const toRemove = current.filter(s => !list.includes(s));

  // Un chef d'équipe ne peut confier (ni reprendre) que ce qu'il détient lui-même.
  for (const s of [...toAdd, ...toRemove]) {
    if (!canGrant(actor, scopes, s)) {
      throw err(403, `Vous ne pouvez pas confier le périmètre « ${SCOPE_LABEL[s] || s} » : vous ne le détenez pas.`);
    }
  }
  for (const s of toAdd) {
    await db.query('INSERT INTO collaborator_scopes (user_id, scope, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [targetId, s, actor.id]);
  }
  if (toRemove.length) {
    await db.query('DELETE FROM collaborator_scopes WHERE user_id = $1 AND scope = ANY($2)', [targetId, toRemove]);
  }
  return listTeam();
}

/** Désigne (ou retire) un chef d'équipe. */
async function setTeamLead(user, targetId, lead) {
  const { actor } = await actorWithScopes(user);
  if (!canDesignateLead(actor)) throw err(403, 'Seul un administrateur ou un chef d\'équipe peut désigner.');
  const target = await db.one("SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL", [targetId]);
  if (!target) throw err(404, 'Compte introuvable.');
  if (!canManage(actor, target)) throw err(403, 'Vous ne pouvez pas modifier ce compte.');
  await db.query('UPDATE users SET team_lead = $2, updated_at = now() WHERE id = $1', [targetId, !!lead]);
  return listTeam();
}

module.exports = {
  SCOPES, SCOPE_LABEL,
  // règles pures
  hasScope, scopeGate, canGrant, canDesignateLead, canManage, audienceFor, serviceVisibleTo,
  // base
  scopesOf, actorWithScopes, requireScope, requireGate, listTeam, setScopes, setTeamLead,
};
