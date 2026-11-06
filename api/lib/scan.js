/* =====================================================================
   Lecture d'un code Douira.

   Un seul point d'entrée pour les deux codes qui existent : la carte de
   membre d'un client et le badge d'un membre de l'équipe. Celui qui scanne
   voit aussitôt à qui il a affaire, et le scan est écrit au journal.

   Trois principes.

     ON DIT CE QU'ON SAIT, ET SEULEMENT CELA. Le scan montre si la personne
     est un client en règle, si elle a une réservation, si elle peut utiliser
     les offres. Il ne montre ni son adresse, ni son téléphone, ni l'historique
     de ses séjours : celui qui scanne a besoin de décider, pas de tout savoir.

     TOUT SCAN LAISSE UNE TRACE, même une simple vérification. C'est elle qui
     permettra d'affirmer plus tard qu'un client s'est présenté ou a profité
     d'une offre. Le journal s'ajoute, ne se corrige pas.

     UN CODE INVALIDE EST UN REFUS NET. Pas de « peut-être » : une carte dont
     la signature ne tombe pas juste n'est pas une carte.

   Règles pures : voir api/test/scan.test.js.
   ===================================================================== */
'use strict';
const db = require('./db');
const sec = require('./security');
const cards = require('./cards');
const badges = require('./badges');

function err(status, msg) { const e = new Error(msg); e.status = status; return e; }

/**
 * Qui a le droit de scanner.
 *
 * Propriétaires, collaborateurs (chefs d'équipe compris), administration et
 * agences. Un client ne scanne pas : il présente.
 */
const ROLES_SCAN = ['admin', 'collaborator', 'owner', 'agency'];

const peutScanner = (user) => !!user && ROLES_SCAN.includes(user.role);

/** Motifs admis, et ce qu'ils affirment. */
const MOTIFS = ['verification', 'offre', 'presence', 'service'];

/**
 * Lit un code Douira sans rien vérifier d'autre que sa forme.
 *
 *   DOUIRA|M|<6 chiffres>|<16 hexa majuscules>   carte de membre
 *   DOUIRA|B|<numéro>|<16 hexa majuscules>       badge d'équipe
 *
 * Renvoie null pour tout le reste — y compris un QR d'un autre système, qu'on
 * ne doit surtout pas essayer d'interpréter.
 */
function lireCode(code) {
  const s = String(code || '').trim();
  const m = /^DOUIRA\|M\|(\d{6})\|([A-Z0-9]{16})$/.exec(s);
  if (m) return { kind: 'member', numero: Number(m[1]), jeton: m[2] };
  const b = /^DOUIRA\|B\|(\d{1,6})\|([A-Z0-9]{16})$/.exec(s);
  if (b) return { kind: 'badge', numero: Number(b[1]), jeton: b[2] };
  return null;
}

/**
 * Le client peut-il utiliser les offres aujourd'hui ?
 *
 * Deux conditions, et une seule raison affichée — la plus bloquante d'abord,
 * pour que celui qui scanne sache quoi dire.
 */
function droitAuxOffres(user) {
  if (!user) return { ok: false, raison: 'Compte introuvable.' };
  if (user.deleted_at) return { ok: false, raison: 'Ce compte a été supprimé.' };
  if (user.status === 'suspendu') return { ok: false, raison: 'Ce compte est suspendu.' };
  if (user.role !== 'client') return { ok: false, raison: 'Ce compte n’est pas un compte client.' };
  return { ok: true, raison: '' };
}

/**
 * Résume les réservations d'un client pour celui qui scanne.
 *
 * Ce qui compte au comptoir : y a-t-il un séjour EN COURS, et sinon le
 * prochain. Le passé ne sert à rien ici.
 *
 * @param bookings  réservations confirmées, dans n'importe quel ordre
 * @param jour      date du jour (AAAA-MM-JJ), injectée pour les tests
 */
function resumeSejours(bookings, jour) {
  const d = String(jour || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const list = (Array.isArray(bookings) ? bookings : [])
    .filter((b) => b && b.status === 'confirmed')
    .map((b) => ({
      id: String(b.id),
      listingId: b.listing_id,
      start: String(b.start_date).slice(0, 10),
      end: String(b.end_date).slice(0, 10),
    }));

  // La date de départ est exclusive : le jour du départ, le séjour est fini.
  const enCours = list.find((b) => b.start <= d && d < b.end) || null;
  const aVenir = list
    .filter((b) => b.start > d)
    .sort((x, y) => (x.start < y.start ? -1 : 1))[0] || null;

  return { enCours, aVenir, total: list.length };
}

/* ---------------- Accès base ---------------- */

/**
 * Retrouve la personne derrière un code, signature vérifiée.
 *
 * La comparaison du jeton passe par safeEqual : comparer deux signatures
 * caractère par caractère laisse deviner la bonne par le temps de réponse.
 */
async function resoudre(lu) {
  if (!lu) throw err(400, 'Code inconnu : ce n’est pas une carte Douira.');

  if (lu.kind === 'member') {
    const u = await db.one('SELECT * FROM users WHERE member_no = $1 AND deleted_at IS NULL', [lu.numero]);
    if (!u || !sec.safeEqual(sec.memberToken(u.id, u.member_no, u.card_version), lu.jeton)) {
      throw err(400, 'Carte inconnue ou invalide.');
    }
    return u;
  }

  const u = await db.one('SELECT * FROM users WHERE badge_no = $1 AND deleted_at IS NULL', [lu.numero]);
  if (!u || !sec.safeEqual(sec.badgeToken(u.id, u.badge_no, u.card_version), lu.jeton)) {
    throw err(400, 'Badge inconnu ou invalide.');
  }
  return u;
}

/**
 * Scanne un code et écrit le passage au journal.
 *
 * @param scanner  celui qui scanne
 * @param body     { code, motif?, activityId?, serviceId?, bookingId?, note? }
 */
async function scanner(scanner_, body) {
  if (!peutScanner(scanner_)) throw err(403, 'Vous n’êtes pas autorisé à scanner.');

  const b = body || {};
  const lu = lireCode(b.code);
  const sujet = await resoudre(lu);

  const motif = MOTIFS.includes(String(b.motif || '')) ? String(b.motif) : 'verification';
  const activityId = b.activityId ? String(b.activityId).slice(0, 40) : null;
  const serviceId = b.serviceId ? String(b.serviceId).slice(0, 40) : null;

  // RATTACHER UN SCAN À UN SERVICE, C'EST EN RÉPONDRE. Le rôle seul ne
  // suffisait pas : n'importe quel collaborateur pouvait écrire « service
  // effectué » sur le service d'un autre, et le journal aurait désigné le
  // mauvais responsable — c'est précisément ce que ce journal est censé
  // établir. On exige donc d'être celui à qui le service est confié.
  if (serviceId) {
    const sv = await db.one('SELECT id, assignee_id FROM services WHERE id = $1', [serviceId]);
    if (!sv) throw err(404, 'Service introuvable.');
    const sien = scanner_.role === 'admin'
      || (!!sv.assignee_id && String(sv.assignee_id) === String(scanner_.id));
    if (!sien) throw err(403, 'Ce service ne vous est pas confié.');
  }
  // Même règle pour une offre : on ne journalise « a profité de l'offre X »
  // que chez l'agence qui porte X. Sinon une agence écrivait des passages au
  // nom d'une autre, et le journal — qui sert de preuve — mentait.
  if (activityId) {
    const act = await db.one('SELECT id, agency_id FROM activities WHERE id = $1', [activityId]);
    if (!act) throw err(404, 'Activité introuvable.');
    const sienne = scanner_.role === 'admin' || scanner_.role === 'collaborator'
      || (!!act.agency_id && String(act.agency_id) === String(scanner_.id));
    if (!sienne) throw err(403, 'Cette activité ne vous appartient pas.');
  }
  // Et une présence ne se rattache qu'à une réservation DU CLIENT SCANNÉ — et,
  // pour un propriétaire, dans un de SES logements.
  let bookingId = b.bookingId ? String(b.bookingId).slice(0, 20) : null;
  if (bookingId) {
    if (lu.kind !== 'member') throw err(400, 'Une réservation ne se rattache qu’à un client.');
    const bk = await db.one('SELECT b.id, l.owner_id FROM bookings b LEFT JOIN listings l ON l.id = b.listing_id WHERE b.id = $1 AND b.user_id = $2', [bookingId, sujet.id]);
    if (!bk) throw err(404, 'Réservation introuvable pour ce client.');
    if (scanner_.role === 'owner' && String(bk.owner_id || '') !== String(scanner_.id)) throw err(403, 'Cette réservation n’est pas dans un de vos logements.');
    if (scanner_.role === 'agency') throw err(403, 'Une agence ne journalise pas de présence.');
  }

  // Ce que le scanneur voit. Rien de plus que ce qu'il lui faut pour décider.
  let vue;
  if (lu.kind === 'member') {
    const droit = droitAuxOffres(sujet);
    // Où le client dort, et jusqu'à quand : l'équipe le voit, un propriétaire
    // ne voit que ses propres logements, une agence rien — une remise au
    // restaurant ne justifie pas de savoir où cette personne loge ce soir.
    let rows = [];
    if (scanner_.role === 'admin' || scanner_.role === 'collaborator') {
      rows = (await db.query(
        "SELECT id, listing_id, start_date, end_date, status FROM bookings WHERE user_id = $1 AND status = 'confirmed'",
        [sujet.id])).rows;
    } else if (scanner_.role === 'owner') {
      rows = (await db.query(
        "SELECT b.id, b.listing_id, b.start_date, b.end_date, b.status FROM bookings b JOIN listings l ON l.id = b.listing_id WHERE b.user_id = $1 AND b.status = 'confirmed' AND l.owner_id = $2",
        [sujet.id, scanner_.id])).rows;
    }
    vue = {
      kind: 'member',
      nom: sujet.name,
      memberNo: String(sujet.member_no),
      niveau: cards.vue(sujet.card_tier),
      clientActif: droit.ok,
      raison: droit.raison,
      sejours: resumeSejours(rows),
      depuis: sujet.created_at,
    };
  } else {
    vue = {
      kind: 'badge',
      nom: sujet.name,
      badgeNo: sujet.badge_no,
      fonction: badges.fonction(sujet),
      livree: badges.livree(sujet),
      // Un badge vaut tant que le compte est actif : on le dit franchement.
      actif: sujet.status !== 'suspendu',
      depuis: sujet.created_at,
    };
  }

  const ligne = await db.one(
    `INSERT INTO scans (scanner_id, scanner_role, subject_id, kind, activity_id, service_id, booking_id, motif, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, at`,
    [scanner_.id, scanner_.role, sujet.id, lu.kind, activityId, serviceId, bookingId, motif,
     String(b.note || '').slice(0, 300)]);

  return { ...vue, scan: { id: String(ligne.id), at: ligne.at, motif } };
}

/** Derniers scans d'une personne, pour pouvoir dire ce qui s'est passé. */
async function historique(subjectId, limite = 20) {
  const r = await db.query(
    `SELECT s.id, s.at, s.kind, s.motif, s.activity_id, s.service_id, s.booking_id,
            u.name AS scanner_name, s.scanner_role
       FROM scans s LEFT JOIN users u ON u.id = s.scanner_id
      WHERE s.subject_id = $1 ORDER BY s.at DESC LIMIT $2`,
    [subjectId, Math.min(100, Math.max(1, limite))]);
  return r.rows.map((x) => ({
    id: String(x.id), at: x.at, kind: x.kind, motif: x.motif,
    activityId: x.activity_id, serviceId: x.service_id, bookingId: x.booking_id,
    par: x.scanner_name || 'Compte supprimé', role: x.scanner_role,
  }));
}

module.exports = {
  ROLES_SCAN, MOTIFS, peutScanner, lireCode, droitAuxOffres, resumeSejours,
  resoudre, scanner, historique,
};
