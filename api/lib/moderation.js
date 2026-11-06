/* =====================================================================
   Modération : bloquer une personne, signaler un contenu, filtrer les mots.

   Règles pures en haut (testables sans base), accès base en bas.

   CE QUE « BLOQUER » VEUT DIRE ICI. Celui qui bloque ne voit plus les
   messages ni les avis de l'autre, et l'autre ne peut plus lui écrire. On ne
   dit pas à la personne bloquée qu'elle l'est : son message est refusé avec
   un motif neutre. Le blocage est symétrique pour l'écriture (aucun des deux
   n'écrit à l'autre) et asymétrique pour la lecture (seul celui qui a bloqué
   est protégé de ce qu'il lit).

   CE QUE LE FILTRE DE MOTS FAIT, ET NE FAIT PAS. Il arrête les insultes les
   plus franches avant qu'elles ne soient publiées, en français et en anglais,
   sur le texte normalisé (sans accents, sans ponctuation entre les lettres).
   Il ne remplace pas l'équipe : tout ce qu'il laisse passer peut être signalé.
   ===================================================================== */
'use strict';
const db = require('./db');

function err(status, msg) { const e = new Error(msg); e.status = status; return e; }

/* ---------------- Règles pures ---------------- */

/**
 * Mots refusés, en forme normalisée (minuscules, sans accent). Une liste
 * courte et franche : des insultes, pas des sujets. On l'allonge en ajoutant
 * une ligne ; on ne l'alourdit pas avec des mots ordinaires qui auraient un
 * usage innocent.
 */
const MOTS_REFUSES = [
  // français
  'connard', 'connasse', 'enculé', 'encule', 'salope', 'pute', 'putain de ta', 'fils de pute', 'fdp', 'nique ta', 'ntm',
  'pd', 'tapette', 'bougnoule', 'negre', 'négro', 'sale arabe', 'sale juif', 'sale noir',
  // anglais
  'fuck you', 'motherfucker', 'bitch', 'cunt', 'nigger', 'faggot', 'retard',
].map(normaliser);

/** Minuscules, sans accents, un seul espace entre les mots. */
function normaliser(texte) {
  return String(texte || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Le texte contient-il un mot refusé ? Renvoie le mot trouvé, ou null.
 * On cherche des MOTS entiers : « pdf » ne contient pas « pd ».
 */
function motRefuse(texte) {
  const n = ' ' + normaliser(texte) + ' ';
  for (const m of MOTS_REFUSES) {
    if (m && n.includes(' ' + m + ' ')) return m;
  }
  return null;
}

/** Lève 400 si le texte ne peut pas être publié. */
function exigerPublicable(texte) {
  const m = motRefuse(texte);
  if (m) throw err(400, 'Ce message contient des propos qui ne peuvent pas être publiés. Reformulez-le.');
}

const KINDS = ['message', 'review', 'conversation', 'user'];
const STATUTS = ['open', 'reviewed', 'dismissed'];

/* ---------------- Accès base ---------------- */

/** Identifiants des personnes que `userId` a bloquées. */
async function bloquesPar(userId) {
  const r = await db.query('SELECT blocked_id FROM user_blocks WHERE blocker_id = $1', [userId]);
  return r.rows.map(x => String(x.blocked_id));
}

/** L'un des deux a-t-il bloqué l'autre ? (Aucun ne peut alors écrire à l'autre.) */
async function bloqueEntre(a, b) {
  if (!a || !b || String(a) === String(b)) return false;
  const r = await db.one(
    'SELECT 1 AS x FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1',
    [a, b]);
  return !!r;
}

async function bloquer(userId, cibleId) {
  if (!cibleId || String(cibleId) === String(userId)) throw err(400, 'Vous ne pouvez pas vous bloquer vous-même.');
  const u = await db.one('SELECT id, role FROM users WHERE id = $1 AND deleted_at IS NULL', [cibleId]);
  if (!u) throw err(404, 'Compte introuvable.');
  // Le service client ne se bloque pas : c'est la voie de recours.
  if (u.role === 'admin') throw err(400, 'Le service client ne peut pas être bloqué. Signalez plutôt le problème.');
  await db.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, cibleId]);
  return { ok: true };
}

async function debloquer(userId, cibleId) {
  await db.query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [userId, cibleId]);
  return { ok: true };
}

/** Les personnes bloquées, avec un prénom pour les reconnaître. */
async function listerBloques(userId) {
  const r = await db.query(
    `SELECT b.blocked_id, b.at, u.name FROM user_blocks b JOIN users u ON u.id = b.blocked_id
      WHERE b.blocker_id = $1 ORDER BY b.at DESC`, [userId]);
  return r.rows.map(x => ({
    id: String(x.blocked_id),
    name: String(x.name || '').trim().split(/\s+/)[0] || 'Compte',
    since: x.at,
  }));
}

/**
 * Signaler un contenu. On retrouve la personne derrière le contenu nous-mêmes :
 * l'appelant ne peut pas désigner n'importe qui.
 */
async function signaler(userId, body) {
  const b = body || {};
  const kind = KINDS.includes(b.kind) ? b.kind : null;
  if (!kind) throw err(400, 'Nature du signalement inconnue.');
  const targetId = String(b.targetId || '').trim().slice(0, 40);
  if (!targetId) throw err(400, 'Contenu à signaler manquant.');
  const reason = String(b.reason || '').trim().slice(0, 1000);

  let targetUser = null;
  if (kind === 'message') {
    const m = await db.one(
      `SELECT m.sender_id FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
        WHERE m.id = $1 AND cm.user_id = $2`, [targetId, userId]);
    if (!m) throw err(404, 'Message introuvable.');
    targetUser = m.sender_id;
  } else if (kind === 'review') {
    const v = await db.one('SELECT author_id FROM reviews WHERE id = $1', [targetId]);
    if (!v) throw err(404, 'Avis introuvable.');
    targetUser = v.author_id;
  } else if (kind === 'conversation') {
    const membre = await db.one('SELECT 1 AS x FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [targetId, userId]);
    if (!membre) throw err(404, 'Conversation introuvable.');
    // L'autre personne du fil, quand il n'y en a qu'une.
    const autres = await db.query(
      "SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2 AND part <> 'support'", [targetId, userId]);
    targetUser = autres.rows.length === 1 ? autres.rows[0].user_id : null;
  } else {
    const u = await db.one('SELECT id FROM users WHERE id = $1', [targetId]);
    if (!u) throw err(404, 'Compte introuvable.');
    targetUser = u.id;
  }
  if (targetUser && String(targetUser) === String(userId)) throw err(400, 'Vous ne pouvez pas vous signaler vous-même.');

  const r = await db.one(
    `INSERT INTO reports (reporter_id, kind, target_id, target_user_id, reason)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, at`,
    [userId, kind, targetId, targetUser, reason]);
  return { id: String(r.id), at: r.at };
}

/** Les signalements, pour l'équipe : les ouverts d'abord, puis les traités. */
async function listerSignalements(statut) {
  const s = STATUTS.includes(statut) ? statut : 'open';
  const r = await db.query(
    `SELECT r.*, a.name AS reporter_name, t.name AS target_name,
            CASE WHEN r.kind = 'message' THEN (SELECT body FROM messages WHERE id::text = r.target_id)
                 WHEN r.kind = 'review'  THEN (SELECT comment FROM reviews WHERE id::text = r.target_id)
                 ELSE '' END AS extrait
       FROM reports r
       LEFT JOIN users a ON a.id = r.reporter_id
       LEFT JOIN users t ON t.id = r.target_user_id
      WHERE r.status = $1
      ORDER BY r.at DESC LIMIT 200`, [s]);
  return r.rows.map(x => ({
    id: String(x.id), kind: x.kind, targetId: x.target_id, reason: x.reason, status: x.status, note: x.note, at: x.at,
    reporter: x.reporter_name || 'Compte supprimé', reporterId: x.reporter_id,
    target: x.target_name || (x.target_user_id ? 'Compte supprimé' : ''), targetUserId: x.target_user_id,
    extrait: String(x.extrait || '').slice(0, 300),
    reviewedAt: x.reviewed_at,
  }));
}

/** L'équipe tranche : traité, ou classé sans suite. */
async function traiter(adminId, id, statut, note) {
  const s = STATUTS.includes(statut) ? statut : 'reviewed';
  const r = await db.one(
    `UPDATE reports SET status = $2, note = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1 RETURNING id`,
    [id, s, String(note || '').trim().slice(0, 1000), adminId]);
  if (!r) throw err(404, 'Signalement introuvable.');
  return { ok: true };
}

module.exports = {
  // règles pures
  MOTS_REFUSES, normaliser, motRefuse, exigerPublicable, KINDS, STATUTS,
  // base
  bloquesPar, bloqueEntre, bloquer, debloquer, listerBloques, signaler, listerSignalements, traiter,
};
