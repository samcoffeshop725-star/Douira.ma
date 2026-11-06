/* =====================================================================
   Destinations ouvertes (pays → villes).

   La liste vit en base et se règle depuis l'administration : ouvrir un pays ou
   une ville ne demande plus de livrer une nouvelle version de l'appli.

   Un instantané est gardé en mémoire pour que la devise d'une ville reste
   lisible de façon SYNCHRONE (lib/money.js s'en sert pendant le calcul d'un
   devis). Repli : la table figée de money.js si la base n'a rien.
   ===================================================================== */
'use strict';
const db = require('./db');
const team = require('./team');

const STATUSES = ['draft', 'published', 'archived'];
function err(status, msg) { const e = new Error(msg); e.status = status; return e; }
const str = (v, max) => (typeof v === 'string' ? v : '').trim().slice(0, max);
const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
// Une coordonnée est un nombre FINI dans sa plage, ou rien : « 1e999 » passait `num`.
const coord = (v, max, nom) => {
  const n = num(v);
  if (n === null) return null;
  if (!Number.isFinite(n) || Math.abs(n) > max) throw err(400, `${nom} doit être comprise entre -${max} et ${max}.`);
  return n;
};

let live = { rows: [], byCity: {} };

const view = r => ({
  id: r.id, country: r.country, city: r.city, currency: r.currency,
  lat: r.lat == null ? null : Number(r.lat), lng: r.lng == null ? null : Number(r.lng),
  status: r.status, sort: Number(r.sort || 0),
});

/** Recharge l'instantané. Appelé au démarrage et après chaque enregistrement. */
async function refresh() {
  try {
    const r = await db.query('SELECT * FROM destinations ORDER BY sort, country, city');
    const byCity = {};
    for (const row of r.rows) byCity[String(row.city).trim().toLowerCase()] = row.currency;
    live = { rows: r.rows.map(view), byCity };
  } catch (e) {
    // Table absente (migration pas encore passée) : on garde le repli du code.
    live = { rows: [], byCity: {} };
  }
  return live.rows;
}

/** Devise d'une ville d'après la base, ou null si inconnue (lecture synchrone). */
function currencyForCity(city) {
  return live.byCity[String(city || '').trim().toLowerCase()] || null;
}

/** Pays et position (approchée, niveau ville) d'une ville, ou null. Lecture
    synchrone depuis l'instantané. Sert la carte de voyages et le score de pays :
    on pose les marqueurs sur la VILLE, jamais sur l'adresse exacte du logement. */
function cityInfo(city) {
  const key = String(city || '').trim().toLowerCase();
  return live.rows.find(d => String(d.city).trim().toLowerCase() === key) || null;
}

/** Destinations ouvertes au public, regroupées par pays. */
function published() {
  const rows = live.rows.filter(d => d.status === 'published');
  const countries = [];
  for (const d of rows) {
    let entry = countries.find(x => x.country === d.country);
    if (!entry) { entry = { country: d.country, cities: [] }; countries.push(entry); }
    entry.cities.push(d);
  }
  return { countries, destinations: rows };
}

async function listAll(user) {
  await team.requireScope(user, 'destinations');
  const r = await db.query('SELECT * FROM destinations ORDER BY sort, country, city');
  return r.rows.map(view);
}

async function nextId() {
  const r = await db.one("SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '\\D', '', 'g'), '')::int), 0) + 1 AS n FROM destinations");
  return 'd' + (r ? r.n : 1);
}

async function save(user, data) {
  await team.requireScope(user, 'destinations');
  const d = data || {};
  const id = d.id && d.id !== 'new' ? str(d.id, 40) : null;
  let existing = null;
  if (id) {
    existing = await db.one('SELECT * FROM destinations WHERE id = $1', [id]);
    if (!existing) throw err(404, 'Destination introuvable.');
  }
  const e = existing || {};
  const country = str(d.country !== undefined ? d.country : e.country, 80);
  const city = str(d.city !== undefined ? d.city : e.city, 80);
  if (!country) throw err(400, 'Le pays est obligatoire.');
  if (!city) throw err(400, 'La ville est obligatoire.');

  // La devise d'une ville fixe celle de TOUTES ses réservations : liste fermée,
  // celle que les prestataires encaissent (lib/money.js) plus le franc CFA
  // pour le jour où un prestataire local sera branché. « MA » ou « €UR »
  // rendait toute une ville imréservable (503) sans dire pourquoi.
  const currency = str(d.currency !== undefined ? d.currency : e.currency, 3).toUpperCase() || 'EUR';
  if (!['MAD', 'EUR', 'USD', 'GBP', 'CAD', 'CHF', 'XOF'].includes(currency)) throw err(400, 'Devise inconnue : MAD, EUR, USD, GBP, CAD, CHF ou XOF.');
  const row = {
    id: id || await nextId(),
    country, city, currency,
    lat: d.lat !== undefined ? coord(d.lat, 90, 'La latitude') : (e.lat == null ? null : e.lat),
    lng: d.lng !== undefined ? coord(d.lng, 180, 'La longitude') : (e.lng == null ? null : e.lng),
    status: STATUSES.includes(d.status) ? d.status : (e.status || 'draft'),
    sort: d.sort !== undefined ? Math.round(num(d.sort) || 0) : Number(e.sort || 0),
  };
  const dup = await db.one(
    'SELECT id FROM destinations WHERE lower(country) = lower($1) AND lower(city) = lower($2) AND id <> $3',
    [row.country, row.city, row.id]);
  if (dup) throw err(409, 'Cette ville existe déjà pour ce pays.');

  const r = await db.one(
    `INSERT INTO destinations (id, country, city, currency, lat, lng, status, sort)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET country = EXCLUDED.country, city = EXCLUDED.city,
       currency = EXCLUDED.currency, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
       status = EXCLUDED.status, sort = EXCLUDED.sort, updated_at = now()
     RETURNING *`,
    [row.id, row.country, row.city, row.currency, row.lat, row.lng, row.status, row.sort]);
  await refresh();
  return view(r);
}

module.exports = { STATUSES, refresh, currencyForCity, cityInfo, published, listAll, save };
