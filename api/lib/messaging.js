/* =====================================================================
   Messagerie, avis de séjour et service client.

   Ce module sépare volontairement :
   - les RÈGLES (fonctions pures, sans base ni HTTP) — testables directement,
     voir api/test/messaging.test.js ;
   - les ACCÈS BASE, qui s'appuient sur ces règles.

   Principes :
   - une conversation n'est lisible que par ses membres (l'administrateur n'a pas
     d'accès d'office : un échange client/propriétaire reste privé) ;
   - un avis n'est possible qu'après la fin du séjour, et une seule fois par
     participant (garanti aussi par un index unique en base) ;
   - le service client est tenu par les collaborateurs désignés par l'admin.
   ===================================================================== */
'use strict';
const db = require('./db');
const team = require('./team');
const rat = require('./ratings');
const mod = require('./moderation');

const MAX_BODY = 4000;
function err(status, msg) { const e = new Error(msg); e.status = status; return e; }

/* ---------------- Règles pures (testables sans base) ---------------- */

/** Date du jour au format ISO (AAAA-MM-JJ), fuseau du site. */
const dateStr = v => (typeof v === 'string' ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10));

/**
 * Un séjour est-il terminé ? La date de départ est exclusive : le jour du départ,
 * le séjour est considéré comme terminé.
 */
function stayIsOver(booking, today) {
  if (!booking || !booking.end_date) return false;
  return dateStr(booking.end_date) <= dateStr(today);
}

/**
 * `userId` peut-il déposer un avis sur cette réservation ?
 * Renvoie { ok: true } ou { ok: false, status, reason }.
 *
 * @param booking  ligne bookings (+ owner_id du logement)
 * @param userId   auteur pressenti
 * @param today    date du jour (ISO)
 * @param existing avis déjà déposé par cet auteur sur cette réservation, ou null
 */
function canReview(booking, userId, today, existing) {
  if (!booking) return { ok: false, status: 404, reason: 'Réservation introuvable.' };
  const isClient = booking.user_id === userId;
  const isOwner = !!booking.owner_id && booking.owner_id === userId;
  if (!isClient && !isOwner) return { ok: false, status: 403, reason: 'Vous n\'avez pas participé à ce séjour.' };
  if (booking.status !== 'confirmed') return { ok: false, status: 400, reason: 'Ce séjour n\'a pas eu lieu.' };
  if (!stayIsOver(booking, today)) return { ok: false, status: 400, reason: 'L\'avis sera possible à la fin du séjour.' };
  if (existing) return { ok: false, status: 409, reason: 'Vous avez déjà donné votre avis sur ce séjour.' };
  return { ok: true, part: isClient ? 'client' : 'owner' };
}

/**
 * `userId` peut-il noter cet ÉCHANGE, et qui note-t-il ?
 *
 * Trois garde-fous, et un seul principe : on ne note que ce qu'on a vécu.
 * - il faut être membre de la conversation ;
 * - l'autre partie doit avoir répondu — noter un fil resté sans réponse
 *   mesurerait le silence, pas le service ;
 * - pour une conversation de séjour, on attend la fin du séjour, comme pour
 *   l'avis du logement.
 *
 * @param conv      ligne conversations
 * @param members   lignes conversation_members (user_id, part)
 * @param messages  [{ sender_id }] de la conversation
 * @param userId    auteur pressenti
 * @param today     date du jour (ISO)
 * @param booking   réservation liée, pour une conversation de séjour (ou null)
 * @param existing  note déjà déposée par cet auteur, ou null
 */
function canRateConversation(conv, members, messages, userId, today, booking, existing) {
  if (!conv) return { ok: false, status: 404, reason: 'Conversation introuvable.' };
  if (!isMember(members, userId)) return { ok: false, status: 403, reason: 'Vous ne participez pas à cet échange.' };
  if (existing) return { ok: false, status: 409, reason: 'Vous avez déjà noté cet échange.' };

  const me = members.find(m => m.user_id === userId);
  const others = members.filter(m => m.user_id !== userId);
  if (!others.length) return { ok: false, status: 400, reason: 'Cet échange n\'a pas d\'interlocuteur.' };

  const aRepondu = Array.isArray(messages) && messages.some(m => m && m.sender_id && m.sender_id !== userId);
  if (!aRepondu) return { ok: false, status: 400, reason: 'La note sera possible dès qu\'on vous aura répondu.' };

  if (conv.kind === 'booking') {
    if (!booking) return { ok: false, status: 404, reason: 'Réservation introuvable.' };
    if (!stayIsOver(booking, today)) return { ok: false, status: 400, reason: 'La note sera possible à la fin du séjour.' };
  }

  // Qui est noté : la part d'en face. Le service client peut compter plusieurs
  // agents — on note alors le service, sans désigner personne.
  const parts = [...new Set(others.map(m => m.part).filter(Boolean))];
  const targetPart = parts.includes('support') ? 'support' : (parts[0] || (me && me.part === 'client' ? 'owner' : 'client'));
  const candidats = others.filter(m => m.part === targetPart);
  const targetId = candidats.length === 1 ? candidats[0].user_id : null;

  return { ok: true, targetPart, targetId };
}

/** Une note doit être un entier de 1 à 5. */
function validRating(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5;
}

/** `userId` est-il membre de la conversation ? (seule porte d'entrée en lecture) */
function isMember(members, userId) {
  return Array.isArray(members) && members.some(m => m && m.user_id === userId);
}

/** Qui participe à la conversation d'une réservation : le client et le propriétaire. */
function bookingParticipants(booking) {
  const out = [{ user_id: booking.user_id, part: 'client' }];
  if (booking.owner_id && booking.owner_id !== booking.user_id) out.push({ user_id: booking.owner_id, part: 'owner' });
  return out;
}

/** Corps de message : non vide, longueur bornée. */
function cleanBody(v) {
  const s = (typeof v === 'string' ? v : '').trim();
  if (!s) return null;
  return s.slice(0, MAX_BODY);
}

/* ---------------- Accès base ---------------- */

async function membersOf(conversationId) {
  const r = await db.query('SELECT user_id, part FROM conversation_members WHERE conversation_id = $1', [conversationId]);
  return r.rows;
}

/**
 * Mise en forme d'une ligne de la liste des conversations.
 *
 * La liste doit pouvoir être dessinée telle quelle : photo du logement, dates
 * du séjour, dernier message et qui l'a écrit. Sans cela l'appli devrait
 * recroiser chaque conversation avec le catalogue et les réservations — ce
 * qu'un propriétaire ne peut pas faire, puisqu'il ne voit pas les
 * réservations des autres par ce chemin.
 *
 * Fonction pure : voir api/test/conversation-rows.test.js.
 *
 * @param x       ligne SQL
 * @param userId  qui regarde — sert à savoir si le dernier message est de lui
 */
function toConversationRow(x, userId) {
  const photos = jsonArr(x.listing_photos);
  return {
    id: String(x.id),
    kind: x.kind,
    bookingId: x.booking_id,
    listingId: x.listing_id,
    subject: x.subject,
    lastAt: x.last_at,
    lastBody: x.last_body,
    part: x.part,
    unread: Number(x.unread || 0),
    // Un client ne reçoit pas l'organigramme : la fiche d'un service cache qui
    // le tient (voir services.view), et le guichet est « le service client »,
    // pas la liste nominative de tous ses agents. L'équipe, elle, voit les noms.
    others: x.part === 'client' && x.kind === 'service' ? 'Prestataire Douira'
      : x.part === 'client' && x.kind === 'support' ? 'Service client'
      : (x.others || ''),
    // Le dernier message est-il de moi ? L'appli préfixe alors « Vous : ».
    lastMine: x.last_sender != null && String(x.last_sender) === String(userId),
    // Le logement dont il est question, pour la vignette et le titre.
    // Une conversation d'expérience porte le nom et la photo de l'expérience,
    // à la place de celles du logement : la ligne se lit de la même façon.
    listingTitle: x.listing_title || x.activity_name || x.vehicle_name || '',
    listingCity: x.listing_city || '',
    listingPhoto: photos.length ? String(photos[0]) : (x.activity_photo || x.vehicle_photo || ''),
    // Dates du séjour, quand la conversation en suit un.
    start: x.start_date ? dateStr(x.start_date) : '',
    end: x.end_date ? dateStr(x.end_date) : '',
  };
}

/** Liste JSON stockée en texte (photos, équipements…) ; jamais d'exception. */
function jsonArr(v) {
  if (Array.isArray(v)) return v;
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

/** Conversations de l'utilisateur, avec le dernier message et le nombre de non-lus. */
async function listForUser(userId) {
  const r = await db.query(
    `SELECT c.id, c.kind, c.booking_id, c.listing_id, c.subject, c.last_at,
            cm.part, cm.last_read_at,
            l.title AS listing_title, l.city AS listing_city, l.photos AS listing_photos,
            ac.name AS activity_name, ac.photo AS activity_photo,
            ve.name AS vehicle_name, ve.photo AS vehicle_photo,
            b.start_date, b.end_date,
            (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.at DESC LIMIT 1) AS last_body,
            (SELECT sender_id FROM messages m WHERE m.conversation_id = c.id ORDER BY m.at DESC LIMIT 1) AS last_sender,
            (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id
               AND (cm.last_read_at IS NULL OR m.at > cm.last_read_at) AND m.sender_id <> $1) AS unread,
            (SELECT string_agg(u.name, ', ') FROM conversation_members x JOIN users u ON u.id = x.user_id
               WHERE x.conversation_id = c.id AND x.user_id <> $1) AS others
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
       LEFT JOIN listings l ON l.id = c.listing_id
       LEFT JOIN activities ac ON ac.id = c.activity_id
       LEFT JOIN vehicles ve ON ve.id = c.vehicle_id
       LEFT JOIN bookings b ON b.id = c.booking_id
      -- Un fil avec une personne que j'ai bloquée disparaît de ma liste.
      WHERE NOT EXISTS (
        SELECT 1 FROM conversation_members y JOIN user_blocks ub ON ub.blocked_id = y.user_id AND ub.blocker_id = $1
         WHERE y.conversation_id = c.id AND y.user_id <> $1 AND y.part <> 'support')
      ORDER BY c.last_at DESC LIMIT 100`, [userId]);
  return r.rows.map(x => toConversationRow(x, userId));
}

/** Lit une conversation : refuse si l'utilisateur n'en est pas membre. */
async function readConversation(userId, conversationId) {
  const c = await db.one('SELECT * FROM conversations WHERE id = $1', [conversationId]);
  if (!c) throw err(404, 'Conversation introuvable.');
  const members = await membersOf(c.id);
  if (!isMember(members, userId)) throw err(403, 'Accès refusé.');
  const m = await db.query(
    `SELECT m.id, m.sender_id, m.body, m.at, m.from_assistant, u.name AS sender_name
       FROM messages m LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = $1 ORDER BY m.at LIMIT 500`, [c.id]);
  await db.query('UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2', [c.id, userId]);
  // Un client face au guichet ou à un prestataire voit un prénom et l'étiquette
  // Douira, pas le nom complet ni la clé de compte de la personne : ce que la
  // fiche du service et le service client cachent ne doit pas sortir par ici.
  const moi = members.find(x => String(x.user_id) === String(userId));
  const discret = !!moi && moi.part === 'client' && (c.kind === 'service' || c.kind === 'support');
  const prenom = n => String(n || '').trim().split(/\s+/)[0] || 'Douira';
  // Ce que j'ai bloqué ne s'affiche plus — ni ici, ni nulle part.
  const bloques = new Set(await mod.bloquesPar(userId));
  // L'autre personne du fil (hors guichet), pour pouvoir la signaler ou la
  // bloquer depuis l'écran : un identifiant, jamais un nom de plus.
  const autres = members.filter(x => String(x.user_id) !== String(userId) && x.part !== 'support');
  return {
    conversation: {
      id: String(c.id), kind: c.kind, bookingId: c.booking_id, listingId: c.listing_id,
      subject: c.subject, lastAt: c.last_at,
      interlocuteurId: autres.length === 1 ? String(autres[0].user_id) : null,
      bloque: autres.some(x => bloques.has(String(x.user_id))),
    },
    messages: m.rows.filter(x => !x.sender_id || !bloques.has(String(x.sender_id))).map(x => {
      const mine = x.sender_id === userId;
      return {
        id: String(x.id), body: x.body, at: x.at,
        senderId: discret && !mine ? null : x.sender_id,
        senderName: x.from_assistant ? 'Assistant Douira'
          : !x.sender_name ? 'Compte supprimé'
          : discret && !mine ? `${prenom(x.sender_name)} · Douira`
          : x.sender_name,
        fromAssistant: !!x.from_assistant,
        mine,
      };
    }),
  };
}

async function postMessage(userId, conversationId, rawBody) {
  const body = cleanBody(rawBody);
  if (!body) throw err(400, 'Le message est vide.');
  // Les insultes franches n'atteignent pas l'autre : refusées avant d'être écrites.
  mod.exigerPublicable(body);
  const c = await db.one('SELECT * FROM conversations WHERE id = $1', [conversationId]);
  if (!c) throw err(404, 'Conversation introuvable.');
  const members = await membersOf(c.id);
  if (!isMember(members, userId)) throw err(403, 'Accès refusé.');
  // Un blocage entre deux personnes du fil ferme l'écriture dans les deux sens,
  // avec un motif neutre : on ne dit pas à qui est bloqué qu'il l'est.
  for (const m of members) {
    if (String(m.user_id) !== String(userId) && m.part !== 'support' && await mod.bloqueEntre(userId, m.user_id)) {
      throw err(403, 'Vous ne pouvez plus écrire dans cette conversation.');
    }
  }
  const r = await db.one(
    'INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1, $2, $3) RETURNING *', [c.id, userId, body]);
  await db.query('UPDATE conversations SET last_at = now() WHERE id = $1', [c.id]);
  await db.query('UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2', [c.id, userId]);
  return { id: String(r.id), body: r.body, at: r.at, senderId: userId, mine: true };
}

/** Crée (ou retrouve) la conversation d'une réservation : client ↔ propriétaire. */
async function openForBooking(userId, bookingId) {
  const b = await db.one(
    `SELECT b.*, l.owner_id, l.title FROM bookings b LEFT JOIN listings l ON l.id = b.listing_id WHERE b.id = $1`, [bookingId]);
  if (!b) throw err(404, 'Réservation introuvable.');
  const parts = bookingParticipants(b);
  if (!parts.some(p => p.user_id === userId)) throw err(403, 'Accès refusé.');
  const existing = await db.one('SELECT * FROM conversations WHERE booking_id = $1', [b.id]);
  if (existing) return String(existing.id);
  // On n'OUVRE un canal avec le propriétaire que pour un séjour confirmé, ou en
  // cours de paiement (le blocage des dates court encore). Une réservation jamais
  // payée, annulée ou expirée ne donne pas le nom du propriétaire ni sa boîte.
  const enCours = b.status === 'confirmed' || (b.status === 'pending_payment' && b.hold_until && new Date(b.hold_until) > new Date());
  if (!enCours) throw err(409, 'La messagerie s’ouvre une fois la réservation confirmée.');
  const c = await db.one(
    `INSERT INTO conversations (kind, booking_id, listing_id, subject) VALUES ('booking', $1, $2, $3) RETURNING *`,
    [b.id, b.listing_id, b.title || b.listing_id]);
  for (const p of parts) {
    await db.query('INSERT INTO conversation_members (conversation_id, user_id, part) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [c.id, p.user_id, p.part]);
  }
  return String(c.id);
}

/**
 * Crée (ou retrouve) la conversation d'une expérience : client ↔ agence.
 *
 * C'est l'une des deux voies pour commander, l'autre étant l'appel au numéro
 * donné par l'agence. Une seule conversation par couple (expérience, client) :
 * on retrouve son fil au lieu d'en ouvrir un nouveau à chaque question.
 */
async function openForActivity(userId, activityId) {
  const a = await db.one(
    "SELECT id, name, agency_id FROM activities WHERE id = $1 AND status = 'published'", [activityId]);
  if (!a) throw err(404, 'Expérience introuvable.');
  // Sans agence rattachée, il n'y a personne à qui écrire : le dire plutôt que
  // d'ouvrir un fil que nul ne lira.
  if (!a.agency_id) throw err(409, 'Cette expérience n\'a pas encore d\'interlocuteur : appelez le numéro indiqué.');
  if (String(a.agency_id) === String(userId)) throw err(400, 'Vous proposez cette expérience.');

  const existing = await db.one(
    `SELECT c.* FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $2
      WHERE c.activity_id = $1 ORDER BY c.last_at DESC LIMIT 1`, [a.id, userId]);
  if (existing) return String(existing.id);

  const c = await db.one(
    `INSERT INTO conversations (kind, activity_id, subject) VALUES ('activity', $1, $2) RETURNING *`,
    [a.id, String(a.name || '').slice(0, 120)]);
  await db.query('INSERT INTO conversation_members (conversation_id, user_id, part) VALUES ($1, $2, $3)',
    [c.id, userId, 'client']);
  await db.query('INSERT INTO conversation_members (conversation_id, user_id, part) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [c.id, a.agency_id, 'agency']);
  return String(c.id);
}

/**
 * Crée (ou retrouve) la conversation d'un véhicule : client ↔ loueur.
 *
 * Même mécanique que pour une expérience — l'autre voie pour réserver étant
 * l'appel au numéro du loueur.
 */
async function openForVehicle(userId, vehicleId) {
  const v = await db.one(
    "SELECT id, name, agency_id FROM vehicles WHERE id = $1 AND status = 'published'", [vehicleId]);
  if (!v) throw err(404, 'Véhicule introuvable.');
  if (!v.agency_id) throw err(409, 'Ce véhicule n\'a pas encore d\'interlocuteur : appelez le numéro indiqué.');
  if (String(v.agency_id) === String(userId)) throw err(400, 'Vous proposez ce véhicule.');

  const existing = await db.one(
    `SELECT c.* FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $2
      WHERE c.vehicle_id = $1 ORDER BY c.last_at DESC LIMIT 1`, [v.id, userId]);
  if (existing) return String(existing.id);

  const c = await db.one(
    `INSERT INTO conversations (kind, vehicle_id, subject) VALUES ('vehicle', $1, $2) RETURNING *`,
    [v.id, String(v.name || '').slice(0, 120)]);
  await db.query('INSERT INTO conversation_members (conversation_id, user_id, part) VALUES ($1, $2, $3)',
    [c.id, userId, 'client']);
  await db.query('INSERT INTO conversation_members (conversation_id, user_id, part) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [c.id, v.agency_id, 'agency']);
  return String(c.id);
}

/**
 * Crée (ou retrouve) la conversation d'un service : client ↔ prestataire.
 *
 * L'interlocuteur est le collaborateur À QUI LE SERVICE EST CONFIÉ
 * (`assignee_id`), et non le service client : poser la question à celui qui
 * fera le travail évite un intermédiaire qui ne saurait pas répondre.
 *
 * Sans personne en charge, on refuse franchement plutôt que d'ouvrir un fil
 * que nul ne lira — l'autre voie reste le numéro affiché sur la fiche.
 */
async function openForService(userId, serviceId) {
  const sv = await db.one(
    "SELECT id, name, assignee_id, audience FROM services WHERE id = $1 AND status = 'published'", [serviceId]);
  if (!sv) throw err(404, 'Service introuvable.');
  // Un service a une AUDIENCE : certains ne s'adressent qu'aux propriétaires
  // (conciergerie, entretien), d'autres qu'aux voyageurs. La liste publique
  // filtre déjà dessus, mais la route prend un identifiant : sans ce
  // contrôle, un client qui devine « s8 » ouvre un fil sur un service qu'il
  // n'a jamais pu voir.
  const moi = await db.one('SELECT role FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
  const attendue = team.audienceFor(moi && moi.role);
  if (sv.audience !== 'both' && sv.audience !== attendue) {
    throw err(403, 'Ce service ne vous est pas proposé.');
  }
  if (!sv.assignee_id) throw err(409, 'Ce service n\'a pas encore d\'interlocuteur : appelez le numéro indiqué.');
  if (String(sv.assignee_id) === String(userId)) throw err(400, 'Vous assurez ce service.');

  const existing = await db.one(
    `SELECT c.* FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $2
      WHERE c.service_id = $1 ORDER BY c.last_at DESC LIMIT 1`, [sv.id, userId]);
  if (existing) {
    // Le service a pu CHANGER DE MAIN depuis la dernière fois. Sans cette
    // ligne, le client continuait d'écrire à quelqu'un qui n'en a plus la
    // charge, et le nouveau prestataire ne voyait jamais le message.
    // L'ancien reste dans le fil : effacer sa présence effacerait l'historique
    // de ce qu'il a répondu.
    await db.query(
      'INSERT INTO conversation_members (conversation_id, user_id, part) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [existing.id, sv.assignee_id, 'provider']);
    return String(existing.id);
  }

  const c = await db.one(
    `INSERT INTO conversations (kind, service_id, subject) VALUES ('service', $1, $2) RETURNING *`,
    [sv.id, String(sv.name || '').slice(0, 120)]);
  await db.query('INSERT INTO conversation_members (conversation_id, user_id, part) VALUES ($1, $2, $3)',
    [c.id, userId, 'client']);
  await db.query('INSERT INTO conversation_members (conversation_id, user_id, part) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [c.id, sv.assignee_id, 'provider']);
  return String(c.id);
}

/** Ouvre une conversation avec le service client (collaborateurs désignés). */
async function openSupport(userId, subject) {
  const agents = await db.query('SELECT user_id FROM support_agents');
  if (!agents.rows.length) throw err(503, 'Le service client n\'est pas joignable pour le moment.');
  // Une seule conversation de support ouverte par personne.
  const existing = await db.one(
    `SELECT c.* FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
      WHERE c.kind = 'support' AND cm.user_id = $1 ORDER BY c.last_at DESC LIMIT 1`, [userId]);
  if (existing) return String(existing.id);
  const c = await db.one(
    `INSERT INTO conversations (kind, subject) VALUES ('support', $1) RETURNING *`,
    [(typeof subject === 'string' ? subject : '').trim().slice(0, 120) || 'Service client']);
  await db.query('INSERT INTO conversation_members (conversation_id, user_id, part) VALUES ($1, $2, $3)', [c.id, userId, 'client']);
  for (const a of agents.rows) {
    await db.query('INSERT INTO conversation_members (conversation_id, user_id, part) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [c.id, a.user_id, 'support']);
  }
  return String(c.id);
}

/* ---------------- Avis ---------------- */

async function bookingForReview(bookingId) {
  return db.one(
    `SELECT b.*, l.owner_id FROM bookings b LEFT JOIN listings l ON l.id = b.listing_id WHERE b.id = $1`, [bookingId]);
}

async function addReview(userId, bookingId, rating, comment, today) {
  if (!validRating(rating)) throw err(400, 'La note doit être comprise entre 1 et 5.');
  // Un avis est public et définitif : les insultes franches n'y entrent pas.
  mod.exigerPublicable(comment);
  const b = await bookingForReview(bookingId);
  const existing = b ? await db.one('SELECT id FROM reviews WHERE booking_id = $1 AND author_id = $2', [b.id, userId]) : null;
  const check = canReview(b, userId, today, existing);
  if (!check.ok) throw err(check.status, check.reason);
  const target = check.part === 'client' ? b.owner_id : b.user_id;
  const r = await db.one(
    `INSERT INTO reviews (booking_id, author_id, target_id, listing_id, rating, comment)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [b.id, userId, target || null, b.listing_id, Number(rating), (typeof comment === 'string' ? comment : '').trim().slice(0, 1500)]);
  return { id: String(r.id), rating: r.rating, comment: r.comment, at: r.at };
}

/** Avis d'une réservation + si l'utilisateur peut encore en déposer un. */
async function reviewsForBooking(userId, bookingId, today) {
  const b = await bookingForReview(bookingId);
  if (!b) throw err(404, 'Réservation introuvable.');
  if (b.user_id !== userId && b.owner_id !== userId) throw err(403, 'Accès refusé.');
  const r = await db.query(
    `SELECT rv.*, u.name AS author_name FROM reviews rv LEFT JOIN users u ON u.id = rv.author_id
      WHERE rv.booking_id = $1 ORDER BY rv.at`, [bookingId]);
  const mine = r.rows.find(x => x.author_id === userId) || null;
  const check = canReview(b, userId, today, mine);
  return {
    reviews: r.rows.map(x => ({
      id: String(x.id), rating: x.rating, comment: x.comment, at: x.at,
      authorName: x.author_name || 'Compte supprimé', mine: x.author_id === userId,
    })),
    canReview: check.ok,
    reason: check.ok ? '' : check.reason,
  };
}

/** Note moyenne publique d'un logement. */
async function listingRating(listingId) {
  const r = await db.one(
    `SELECT round(avg(rating)::numeric, 1) AS avg, count(*) AS n FROM reviews
      WHERE listing_id = $1 AND target_id IS NOT NULL`, [listingId]);
  return { average: r && r.avg ? Number(r.avg) : null, count: r ? Number(r.n || 0) : 0 };
}

/**
 * Nombre d'avis en dessous duquel la note d'un hôte n'est PAS publiée.
 *
 * Une moyenne sur un ou deux avis ne mesure rien : elle expose surtout celui qui
 * débute, et un seul client mécontent suffirait à le marquer durablement. On
 * préfère ne rien afficher plutôt qu'afficher un chiffre trompeur.
 */
const HOST_MIN_REVIEWS = 3;

/** Fenêtre sur laquelle on juge qu'un logement est recherché. */
const RARE_JOURS = 60;

/**
 * « Perle rare » : la plupart des nuits des deux prochains mois sont prises.
 *
 * Compté sur les réservations réelles, jamais sur un nombre de vues : un
 * logement très regardé mais toujours libre n'est pas rare, et l'annoncer
 * serait un argument de vente sans fondement.
 */
async function isRareFind60(listingId) {
  const r = await db.one(
    `SELECT COALESCE(SUM(
         GREATEST(0, LEAST(end_date, now()::date + $2) - GREATEST(start_date, now()::date))
       ), 0) AS nuits
       FROM bookings
      WHERE listing_id = $1 AND status = 'confirmed'
        AND end_date > now()::date AND start_date < now()::date + $2`,
    [listingId, RARE_JOURS]);
  return rat.isRareFind(r ? Number(r.nuits || 0) : 0, RARE_JOURS);
}

/**
 * Réputation publique d'un logement : la note du lieu, et celle de son hôte.
 *
 * Deux sources pour l'hôte, parce qu'elles disent la même chose sous deux
 * angles : les avis de séjour qui le désignent, et les notes d'échange. Un hôte
 * qui répond bien mais loue un logement moyen ne doit pas être confondu avec
 * l'inverse — d'où deux chiffres séparés plutôt qu'un seul.
 */
/**
 * Avis publics d'un logement, avec la réponse de l'hôte.
 *
 * Seul le PRÉNOM de l'auteur est exposé : un avis est public, le nom de
 * famille de celui qui l'a écrit n'a pas à l'être. Les avis sans commentaire
 * sont écartés — une note seule est déjà comptée dans la moyenne, l'afficher
 * en liste n'apprend rien de plus.
 */
async function listingReviews(listingId, limite = 20, viewerId = null) {
  // Les avis des personnes que le lecteur a bloquées lui sont cachés ; pour un
  // visiteur sans compte, rien n'est caché.
  const r = await db.query(
    `SELECT v.id, v.rating, v.comment, v.at, v.reply, v.reply_at,
            u.name AS author_name
       FROM reviews v
       LEFT JOIN users u ON u.id = v.author_id
      WHERE v.listing_id = $1 AND v.target_id IS NOT NULL AND btrim(v.comment) <> ''
        AND ($3::uuid IS NULL OR NOT EXISTS (SELECT 1 FROM user_blocks ub WHERE ub.blocker_id = $3 AND ub.blocked_id = v.author_id))
      ORDER BY v.at DESC
      LIMIT $2`,
    [listingId, Math.max(1, Math.min(50, Number(limite) || 20)), viewerId || null]);
  return r.rows.map(x => ({
    id: String(x.id),
    rating: Number(x.rating),
    comment: x.comment,
    at: x.at,
    author: String(x.author_name || '').trim().split(/\s+/)[0] || 'Voyageur',
    reply: x.reply || '',
    replyAt: x.reply_at || null,
  }));
}

/**
 * Qui a le droit de répondre à un avis.
 *
 * Le propriétaire du logement concerné, et lui seul — plus l'équipe Douira
 * (admin, ou collaborateur portant le périmètre « listings »), qui répond au
 * nom de la plateforme quand le propriétaire ne le fait pas. Un voyageur ne
 * répond jamais à l'avis d'un autre.
 */
function canReply(user, ownerId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'owner') return String(user.id) === String(ownerId);
  if (user.role === 'collaborator') return (user.scopes || []).includes('listings');
  return false;
}

/** Écrit (ou remplace) la réponse de l'hôte à un avis. */
async function replyToReview(user, reviewId, text) {
  const v = await db.one(
    `SELECT v.id, v.listing_id, l.owner_id
       FROM reviews v LEFT JOIN listings l ON l.id = v.listing_id
      WHERE v.id = $1`, [reviewId]);
  if (!v) throw err(404, 'Avis introuvable.');
  if (!canReply(user, v.owner_id)) throw err(403, 'Seul l’hôte de ce logement peut répondre.');

  const reponse = (typeof text === 'string' ? text : '').trim().slice(0, 1000);
  const r = await db.one(
    `UPDATE reviews
        SET reply = $2,
            reply_at = CASE WHEN $2 = '' THEN NULL ELSE now() END,
            reply_by = CASE WHEN $2 = '' THEN NULL ELSE $3::uuid END
      WHERE id = $1
      RETURNING id, reply, reply_at`,
    [reviewId, reponse, user.id]);
  return { id: String(r.id), reply: r.reply || '', replyAt: r.reply_at || null };
}

async function listingReputation(listingId) {
  const lieu = await listingRating(listingId);

  const l = await db.one('SELECT owner_id FROM listings WHERE id = $1', [listingId]);
  if (!l || !l.owner_id) return { listing: lieu, host: null };

  // Profil public de l'hôte : ce qu'il a bien voulu renseigner, et depuis quand
  // il reçoit. Rien d'obligatoire — une fiche reste valable sans.
  const u = await db.one(
    'SELECT name, host_bio, host_languages, host_photo, created_at FROM users WHERE id = $1 AND deleted_at IS NULL',
    [l.owner_id]);

  const h = await db.one(
    `SELECT round(avg(rating)::numeric, 1) AS avg, count(*) AS n FROM (
        SELECT rating FROM reviews WHERE target_id = $1
        UNION ALL
        SELECT rating FROM conversation_ratings WHERE target_id = $1 AND target_part = 'owner'
     ) t`, [l.owner_id]);

  const n = h ? Number(h.n || 0) : 0;
  const moyenne = h && h.avg ? Number(h.avg) : null;

  // Le PROFIL s'affiche même sans note : on peut présenter quelqu'un sans le
  // noter. Seule la MOYENNE attend d'avoir assez d'avis pour vouloir dire
  // quelque chose.
  const profil = u
    ? {
        // Prénom seul : le nom de famille d'un hôte n'a pas à être public.
        prenom: String(u.name || '').trim().split(/\s+/)[0] || '',
        bio: u.host_bio || '',
        langues: String(u.host_languages || '').split(',').map(x => x.trim()).filter(Boolean),
        photo: u.host_photo || '',
        depuis: u.created_at,
        superhote: rat.isSuperhost(moyenne, n),
      }
    : null;

  const note = n >= HOST_MIN_REVIEWS ? { average: moyenne, count: n } : null;
  if (!profil && !note) return { listing: lieu, host: null };
  return { listing: lieu, host: Object.assign({}, profil, note ? { average: note.average, count: note.count } : {}) };
}

/**
 * La note de QUELQU'UN, telle qu'il la voit lui-même.
 *
 * Distincte de la réputation publique : on montre ici sa note à l'intéressé,
 * même sous le seuil de publication — c'est la sienne, il a le droit de la
 * connaître, et de savoir si elle est déjà visible des autres.
 *
 * Les deux sources sont séparées parce qu'elles ne se corrigent pas de la même
 * façon : un séjour mal noté ne se rattrape pas, un échange suivant si.
 */
async function myRating(userId) {
  const sejours = await db.one(
    'SELECT round(avg(rating)::numeric, 1) AS avg, count(*) AS n FROM reviews WHERE target_id = $1',
    [userId]);
  const echanges = await db.one(
    'SELECT round(avg(rating)::numeric, 1) AS avg, count(*) AS n FROM conversation_ratings WHERE target_id = $1',
    [userId]);
  const total = await db.one(
    `SELECT round(avg(rating)::numeric, 1) AS avg, count(*) AS n FROM (
        SELECT rating FROM reviews WHERE target_id = $1
        UNION ALL
        SELECT rating FROM conversation_ratings WHERE target_id = $1
     ) t`, [userId]);

  const vue = r => ({
    average: r && r.avg ? Number(r.avg) : null,
    count: r ? Number(r.n || 0) : 0,
  });
  const ensemble = vue(total);
  return {
    overall: ensemble,
    stays: vue(sejours),
    exchanges: vue(echanges),
    // Utile à savoir pour un hôte : sa note compte-t-elle déjà pour les clients ?
    publicThreshold: HOST_MIN_REVIEWS,
    isPublic: ensemble.count >= HOST_MIN_REVIEWS,
  };
}

/**
 * Message écrit par l'assistant, sans expéditeur humain.
 *
 * Sert à briefer l'équipe AVANT qu'elle ne prenne la main : le collaborateur
 * doit arriver en sachant ce que le client cherche, pour ne pas lui faire tout
 * répéter. C'est la seule écriture de message qui ne vient pas d'un compte.
 */
async function postAssistantMessage(conversationId, body) {
  const texte = cleanBody(body);
  if (!texte) return null;
  const m = await db.one(
    'INSERT INTO messages (conversation_id, sender_id, body, from_assistant) VALUES ($1, NULL, $2, true) RETURNING *',
    [conversationId, texte]);
  await db.query('UPDATE conversations SET last_at = now() WHERE id = $1', [conversationId]);
  return { id: String(m.id), body: m.body, at: m.at };
}

/* ---------------- Note d'un échange ---------------- */

async function conversationContext(conversationId) {
  const conv = await db.one('SELECT * FROM conversations WHERE id = $1', [conversationId]);
  if (!conv) return null;
  const members = (await db.query('SELECT user_id, part FROM conversation_members WHERE conversation_id = $1', [conv.id])).rows;
  // Un seul message de l'autre partie suffit à prouver qu'on a répondu : inutile
  // de rapatrier tout le fil pour ça.
  const messages = (await db.query('SELECT DISTINCT sender_id FROM messages WHERE conversation_id = $1', [conv.id])).rows;
  const booking = conv.booking_id ? await bookingForReview(conv.booking_id) : null;
  return { conv, members, messages, booking };
}

/** État de la note pour cet utilisateur : la sienne, et s'il peut en donner une. */
async function conversationRating(userId, conversationId, today) {
  const ctx = await conversationContext(conversationId);
  if (!ctx) throw err(404, 'Conversation introuvable.');
  if (!isMember(ctx.members, userId)) throw err(403, 'Accès refusé.');
  const mine = await db.one(
    'SELECT rating, comment, at FROM conversation_ratings WHERE conversation_id = $1 AND author_id = $2',
    [ctx.conv.id, userId]);
  const check = canRateConversation(ctx.conv, ctx.members, ctx.messages, userId, today, ctx.booking, mine);
  return {
    mine: mine ? { rating: mine.rating, comment: mine.comment, at: mine.at } : null,
    canRate: check.ok,
    reason: check.ok ? '' : check.reason,
  };
}

async function rateConversation(userId, conversationId, rating, comment, today) {
  if (!validRating(rating)) throw err(400, 'La note doit être comprise entre 1 et 5.');
  const ctx = await conversationContext(conversationId);
  if (!ctx) throw err(404, 'Conversation introuvable.');
  const mine = await db.one(
    'SELECT id FROM conversation_ratings WHERE conversation_id = $1 AND author_id = $2', [ctx.conv.id, userId]);
  const check = canRateConversation(ctx.conv, ctx.members, ctx.messages, userId, today, ctx.booking, mine);
  if (!check.ok) throw err(check.status, check.reason);
  const r = await db.one(
    `INSERT INTO conversation_ratings (conversation_id, author_id, target_part, target_id, rating, comment)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, rating, comment, at`,
    [ctx.conv.id, userId, check.targetPart, check.targetId,
     Number(rating), (typeof comment === 'string' ? comment : '').trim().slice(0, 1500)]);
  return { id: String(r.id), rating: r.rating, comment: r.comment, at: r.at };
}

/**
 * Ce qui fait la différence : moyennes par part et par personne.
 * Les séjours viennent de `reviews`, les échanges de `conversation_ratings`.
 */
async function ratingsSummary() {
  const parts = await db.query(
    `SELECT target_part AS part, round(avg(rating)::numeric, 1) AS avg, count(*) AS n
       FROM conversation_ratings GROUP BY target_part ORDER BY target_part`);
  const gens = await db.query(
    `SELECT u.id, u.name, u.role,
            round(avg(cr.rating)::numeric, 1) AS avg, count(*) AS n
       FROM conversation_ratings cr JOIN users u ON u.id = cr.target_id
      WHERE u.deleted_at IS NULL
   GROUP BY u.id, u.name, u.role
   ORDER BY avg DESC NULLS LAST, n DESC LIMIT 100`);
  const sejours = await db.one(
    `SELECT round(avg(rating)::numeric, 1) AS avg, count(*) AS n FROM reviews WHERE listing_id IS NOT NULL`);
  return {
    parts: parts.rows.map(x => ({ part: x.part, average: x.avg ? Number(x.avg) : null, count: Number(x.n || 0) })),
    people: gens.rows.map(x => ({
      id: x.id, name: x.name, role: x.role,
      average: x.avg ? Number(x.avg) : null, count: Number(x.n || 0),
    })),
    stays: { average: sejours && sejours.avg ? Number(sejours.avg) : null, count: sejours ? Number(sejours.n || 0) : 0 },
  };
}

/* ---------------- Service client (admin) ---------------- */

async function listSupportAgents() {
  const r = await db.query(
    `SELECT s.user_id, s.at, u.name, u.email, u.role FROM support_agents s JOIN users u ON u.id = s.user_id
      WHERE u.deleted_at IS NULL ORDER BY u.name`);
  return r.rows.map(x => ({ id: x.user_id, name: x.name, email: x.email, role: x.role, since: x.at }));
}

async function assignSupportAgent(admin, userId) {
  const u = await db.one("SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL", [userId]);
  if (!u) throw err(404, 'Compte introuvable.');
  if (u.role !== 'collaborator' && u.role !== 'admin') throw err(400, 'Seuls les collaborateurs peuvent tenir le service client.');
  await db.query('INSERT INTO support_agents (user_id, assigned_by) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING', [userId, admin.id]);
  // Le nouveau collaborateur rejoint les conversations de support déjà ouvertes.
  await db.query(
    `INSERT INTO conversation_members (conversation_id, user_id, part)
     SELECT c.id, $1, 'support' FROM conversations c WHERE c.kind = 'support'
     ON CONFLICT DO NOTHING`, [userId]);
  return listSupportAgents();
}

async function removeSupportAgent(userId) {
  await db.query('DELETE FROM support_agents WHERE user_id = $1', [userId]);
  // On le retire des conversations de support, sans toucher aux messages déjà envoyés.
  await db.query(
    `DELETE FROM conversation_members cm USING conversations c
      WHERE cm.conversation_id = c.id AND c.kind = 'support' AND cm.user_id = $1`, [userId]);
  return listSupportAgents();
}

module.exports = {
  // règles pures
  stayIsOver, canReview, canRateConversation, validRating, isMember, bookingParticipants, cleanBody,
  toConversationRow,
  // base
  listForUser, readConversation, postMessage, openForBooking, openForActivity, openForVehicle, openForService, openSupport,
  addReview, reviewsForBooking, listingRating, listingReputation, myRating, HOST_MIN_REVIEWS,
  listingReviews, replyToReview, canReply,
  conversationRating, rateConversation, ratingsSummary, postAssistantMessage,
  listSupportAgents, assignSupportAgent, removeSupportAgent,
};
