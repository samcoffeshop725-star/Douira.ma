/* =====================================================================
   Les prestations : une intervention réellement faite chez un client.

   LE DÉROULÉ, EN DEUX TEMPS.

     AVANT de commencer, le prestataire scanne la carte du client et saisit
     le prix demandé. La prestation s'ouvre.

     APRÈS avoir terminé, il rescanne la même carte. La prestation se ferme.

   LE DEUXIÈME SCAN NE VAUT QUE PARCE QUE LE PREMIER A EU LIEU. Le client a
   vu le prix AVANT que le travail commence : c'est toute la raison d'être des
   deux temps. D'où la règle qui gouverne ce fichier — le montant est fixé à
   l'ouverture et n'est JAMAIS réécrit à la fermeture. Un prix qu'on peut
   relever une fois le travail fait n'est pas un prix annoncé, c'est une
   addition.

   TROIS AUTRES RÈGLES, ET CE QUI ARRIVE SANS ELLES.

     QUI SCANNE. Seul celui à qui le service est confié peut ouvrir et fermer
     une prestation dessus. Sans ce contrôle, n'importe quel collaborateur
     pourrait facturer au nom d'un autre — et le journal des scans désignerait
     le mauvais responsable.

     LA MÊME CARTE AUX DEUX BOUTS. On ferme avec la carte du client qu'on a
     scanné en ouvrant. Sans cela, on pourrait ouvrir chez l'un et clore chez
     l'autre, et la trace ne prouverait plus rien.

     UN SEUL TRAVAIL À LA FOIS. Un index unique partiel en base interdit deux
     prestations ouvertes pour un même couple (service, client). Un deuxième
     scan d'ouverture ne crée donc rien : il RETROUVE celle qui est en cours.
     C'est ce qui rend l'appli supportable quand le réseau hésite et qu'on
     scanne deux fois.

   ON N'ENCAISSE PAS ICI. `paid_at` dit seulement si le règlement a été
   enregistré. Une prestation terminée et non réglée se lit « à payer ».

   Règles pures éprouvées : voir api/test/interventions.test.js.
   ===================================================================== */
'use strict';
const db = require('./db');
const mny = require('./money');
const scan = require('./scan');

function err(status, msg) { const e = new Error(msg); e.status = status; return e; }

/** Les états d'une prestation, et ce qu'ils affirment. */
const ETATS = ['en_cours', 'terminee', 'annulee'];

/**
 * Le montant demandé, en unités entières de la devise.
 *
 * Fonction pure. Refuse plutôt que de corriger : un prix mal saisi qu'on
 * arrondit en silence devient un prix que personne n'a annoncé. Le zéro est
 * admis — un geste commercial est un montant, pas une absence.
 *
 * @throws si ce n'est pas un entier positif raisonnable
 */
function montantValide(v) {
  if (v === null || v === undefined || v === '') throw err(400, 'Indiquez le prix demandé.');
  const n = Number(v);
  if (!Number.isFinite(n)) throw err(400, 'Le prix doit être un nombre.');
  if (n < 0) throw err(400, 'Le prix ne peut pas être négatif.');
  if (!Number.isInteger(n)) throw err(400, 'Le prix se saisit en unités entières, sans centimes.');
  // Un plafond franc vaut mieux qu'un débordement silencieux : au-delà, c'est
  // une faute de frappe, et la refuser coûte moins cher que de la corriger.
  if (n > 1000000) throw err(400, 'Ce prix dépasse le maximum autorisé.');
  return n;
}

/**
 * Ce prestataire peut-il intervenir sur CE service ?
 *
 * Fonction pure, pour que la règle se lise d'un coup d'œil. L'administration
 * passe partout — elle doit pouvoir dépanner un client sur place. Un
 * collaborateur ne passe que sur ce qui lui est confié.
 */
function peutIntervenir(user, service) {
  if (!user || !service) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'collaborator') return false;
  if (!service.assignee_id) return false;
  return String(service.assignee_id) === String(user.id);
}

/**
 * Le client scanné est-il bien celui de la prestation ouverte ?
 *
 * Sans cette vérification, on ouvrirait chez l'un et clorait chez l'autre :
 * la trace ne prouverait plus que le travail a été fait pour quelqu'un.
 */
const memeClient = (prestation, clientId) =>
  !!prestation && !!clientId && String(prestation.client_id) === String(clientId);

/**
 * Ce qu'une prestation devient pour le client, sur sa page Réservations.
 *
 * Trois états, et un seul mot pour chacun :
 *   en cours  — le prestataire est chez vous, il a commencé ;
 *   à payer   — c'est fait, le règlement n'est pas enregistré ;
 *   réglé     — c'est fait et payé ;
 *   annulée   — elle n'a pas eu lieu.
 *
 * Fonction pure : l'état se déduit, il ne se stocke pas en double. Deux
 * sources de vérité pour un même fait finissent toujours par se contredire.
 */
function etatClient(p) {
  if (!p) return '';
  if (p.status === 'annulee') return 'annulee';
  if (p.status === 'en_cours') return 'en_cours';
  return p.paid_at ? 'reglee' : 'a_payer';
}

/** Le libellé français d'un état, écrit une fois. */
const LIBELLE = {
  en_cours: 'En cours',
  a_payer: 'À payer',
  reglee: 'Réglée',
  annulee: 'Annulée',
};

/* ---------------- Mise en forme ---------------- */

const vue = r => ({
  id: r.id,
  serviceId: r.service_id,
  serviceNom: r.service_nom || '',
  categorie: r.service_categorie || '',
  clientId: r.client_id,
  clientNom: r.client_nom || '',
  prestataireId: r.provider_id,
  prestataireNom: r.provider_nom || '',
  statut: r.status,
  etat: etatClient(r),
  etatLibelle: LIBELLE[etatClient(r)] || '',
  montant: r.amount == null ? null : Number(r.amount),
  devise: r.currency,
  note: r.note || '',
  ville: r.city || '',
  debut: r.started_at,
  fin: r.ended_at,
  reglee: !!r.paid_at,
});

const JOINTURES = `
  LEFT JOIN services sv ON sv.id = i.service_id
  LEFT JOIN users cu ON cu.id = i.client_id
  LEFT JOIN users pu ON pu.id = i.provider_id`;

const COLONNES = `
  i.*, sv.name AS service_nom, sv.category AS service_categorie,
  cu.name AS client_nom, pu.name AS provider_nom`;

/* ---------------- Les deux scans ---------------- */

/**
 * Premier scan : la prestation s'ouvre, le prix est arrêté.
 *
 * @param user   le prestataire qui scanne
 * @param body   { code, serviceId, amount, note? }
 */
async function ouvrir(user, body) {
  const b = body || {};
  if (!user) throw err(401, 'Connectez-vous.');

  const service = await db.one('SELECT * FROM services WHERE id = $1', [String(b.serviceId || '').slice(0, 40)]);
  if (!service) throw err(404, 'Service introuvable.');
  if (!peutIntervenir(user, service)) throw err(403, 'Ce service ne vous est pas confié.');
  if (service.status !== 'published') throw err(409, 'Ce service n’est pas publié.');

  const montant = montantValide(b.amount);

  // On lit la carte AVANT tout le reste : un code invalide doit être un refus
  // net, pas une prestation à moitié ouverte.
  const lu = scan.lireCode(b.code);
  if (!lu || lu.kind !== 'member') throw err(400, 'Présentez la carte de membre du client.');
  const client = await scan.resoudre(lu);

  const droit = scan.droitAuxOffres(client);
  if (!droit.ok) throw err(409, droit.raison);
  if (String(client.id) === String(user.id)) throw err(400, 'Vous ne pouvez pas intervenir pour vous-même.');

  // Déjà ouverte ? On la REND au lieu d'en créer une seconde. Le prestataire
  // a pu scanner deux fois parce que le réseau a hésité : la deuxième fois ne
  // doit rien coûter au client.
  const encours = await db.one(
    `SELECT ${COLONNES} FROM interventions i ${JOINTURES}
      WHERE i.service_id = $1 AND i.client_id = $2 AND i.status = 'en_cours'`,
    [service.id, client.id]);
  if (encours) return { intervention: vue(encours), deja: true };

  // La devise vient de la VILLE du service. (`services` n'a pas de colonne
  // `currency` : la chercher ici ferait croire le contraire au prochain
  // lecteur.) Le corps de la requête ne la décide pas — sans quoi on
  // facturerait un ménage marrakchi en francs CFA.
  const devise = deviseDe(service.city);

  const ligne = await db.tx(async (t) => {
    // Deux ouvertures à la même seconde calculaient le même « iv-N » : la
    // seconde violait la clé et son scan partait avec elle. On sérialise.
    await t.query("SELECT pg_advisory_xact_lock(hashtext('interventions_id'))");
    const s = await t.one(
      `INSERT INTO scans (scanner_id, scanner_role, subject_id, kind, service_id, motif, note)
       VALUES ($1,$2,$3,'member',$4,'service',$5) RETURNING id`,
      [user.id, user.role, client.id, service.id, 'Début de prestation']);
    const i = await t.one(
      `INSERT INTO interventions (id, service_id, client_id, provider_id, status, amount, currency, note, city, start_scan)
       VALUES ($1,$2,$3,$4,'en_cours',$5,$6,$7,$8,$9) RETURNING id`,
      [await prochainId(t), service.id, client.id, user.id, montant, devise,
       String(b.note || '').slice(0, 300), service.city || '', s.id]);
    return i;
  });

  const cree = await db.one(
    `SELECT ${COLONNES} FROM interventions i ${JOINTURES} WHERE i.id = $1`, [ligne.id]);
  return { intervention: vue(cree), deja: false };
}

/**
 * Second scan : la prestation se ferme.
 *
 * Le montant n'est PAS relu depuis le corps de la requête : il a été arrêté à
 * l'ouverture, devant le client. C'est la seule garantie qu'il a eue.
 *
 * @param body { code, serviceId }
 */
async function fermer(user, body) {
  const b = body || {};
  if (!user) throw err(401, 'Connectez-vous.');

  const service = await db.one('SELECT * FROM services WHERE id = $1', [String(b.serviceId || '').slice(0, 40)]);
  if (!service) throw err(404, 'Service introuvable.');
  if (!peutIntervenir(user, service)) throw err(403, 'Ce service ne vous est pas confié.');

  const lu = scan.lireCode(b.code);
  if (!lu || lu.kind !== 'member') throw err(400, 'Présentez la carte de membre du client.');
  const client = await scan.resoudre(lu);

  const encours = await db.one(
    `SELECT * FROM interventions WHERE service_id = $1 AND client_id = $2 AND status = 'en_cours'`,
    [service.id, client.id]);
  if (!encours) {
    throw err(409, 'Aucune prestation en cours pour ce client sur ce service. Scannez d’abord pour commencer.');
  }
  // Ceinture ET bretelles : la requête ci-dessus filtre déjà sur le client,
  // mais la règle doit être dite là où on la lit.
  if (!memeClient(encours, client.id)) throw err(409, 'Ce n’est pas la carte du client de cette prestation.');

  const ligne = await db.tx(async (t) => {
    const s = await t.one(
      `INSERT INTO scans (scanner_id, scanner_role, subject_id, kind, service_id, motif, note)
       VALUES ($1,$2,$3,'member',$4,'service',$5) RETURNING id`,
      [user.id, user.role, client.id, service.id, 'Fin de prestation']);
    return t.one(
      `UPDATE interventions SET status = 'terminee', ended_at = now(), end_scan = $2
        WHERE id = $1 AND status = 'en_cours' RETURNING id`,
      [encours.id, s.id]);
  });
  if (!ligne) throw err(409, 'Cette prestation vient d’être fermée.');

  const close = await db.one(
    `SELECT ${COLONNES} FROM interventions i ${JOINTURES} WHERE i.id = $1`, [encours.id]);
  return { intervention: vue(close) };
}

/** Annule une prestation ouverte : elle n'a pas eu lieu. */
async function annuler(user, id, motif) {
  if (!user) throw err(401, 'Connectez-vous.');
  const p = await db.one('SELECT * FROM interventions WHERE id = $1', [String(id || '').slice(0, 40)]);
  if (!p) throw err(404, 'Prestation introuvable.');
  const service = await db.one('SELECT * FROM services WHERE id = $1', [p.service_id]);
  if (!peutIntervenir(user, service)) throw err(403, 'Cette prestation ne vous appartient pas.');
  if (p.status !== 'en_cours') throw err(409, 'Seule une prestation en cours peut être annulée.');

  await db.query(
    `UPDATE interventions SET status = 'annulee', note = CASE WHEN $2 = '' THEN note ELSE $2 END
      WHERE id = $1 AND status = 'en_cours'`,
    [p.id, String(motif || '').slice(0, 300)]);
  const a = await db.one(`SELECT ${COLONNES} FROM interventions i ${JOINTURES} WHERE i.id = $1`, [p.id]);
  return { intervention: vue(a) };
}

/* ---------------- Lectures ---------------- */

/** Ce que le CLIENT voit sur sa page Réservations. */
async function pourClient(userId) {
  const r = await db.query(
    `SELECT ${COLONNES} FROM interventions i ${JOINTURES}
      WHERE i.client_id = $1 ORDER BY i.started_at DESC LIMIT 200`, [userId]);
  return r.rows.map(vue);
}

/** Ce que le PRESTATAIRE retrouve de son travail. */
async function pourPrestataire(userId) {
  const r = await db.query(
    `SELECT ${COLONNES} FROM interventions i ${JOINTURES}
      WHERE i.provider_id = $1 ORDER BY i.started_at DESC LIMIT 200`, [userId]);
  return r.rows.map(vue);
}

/* ---------------- Détails ---------------- */

/**
 * Devise d'une ville : LA MÊME que pour les séjours (lib/money.js, et les
 * destinations réglées en administration). Une table à part disait Dakar en
 * francs CFA quand tout le reste du système facture Dakar en euros : un
 * prestataire qui tapait « 50 » enregistrait 50 XOF, soit huit centimes.
 */
function deviseDe(ville) {
  return mny.currencyForCity(String(ville || '').trim(), 'MAD');
}

/** Identifiant lisible : iv-1, iv-2… Comme le reste du catalogue. */
async function prochainId(t) {
  const q = t || db;
  const r = await q.one(
    `SELECT COALESCE(MAX(CAST(NULLIF(regexp_replace(id, '\\D', '', 'g'), '') AS integer)), 0) + 1 AS n
       FROM interventions`);
  return 'iv-' + (r && r.n ? r.n : 1);
}

module.exports = {
  ETATS, LIBELLE,
  montantValide, peutIntervenir, memeClient, etatClient, deviseDe,
  ouvrir, fermer, annuler, pourClient, pourPrestataire,
};
