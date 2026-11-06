/* =====================================================================
   Pièces justificatives des clients (loi 09-08).

   - Séjour   : une pièce d'identité (CIN ou passeport) — déclaration des voyageurs.
   - Véhicule : en plus, le permis de conduire.

   Le numéro et l'image sont CHIFFRÉS (clé DATA_KEY, comme les adresses et codes
   d'accès). L'image est effacée automatiquement à l'échéance ; la vérification,
   elle, est conservée pour prouver que l'obligation a été remplie.

   Règles pures en haut (testables sans base), accès base en bas.
   ===================================================================== */
'use strict';
const db = require('./db');
const sec = require('./security');

const KINDS = ['cin', 'passeport', 'permis'];
const KIND_LABEL = { cin: 'Carte d\'identité nationale', passeport: 'Passeport', permis: 'Permis de conduire' };
/** Pièces d'identité acceptées : l'une OU l'autre suffit. */
const IDENTITY = ['cin', 'passeport'];
/** Durée de conservation de l'image après la fin du séjour. */
const KEEP_DAYS = 90;
/** Taille maximale d'une image transmise (en base64). */
const MAX_FILE = 2 * 1024 * 1024;

function err(status, msg) { const e = new Error(msg); e.status = status; return e; }

/* ---------------- Règles pures ---------------- */

/** Un document est-il valable aujourd'hui ? (vérifié, et non expiré) */
function isUsable(doc) {
  return !!doc && doc.status === 'verified';
}

/**
 * Pièces exigées pour une réservation.
 * Toujours une pièce d'identité ; le permis en plus si un véhicule est loué.
 */
function requiredKinds(withVehicle) {
  return withVehicle ? ['identity', 'permis'] : ['identity'];
}

/**
 * Ce qui manque au dossier, parmi les pièces exigées.
 * `docs` : les documents de la personne. Renvoie une liste d'exigences non remplies.
 */
function missing(docs, withVehicle) {
  const list = Array.isArray(docs) ? docs : [];
  const out = [];
  for (const need of requiredKinds(withVehicle)) {
    if (need === 'identity') {
      const ok = list.some(d => IDENTITY.includes(d.kind) && isUsable(d));
      if (!ok) out.push('identity');
    } else if (!list.some(d => d.kind === need && isUsable(d))) {
      out.push(need);
    }
  }
  return out;
}

/** Message lisible expliquant ce qui bloque. */
function missingLabel(missingList) {
  const parts = (missingList || []).map(m =>
    m === 'identity' ? 'une pièce d\'identité (CIN ou passeport)' : KIND_LABEL[m] ? KIND_LABEL[m].toLowerCase() : m);
  if (!parts.length) return '';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} et ${parts[parts.length - 1]}`;
}

/** Une image transmise est-elle acceptable ? (format et taille) */
function checkFile(dataUrl) {
  if (dataUrl === undefined || dataUrl === null || dataUrl === '') return { ok: true, data: null, mime: '' };
  if (typeof dataUrl !== 'string') return { ok: false, reason: 'Image invalide.' };
  const m = /^data:(image\/(?:jpeg|jpg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!m) return { ok: false, reason: 'Format accepté : photo JPEG, PNG, WebP ou PDF.' };
  if (m[2].length > MAX_FILE) return { ok: false, reason: 'Fichier trop lourd (2 Mo maximum).' };
  return { ok: true, data: m[2], mime: m[1] };
}

/* ---------------- Accès base ---------------- */

/** Vue sûre : jamais le numéro en clair, jamais l'image. */
const view = r => ({
  id: String(r.id), kind: r.kind, label: KIND_LABEL[r.kind] || r.kind,
  status: r.status, note: r.note,
  hasFile: !!r.file_enc,
  reviewedAt: r.reviewed_at, createdAt: r.created_at, expiresAt: r.expires_at,
});

async function listMine(userId) {
  const r = await db.query('SELECT * FROM client_documents WHERE user_id = $1 ORDER BY kind', [userId]);
  return r.rows.map(view);
}

/** Dépose (ou remplace) une pièce. Elle repasse en attente de vérification. */
async function submit(user, data) {
  const d = data || {};
  if (!KINDS.includes(d.kind)) throw err(400, 'Type de pièce inconnu.');
  const number = (typeof d.number === 'string' ? d.number : '').trim().slice(0, 40);
  if (number.length < 4) throw err(400, 'Indiquez le numéro de la pièce.');
  const file = checkFile(d.file);
  if (!file.ok) throw err(400, file.reason);

  const r = await db.one(
    `INSERT INTO client_documents (user_id, kind, number_enc, file_enc, mime, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', now() + make_interval(days => $6))
     ON CONFLICT (user_id, kind) DO UPDATE SET
       number_enc = EXCLUDED.number_enc, file_enc = EXCLUDED.file_enc, mime = EXCLUDED.mime,
       status = 'pending', note = '', reviewed_by = NULL, reviewed_at = NULL,
       expires_at = EXCLUDED.expires_at, updated_at = now()
     RETURNING *`,
    [user.id, d.kind, sec.encrypt(number), file.data ? sec.encrypt(file.data) : null, file.mime, KEEP_DAYS]);
  return view(r);
}

async function remove(user, kind) {
  if (!KINDS.includes(kind)) throw err(400, 'Type de pièce inconnu.');
  await db.query('DELETE FROM client_documents WHERE user_id = $1 AND kind = $2', [user.id, kind]);
  return listMine(user.id);
}

/** Ce qui manque à une personne pour réserver (avec ou sans véhicule). */
async function missingFor(userId, withVehicle) {
  const r = await db.query('SELECT kind, status FROM client_documents WHERE user_id = $1', [userId]);
  return missing(r.rows, withVehicle);
}

/* ---------------- Vérification par l'équipe ---------------- */

async function listPending() {
  const r = await db.query(
    `SELECT d.*, u.name AS client_name FROM client_documents d JOIN users u ON u.id = d.user_id
      WHERE d.status = 'pending' ORDER BY d.created_at LIMIT 200`);
  return r.rows.map(x => Object.assign(view(x), { clientName: x.client_name }));
}

/**
 * Image d'une pièce, en clair, pour un usage INTERNE au serveur.
 *
 * Aucune route ne l'expose : elle sert à la comparaison faciale automatique,
 * qui a besoin du portrait sans qu'aucun humain ne le regarde. Rend null
 * plutôt que de lever quand l'image a été purgée — l'appelant décidera.
 */
async function imageFor(id) {
  const r = await db.one('SELECT file_enc, mime FROM client_documents WHERE id = $1', [id]);
  if (!r || !r.file_enc) return null;
  try { return { data: sec.decrypt(r.file_enc), mime: r.mime || 'image/jpeg' }; }
  catch (e) { return null; }
}

/** Image et numéro en clair, pour la seule vérification par l'équipe habilitée.
    Le numéro ne sort QUE par ici — pièce par pièce, et la consultation est
    tracée —, jamais dans la liste d'attente. */
async function fileFor(id) {
  // UNIQUEMENT les pièces en attente de décision : c'est le seul besoin métier.
  // Sans ce filtre, l'identifiant étant séquentiel, une simple boucle rapatriait
  // toutes les pièces jamais déposées, y compris celles déjà vérifiées.
  const r = await db.one(
    "SELECT file_enc, mime, number_enc FROM client_documents WHERE id = $1 AND status = 'pending'", [id]);
  if (!r || !r.file_enc) throw err(404, 'Aucune pièce en attente sous cet identifiant.');
  let number = '';
  try { number = r.number_enc ? sec.decrypt(r.number_enc) : ''; }
  catch (e) { number = ''; } // un numéro illisible ne doit pas cacher l'image
  try {
    return { mime: r.mime || 'image/jpeg', data: sec.decrypt(r.file_enc), number };
  } catch (e) {
    throw err(500, 'Déchiffrement impossible (DATA_KEY ?).');
  }
}

async function review(reviewer, id, status, note) {
  if (!['verified', 'rejected'].includes(status)) throw err(400, 'Décision invalide.');
  const r = await db.one(
    `UPDATE client_documents SET status = $2, note = $3, reviewed_by = $4, reviewed_at = now(), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, status, (typeof note === 'string' ? note : '').trim().slice(0, 300), reviewer.id]);
  if (!r) throw err(404, 'Pièce introuvable.');
  return view(r);
}

module.exports = {
  KINDS, KIND_LABEL, IDENTITY, KEEP_DAYS, MAX_FILE,
  // règles pures
  isUsable, requiredKinds, missing, missingLabel, checkFile,
  // base
  listMine, submit, remove, missingFor, listPending, fileFor, imageFor, review,
};
