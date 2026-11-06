/* =====================================================================
   Catalogue des services de la plateforme.

   Un service s'adresse aux CLIENTS, aux PROPRIÉTAIRES, ou aux deux quand
   l'équipe le décide explicitement (`audience = 'both'`). Les deux publics ne
   voient donc pas la même liste.

   L'administration des services exige le périmètre « services » (voir team.js) :
   l'admin l'a toujours, un collaborateur seulement s'il lui a été confié.
   ===================================================================== */
'use strict';
const db = require('./db');
// Pour `telephoneExperience` : un numéro de téléphone obéit aux mêmes règles
// qu'il désigne une agence ou un prestataire. Une seconde copie de la règle
// aurait fini par diverger de la première.
const catalogAdmin = require('./catalog_admin');
const team = require('./team');

/* ---------------- Catégories ----------------
   Elles vivent en base (table `service_categories`) pour que l'équipe puisse en
   ajouter sans déploiement. Cette liste ne sert plus que de repli : base
   injoignable, ou table pas encore migrée.

   `icon` nomme une icône du jeu de l'appli — pas un emoji : les emoji sont les
   dessins du système, identiques dans toutes les applications du téléphone. */
const CATEGORIES_REPLI = [
  { key: 'menage', label: 'Ménage', icon: 'broom', sort: 10 },
  { key: 'massage', label: 'Massage', icon: 'massage', sort: 20 },
  { key: 'sauna', label: 'Sauna & hammam', icon: 'hammam', sort: 30 },
  { key: 'chef', label: 'Chef privé', icon: 'chef', sort: 40 },
  { key: 'babysitting', label: 'Baby-sitting', icon: 'baby', sort: 50 },
  { key: 'chauffeur', label: 'Chauffeur', icon: 'car', sort: 60 },
  { key: 'transfert', label: 'Transferts', icon: 'plane', sort: 70 },
  { key: 'conciergerie', label: 'Conciergerie', icon: 'key', sort: 80 },
  { key: 'entretien', label: 'Entretien', icon: 'tools', sort: 90 },
  { key: 'photo', label: 'Photographie', icon: 'camera', sort: 100 },
  { key: 'autre', label: 'Autre', icon: 'tag', sort: 999 },
];

/** Catégorie de dernier recours : jamais supprimable, jamais absente. */
const CATEGORIE_DEFAUT = 'autre';

// Les catégories changent rarement et sont lues à chaque liste : un cache court
// évite d'interroger la base pour chaque carte affichée.
let catCache = { at: 0, list: null };
const CAT_TTL = 30000;

async function categories(force) {
  if (!force && catCache.list && Date.now() - catCache.at < CAT_TTL) return catCache.list;
  try {
    const r = await db.query('SELECT key, label, icon, sort FROM service_categories ORDER BY sort, label');
    const list = r.rows.map(x => ({ key: x.key, label: x.label, icon: x.icon || '', sort: Number(x.sort) }));
    catCache = { at: Date.now(), list: list.length ? list : CATEGORIES_REPLI };
  } catch (e) {
    // Table absente ou base indisponible : on sert le repli plutôt que rien.
    catCache = { at: Date.now(), list: CATEGORIES_REPLI };
  }
  return catCache.list;
}

/**
 * Clé technique tirée d'un libellé : « Baby-sitting » -> « babysitting ».
 * Deux libellés qui se ressemblent ne doivent pas créer deux catégories.
 */
function slug(label) {
  return String(label || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '')
    .slice(0, 40);
}
const AUDIENCES = ['client', 'owner', 'both'];
const STATUSES = ['draft', 'published', 'archived'];

function err(status, msg) { const e = new Error(msg); e.status = status; return e; }
const str = (v, max) => (typeof v === 'string' ? v : '').trim().slice(0, max);
const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);

/** Liste JSON gardée en texte ; une colonne abîmée ne vide pas la fiche. */
function jsonArr(v) {
  if (Array.isArray(v)) return v.map(String);
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}

/** Nettoie une liste saisie en texte à lignes (horaires, inclus, photos). */
function normaliserListe(v, max, longueur) {
  const brut = Array.isArray(v) ? v.filter(x => typeof x === 'string') : String(v || '').split('\n');
  return brut.map(x => x.trim().slice(0, longueur)).filter(Boolean).slice(0, max);
}

const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));

/**
 * Une coordonnée, ou le refus.
 *
 * Sans bornes, une latitude de 500 passait : le service se posait sur un
 * point que la carte ne peut pas montrer, et personne ne comprenait pourquoi
 * il avait disparu. Hors limites, on REFUSE au lieu d'écrire n'importe quoi.
 */
function coordValide(v, nom, max) {
  const n = num(v);
  if (n === null) return null;
  if (!Number.isFinite(n) || Math.abs(n) > max) {
    throw err(400, `${nom} doit être comprise entre -${max} et ${max}.`);
  }
  return n;
}

/**
 * Ce qu'on montre d'un service.
 *
 * `interne` ajoute ce qui ne regarde QUE l'équipe : à qui le service est
 * confié. L'identifiant d'un collaborateur est une clé de compte, et savoir
 * qui fait le ménage dans quel riad n'apprend rien d'utile à un voyageur —
 * mais apprend beaucoup à qui prépare une usurpation.
 */
const view = (r, interne = false) => ({
  id: r.id, name: r.name, category: r.category, audience: r.audience, status: r.status,
  city: r.city, price: r.price == null ? null : Number(r.price), unit: r.unit,
  description: r.description, photo: r.photo || '',
  // Y a-t-il quelqu'un à qui écrire ? La fiche en a besoin pour choisir
  // entre le prestataire et l'équipe — sans livrer QUI c'est.
  joignable: !!r.assignee_id,
  ...(interne ? { assigneeId: r.assignee_id || null, assigneeName: r.assignee_name || null } : {}),
  quartier: r.area || '',
  // Position APPROXIMATIVE : le quartier, jamais l'adresse exacte.
  position: (r.lat != null && r.lng != null) ? { lat: Number(r.lat), lng: Number(r.lng) } : null,
  horaires: jsonArr(r.hours),
  inclus: jsonArr(r.includes),
  // La vignette OUVRE la galerie, elle ne lui cède pas la place. Avant, une
  // galerie non vide masquait entièrement `photo` : le prestataire déposait
  // une image depuis « Ma fiche » et ne la voyait jamais dès que l'équipe
  // avait saisi une ligne de galerie.
  photos: [...(r.photo ? [r.photo] : []), ...jsonArr(r.photos).filter(p => p !== r.photo)],
  // Numéro pour joindre celui qui fera le service, dans l'appli ou par
  // WhatsApp. Vide tant que personne ne l'a saisi : il n'y a pas de numéro par
  // défaut — celui de l'équipe ne doit pas se retrouver sur le service d'un
  // prestataire à son insu.
  telephone: r.phone || '',
});

/** Taille maximale d'une image déposée depuis l'appli, en caractères base64. */
const PHOTO_MAX = 2000000;

/**
 * Valide la photo d'un service.
 *
 * Elle est PUBLIQUE : on n'accepte qu'un chemin relatif servi par le site, ou
 * une image déposée en base64. Tout le reste est refusé — une URL vers un
 * domaine tiers ferait du site un afficheur de contenu qu'il ne maîtrise pas,
 * et donnerait à ce tiers l'adresse IP de chaque visiteur.
 *
 * Chaîne vide = pas de photo, ce qui est un état normal : l'appli retombe
 * alors sur l'icône de la catégorie.
 *
 * Fonction pure : voir api/test/service-photo.test.js.
 */
function photoValide(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return '';
  if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=\s]+$/.test(s)) {
    if (s.length > PHOTO_MAX) throw err(400, 'Image trop lourde : 2 Mo au maximum.');
    return s;
  }
  // Chemin relatif : pas de protocole, pas de remontée de dossier, pas de
  // barre initiale (qui ouvrirait la racine du serveur).
  if (/^[\w.-]+(?:\/[\w.-]+)*\.(?:jpe?g|png|webp)(?:\?[\w=.&-]*)?$/i.test(s) && !s.includes('..')) {
    return s.slice(0, 300);
  }
  throw err(400, 'Photo invalide : une image JPEG, PNG ou WebP est attendue.');
}

/** Identifiant lisible : s1, s2… (même esprit que les logements/activités). */
async function nextId() {
  const r = await db.one("SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '\\D', '', 'g'), '')::int), 0) + 1 AS n FROM services");
  return 's' + (r ? r.n : 1);
}

/** Services visibles par l'utilisateur, selon son rôle (ou côté client si non connecté). */
async function listPublic(user, city) {
  const audience = team.audienceFor(user && user.role);
  const params = [audience];
  let sql = `SELECT s.*, u.name AS assignee_name FROM services s LEFT JOIN users u ON u.id = s.assignee_id
              WHERE s.status = 'published' AND (s.audience = $1 OR s.audience = 'both')`;
  if (city) { params.push(city); sql += ` AND (s.city = '' OR s.city = $${params.length})`; }
  sql += ' ORDER BY s.category, s.name';
  const r = await db.query(sql, params);
  return { audience, services: r.rows.map(x => view(x)), categories: await categories() };
}

/** Administration : tous les services, quelle que soit l'audience. */
async function listAll(user) {
  await team.requireScope(user, 'services');
  const r = await db.query(
    `SELECT s.*, u.name AS assignee_name FROM services s LEFT JOIN users u ON u.id = s.assignee_id
      ORDER BY s.audience, s.category, s.name`);
  return r.rows.map(x => view(x, true));
}

/**
 * Enregistre un service.
 *
 * `opts.dejaAutorise` n'existe que pour `saveFiche`, qui a déjà tranché la
 * permission d'une AUTRE manière — le service est confié à cette personne.
 * Sans cette option, il faudrait soit recopier ici toute la validation, soit
 * fabriquer un faux utilisateur administrateur pour franchir le contrôle :
 * la première solution finit par diverger, la seconde est une escalade de
 * privilège déguisée en commodité.
 */
async function save(user, data, opts) {
  if (!opts || !opts.dejaAutorise) await team.requireScope(user, 'services');
  const d = data || {};
  const id = d.id && d.id !== 'new' ? str(d.id, 40) : null;
  let existing = null;
  if (id) {
    existing = await db.one('SELECT * FROM services WHERE id = $1', [id]);
    if (!existing) throw err(404, 'Service introuvable.');
  }
  const e = existing || {};
  const name = str(d.name !== undefined ? d.name : e.name, 120);
  if (!name) throw err(400, 'Le nom du service est obligatoire.');

  // L'audience « both » est un choix explicite de l'équipe, pas un défaut.
  const audience = oneOf(d.audience, AUDIENCES, e.audience || 'client');

  let assignee = d.assigneeId !== undefined ? (str(d.assigneeId, 40) || null) : (e.assignee_id || null);
  if (assignee) {
    const a = await db.one("SELECT id, role FROM users WHERE id = $1 AND deleted_at IS NULL", [assignee]);
    if (!a) throw err(404, 'Collaborateur introuvable.');
    if (a.role !== 'collaborator' && a.role !== 'admin') throw err(400, 'Un service se confie à un collaborateur.');
  }

  const row = {
    id: id || await nextId(),
    name,
    category: await categorieValide(d.category, e.category),
    audience,
    status: oneOf(d.status, STATUSES, e.status || 'draft'),
    city: str(d.city !== undefined ? d.city : e.city, 80),
    price: d.price === undefined ? (e.price == null ? null : e.price) : (d.price === null || d.price === '' ? null : Math.max(0, Math.round(Number(d.price) || 0))),
    unit: str(d.unit !== undefined ? d.unit : e.unit, 40),
    description: str(d.description !== undefined ? d.description : e.description, 1500),
    photo: d.photo !== undefined ? photoValide(d.photo) : (e.photo || ''),
    area: str(d.quartier !== undefined ? d.quartier : e.area, 80),
    lat: d.lat !== undefined ? coordValide(d.lat, 'La latitude', 90) : (e.lat != null ? e.lat : null),
    lng: d.lng !== undefined ? coordValide(d.lng, 'La longitude', 180) : (e.lng != null ? e.lng : null),
    hours: JSON.stringify(d.horaires !== undefined ? normaliserListe(d.horaires, 8, 80) : jsonArr(e.hours)),
    includes: JSON.stringify(d.inclus !== undefined ? normaliserListe(d.inclus, 12, 90) : jsonArr(e.includes)),
    // Chaque ligne de la galerie passe par le MÊME contrôle que la vignette.
    // Sans cela, `photo` était vérifiée et `photos` ne l'était pas : il
    // suffisait de mettre son adresse dans la galerie pour la contourner.
    photos: JSON.stringify(d.photos !== undefined
      ? normaliserListe(d.photos, 10, 300).map(photoValide)
      : jsonArr(e.photos)),
    phone: Object.prototype.hasOwnProperty.call(d, 'telephone')
      ? catalogAdmin.telephoneExperience(d.telephone)
      : (e.phone || ''),
    assignee_id: assignee,
  };
  const r = await db.one(
    // Les six dernières colonnes (quartier, position, horaires, inclus,
    // galerie) sont arrivées avec la migration 026 : elles avaient été
    // ajoutées à la mise à jour et à la liste des valeurs, mais oubliées
    // ici — l'insertion recevait dix-sept valeurs pour onze colonnes, et
    // PostgreSQL refusait l'ordre entier.
    `INSERT INTO services (id, name, category, audience, status, city, price, unit, description, photo, assignee_id,
                           area, lat, lng, hours, includes, photos, phone)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category,
       audience = EXCLUDED.audience, status = EXCLUDED.status, city = EXCLUDED.city,
       price = EXCLUDED.price, unit = EXCLUDED.unit, description = EXCLUDED.description,
       photo = EXCLUDED.photo, assignee_id = EXCLUDED.assignee_id, area = EXCLUDED.area,
       lat = EXCLUDED.lat, lng = EXCLUDED.lng, hours = EXCLUDED.hours,
       includes = EXCLUDED.includes, photos = EXCLUDED.photos, phone = EXCLUDED.phone,
       updated_at = now()
     RETURNING *`,
    [row.id, row.name, row.category, row.audience, row.status, row.city, row.price, row.unit,
     row.description, row.photo, row.assignee_id, row.area, row.lat, row.lng,
     row.hours, row.includes, row.photos, row.phone]);
  return view(r);
}

async function publish(user, id, on) {
  await team.requireScope(user, 'services');
  const s = await db.one('SELECT * FROM services WHERE id = $1', [id]);
  if (!s) throw err(404, 'Service introuvable.');
  const r = await db.one("UPDATE services SET status = $2, updated_at = now() WHERE id = $1 RETURNING *",
    [id, on ? 'published' : 'draft']);
  return view(r);
}

/**
 * Catégorie retenue pour un service.
 *
 * Une catégorie inconnue est refusée plutôt que silencieusement remplacée :
 * sans cela, une faute de frappe rangerait le service dans « Autre » sans que
 * personne ne s'en aperçoive.
 */
async function categorieValide(demandee, existante) {
  if (demandee === undefined || demandee === null || demandee === '') {
    return existante || CATEGORIE_DEFAUT;
  }
  const k = slug(demandee);
  const list = await categories();
  if (!list.some(x => x.key === k)) throw err(400, 'Catégorie inconnue.');
  return k;
}

/** Crée ou renomme une catégorie. Périmètre « services » exigé. */
async function saveCategory(user, data) {
  await team.requireScope(user, 'services');
  const d = data || {};
  const label = str(d.label, 60);
  if (!label) throw err(400, 'Le nom de la catégorie est obligatoire.');
  // Une clé fournie permet de RENOMMER sans casser les services déjà rangés.
  // Sans clé fournie, on crée. Mais si ce libellé existe déjà, on met à jour
  // l'existante plutôt que d'en créer une jumelle sous une autre clé
  // (« Chef privé » ne doit pas doubler « chef »).
  let key = slug(d.key || '');
  if (!key) {
    const deja = (await categories()).find(x => x.label.toLowerCase() === label.toLowerCase());
    key = deja ? deja.key : slug(label);
  }
  if (!key) throw err(400, 'Nom de catégorie invalide.');
  const icon = str(d.icon, 30);
  const sort = Number.isFinite(Number(d.sort)) ? Math.max(0, Math.min(998, Math.round(Number(d.sort)))) : 100;

  const r = await db.one(
    `INSERT INTO service_categories (key, label, icon, sort) VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, icon = EXCLUDED.icon,
       sort = EXCLUDED.sort, updated_at = now()
     RETURNING key, label, icon, sort`,
    [key, label, icon, sort]);
  await categories(true);
  return { key: r.key, label: r.label, icon: r.icon || '', sort: Number(r.sort) };
}

/**
 * Supprime une catégorie.
 *
 * On refuse tant qu'elle est utilisée, et on dit par combien de services : la
 * réassignation silencieuse rangerait des services ailleurs sans que l'équipe
 * l'ait décidé.
 */
async function deleteCategory(user, key) {
  await team.requireScope(user, 'services');
  const k = slug(key);
  if (k === CATEGORIE_DEFAUT) throw err(400, '« Autre » ne peut pas être supprimée : elle sert de repli.');
  const used = await db.one('SELECT count(*)::int AS n FROM services WHERE category = $1', [k]);
  const n = used ? Number(used.n || 0) : 0;
  if (n > 0) {
    throw err(409, `Cette catégorie est utilisée par ${n} service${n > 1 ? 's' : ''}. Changez-les de catégorie d'abord.`);
  }
  await db.query('DELETE FROM service_categories WHERE key = $1', [k]);
  await categories(true);
  return { key: k };
}


/* =====================================================================
   L'ACCÈS DU PRESTATAIRE

   Qui remplit quoi, et pourquoi la ligne passe là.

   Le catalogue appartient à l'équipe : c'est elle qui décide QUE le service
   existe, à QUI il s'adresse, COMBIEN il coûte et s'il est publié. Ce sont des
   décisions commerciales, et elles ne se délèguent pas à chaque prestataire.

   Mais ce que l'équipe ne peut pas savoir à sa place, c'est OÙ il travaille,
   PAR QUEL NUMÉRO on le joint, à QUELLES HEURES, ce que la prestation comprend
   et à quoi elle ressemble. Laisser l'administration remplir cela, c'est
   garantir que ce sera faux ou vide — et c'est exactement pourquoi la page
   Services n'avait ni carte, ni photo, ni contact.

   D'où deux séries de champs, et une frontière écrite noir sur blanc.
   ===================================================================== */

/**
 * Les champs qu'un prestataire remplit lui-même sur SA fiche.
 *
 * Tout ce qui n'est pas dans cette liste lui est refusé, y compris s'il
 * l'envoie : une liste blanche se trompe en bloquant, une liste noire se
 * trompe en laissant passer, et c'est le prix qui passerait.
 */
const CHAMPS_PRESTATAIRE = [
  'description', 'photo', 'photos', 'telephone', 'quartier', 'lat', 'lng',
  'horaires', 'inclus',
];

/**
 * Les champs que SEULE l'équipe décide. Énumérés pour pouvoir le DIRE à qui
 * les envoie, au lieu de les ignorer en silence : un prestataire qui corrige
 * un prix et voit sa fiche enregistrée croirait l'avoir changé.
 */
const CHAMPS_EQUIPE = ['name', 'category', 'audience', 'status', 'city', 'price', 'unit', 'assigneeId'];

/**
 * Ne garde d'un corps de requête que ce qui revient au prestataire.
 *
 * Fonction pure : voir api/test/service-fiche.test.js.
 *
 * @returns { champs, refuses } — `refuses` sert à répondre franchement.
 */
function filtrerChampsPrestataire(data) {
  const d = data && typeof data === 'object' ? data : {};
  const champs = {};
  const refuses = [];
  for (const k of Object.keys(d)) {
    if (k === 'id') continue;                       // l'identifiant vient de l'URL
    if (CHAMPS_PRESTATAIRE.includes(k)) champs[k] = d[k];
    else if (CHAMPS_EQUIPE.includes(k)) refuses.push(k);
    // Un champ inconnu est ignoré sans bruit : il ne promet rien.
  }
  return { champs, refuses };
}

/**
 * Ce prestataire a-t-il le droit de modifier CE service ?
 *
 * Fonction pure, pour que la règle soit lisible et éprouvée d'un coup d'œil.
 * L'administration passe partout ; un collaborateur ne passe que sur les
 * services qui lui sont confiés. Le périmètre « services » (l'équipe du
 * catalogue) est vérifié à part, par `requireScope`, dans `save`.
 */
function peutRemplirFiche(user, service) {
  if (!user || !service) return false;
  if (user.role === 'admin') return true;
  if (!service.assignee_id) return false;
  return String(service.assignee_id) === String(user.id);
}

/** Les services confiés à cette personne, publiés ou non : c'est son travail. */
async function listMine(user) {
  if (!user) throw err(401, 'Connectez-vous.');
  const r = await db.query(
    `SELECT s.*, u.name AS assignee_name
       FROM services s LEFT JOIN users u ON u.id = s.assignee_id
      WHERE s.assignee_id = $1 ORDER BY s.city, s.name`, [user.id]);
  return r.rows.map(x => view(x, true));
}

/**
 * Le prestataire remplit sa fiche.
 *
 * On relit le service AVANT de décider : la permission dépend de qui en a la
 * charge, et cela ne se devine pas depuis le corps de la requête.
 */
async function saveFiche(user, id, data) {
  if (!user) throw err(401, 'Connectez-vous.');
  const sv = await db.one('SELECT * FROM services WHERE id = $1', [str(id, 40)]);
  if (!sv) throw err(404, 'Service introuvable.');
  if (!peutRemplirFiche(user, sv)) throw err(403, 'Ce service ne vous est pas confié.');

  const { champs, refuses } = filtrerChampsPrestataire(data);
  if (refuses.length) {
    throw err(403, refuses.includes('price')
      ? 'Le tarif du catalogue est fixé par l’équipe Douira. Le prix de chaque intervention, lui, se saisit au moment du scan.'
      : 'Ces informations sont fixées par l’équipe Douira.');
  }
  if (!Object.keys(champs).length) throw err(400, 'Rien à enregistrer.');

  // On repasse par `save`, qui porte toute la validation — numéro de
  // téléphone, photo, coordonnées. Écrire une seconde fois ces contrôles ici
  // aurait fini par les faire diverger. La permission a été tranchée par
  // `peutRemplirFiche` ci-dessus, et c'est ce que dit `dejaAutorise`.
  return save(user, { ...champs, id: sv.id }, { dejaAutorise: true });
}

module.exports = {
  CATEGORIES_REPLI, CATEGORIE_DEFAUT, AUDIENCES, STATUSES,
  slug, categories, categorieValide, saveCategory, deleteCategory,
  listPublic, listAll, save, publish, photoValide, coordValide,
  CHAMPS_PRESTATAIRE, CHAMPS_EQUIPE, filtrerChampsPrestataire, peutRemplirFiche,
  listMine, saveFiche,
};
