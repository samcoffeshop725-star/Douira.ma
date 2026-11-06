/* =====================================================================
   Vérification du visage : la personne est-elle le titulaire de la pièce ?

   La pièce prouve qu'un document existe. Elle ne prouve pas qu'il appartient
   à celui qui le présente. Ce module ajoute la seconde moitié : un selfie,
   comparé au portrait de la pièce.

   QUI COMPARE. Aujourd'hui : l'équipe habilitée, qui voit les deux images
   côte à côte et décide. Demain : un prestataire spécialisé, qui rendra le
   même verdict par la même porte (`provider`). Le reste du système ne
   changera pas — et la comparaison humaine restera de toute façon, parce que
   le RGPD interdit de refuser quelqu'un automatiquement sans recours.

   CE QU'ON NE FAIT PAS. Aucune comparaison côté appareil : un verdict calculé
   sur le téléphone de celui qu'on vérifie est un verdict qu'il peut réécrire.
   Aucun gabarit facial conservé : on garde la décision, pas la mesure.

   Règles pures en haut (testables sans base), accès base en bas.
   ===================================================================== */
'use strict';
const db = require('./db');
const sec = require('./security');
const docs = require('./documents');
const kycAuto = require('./kyc_auto');

const STATUSES = ['pending', 'review', 'passed', 'failed'];
/** Décisions qu'un humain peut rendre. « pending » et « review » s'attendent. */
const DECISIONS = ['passed', 'failed'];

/** Tentatives autorisées par période glissante. */
const MAX_ATTEMPTS = 3;
const ATTEMPT_WINDOW_H = 24;
/** Au-delà, un dossier sans décision voit son selfie effacé. */
const KEEP_DAYS = 30;
/** Un selfie est une photo, pas un document : plus petit, et jamais un PDF. */
const MAX_SELFIE = 1.5 * 1024 * 1024;
/** Validité d'une vérification réussie. */
const VALID_DAYS = 365;

function err(status, msg) { const e = new Error(msg); e.status = status; return e; }

/* ---------------- Règles pures ---------------- */

/**
 * Le selfie transmis est-il acceptable ?
 *
 * Images seulement : un PDF est accepté pour une pièce scannée, jamais pour
 * un visage — et accepter un format qu'on n'attend pas, c'est accepter du
 * contenu qu'on n'a pas prévu d'afficher.
 */
function checkSelfie(dataUrl) {
  const s = typeof dataUrl === 'string' ? dataUrl.trim() : '';
  if (!s) return { ok: false, reason: 'Aucune photo reçue.' };
  const m = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(s);
  if (!m) return { ok: false, reason: 'Format accepté : photo JPEG, PNG ou WebP.' };
  if (m[2].length > MAX_SELFIE) return { ok: false, reason: 'Photo trop lourde (1,5 Mo maximum).' };
  return { ok: true, data: m[2], mime: m[1] };
}

/**
 * La pièce à laquelle comparer le visage.
 *
 * Une pièce d'identité suffit : c'est elle qui porte le portrait. Le permis
 * en porte un aussi, mais on compare au document qui identifie, pas à celui
 * qui autorise à conduire.
 */
function pieceAComparer(documents) {
  const list = Array.isArray(documents) ? documents : [];
  // Une pièce vérifiée d'abord : son portrait a déjà été regardé par l'équipe.
  return list.find(d => docs.IDENTITY.includes(d.kind) && d.status === 'verified')
    || list.find(d => docs.IDENTITY.includes(d.kind) && d.status === 'pending')
    || null;
}

/**
 * État de la vérification d'une personne, à partir de ses contrôles.
 *
 * `rows` : du plus récent au plus ancien.
 */
function etat(rows, now) {
  const list = Array.isArray(rows) ? rows : [];
  const maintenant = now ? new Date(now) : new Date();
  const dernier = list[0] || null;

  if (!dernier) return { statut: 'absente', motif: '', depuis: null, valideJusqua: null };

  if (dernier.status === 'passed') {
    const fin = new Date(new Date(dernier.decided_at || dernier.created_at).getTime()
      + VALID_DAYS * 86400000);
    // Une vérification périmée n'est pas une vérification refusée : on la
    // redemande, on ne reproche rien.
    if (fin < maintenant) {
      return { statut: 'expiree', motif: '', depuis: dernier.decided_at, valideJusqua: fin.toISOString() };
    }
    return { statut: 'validee', motif: '', depuis: dernier.decided_at, valideJusqua: fin.toISOString() };
  }

  if (dernier.status === 'failed') {
    return { statut: 'refusee', motif: dernier.reason || '', depuis: dernier.decided_at, valideJusqua: null };
  }

  return { statut: 'en_revue', motif: '', depuis: dernier.created_at, valideJusqua: null };
}

/**
 * Peut-on tenter une nouvelle vérification ?
 *
 * Trois tentatives par jour. Au-delà, on n'ouvre pas une quatrième : on laisse
 * la revue humaine faire son travail. Un dossier déjà en revue n'en relance
 * pas un second — sinon l'équipe compare deux fois la même chose.
 */
function peutTenter(rows, now) {
  const list = Array.isArray(rows) ? rows : [];
  const maintenant = now ? new Date(now).getTime() : Date.now();
  const e = etat(list, now);

  if (e.statut === 'en_revue') {
    return { ok: false, raison: 'Votre vérification est en cours d’examen. Nous revenons vers vous sous 24 heures.' };
  }
  if (e.statut === 'validee') {
    return { ok: false, raison: 'Votre identité est déjà confirmée.' };
  }

  const recentes = list.filter(r =>
    maintenant - new Date(r.created_at).getTime() < ATTEMPT_WINDOW_H * 3600000);
  if (recentes.length >= MAX_ATTEMPTS) {
    return { ok: false, raison: 'Trop de tentatives aujourd’hui. Réessayez demain, ou écrivez-nous.' };
  }
  return { ok: true, raison: '', tentative: recentes.length + 1 };
}

/* ---------------- Accès base ---------------- */

/** Vue sûre : jamais le selfie, jamais l'identifiant du prestataire. */
const view = r => ({
  id: String(r.id),
  status: r.status,
  reason: r.reason || '',
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

async function mesControles(userId) {
  const r = await db.query(
    'SELECT * FROM kyc_checks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [userId]);
  return r.rows;
}

/** Ce que l'appli affiche : l'état, et si une tentative est possible. */
async function mine(userId) {
  const rows = await mesControles(userId);
  const e = etat(rows);
  const t = peutTenter(rows);
  return {
    ...e,
    peutTenter: t.ok,
    raison: t.raison,
    tentativesRestantes: Math.max(0, MAX_ATTEMPTS - rows.filter(r =>
      Date.now() - new Date(r.created_at).getTime() < ATTEMPT_WINDOW_H * 3600000).length),
    validiteJours: VALID_DAYS,
    // L'appli adapte son message d'attente : « quelques secondes » n'est pas
    // « sous 24 heures », et annoncer l'un pour l'autre se paie en messages
    // au service client.
    immediat: kycAuto.automatique(),
  };
}

/**
 * Dépose un selfie et ouvre une vérification.
 *
 * `consent` doit être explicitement vrai : c'est la base légale du traitement
 * (RGPD article 9.2.a). Sans lui, on ne traite rien — et on le dit.
 */
async function submit(user, data) {
  const d = data || {};
  if (d.consent !== true) {
    throw err(400, 'Votre accord explicite est nécessaire pour vérifier votre visage.');
  }

  const mesPieces = await docs.listMine(user.id);
  const piece = pieceAComparer(mesPieces);
  if (!piece) {
    throw err(400, 'Déposez d’abord votre pièce d’identité : c’est à son portrait que votre visage sera comparé.');
  }

  const rows = await mesControles(user.id);
  const t = peutTenter(rows);
  if (!t.ok) throw err(429, t.raison);

  const selfie = checkSelfie(d.selfie);
  if (!selfie.ok) throw err(400, selfie.reason);

  // Comparaison automatique si un pilote est configuré. Elle a lieu AVANT
  // d'écrire quoi que ce soit : une photo à refaire ne laisse alors aucune
  // trace, et une concordance franche n'a jamais besoin d'être stockée.
  const image = await docs.imageFor(piece.id);
  const auto = await kycAuto.comparer(Buffer.from(selfie.data, 'base64'), image ? image.data : null);

  if (auto.issue === 'retry') {
    // Ni enregistrement, ni tentative décomptée : le client recommence.
    throw err(400, auto.reason);
  }

  const accepte = auto.issue === 'passed';
  const r = await db.one(
    `INSERT INTO kyc_checks (user_id, doc_id, status, reason, provider, selfie_enc, mime, attempt, decided_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(days => $10))
     RETURNING *`,
    [user.id, piece.id,
      accepte ? 'passed' : 'review',
      auto.reason || '',
      auto.provider,
      // Accepté automatiquement : le selfie n'a plus aucun usage, il n'est
      // donc jamais écrit. Sinon l'équipe en a besoin pour trancher.
      accepte ? null : sec.encrypt(selfie.data),
      selfie.mime, t.tentative,
      accepte ? new Date().toISOString() : null,
      KEEP_DAYS]);
  return view(r);
}

/* ---------------- Examen par l'équipe ---------------- */

async function listPending() {
  const r = await db.query(
    `SELECT k.id, k.created_at, k.attempt, u.name AS client_name, d.kind AS doc_kind
       FROM kyc_checks k
       JOIN users u ON u.id = k.user_id
       LEFT JOIN client_documents d ON d.id = k.doc_id
      WHERE k.status IN ('review', 'pending')
      ORDER BY k.created_at
      LIMIT 200`);
  return r.rows.map(x => ({
    id: String(x.id),
    clientName: x.client_name,
    docKind: x.doc_kind || '',
    docLabel: docs.KIND_LABEL[x.doc_kind] || '',
    attempt: Number(x.attempt || 1),
    createdAt: x.created_at,
  }));
}

/**
 * Les deux images à comparer, en clair, pour la seule décision.
 *
 * Elles ne sortent QUE par ici, uniquement pour un dossier en attente, et la
 * consultation est tracée — mêmes règles que `documents.fileFor`. Sans les
 * deux côte à côte, il n'y a rien à comparer : les renvoyer séparément
 * obligerait à ouvrir deux fois.
 */
async function filesFor(id) {
  const r = await db.one(
    `SELECT k.selfie_enc, k.mime, k.doc_id, d.file_enc AS doc_enc, d.mime AS doc_mime, d.kind
       FROM kyc_checks k
       LEFT JOIN client_documents d ON d.id = k.doc_id
      WHERE k.id = $1 AND k.status IN ('review', 'pending')`, [id]);
  if (!r || !r.selfie_enc) throw err(404, 'Aucune vérification en attente sous cet identifiant.');

  let selfie = '';
  try { selfie = sec.decrypt(r.selfie_enc).toString('base64'); }
  catch (e) { throw err(500, 'Déchiffrement impossible (DATA_KEY ?).'); }

  // La pièce peut avoir été purgée (90 jours) alors que la vérification, elle,
  // attend encore. On rend le selfie quand même, en le disant : l'équipe
  // saura qu'elle n'a rien à comparer plutôt que de croire à une panne.
  let piece = '';
  if (r.doc_enc) {
    try { piece = sec.decrypt(r.doc_enc).toString('base64'); } catch (e) { piece = ''; }
  }

  return {
    selfie: `data:${r.mime || 'image/jpeg'};base64,${selfie}`,
    piece: piece ? `data:${r.doc_mime || 'image/jpeg'};base64,${piece}` : '',
    kind: r.kind || '',
    label: docs.KIND_LABEL[r.kind] || '',
  };
}

/**
 * Rend la décision, et EFFACE le selfie dans le même mouvement.
 *
 * Le selfie n'a d'usage que jusqu'à la comparaison. Le garder « au cas où »
 * serait conserver une donnée biométrique sans finalité — exactement ce que
 * la minimisation interdit.
 */
async function review(reviewer, id, status, reason) {
  if (!DECISIONS.includes(status)) throw err(400, 'Décision invalide.');
  const motif = (typeof reason === 'string' ? reason : '').trim().slice(0, 300);
  if (status === 'failed' && !motif) throw err(400, 'Indiquez le motif du refus.');

  const r = await db.one(
    `UPDATE kyc_checks
        SET status = $2, reason = $3, reviewed_by = $4, decided_at = now(), selfie_enc = NULL
      WHERE id = $1 AND status IN ('review', 'pending')
      RETURNING *`,
    [id, status, motif, reviewer.id]);
  if (!r) throw err(404, 'Vérification introuvable ou déjà tranchée.');
  return view(r);
}

/** Vérification en cours de validité ? Utilisé par les règles métier. */
async function estConfirme(userId) {
  const rows = await mesControles(userId);
  return etat(rows).statut === 'validee';
}

module.exports = {
  STATUSES, DECISIONS, MAX_ATTEMPTS, ATTEMPT_WINDOW_H, KEEP_DAYS, MAX_SELFIE, VALID_DAYS,
  // règles pures
  checkSelfie, pieceAComparer, etat, peutTenter,
  // base
  mine, submit, listPending, filesFor, review, estConfirme,
};
