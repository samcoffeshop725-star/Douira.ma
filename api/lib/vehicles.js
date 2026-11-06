/* =====================================================================
   Voitures et motos proposées à la location.

   Même organisation que les services : catalogue public filtré par ville, et
   administration réservée au périmètre « vehicles » (l'admin l'a toujours, un
   collaborateur seulement si on le lui a confié).
   ===================================================================== */
'use strict';
const db = require('./db');
const team = require('./team');

const KINDS = ['voiture', 'moto'];
const GEARBOXES = ['', 'manuelle', 'automatique'];
const STATUSES = ['draft', 'published', 'archived'];

function err(status, msg) { const e = new Error(msg); e.status = status; return e; }
const str = (v, max) => (typeof v === 'string' ? v : '').trim().slice(0, max);
const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);
// Le numéro d'un loueur se valide comme celui d'une agence d'expérience : même
// exigence, même message d'erreur. Une seule règle pour une seule chose.
const { telephoneExperience: telephoneValide } = require('./catalog_admin');
// La vignette se valide comme celle d'un service : un chemin servi par le
// site, ou une image déposée depuis l'appli. Sans cela, une agence qui n'a
// aucun accès au serveur ne pourrait jamais illustrer son véhicule.
const { photoValide } = require('./services');
const int = v => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Math.max(0, Math.round(Number(v))));

/** Liste JSON gardée en texte ; une colonne abîmée ne vide pas la fiche. */
function jsonArr(v) {
  if (Array.isArray(v)) return v.map(String);
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}

/**
 * Nettoie une liste saisie par l'équipe (photos, équipements).
 *
 * Accepte un tableau ou un texte à lignes : l'écran d'administration a un
 * champ multiligne, pas un tableau.
 */
function normaliserListe(v, max, longueur) {
  const brut = Array.isArray(v) ? v.filter((x) => typeof x === 'string') : String(v || '').split('\n');
  return brut.map((x) => x.trim().slice(0, longueur)).filter(Boolean).slice(0, max);
}

const PHOTOS_MAX = 10;
const EQUIPEMENTS_MAX = 14;

const view = r => ({
  id: r.id, name: r.name, kind: r.kind, city: r.city,
  pricePerDay: Number(r.price_per_day || 0), deposit: Number(r.deposit || 0),
  seats: r.seats == null ? null : Number(r.seats), gearbox: r.gearbox,
  specs: r.specs, photo: r.photo, status: r.status,
  description: r.description || '',
  // La vignette ouvre la galerie : si personne n'a mis de galerie, elle en
  // tient lieu plutôt que de laisser la fiche sans image.
  photos: jsonArr(r.photos).length ? jsonArr(r.photos) : (r.photo ? [r.photo] : []),
  equipements: jsonArr(r.equipments),
  agenceId: r.agency_id || null,
  agence: r.agency_name || '',
  telephone: r.phone || '',
  retrait: r.pickup || '',
  // Position APPROXIMATIVE du point de retrait.
  position: (r.lat != null && r.lng != null) ? { lat: Number(r.lat), lng: Number(r.lng) } : null,
});

async function nextId() {
  const r = await db.one("SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '\\D', '', 'g'), '')::int), 0) + 1 AS n FROM vehicles");
  return 'v' + (r ? r.n : 1);
}

/** Véhicules publiés, éventuellement limités à une ville. */
async function listPublic(city) {
  const params = [];
  let sql = "SELECT * FROM vehicles WHERE status = 'published'";
  if (city) { params.push(city); sql += ` AND (city = '' OR city = $${params.length})`; }
  sql += ' ORDER BY kind, price_per_day';
  const r = await db.query(sql, params);
  return { vehicles: r.rows.map(view) };
}

async function listAll(user) {
  await team.requireScope(user, 'vehicles');
  const r = await db.query('SELECT * FROM vehicles ORDER BY city, kind, name');
  return r.rows.map(view);
}

async function save(user, data) {
  await team.requireScope(user, 'vehicles');
  const d = data || {};
  const id = d.id && d.id !== 'new' ? str(d.id, 40) : null;
  let existing = null;
  if (id) {
    existing = await db.one('SELECT * FROM vehicles WHERE id = $1', [id]);
    if (!existing) throw err(404, 'Véhicule introuvable.');
  }
  const e = existing || {};
  const name = str(d.name !== undefined ? d.name : e.name, 120);
  if (!name) throw err(400, 'Le nom du véhicule est obligatoire.');

  const price = d.pricePerDay === undefined ? Number(e.price_per_day || 0) : (int(d.pricePerDay) || 0);
  if (price <= 0) throw err(400, 'Indiquez un prix par jour.');

  // L'agence rattachée devient membre de chaque conversation ouverte sur le
  // véhicule : on exige donc un compte d'agence (ou l'admin) qui existe, comme
  // services.save l'exige pour le prestataire. Un identifiant quelconque, un
  // client complice par exemple, lirait tout sous l'étiquette « agence ».
  let agencyId = e.agency_id || null;
  if (d.agenceId !== undefined) {
    const voulu = str(d.agenceId, 40);
    if (!voulu) agencyId = null;
    else {
      if (!/^[0-9a-f-]{36}$/i.test(voulu)) throw err(400, 'Identifiant d’agence invalide.');
      const ag = await db.one("SELECT id, role FROM users WHERE id = $1 AND deleted_at IS NULL", [voulu]);
      if (!ag || (ag.role !== 'agency' && ag.role !== 'admin')) throw err(404, 'Compte d’agence introuvable.');
      agencyId = ag.id;
    }
  }
  // Une coordonnée est un nombre fini dans sa plage, ou rien : « 1e999 » et
  // 9999 passaient, et la carte de tout le monde se cadrait sur l'absurde.
  const coord = (v, actuel, max, nom) => {
    if (v === undefined) return actuel != null ? actuel : null;
    if (v === '' || v === null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || Math.abs(n) > max) throw err(400, `${nom} doit être comprise entre -${max} et ${max}.`);
    return n;
  };

  const row = {
    id: id || await nextId(),
    name,
    kind: oneOf(d.kind, KINDS, e.kind || 'voiture'),
    city: str(d.city !== undefined ? d.city : e.city, 80),
    price_per_day: price,
    deposit: d.deposit === undefined ? Number(e.deposit || 0) : (int(d.deposit) || 0),
    seats: d.seats === undefined ? (e.seats == null ? null : e.seats) : int(d.seats),
    gearbox: oneOf(d.gearbox, GEARBOXES, e.gearbox || ''),
    specs: str(d.specs !== undefined ? d.specs : e.specs, 500),
    photo: d.photo !== undefined ? photoValide(d.photo) : (e.photo || ''),
    status: oneOf(d.status, STATUSES, e.status || 'draft'),
    description: str(d.description !== undefined ? d.description : e.description, 2000),
    // La galerie passe par la même porte que la vignette : une adresse tierce
    // dans la liste ferait charger à chaque visiteur une image chez un inconnu.
    photos: JSON.stringify(
      d.photos !== undefined ? normaliserListe(d.photos, PHOTOS_MAX, 300).map(photoValide) : jsonArr(e.photos)),
    equipments: JSON.stringify(
      d.equipements !== undefined ? normaliserListe(d.equipements, EQUIPEMENTS_MAX, 60) : jsonArr(e.equipments)),
    agency_id: agencyId,
    agency_name: str(d.agence !== undefined ? d.agence : e.agency_name, 120),
    // Même validation que le numéro d'une expérience : un numéro composable,
    // gardé dans la forme écrite par l'agence.
    phone: d.telephone !== undefined ? telephoneValide(d.telephone) : (e.phone || ''),
    pickup: str(d.retrait !== undefined ? d.retrait : e.pickup, 120),
    lat: coord(d.lat, e.lat, 90, 'La latitude'),
    lng: coord(d.lng, e.lng, 180, 'La longitude'),
  };
  const r = await db.one(
    `INSERT INTO vehicles (id, name, kind, city, price_per_day, deposit, seats, gearbox, specs, photo, status,
                           description, photos, equipments, agency_id, agency_name, phone,
                           pickup, lat, lng)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, city = EXCLUDED.city,
       price_per_day = EXCLUDED.price_per_day, deposit = EXCLUDED.deposit, seats = EXCLUDED.seats,
       gearbox = EXCLUDED.gearbox, specs = EXCLUDED.specs, photo = EXCLUDED.photo,
       status = EXCLUDED.status, description = EXCLUDED.description, photos = EXCLUDED.photos,
       equipments = EXCLUDED.equipments, agency_id = EXCLUDED.agency_id,
       agency_name = EXCLUDED.agency_name, phone = EXCLUDED.phone, pickup = EXCLUDED.pickup,
       lat = EXCLUDED.lat, lng = EXCLUDED.lng, updated_at = now()
     RETURNING *`,
    [row.id, row.name, row.kind, row.city, row.price_per_day, row.deposit,
     row.seats, row.gearbox, row.specs, row.photo, row.status,
     row.description, row.photos, row.equipments, row.agency_id, row.agency_name, row.phone,
     row.pickup, row.lat, row.lng]);
  return view(r);
}

module.exports = { KINDS, GEARBOXES, STATUSES, PHOTOS_MAX, EQUIPEMENTS_MAX, normaliserListe, photoValide, listPublic, listAll, save };
