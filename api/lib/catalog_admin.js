/* =====================================================================
   Administration du catalogue en base (biens et activités) avec droits :
     - Biens (listings)   : admin, collaborateur, propriétaire (propriétaire = ses biens uniquement)
     - Activités (activities) : admin, agence (agence = ses activités uniquement)
   Chaque fonction reçoit l'utilisateur courant (session) et applique les droits.
   Logique pure (pas de HTTP) : testable directement avec DATABASE_URL.
   ===================================================================== */
'use strict';

/** Colonne jsonb lue comme tableau, qu'elle arrive en objet ou en texte. */
function jsonArr(v) {
  if (Array.isArray(v)) return v;
  try { const x = JSON.parse(v || '[]'); return Array.isArray(x) ? x : []; } catch (e) { return []; }
}
const db = require('./db');
const team = require('./team');

const LISTING_ROLES = ['admin', 'collaborator', 'owner'];
const ACTIVITY_ROLES = ['admin', 'agency', 'collaborator'];
const num = (v, d = 0) => (v === 0 || (v != null && v !== '' && !isNaN(Number(v)))) ? Number(v) : d;
const clampPct = v => Math.max(0, Math.min(90, Math.round(num(v, 0))));
// Une activité publiée doit offrir une réduction membre d'au moins ce pourcentage.
const MIN_ACTIVITY_PCT = 5;
const oneOf = (v, arr, d) => arr.includes(v) ? v : d;
function err(status, msg) { const e = new Error(msg); e.status = status; return e; }
// Pour une mise à jour partielle : prendre la valeur fournie si présente, sinon celle déjà en base, sinon le défaut.
const has = (d, k) => Object.prototype.hasOwnProperty.call(d, k) && d[k] != null && d[k] !== '';
// Une coordonnée est un nombre FINI dans sa plage, ou rien. `num` laissait passer
// « 1e999 » (Infinity) et 9999 : la carte de tous les visiteurs se cadrait dessus.
const coordOk = (v, max, nom) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > max) throw err(400, `${nom} doit être comprise entre -${max} et ${max}.`);
  return n;
};
const pick = (d, k, existingVal, def) => has(d, k) ? d[k] : (existingVal != null ? existingVal : def);

/* ---- Date, heure et téléphone d'une expérience (fonctions pures) ----

   Ces trois champs sont FACULTATIFS. Beaucoup d'expériences se tiennent tous
   les jours, et le numéro appartient à l'agence : rien n'est inventé, rien
   n'est rempli par défaut. Une saisie illisible est refusée avec son motif
   plutôt que corrigée en silence — l'agence doit savoir ce qui n'allait pas.

   Voir api/test/activity-contact.test.js. */

/** Jour de l'expérience, au format AAAA-MM-JJ. null = pas de date fixée. */
function dateExperience(v) {
  const s = typeof v === 'string' ? v.trim().slice(0, 10) : '';
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw err(400, 'Date invalide : attendu AAAA-MM-JJ.');
  const d = new Date(`${s}T00:00:00Z`);
  // Une date qui existe vraiment : « 2026-02-30 » passe la forme, pas le calendrier.
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw err(400, 'Cette date n\'existe pas.');
  }
  return s;
}

/** Heure de rendez-vous, « 09:30 ». '' quand elle n'est pas fixée. */
function heureExperience(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return '';
  const m = /^(\d{1,2})[:hH](\d{2})$/.exec(s);
  if (!m) throw err(400, 'Heure invalide : attendu HH:MM.');
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) throw err(400, 'Heure invalide : attendu HH:MM.');
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Numéro à appeler pour commander.
 *
 * On garde la forme saisie par l'agence — espaces compris, c'est ainsi qu'elle
 * l'écrit sur ses supports — mais on vérifie qu'elle contient un numéro
 * composable. L'appli le nettoie au moment de l'appel.
 */
function telephoneExperience(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return '';
  const chiffres = s.replace(/\D/g, '');
  if (chiffres.length < 8 || chiffres.length > 15) throw err(400, 'Numéro de téléphone invalide.');
  if (!/^\+?[\d\s().-]+$/.test(s)) throw err(400, 'Numéro de téléphone invalide.');
  return s.slice(0, 30);
}

/**
 * Détail des couchages : [{ name, beds }], tel qu'il s'affichera dans
 * « Où vous dormirez ».
 *
 * Ce champ vient d'un formulaire libre : on borne le nombre de pièces et la
 * longueur des textes, et on jette les lignes vides — un propriétaire qui
 * ajoute une pièce puis change d'avis ne doit pas publier une carte sans
 * contenu.
 */
const ROOMS_MAX = 12;
function normalizeRooms(list) {
  return (Array.isArray(list) ? list : [])
    .slice(0, ROOMS_MAX)
    .map(x => ({
      name: String((x && x.name) || '').trim().slice(0, 60),
      beds: String((x && x.beds) || '').trim().slice(0, 80),
    }))
    .filter(x => x.name || x.beds);
}

async function nextId(table, prefix) {
  const r = await db.one(`SELECT COALESCE(MAX((regexp_replace(id, '\\D', '', 'g'))::bigint), 0) + 1 AS n FROM ${table} WHERE id ~ ('^' || $1 || '[0-9]+$')`, [prefix]);
  return prefix + r.n;
}
function upsertSql(table, row) {
  const cols = Object.keys(row), ph = cols.map((_, i) => '$' + (i + 1)).join(', ');
  const set = cols.filter(c => c !== 'id').map(c => `${c} = EXCLUDED.${c}`).join(', ');
  return { sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph}) ON CONFLICT (id) DO UPDATE SET ${set} RETURNING *`, vals: cols.map(c => row[c]) };
}

/* ---------------- Biens ---------------- */
async function listListings(user) {
  if (!LISTING_ROLES.includes(user.role)) throw err(403, 'Accès refusé.');
  await team.requireGate(user, 'listings');
  if (user.role === 'owner') return (await db.query('SELECT * FROM listings WHERE owner_id = $1 ORDER BY created_at DESC', [user.id])).rows;
  return (await db.query('SELECT * FROM listings ORDER BY created_at DESC')).rows;
}
async function saveListing(user, data) {
  if (!LISTING_ROLES.includes(user.role)) throw err(403, 'Accès refusé.');
  await team.requireGate(user, 'listings');
  const d = data || {};
  const id = d.id && d.id !== 'new' ? String(d.id) : null;
  let existing = null;
  if (id) { existing = (await db.query('SELECT * FROM listings WHERE id = $1', [id])).rows[0]; if (!existing) throw err(404, 'Bien introuvable.'); }
  // Propriétaire : seulement ses propres biens, et il ne peut pas se les retirer
  if (user.role === 'owner' && existing && existing.owner_id !== user.id) throw err(403, 'Ce bien ne vous appartient pas.');
  const e = existing || {};
  // Le titre est obligatoire à la création ; sur mise à jour partielle on garde l'existant.
  const title = String(has(d, 'title') ? d.title : (e.title || '')).trim();
  if (!title) throw err(400, 'Le titre est obligatoire.');
  const ownerId = user.role === 'owner' ? user.id : (has(d, 'ownerId') ? d.ownerId : (e.owner_id || null));
  // Publication autorisée pour admin/collaborateur/propriétaire ; statut limité aux valeurs connues
  const status = oneOf(d.status, ['draft', 'published', 'archived'], e.status || 'draft');
  const amenities = Array.isArray(d.amenities) ? JSON.stringify(d.amenities.slice(0, 40).map(x => String(x).slice(0, 40))) : (e.amenities != null ? e.amenities : '[]');
  const photos = Array.isArray(d.photos) ? JSON.stringify(d.photos.slice(0, 20).map(x => String(x).replace(/\?.*$/, '').slice(0, 200))) : (e.photos != null ? e.photos : '[]');
  const row = {
    id: id || await nextId('listings', 'b'),
    category: oneOf(d.category, ['appartement', 'villa'], e.category || 'appartement'),
    status,
    owner_id: ownerId,
    management_mode: oneOf(d.managementMode, ['delegue', 'autonome'], e.management_mode || 'delegue'),
    title: title.slice(0, 120),
    title_en: String(pick(d, 'titleEn', e.title_en, '')).trim().slice(0, 120),
    description: String(pick(d, 'description', e.description, '')).slice(0, 4000),
    description_en: String(pick(d, 'descriptionEn', e.description_en, '')).slice(0, 4000),
    city: String(pick(d, 'city', e.city, 'Marrakech')).trim().slice(0, 80),
    area: String(pick(d, 'area', e.area, '')).trim().slice(0, 80),
    lat: has(d, 'lat') ? coordOk(d.lat, 90, 'La latitude') : (e.lat != null ? e.lat : null),
    lng: has(d, 'lng') ? coordOk(d.lng, 180, 'La longitude') : (e.lng != null ? e.lng : null),
    guests: Math.max(1, num(pick(d, 'guests', e.guests, 2), 2)),
    bedrooms: Math.max(0, num(pick(d, 'bedrooms', e.bedrooms, 0), 0)),
    bathrooms: Math.max(0, num(pick(d, 'bathrooms', e.bathrooms, 0), 0)),
    beds: Math.max(0, num(pick(d, 'beds', e.beds, 0), 0)),
    rooms: JSON.stringify(normalizeRooms(Array.isArray(d.rooms) ? d.rooms : jsonArr(e.rooms))),
    surface: has(d, 'surface') ? num(d.surface, null) : (e.surface != null ? e.surface : null),
    amenities,
    photos,
    owner_price: Math.max(0, Math.round(num(pick(d, 'ownerPrice', e.owner_price, 0), 0))),
    policy: oneOf(d.policy, ['flexible', 'moderee', 'stricte'], e.policy || 'moderee'),
    check_in: String(pick(d, 'checkIn', e.check_in, '15:00')).slice(0, 5),
    check_out: String(pick(d, 'checkOut', e.check_out, '11:00')).slice(0, 5),
    min_nights: Math.max(1, num(pick(d, 'minNights', e.min_nights, 1), 1)),
    registration_no: String(pick(d, 'registrationNo', e.registration_no, '')).trim().slice(0, 60),
    contact_phone: String(pick(d, 'contactPhone', e.contact_phone, '')).trim().slice(0, 40),
    diamond: has(d, 'diamond') ? !!d.diamond : !!e.diamond,
    discount_pct: has(d, 'discountPct') ? clampPct(d.discountPct) : (e.discount_pct || 0),
    discount_label: String(pick(d, 'discountLabel', e.discount_label, '')).trim().slice(0, 80),
    discount_from: has(d, 'discountFrom') ? d.discountFrom : (e.discount_from || null),
    discount_to: has(d, 'discountTo') ? d.discountTo : (e.discount_to || null),
    updated_at: new Date().toISOString(),
    published_at: status === 'published' ? (e.published_at || new Date().toISOString()) : (e.published_at || null)
  };
  const { sql, vals } = upsertSql('listings', row);
  const saved = (await db.query(sql, vals)).rows[0];
  // Le bien change de propriétaire : les conversations de réservation déjà
  // ouvertes suivent le bien, pas l'ancien hôte. Sinon il continuait de lire
  // les dates d'arrivée et les questions des clients d'un logement qui n'est
  // plus le sien, et le nouveau n'y était pas.
  if (existing && String(existing.owner_id || '') !== String(row.owner_id || '')) {
    await db.query("DELETE FROM conversation_members WHERE part = 'owner' AND conversation_id IN (SELECT id FROM conversations WHERE listing_id = $1)", [row.id]).catch(() => {});
    if (row.owner_id) {
      await db.query(`INSERT INTO conversation_members (conversation_id, user_id, part)
        SELECT id, $2, 'owner' FROM conversations WHERE listing_id = $1 ON CONFLICT DO NOTHING`, [row.id, row.owner_id]).catch(() => {});
    }
  }
  return saved;
}
async function publishListing(user, id, publish) {
  if (!LISTING_ROLES.includes(user.role)) throw err(403, 'Accès refusé.');
  await team.requireGate(user, 'listings');
  const l = (await db.query('SELECT * FROM listings WHERE id = $1', [id])).rows[0]; if (!l) throw err(404, 'Bien introuvable.');
  if (user.role === 'owner' && l.owner_id !== user.id) throw err(403, 'Ce bien ne vous appartient pas.');
  const status = publish ? 'published' : 'draft';
  const r = await db.query('UPDATE listings SET status = $2, published_at = COALESCE(published_at, $3), updated_at = now() WHERE id = $1 RETURNING *', [id, status, publish ? new Date().toISOString() : null]);
  return r.rows[0];
}

/* ---------------- Activités ---------------- */
async function listActivities(user) {
  if (!ACTIVITY_ROLES.includes(user.role)) throw err(403, 'Accès refusé.');
  await team.requireGate(user, 'activities');
  if (user.role === 'agency') return (await db.query('SELECT * FROM activities WHERE agency_id = $1 ORDER BY created_at DESC', [user.id])).rows;
  return (await db.query('SELECT * FROM activities ORDER BY created_at DESC')).rows;
}
async function saveActivity(user, data) {
  if (!ACTIVITY_ROLES.includes(user.role)) throw err(403, 'Accès refusé.');
  await team.requireGate(user, 'activities');
  const d = data || {};
  const id = d.id && d.id !== 'new' ? String(d.id) : null;
  let existing = null;
  if (id) { existing = (await db.query('SELECT * FROM activities WHERE id = $1', [id])).rows[0]; if (!existing) throw err(404, 'Activité introuvable.'); }
  if (user.role === 'agency' && existing && existing.agency_id !== user.id) throw err(403, 'Cette activité ne vous appartient pas.');
  const e = existing || {};
  const name = String(has(d, 'name') ? d.name : (e.name || '')).trim();
  if (!name) throw err(400, 'Le nom est obligatoire.');
  // Réduction membre -% obligatoire (à la création comme à la mise à jour, sinon on garde l'existant si fourni vide).
  const pct = has(d, 'pct') ? clampPct(d.pct) : (e.discount_pct || 0);
  if (!pct) throw err(400, 'La réduction membre en pourcentage est obligatoire.');
  const agencyId = user.role === 'agency' ? user.id : (has(d, 'agencyId') ? d.agencyId : (e.agency_id || null));
  const row = {
    id: id || await nextId('activities', 'a'),
    name: name.slice(0, 100),
    category: oneOf(d.cat, ['culture', 'souks', 'gastronomie', 'bienetre', 'excursions', 'sport', 'pratique'], e.category || 'culture'),
    status: oneOf(d.status, ['draft', 'published', 'archived'], e.status || 'draft'),
    agency_id: agencyId,
    agency_name: String(pick(d, 'agencyName', e.agency_name, user.name || '')).slice(0, 120),
    agency_desc: String(pick(d, 'agencyDesc', e.agency_desc, '')).slice(0, 400),
    lat: has(d, 'lat') ? coordOk(d.lat, 90, 'La latitude') : (e.lat != null ? e.lat : null),
    lng: has(d, 'lng') ? coordOk(d.lng, 180, 'La longitude') : (e.lng != null ? e.lng : null),
    price: has(d, 'price') ? Math.max(0, Math.round(num(d.price, 0))) : (e.price != null ? e.price : null),
    discount_pct: pct,
    note: String(pick(d, 'note', e.note, '')).slice(0, 200),
    parcours: String(pick(d, 'parcours', e.parcours, '')).slice(0, 1000),
    photo: String(pick(d, 'photo', e.photo, '')).replace(/\?.*$/, '').slice(0, 200),
    // Quand et à quel numéro : facultatifs, jamais inventés.
    starts_on: has(d, 'startsOn') ? dateExperience(d.startsOn)
      : (Object.prototype.hasOwnProperty.call(d, 'startsOn') ? null : (e.starts_on || null)),
    starts_at: Object.prototype.hasOwnProperty.call(d, 'startsAt') ? heureExperience(d.startsAt) : (e.starts_at || ''),
    phone: Object.prototype.hasOwnProperty.call(d, 'phone') ? telephoneExperience(d.phone) : (e.phone || ''),
    updated_at: new Date().toISOString()
  };
  // On ne publie pas une activité sans réduction membre suffisante.
  if (row.status === 'published' && row.discount_pct < MIN_ACTIVITY_PCT) throw err(400, `Une activité publiée doit offrir au moins ${MIN_ACTIVITY_PCT} % de réduction membre.`);
  const { sql, vals } = upsertSql('activities', row);
  return (await db.query(sql, vals)).rows[0];
}
async function publishActivity(user, id, publish) {
  if (!ACTIVITY_ROLES.includes(user.role)) throw err(403, 'Accès refusé.');
  await team.requireGate(user, 'activities');
  const a = (await db.query('SELECT * FROM activities WHERE id = $1', [id])).rows[0]; if (!a) throw err(404, 'Activité introuvable.');
  if (user.role === 'agency' && a.agency_id !== user.id) throw err(403, 'Cette activité ne vous appartient pas.');
  if (publish && Number(a.discount_pct || 0) < MIN_ACTIVITY_PCT) throw err(400, `Une activité publiée doit offrir au moins ${MIN_ACTIVITY_PCT} % de réduction membre.`);
  const r = await db.query('UPDATE activities SET status = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, publish ? 'published' : 'draft']);
  return r.rows[0];
}

module.exports = {
  listListings, saveListing, publishListing, listActivities, saveActivity, publishActivity,
  LISTING_ROLES, ACTIVITY_ROLES, normalizeRooms, ROOMS_MAX,
  // règles pures
  dateExperience, heureExperience, telephoneExperience,
};
