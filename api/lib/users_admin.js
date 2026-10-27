/* =====================================================================
   Administration des comptes (réservée à l'administrateur).
   L'admin crée/invite les comptes propriétaire, collaborateur, agence (ou client),
   peut suspendre/réactiver, changer le rôle et renvoyer une invitation.
   Un compte créé est en statut « invite » : il n'a pas de mot de passe utilisable ;
   la personne choisit le sien via un lien d'invitation (table password_resets),
   ce qui active le compte (voir la route /api/auth/reset).
   Logique pure (pas de HTTP) : testable directement avec DATABASE_URL.
   ===================================================================== */
'use strict';
const db = require('./db');
const sec = require('./security');

const ASSIGNABLE_ROLES = ['client', 'owner', 'collaborator', 'agency']; // l'admin n'attribue pas le rôle admin
const INVITE_DAYS = 7;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const str = (v, max) => (typeof v === 'string' ? v : '').trim().slice(0, max);
function err(status, msg) { const e = new Error(msg); e.status = status; return e; }
function requireAdmin(user) { if (!user || user.role !== 'admin') throw err(403, 'Accès refusé.'); }

const view = u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone || '', role: u.role, status: u.status, description: u.description || '', createdAt: u.created_at, invitedBy: u.invited_by, invitedByName: u.invited_by_name || null, mustChangePassword: !!u.must_change_password });

async function listUsers(admin) {
  requireAdmin(admin);
  const r = await db.query("SELECT u.*, inv.name AS invited_by_name FROM users u LEFT JOIN users inv ON inv.id = u.invited_by WHERE u.deleted_at IS NULL ORDER BY u.created_at DESC");
  return r.rows.map(view);
}

// Crée un lien d'invitation (jeton de réinitialisation) valable INVITE_DAYS jours. Renvoie le jeton en clair (à mettre dans l'URL).
async function makeInviteToken(userId) {
  const tok = sec.token(32);
  await db.query(`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`, [sec.sha256(tok), userId, INVITE_DAYS]);
  return tok;
}

async function createUser(admin, data) {
  requireAdmin(admin);
  const d = data || {};
  const name = str(d.name, 80), email = str(d.email, 254).toLowerCase(), phone = str(d.phone, 30);
  const role = ASSIGNABLE_ROLES.includes(d.role) ? d.role : null;
  if (name.length < 2) throw err(400, 'Indiquez le nom de la personne.');
  if (!EMAIL.test(email)) throw err(400, 'Adresse e-mail invalide.');
  if (!role) throw err(400, 'Choisissez un rôle (propriétaire, collaborateur, agence ou client).');
  const exists = await db.one('SELECT id, deleted_at FROM users WHERE email = $1', [email]);
  if (exists) throw err(409, 'Un compte existe déjà avec cette adresse.');
  // Mot de passe inutilisable : la personne choisira le sien via le lien d'invitation.
  const u = await db.one(
    `INSERT INTO users (email, name, phone, role, pass_hash, consent_at, status, must_change_password, invited_by, description)
     VALUES ($1, $2, $3, $4, $5, now(), 'invite', true, $6, $7) RETURNING *`,
    [email, name, phone, role, sec.hashPassword(sec.token(32)), admin.id, str(d.description, 400)]);
  const token = await makeInviteToken(u.id);
  return { user: view(u), token };
}

// Renvoyer une invitation (nouveau lien). Possible tant que le compte n'a pas encore choisi de mot de passe (statut invite).
async function reinvite(admin, id) {
  requireAdmin(admin);
  const u = await db.one('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!u) throw err(404, 'Compte introuvable.');
  if (u.role === 'admin') throw err(403, 'Compte administrateur : non modifiable ici.');
  const token = await makeInviteToken(u.id);
  return { user: view(u), token };
}

async function setStatus(admin, id, status) {
  requireAdmin(admin);
  if (!['actif', 'suspendu'].includes(status)) throw err(400, 'Statut invalide.');
  if (id === admin.id) throw err(400, 'Vous ne pouvez pas changer votre propre statut.');
  const u = await db.one('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!u) throw err(404, 'Compte introuvable.');
  if (u.role === 'admin') throw err(403, 'Un compte administrateur ne peut pas être suspendu ici.');
  const r = await db.query('UPDATE users SET status = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, status]);
  if (status === 'suspendu') await db.query('DELETE FROM sessions WHERE user_id = $1', [id]); // couper les sessions en cours
  return view(r.rows[0]);
}

async function setRole(admin, id, role) {
  requireAdmin(admin);
  if (!ASSIGNABLE_ROLES.includes(role)) throw err(400, 'Rôle invalide.');
  if (id === admin.id) throw err(400, 'Vous ne pouvez pas changer votre propre rôle.');
  const u = await db.one('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!u) throw err(404, 'Compte introuvable.');
  if (u.role === 'admin') throw err(403, 'Un compte administrateur ne peut pas être rétrogradé ici.');
  const r = await db.query('UPDATE users SET role = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, role]);
  return view(r.rows[0]);
}

module.exports = { listUsers, createUser, reinvite, setStatus, setRole, ASSIGNABLE_ROLES, INVITE_DAYS };
