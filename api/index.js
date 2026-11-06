/* =====================================================================
   DOUIRA · API (comptes, réservations, paiement, carte de membre, RGPD)
   Montée dans server.js quand DATABASE_URL est définie : toutes les routes
   commencent par /api/. Principes :
   - le prix et la disponibilité sont calculés ici (catalog.js), jamais dans le navigateur ;
   - aucune donnée de carte bancaire ne transite : page de paiement du prestataire (psp/) ;
   - une réservation n'est confirmée QUE par un webhook/callback signé, de façon idempotente ;
   - sessions en base (cookie HttpOnly, SameSite=Lax, Secure), jeton anti-CSRF, vérification d'origine ;
   - limitation de débit sur la connexion, l'inscription, la réinitialisation et le paiement ;
   - journaux sans données sensibles ; adresse et code d'accès chiffrés et réservés au client concerné.
   ===================================================================== */
'use strict';
const db = require('./lib/db');
const sec = require('./lib/security');
const cat = require('./lib/catalog');
const cadmin = require('./lib/catalog_admin');
const uadmin = require('./lib/users_admin');
const mail = require('./lib/mail');
const push = require('./lib/push');
const msg = require('./lib/messaging');
const mny = require('./lib/money');
const team = require('./lib/team');
const svc = require('./lib/services');
const itv = require('./lib/interventions');
const pay = require('./lib/payments');
const dest = require('./lib/destinations');
const refs = require('./lib/referrals');
const sso = require('./lib/sso');
const veh = require('./lib/vehicles');
const docs = require('./lib/documents');
const kyc = require('./lib/kyc');
const wallet = require('./lib/wallet');
const assistant = require('./lib/assistant');
const rat = require('./lib/ratings');
const inv = require('./lib/invoices');
const cards = require('./lib/cards');
const badges = require('./lib/badges');
const scan = require('./lib/scan');
const moderation = require('./lib/moderation');
// La devise d'une ville vient des destinations réglées en administration.
mny.useDestinations(dest.currencyForCity);
const H = require('./lib/http');
const PSPS = { stripe: require('./psp/stripe'), cmi: require('./psp/cmi'), simulate: require('./psp/simulate') };

const SESSION_COOKIE = 'douira_s';
const sessionTtlH = role => role === 'admin' ? Math.max(1, Number(process.env.ADMIN_SESSION_HOURS) || 8) : Math.max(1, Number(process.env.SESSION_HOURS) || 24 * 14);
const HOLD_MIN = Math.max(10, Number(process.env.HOLD_MINUTES) || 30);
/* Adresse publique du site. Elle sert à fabriquer les liens de réinitialisation
   et d'invitation : elle ne doit JAMAIS venir de l'en-tête Host, que le client
   choisit. Sans SITE_URL, un « Host: attaquant.tld » suffirait à faire envoyer à
   la victime un lien de réinitialisation valide pointant chez l'attaquant.
   Hors production on tolère le repli, pour le développement local. */
const siteUrl = req => {
  const configured = (process.env.SITE_URL || '').replace(/\/$/, '');
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') throw new H.HttpError(500, 'Site mal configuré.');
  return `${H.isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
};
/* Prestataire d'encaissement. Le compte peut être choisi PAR VILLE depuis
   l'administration (ex. Marrakech sur le compte marocain, les autres sur Stripe) ;
   à défaut on garde la détection automatique d'origine. */
const psp = city => {
  const chosen = pay.providerFor(city);
  // « simulate » ne se devine jamais : il faut l'avoir ÉCRIT (PSP=simulate). Sans
  // prestataire configuré, le paiement est indisponible — pas gratuit.
  const name = chosen || (PSPS.stripe.enabled() ? 'stripe' : PSPS.cmi.enabled() ? 'cmi' : process.env.PSP === 'simulate' ? 'simulate' : '');
  const p = PSPS[name];
  if (!p || !p.enabled()) throw new H.HttpError(503, 'Paiement en ligne indisponible pour le moment.');
  return p;
};
const audit = (actor, action, target, ip) => db.query('INSERT INTO audit (actor, action, target, ip) VALUES ($1, $2, $3, $4)', [actor || null, action, String(target || '').slice(0, 120), ip || '']).catch(e => console.error('audit', e.message));
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, memberNo: u.member_no, createdAt: u.created_at, mustChangePassword: !!u.must_change_password, publicProfile: !!u.public_profile, authProvider: u.auth_provider || 'password', avatarUrl: u.avatar_url || '' });
// Prénom seul : tout ce qui est montré d'un membre à un AUTRE membre (avis,
// profil public) s'en tient au prénom, comme le reste de l'application.
const firstName = name => String(name || '').trim().split(/\s+/)[0] || '';
/* Le compte AVEC ses périmètres. Sans cela l'appli ne peut pas savoir ce qu'un
   collaborateur a le droit de faire : elle lui montrerait des boutons que le
   serveur refuse. Seul un collaborateur a des périmètres ; l'administrateur les
   détient tous, ce que `teamLead` et `role` suffisent à dire. */
async function meUser(u) {
  const base = publicUser(u);
  if (!u || u.role !== 'collaborator') return Object.assign(base, { scopes: [], teamLead: false });
  const scopes = await team.scopesOf(u.id).catch(() => []);
  return Object.assign(base, { scopes, teamLead: !!u.team_lead });
}
const str = (v, max) => (typeof v === 'string' ? v : '').trim().slice(0, max);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
// Libellés de rôle (e-mails serveur) ; le frontend a sa propre copie dans index.html
const ROLE_LABEL = { admin: 'Administrateur', collaborator: 'Collaborateur', owner: 'Propriétaire', agency: 'Agence', client: 'Client' };

/* ---------- Sessions ---------- */
async function createSession(res, req, user) {
  const tok = sec.token(32), csrf = sec.token(24), ttl = sessionTtlH(user.role);
  await db.query('INSERT INTO sessions (id, user_id, csrf, expires_at, ip, ua) VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5, $6)', [sec.sha256(tok), user.id, csrf, ttl, H.clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200)]);
  H.setCookie(res, SESSION_COOKIE, tok, { secure: H.isHttps(req) || process.env.NODE_ENV === 'production', maxAge: ttl * 3600 });
  return csrf;
}
async function currentSession(req) {
  const tok = H.cookies(req)[SESSION_COOKIE]; if (!tok) return null;
  const s = await db.one("SELECT s.id AS session_id, s.csrf, s.expires_at, s.last_seen, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.expires_at > now() AND u.deleted_at IS NULL AND u.status <> 'suspendu'", [sec.sha256(tok)]);
  if (!s) return null;
  if (Date.now() - new Date(s.last_seen).getTime() > 5 * 60000) db.query('UPDATE sessions SET last_seen = now(), expires_at = now() + make_interval(hours => $2) WHERE id = $1', [s.session_id, sessionTtlH(s.role)]).catch(() => {});
  return s;
}
async function destroySession(req, res) {
  const tok = H.cookies(req)[SESSION_COOKIE]; if (tok) await db.query('DELETE FROM sessions WHERE id = $1', [sec.sha256(tok)]);
  H.setCookie(res, SESSION_COOKIE, '', { secure: H.isHttps(req), maxAge: 0 });
}
// Les fonctions de catalog_admin lèvent des Error munis de .status (403/404/400) ; on les relaie en HttpError.
async function ca(fn) { try { return await fn(); } catch (e) { if (e instanceof H.HttpError) throw e; if (e && typeof e.status === 'number') throw new H.HttpError(e.status, e.message); throw e; } }
function requireUser(ctx, role) {
  if (!ctx.session) throw new H.HttpError(401, 'Connexion requise.');
  if (role && ctx.session.role !== role) throw new H.HttpError(403, 'Accès refusé.');
  return ctx.session;
}
// Les requêtes qui modifient l'état exigent le jeton anti-CSRF de la session (en-tête X-CSRF-Token)
function requireCsrf(ctx) { const s = requireUser(ctx); const given = ctx.req.headers['x-csrf-token'] || ''; if (!given || !sec.safeEqual(given, s.csrf)) throw new H.HttpError(403, 'Jeton de sécurité manquant ou expiré : rechargez la page.'); return s; }
// Vérification d'origine pour toute requête non GET venant d'un navigateur
function checkOrigin(req) {
  const o = req.headers.origin; if (!o) return;
  let host = ''; try { host = new URL(o).host; } catch (e) { /* invalide */ }
  const allowed = [req.headers.host, (() => { try { return new URL(process.env.SITE_URL || 'http://x').host; } catch (e) { return ''; } })()].filter(Boolean);
  if (!allowed.includes(host)) throw new H.HttpError(403, 'Origine refusée.');
}

/* ---------- Réservations ---------- */
const bookingRef = () => 'DR-' + sec.token(6).replace(/[^A-Za-z0-9]/g, 'X').slice(0, 6).toUpperCase();
function bookingView(b, withAccess) {
  const v = { id: b.id, listingId: b.listing_id, start: cat.dateStr(b.start_date), end: cat.dateStr(b.end_date), guests: b.guests, status: b.status, q: b.quote, amount: b.amount, currency: b.currency, holdUntil: b.hold_until, paidAt: b.paid_at, cancelledAt: b.cancelled_at, refundAmount: b.refund_amount, createdAt: b.created_at, psp: b.psp };
  if (b.status === 'pending_payment' && b.pay_url && new Date(b.hold_until) > new Date()) v.payUrl = b.pay_url;
  if (withAccess) v.access = withAccess;
  return v;
}
// Adresse et code d'accès : réservation confirmée, de la veille de l'arrivée au jour du départ
async function accessFor(b) {
  if (b.status !== 'confirmed') return null;
  const today = cat.isoToday(), start = cat.dateStr(b.start_date), end = cat.dateStr(b.end_date);
  if (today < cat.shiftDays(start, -1) || today > end) return null;   // de la veille de l'arrivée au jour du départ, heure locale du site
  const a = await db.one('SELECT * FROM listing_access WHERE listing_id = $1', [b.listing_id]); if (!a) return null;
  try { return { address: sec.decrypt(a.address_enc), code: sec.decrypt(a.code_enc), notes: sec.decrypt(a.notes_enc) }; } catch (e) { console.error('Déchiffrement impossible (DATA_KEY ?)'); return null; }
}
async function unavailable(listingId) {
  const r = await db.query("SELECT start_date, end_date FROM bookings WHERE listing_id = $1 AND end_date >= $2::date AND (status = 'confirmed' OR (status = 'pending_payment' AND hold_until > now())) ORDER BY start_date", [listingId, cat.isoToday()]);
  return r.rows.map(x => [cat.dateStr(x.start_date), cat.dateStr(x.end_date)]);
}
async function createBooking(ctx, body) {
  const user = requireCsrf(ctx);
  await H.rateLimit('book:' + user.id, 10, 900);
  await cat.refreshDb();
  let l = cat.listing(str(body.listingId, 40));
  if (!l) { await cat.refreshDb(true); l = cat.listing(str(body.listingId, 40)); } // bien fraîchement publié
  const start = str(body.start, 10), end = str(body.end, 10), guests = Number(body.guests);
  const problem = cat.validate(l, start, end, guests); if (problem) throw new H.HttpError(400, problem);
  // Pièces justificatives exigées avant toute réservation (déclaration des voyageurs).
  const manque = await docs.missingFor(user.id, false);
  if (manque.length) {
    throw new H.HttpError(428, `Avant de réserver, transmettez ${docs.missingLabel(manque)} depuis votre profil.`);
  }
  const q = cat.quote(l, start, end, guests); const amount = mny.toMinor(q.total, q.currency);
  // La devise dépend de la ville du logement : on vérifie AVANT de créer la réservation
  // que le prestataire sait l'encaisser, plutôt que d'échouer (ou de facturer de travers)
  // au moment du paiement.
  if (!mny.pspSupports(psp(l.city).name, q.currency)) {
    throw new H.HttpError(503, `La réservation en ligne n'est pas encore disponible pour ${l.city} (paiement en ${q.currency}). Contactez-nous, notre équipe s'en occupe.`);
  }
  const booking = await db.tx(async t => {
    await t.query('SELECT pg_advisory_xact_lock(hashtext($1))', [l.id]); // sérialise les réservations d'un même bien
    const clash = await t.one("SELECT id FROM bookings WHERE listing_id = $1 AND start_date < $3 AND end_date > $2 AND (status = 'confirmed' OR (status = 'pending_payment' AND hold_until > now())) LIMIT 1", [l.id, start, end]);
    if (clash) throw new H.HttpError(409, 'Ces dates ne sont plus disponibles.');
    // Bon de parrainage éventuel : on en RÉSERVE un sous verrou (il ne peut donc
    // pas servir deux réservations à la fois), on l'applique au devis du serveur,
    // puis on l'attache à la réservation créée — le tout dans cette transaction,
    // pour qu'un échec rende le bon automatiquement.
    const bon = await refs.peek(t, user.id);
    const devis = bon ? refs.applyReferral(q, bon.pct) : q;
    const montant = mny.toMinor(devis.total, devis.currency);
    for (let i = 0; i < 5; i++) {
      const id = bookingRef();
      const r = await t.one('INSERT INTO bookings (id, user_id, listing_id, start_date, end_date, guests, status, quote, amount, currency, hold_until, psp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(mins => $11), $12) ON CONFLICT (id) DO NOTHING RETURNING *', [id, user.id, l.id, start, end, guests, 'pending_payment', devis, montant, devis.currency, HOLD_MIN, psp(l.city).name]);
      if (r) { if (bon) await refs.markUsed(t, bon.id, r.id); return r; }
    }
    throw new H.HttpError(500, 'Référence indisponible, réessayez.');
  });
  audit(user.id, 'booking.create', booking.id, ctx.ip);
  const label = `${cat.siteName()} · ${l.title} · ${cat.nights(start, end)} nuit(s) · ${booking.id}`;
  try {
    const co = await psp(l.city).createCheckout({ booking, user, siteUrl: siteUrl(ctx.req), apiUrl: siteUrl(ctx.req), label });
    await db.query('UPDATE bookings SET psp_ref = $2, pay_url = $3, updated_at = now() WHERE id = $1', [booking.id, co.ref, co.url]);
    return { booking: bookingView(booking), url: co.url };
  } catch (e) {
    await db.tx(async t => {
      await refs.release(t, booking.id);   // la réservation n'aboutira pas : on rend le bon
      await t.query("UPDATE bookings SET status = 'failed', updated_at = now() WHERE id = $1", [booking.id]);
    }).catch(err => console.error('Paiement : nettoyage impossible', err.message));
    console.error('Paiement : création impossible', e.message); throw e instanceof H.HttpError ? e : new H.HttpError(502, 'Paiement indisponible, réessayez dans quelques minutes.');
  }
}
/* Application idempotente d'un événement de paiement (webhook signé, callback vérifié ou simulation) */
async function applyPaymentEvent(pspName, ev, eventId) {
  if (!ev.kind || !ev.bookingId) return { ignored: true };
  return db.tx(async t => {
    // La réservation d'abord, verrouillée : deux livraisons simultanées du même
    // événement se suivent au lieu de se croiser. Une référence inconnue (événement
    // d'un autre système, identifiant forgé) est ignorée proprement — l'inscrire
    // dans payment_events violerait la clé étrangère et le prestataire, sur une
    // erreur 500, réessaierait pendant des jours.
    const b = await t.one('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [ev.bookingId]); if (!b) return { unknown: true };
    const seen = await t.one('INSERT INTO payment_events (id, booking_id, type) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING id', [eventId, ev.bookingId, ev.kind]);
    if (!seen) return { duplicate: true };
    if (ev.kind === 'paid') {
      if (b.status === 'confirmed') return { already: true };
      // Le montant et la devise attendus sont ceux CALCULÉS PAR LE SERVEUR à la
      // création (jamais ceux du navigateur). Le prestataire les renvoie dans son
      // unité (lib/money.js) : on compare dans cette unité. Un écart signifie que
      // de l'argent est arrivé sans correspondre au séjour : la réservation est
      // close et l'équipe prévenue pour rembourser.
      const attendu = mny.pspAmount(b.amount, b.currency);
      const ecart = (ev.amount && Number(ev.amount) !== attendu) ? `montant reçu ${ev.amount} ≠ attendu ${attendu}`
        : (ev.currency && String(ev.currency).toLowerCase() !== String(b.currency).toLowerCase()) ? `devise reçue ${ev.currency} ≠ attendue ${b.currency}` : '';
      if (ecart) {
        console.error(`Paiement ${b.id} : ${ecart}`);
        await refs.release(t, b.id);
        await t.query("UPDATE bookings SET status = 'failed', psp = $2, psp_ref = $3, updated_at = now() WHERE id = $1", [b.id, pspName, ev.ref || b.psp_ref]);
        return { mismatch: true, stray: ecart, booking: Object.assign(b, { status: 'failed', psp: pspName, psp_ref: ev.ref || b.psp_ref }) };
      }
      // Un paiement peut arriver APRÈS l'annulation (la session Stripe vit 31 min,
      // un paiement différé des jours) ou après l'expiration du blocage. Les
      // dates ont alors été rendues : on ne confirme JAMAIS sans les revérifier,
      // sous le même verrou que la création — sinon deux séjours encaissés sur
      // le même bien. L'argent reçu « à côté » est gardé en référence pour le
      // rembourser, et l'équipe est prévenue.
      if (b.status === 'cancelled') {
        await t.query('UPDATE bookings SET psp = $2, psp_ref = $3, updated_at = now() WHERE id = $1', [b.id, pspName, ev.ref || b.psp_ref]);
        return { stray: 'annulée', booking: Object.assign(b, { psp: pspName, psp_ref: ev.ref || b.psp_ref }) };
      }
      await t.query('SELECT pg_advisory_xact_lock(hashtext($1))', [b.listing_id]);
      const clash = await t.one("SELECT id FROM bookings WHERE listing_id = $1 AND id <> $2 AND start_date < $4 AND end_date > $3 AND (status = 'confirmed' OR (status = 'pending_payment' AND hold_until > now())) LIMIT 1", [b.listing_id, b.id, cat.dateStr(b.start_date), cat.dateStr(b.end_date)]);
      if (clash) {
        await refs.release(t, b.id);
        await t.query("UPDATE bookings SET status = 'failed', psp = $2, psp_ref = $3, updated_at = now() WHERE id = $1", [b.id, pspName, ev.ref || b.psp_ref]);
        return { stray: `dates reprises par ${clash.id}`, booking: Object.assign(b, { status: 'failed', psp: pspName, psp_ref: ev.ref || b.psp_ref }) };
      }
      await t.query("UPDATE bookings SET status = 'confirmed', paid_at = now(), psp = $2, psp_ref = $3, updated_at = now() WHERE id = $1", [b.id, pspName, ev.ref || b.psp_ref]);
      return { confirmed: true, booking: Object.assign(b, { status: 'confirmed' }) };
    }
    if ((ev.kind === 'failed' || ev.kind === 'expired') && b.status === 'pending_payment') {
      // Une carte refusée chez un prestataire qui accepte une nouvelle tentative
      // (CMI : chaque essai est un nouveau formulaire) ne clôt pas le séjour tant
      // que les dates sont bloquées : le client est prévenu et peut réessayer.
      // Chez Stripe, la page Checkout gère elle-même les nouveaux essais et ne
      // signale un échec que pour un paiement différé, définitif.
      if (ev.kind === 'failed' && ev.retryable && new Date(b.hold_until) > new Date()) return { declined: true, booking: b };
      // Le paiement ne se fera pas : on rend le bon de parrainage éventuel avant de clore.
      await refs.release(t, b.id);
      await t.query('UPDATE bookings SET status = $2, updated_at = now() WHERE id = $1', [b.id, ev.kind]);
      return { [ev.kind]: true, booking: Object.assign(b, { status: ev.kind }) };
    }
    if (ev.kind === 'refunded') { await t.query('UPDATE bookings SET refund_amount = GREATEST(refund_amount, $2), updated_at = now() WHERE id = $1', [b.id, ev.amount || 0]); return { refunded: true }; }
    return { noop: true };
  });
}
/* Le paiement n'a pas abouti : le client doit le savoir tout de suite, avec ce
   qu'il peut encore faire. Trois cas :
   - declined : refusé mais le délai court encore → réessayer depuis sa réservation ;
   - failed   : définitif, dates rendues → réserver à nouveau ;
   - expired  : délai de paiement dépassé, dates rendues → réserver à nouveau. */
async function notifyPaymentFailed(booking, cas) {
  const u = await db.one('SELECT * FROM users WHERE id = $1', [booking.user_id]); if (!u) return;
  const l = cat.listing(booking.listing_id) || { title: booking.listing_id };
  const site = process.env.SITE_URL || '';
  const lien = `${site}/#espace-c_booking~${booking.id}`;
  const sejour = `${l.title}, du ${cat.dateStr(booking.start_date)} au ${cat.dateStr(booking.end_date)}`;
  let subject, text, push_;
  if (cas === 'declined') {
    const limite = booking.hold_until ? new Date(booking.hold_until).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: cat.TZ }) : '';
    subject = `Paiement refusé · ${booking.id}`;
    text = `Bonjour ${u.name},\n\nLe paiement de votre réservation ${booking.id} (${sejour}) a été refusé par votre banque. Rien n'a été débité.\n\nVos dates restent réservées${limite ? ` jusqu'à ${limite}` : ' quelques minutes'} : vous pouvez réessayer, avec la même carte ou une autre, depuis votre réservation : ${lien}\n\nPassé ce délai, les dates seront libérées.\n\n${cat.siteName()}`;
    push_ = 'Paiement refusé — vous pouvez réessayer depuis votre réservation.';
  } else {
    subject = `${cas === 'expired' ? 'Délai de paiement dépassé' : 'Paiement non abouti'} · ${booking.id}`;
    text = `Bonjour ${u.name},\n\n${cas === 'expired' ? `Le délai de paiement de votre réservation ${booking.id} (${sejour}) est dépassé` : `Le paiement de votre réservation ${booking.id} (${sejour}) n'a pas abouti`}. Rien n'a été débité, et les dates ont été libérées.\n\nSi vous souhaitez toujours ce séjour, réservez-le à nouveau : il se peut que les dates soient encore disponibles. ${site}\n\n${cat.siteName()}`;
    push_ = cas === 'expired' ? 'Délai de paiement dépassé : les dates ont été libérées.' : 'Paiement non abouti : les dates ont été libérées.';
  }
  await mail.send({ to: u.email, subject, text });
  push.toUser(u.id, { title: subject.replace(/ · .*$/, ''), body: push_, data: { url: `/booking/${booking.id}` } }).catch(e => console.error('push', e.message));
}
/* Paiement reçu sur une réservation qui ne peut plus être confirmée : l'argent
   est chez le prestataire, le séjour n'aura pas lieu. Rien d'automatique ici —
   un remboursement se décide — mais l'équipe doit le savoir tout de suite. */
async function notifyStrayPayment(booking, raison) {
  console.error(`Paiement ${booking.id} reçu hors séjour (${raison}) : à rembourser (${booking.psp} ${booking.psp_ref || ''})`);
  const adm = await mail.adminEmail().catch(() => '');
  if (adm) await mail.send({ to: adm, subject: `[${cat.siteName()}] Paiement à rembourser · ${booking.id}`, text: `Un paiement de ${(booking.amount / 100).toFixed(0)} ${booking.currency} est arrivé pour la réservation ${booking.id}, mais elle ne peut pas être confirmée : ${raison}.\n\nLe séjour n'est pas réservé. Remboursez le client depuis ${booking.psp} (référence ${booking.psp_ref || 'inconnue'}).` });
}
async function notifyConfirmed(booking) {
  const u = await db.one('SELECT * FROM users WHERE id = $1', [booking.user_id]); const l = cat.listing(booking.listing_id) || { title: booking.listing_id };
  const site = process.env.SITE_URL || '';
  const text = `Bonjour ${u.name},\n\nVotre réservation ${booking.id} est confirmée : ${l.title}, du ${booking.start_date} au ${booking.end_date}, ${booking.guests} voyageur(s), ${(booking.amount / 100).toFixed(0)} ${booking.currency}.\n\nL'adresse exacte et le code d'accès apparaîtront dans votre espace (« Mes réservations ») la veille de votre arrivée : ${site}/#espace-c_booking~${booking.id}\n\n${cat.siteName()}`;
  await mail.send({ to: u.email, subject: `Réservation confirmée · ${booking.id}`, text });

  // La facture part dans un second message : la confirmation se lit d'un coup
  // d'œil, la facture se garde. Une facture qu'on ne parvient pas à émettre ne
  // doit pas empêcher la confirmation d'arriver.
  try {
    const f = await inv.issueForBooking(booking);
    if (f) {
      await mail.send({
        to: u.email,
        subject: `Facture ${f.numero} · ${cat.siteName()}`,
        text: inv.invoiceText(f),
        html: inv.invoiceHtml(f),
      });
    }
  } catch (e) {
    console.error(`Facture ${booking.id} : ${e.message}`);
  }
  // Notification push (l'e-mail reste la voie officielle ; le push n'est qu'un rappel).
  push.toUser(u.id, {
    title: 'Réservation confirmée',
    body: `${l.title} · ${cat.dateStr(booking.start_date)} → ${cat.dateStr(booking.end_date)}`,
    data: { url: `/booking/${booking.id}` },
  }).catch(e => console.error('push', e.message));
  const adm = await mail.adminEmail(); if (adm) await mail.send({ to: adm, subject: `[${cat.siteName()}] Nouvelle réservation ${booking.id}`, text: `${l.title} · ${booking.start_date} → ${booking.end_date} · ${booking.guests} pers. · ${(booking.amount / 100).toFixed(0)} ${booking.currency} · client ${u.name} (${u.email}${u.phone ? ', ' + u.phone : ''}).` });
}

/* ---------- Routes ---------- */
const R = new H.Router();
R.add('GET', '/api/health', async () => ({ ok: true, psp: (() => { try { return psp().name; } catch (e) { return null; } })(), time: new Date().toISOString() }));
R.add('GET', '/api/me', async ctx => ctx.session ? { user: await meUser(ctx.session), csrf: ctx.session.csrf } : { user: null });
// Catalogue public (biens et activités publiés en base) ; si la base est vide, le site garde config.js.
R.add('GET', '/api/catalog', async ctx => { await H.rateLimit('catalog:' + ctx.ip, 120, 60); return cat.publicCatalog(); });

R.add('POST', '/api/auth/register', async ctx => {
  const b = await H.readJson(ctx.req); await H.rateLimit('register:' + ctx.ip, 10, 3600);
  const name = str(b.name, 80), email = str(b.email, 254).toLowerCase(), phone = str(b.phone, 30), pw = b.password;
  if (name.length < 2) throw new H.HttpError(400, 'Indiquez votre nom.');
  if (!EMAIL.test(email)) throw new H.HttpError(400, 'Adresse e-mail invalide.');
  if (b.consent !== true) throw new H.HttpError(400, 'Acceptez les conditions et la politique de confidentialité.');
  const pp = sec.passwordProblem(pw); if (pp) throw new H.HttpError(400, pp);
  const exists = await db.one('SELECT id FROM users WHERE email = $1', [email]);
  if (exists) throw new H.HttpError(409, 'Un compte existe déjà avec cette adresse. Connectez-vous ou réinitialisez votre mot de passe.');
  // Inscription et crédit du parrain dans une seule transaction : un filleul créé
  // sans que le parrain soit crédité (ou l'inverse) serait incohérent.
  const u = await db.tx(async t => {
    const row = await t.one('INSERT INTO users (email, name, phone, pass_hash, consent_at) VALUES ($1, $2, $3, $4, now()) RETURNING *', [email, name, phone, sec.hashPassword(pw)]);
    // Le code d'invitation est facultatif : un code absent ou inconnu n'empêche
    // jamais l'inscription (refs.creditOnRegister reste silencieux).
    await refs.creditOnRegister(t, row.id, b.referralCode).catch(e => console.error('parrainage', e.message));
    return row;
  });
  const csrf = await createSession(ctx.res, ctx.req, u); audit(u.id, 'user.register', '', ctx.ip);
  return { user: await meUser(u), csrf };
});
R.add('POST', '/api/auth/login', async ctx => {
  const b = await H.readJson(ctx.req); const email = str(b.email, 254).toLowerCase();
  await H.rateLimit('login:ip:' + ctx.ip, 20, 900); await H.rateLimit('login:email:' + sec.sha256(email).slice(0, 24), 5, 900);
  const u = await db.one('SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
  const ok = u ? sec.verifyPassword(b.password, u.pass_hash) : (sec.verifyPassword('x', 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='), false); // temps constant
  if (!ok) { audit(null, 'login.fail', '', ctx.ip); throw new H.HttpError(401, 'E-mail ou mot de passe incorrect.'); }
  if (u.status === 'suspendu') { audit(u.id, 'login.suspended', '', ctx.ip); throw new H.HttpError(403, 'Ce compte est suspendu. Contactez l\'administrateur.'); }
  const csrf = await createSession(ctx.res, ctx.req, u); audit(u.id, 'login', '', ctx.ip);
  return { user: await meUser(u), csrf };
});
/* Connexion Google / Apple (SSO). Le téléphone envoie le jeton d'identité signé
   du fournisseur ; le serveur le VÉRIFIE (lib/sso), puis :
     - compte déjà lié à ce fournisseur → on le connecte ;
     - même e-mail déjà en base → on rattache le fournisseur et on connecte ;
     - sinon → on crée un compte (sans mot de passe utilisable), e-mail déjà
       vérifié par le fournisseur.
   Le résultat est NOTRE session habituelle (cookie + jeton CSRF), comme register
   et login — il n'y a pas de JWT dans cette application. */
R.add('POST', '/api/auth/oauth', async ctx => {
  const b = await H.readJson(ctx.req);
  await H.rateLimit('oauth:' + ctx.ip, 20, 900);
  const provider = b.provider === 'google' ? 'google' : b.provider === 'apple' ? 'apple' : '';
  if (!provider) throw new H.HttpError(400, 'Fournisseur de connexion inconnu.');
  const idToken = typeof b.idToken === 'string' ? b.idToken : '';
  if (!idToken) throw new H.HttpError(400, 'Jeton de connexion manquant.');

  let info;
  // Le détail de l'échec reste au journal : il ne renseigne pas un appelant anonyme.
  try { info = await sso[provider](idToken); }
  catch (e) { console.error(`SSO ${provider} :`, e.message); throw new H.HttpError(401, `Connexion ${provider === 'google' ? 'Google' : 'Apple'} refusée.`); }
  if (!info.email) throw new H.HttpError(400, "Ce compte ne partage pas d'adresse e-mail. Connectez-vous avec un e-mail et un mot de passe.");

  const col = provider === 'google' ? 'google_id' : 'apple_id';
  // Apple ne donne le nom qu'à la toute première autorisation : l'appli nous le
  // transmet alors dans b.name. Sinon on part de ce que le jeton porte, puis de l'e-mail.
  const nom = str(b.name, 80) || info.name || info.email.split('@')[0];

  const u = await db.tx(async t => {
    // 1) déjà lié par cet identifiant de fournisseur
    let row = await t.one(`SELECT * FROM users WHERE ${col} = $1 AND deleted_at IS NULL`, [info.sub]);
    if (row) {
      if (row.status === 'suspendu') throw new H.HttpError(403, 'Ce compte est suspendu. Contactez l\'administrateur.');
      return row;
    }
    // 2) même e-mail déjà en base → on rattache le fournisseur au compte existant
    row = await t.one('SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL', [info.email]);
    if (row) {
      if (row.status === 'suspendu') throw new H.HttpError(403, 'Ce compte est suspendu. Contactez l\'administrateur.');
      await t.query(`UPDATE users SET ${col} = $2, avatar_url = CASE WHEN avatar_url = '' THEN $3 ELSE avatar_url END, updated_at = now() WHERE id = $1`, [row.id, info.sub, info.avatar]);
      return row;
    }
    // 3) nouveau compte : pas de mot de passe utilisable (haché d'un secret aléatoire),
    //    e-mail déjà vérifié par le fournisseur, consentement donné à l'inscription.
    const created = await t.one(
      `INSERT INTO users (email, name, pass_hash, consent_at, auth_provider, ${col}, avatar_url)
       VALUES ($1, $2, $3, now(), $4, $5, $6) RETURNING *`,
      [info.email, nom, sec.hashPassword(sec.token(24)), provider, info.sub, info.avatar]);
    await refs.creditOnRegister(t, created.id, b.referralCode).catch(e => console.error('parrainage', e.message));
    return created;
  });

  const csrf = await createSession(ctx.res, ctx.req, u);
  audit(u.id, 'user.oauth.' + provider, '', ctx.ip);
  return { user: await meUser(u), csrf };
});
R.add('POST', '/api/auth/logout', async ctx => { if (ctx.session) audit(ctx.session.id, 'logout', '', ctx.ip); await destroySession(ctx.req, ctx.res); return { ok: true }; });
R.add('POST', '/api/auth/forgot', async ctx => {
  const b = await H.readJson(ctx.req); const email = str(b.email, 254).toLowerCase();
  await H.rateLimit('forgot:' + ctx.ip, 5, 3600);
  // Et par DESTINATAIRE : une adresse ne reçoit pas plus de trois liens par
  // heure, d'où que viennent les demandes. Une limite par IP seule se contourne
  // en changeant d'adresse, et la victime recevait un e-mail par appel.
  await H.rateLimit('forgot:to:' + sec.sha256(email).slice(0, 24), 3, 3600);
  const u = await db.one('SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
  if (u) { const tok = sec.token(32); await db.query("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '30 minutes')", [sec.sha256(tok), u.id]);
    await mail.send({ to: u.email, subject: `${cat.siteName()} · réinitialisation du mot de passe`, text: `Bonjour ${u.name},\n\nPour choisir un nouveau mot de passe (lien valable 30 minutes) : ${siteUrl(ctx.req)}/#reinitialiser~${tok}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.` }); }
  return { ok: true }; // même réponse que l'adresse existe ou non
});
R.add('POST', '/api/auth/reset', async ctx => {
  const b = await H.readJson(ctx.req); await H.rateLimit('reset:' + ctx.ip, 10, 3600);
  const pp = sec.passwordProblem(b.password); if (pp) throw new H.HttpError(400, pp);
  const r = await db.one('SELECT * FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()', [sec.sha256(str(b.token, 100))]);
  if (!r) throw new H.HttpError(400, 'Lien invalide ou expiré.');
  // Choisir son mot de passe active un compte invité et lève l'obligation de changement initial.
  await db.tx(async t => { await t.query('UPDATE password_resets SET used_at = now() WHERE token_hash = $1', [r.token_hash]); await t.query("UPDATE users SET pass_hash = $2, must_change_password = false, status = CASE WHEN status = 'invite' THEN 'actif' ELSE status END, updated_at = now() WHERE id = $1", [r.user_id, sec.hashPassword(b.password)]); await t.query('DELETE FROM sessions WHERE user_id = $1', [r.user_id]); });
  audit(r.user_id, 'password.reset', '', ctx.ip); return { ok: true };
});
R.add('POST', '/api/auth/password', async ctx => {
  const u = requireCsrf(ctx); const b = await H.readJson(ctx.req);
  if (!sec.verifyPassword(b.current, u.pass_hash)) throw new H.HttpError(401, 'Mot de passe actuel incorrect.');
  const pp = sec.passwordProblem(b.password); if (pp) throw new H.HttpError(400, pp);
  if (sec.verifyPassword(b.password, u.pass_hash)) throw new H.HttpError(400, 'Choisissez un mot de passe différent de l\'actuel.');
  await db.query('UPDATE users SET pass_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1', [u.id, sec.hashPassword(b.password)]);
  await db.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [u.id, u.session_id]); // déconnecte les autres appareils
  audit(u.id, 'password.change', '', ctx.ip); return { ok: true };
});
R.add('GET', '/api/listings/:id/unavailable', async ctx => { await H.rateLimit('cal:' + ctx.ip, 120, 60); await cat.refreshDb(); return { listingId: ctx.params.id, ranges: await unavailable(cat.internalId(str(ctx.params.id, 40))) }; });
R.add('POST', '/api/quote', async ctx => { await H.rateLimit('quote:' + ctx.ip, 60, 60); const b = await H.readJson(ctx.req); await cat.refreshDb(); const l = cat.listing(str(b.listingId, 40)); const p = cat.validate(l, str(b.start, 10), str(b.end, 10), Number(b.guests)); if (p) throw new H.HttpError(400, p); const taken = (await unavailable(l.id)).some(([s, e]) => s < b.end && e > b.start); if (taken) throw new H.HttpError(409, 'Ces dates ne sont plus disponibles.'); return { quote: cat.quote(l, b.start, b.end, Number(b.guests)) }; });
R.add('POST', '/api/bookings', async ctx => createBooking(ctx, await H.readJson(ctx.req)));
R.add('GET', '/api/bookings', async ctx => { const u = requireUser(ctx); const r = await db.query('SELECT * FROM bookings WHERE user_id = $1 ORDER BY start_date DESC', [u.id]); return { bookings: r.rows.map(b => bookingView(b)) }; });
R.add('GET', '/api/bookings/:id', async ctx => {
  const u = requireUser(ctx); const b = await db.one('SELECT * FROM bookings WHERE id = $1 AND user_id = $2', [str(ctx.params.id, 20), u.id]);
  if (!b) throw new H.HttpError(404, 'Réservation introuvable.');
  if (b.status === 'pending_payment' && new Date(b.hold_until) < new Date()) { await db.query("UPDATE bookings SET status = 'expired' WHERE id = $1 AND status = 'pending_payment'", [b.id]); b.status = 'expired'; }
  const access = await accessFor(b); if (access) audit(u.id, 'access.view', b.id, ctx.ip);
  return { booking: bookingView(b, access), refund: b.status === 'confirmed' ? cat.refundFor(b) : null };
});
// Facture d'une réservation payée. Elle est figée à l'émission : ce qu'on relit
// ici est exactement ce qui a été envoyé au client.
// Le HTML part avec la facture : c'est lui que l'appli imprime en PDF, et
// c'est exactement le document envoyé par e-mail. Une seule source.
R.add('GET', '/api/bookings/:id/invoice', async ctx => {
  const u = requireUser(ctx);
  const f = await inv.forBooking(u, str(ctx.params.id, 20));
  return { invoice: f, html: inv.invoiceHtml(f) };
});
R.add('POST', '/api/bookings/:id/cancel', async ctx => {
  const u = requireCsrf(ctx); const b = await db.one('SELECT * FROM bookings WHERE id = $1 AND user_id = $2', [str(ctx.params.id, 20), u.id]);
  if (!b) throw new H.HttpError(404, 'Réservation introuvable.');
  if (b.status === 'pending_payment') {
    await db.tx(async t => {
      await refs.release(t, b.id);   // jamais payée : le bon de parrainage éventuel revient dans la jauge
      await t.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE id = $1", [b.id]);
    });
    // La page de paiement, elle, resterait ouverte 31 minutes : on la ferme
    // chez le prestataire, pour qu'un paiement ne tombe pas sur un séjour annulé.
    const p = PSPS[b.psp]; if (p && p.expireCheckout && b.psp_ref) p.expireCheckout(b.psp_ref).catch(e => console.error('Paiement : fermeture de la session', e.message));
    return { ok: true, refund: 0 };
  }
  if (b.status !== 'confirmed') throw new H.HttpError(400, 'Cette réservation ne peut plus être annulée.');
  if (cat.dateStr(b.end_date) < cat.isoToday()) throw new H.HttpError(400, 'Séjour terminé.');
  // La politique s'applique au montant ENCORE détenu : un geste commercial déjà
  // remboursé depuis le tableau de bord du prestataire ne se rembourse pas deux fois.
  const rf = cat.refundFor(b); let refundNote = '';
  const deja = Math.max(0, Number(b.refund_amount) || 0);
  const montant = Math.max(0, Math.min(rf.amount, b.amount - deja));
  if (montant > 0) { try { await PSPS[b.psp].refund(b, montant); } catch (e) { console.error('Remboursement : ' + e.message); refundNote = 'Le remboursement sera traité manuellement par notre équipe.'; } }
  await db.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now(), refund_amount = $2, updated_at = now() WHERE id = $1", [b.id, deja + montant]);
  audit(u.id, 'booking.cancel', b.id, ctx.ip);
  await mail.send({ to: u.email, subject: `Annulation · ${b.id}`, text: `Votre réservation ${b.id} est annulée. Remboursement selon la politique ${rf.policy} : ${(montant / 100).toFixed(0)} ${b.currency}. ${refundNote}`.trim() });
  const adm = await mail.adminEmail(); if (adm) await mail.send({ to: adm, subject: `[${cat.siteName()}] Annulation ${b.id}`, text: `Réservation ${b.id} annulée par le client. Remboursement ${(montant / 100).toFixed(0)} ${b.currency} (${rf.pct} %${deja ? `, ${(deja / 100).toFixed(0)} déjà remboursés` : ''}). ${refundNote}` });
  return { ok: true, refund: montant, note: refundNote };
});

/* Carte de membre : numéro et jeton signé (HMAC), QR « DOUIRA|M|<n°>|<jeton> » */
/* Notifications push : l'appli enregistre le jeton Expo de l'appareil après accord
   de l'utilisateur, et le retire à la déconnexion explicite des notifications. */
R.add('PUT', '/api/me/push-token', async ctx => {
  const u = requireCsrf(ctx); const b = await H.readJson(ctx.req);
  const token = str(b.token, 200);
  if (!push.isExpoToken(token)) throw new H.HttpError(400, 'Jeton de notification invalide.');
  const platform = ['ios', 'android', 'web'].includes(str(b.platform, 10)) ? str(b.platform, 10) : '';
  await H.rateLimit('pushreg:' + u.id, 30, 3600);

  /* Le même appareil peut changer de compte — mais un jeton Expo n'est pas une
     preuve de possession : qui le connaît pouvait se l'attribuer, privant la
     victime de ses notifications et poussant les siennes sur son écran.

     Une reprise n'est donc acceptée que si elle est plausible :
     - c'est déjà le même compte (simple ré-enregistrement) ;
     - l'ancien propriétaire n'a plus aucune session valide (il s'est déconnecté
       ou a désinstallé : c'est le vrai cas de l'appareil qui change de mains —
       la déconnexion supprime d'ailleurs la ligne elle-même) ;
     - ou la ligne est dormante depuis plus de deux jours (appli réinstallée
       après un plantage, sans déconnexion propre).

     Sinon la demande est ignorée en silence : l'appareil d'un utilisateur actif
     ne se fait pas voler ses notifications. */
  const r = await db.query(
    `INSERT INTO push_tokens (token, user_id, platform) VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, last_seen = now()
      WHERE push_tokens.user_id = EXCLUDED.user_id
         OR push_tokens.last_seen < now() - interval '2 days'
         OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = push_tokens.user_id AND s.expires_at > now())
     RETURNING user_id`,
    [token, u.id, platform]);
  // Refus : on ne le dit pas à l'appelant (il n'a pas à savoir que ce jeton est
  // pris), mais on le trace — c'est le signal d'une tentative de détournement.
  if (!r.rows.length) audit(u.id, 'push.takeover.refused', token.slice(-12), ctx.ip);
  return { ok: true };
});
R.add('POST', '/api/me/push-token/remove', async ctx => {
  const u = requireCsrf(ctx); const b = await H.readJson(ctx.req);
  await db.query('DELETE FROM push_tokens WHERE token = $1 AND user_id = $2', [str(b.token, 200), u.id]);
  return { ok: true };
});

// La carte porte le nom du titulaire et son niveau : c'est ce que l'agence
// lit, et ce que le membre reconnaît. Le QR, lui, ne change jamais.
R.add('GET', '/api/me/card', async ctx => {
  const u = requireUser(ctx);
  const t = sec.memberToken(u.id, u.member_no, u.card_version);
  return {
    memberNo: String(u.member_no),
    holder: String(u.name || '').trim(),
    tier: cards.vue(u.card_tier),
    token: t,
    qr: `DOUIRA|M|${u.member_no}|${t}`,
    since: u.created_at,
    renewal: new Date(new Date(u.created_at).setFullYear(new Date(u.created_at).getFullYear() + 1)).toISOString(),
  };
});

/* Lecture d'un code Douira : carte de membre ou badge d'équipe.

   Un seul point d'entrée pour les deux. Le scanneur voit à qui il a affaire,
   et le passage est écrit au journal — c'est lui qui permettra d'affirmer
   plus tard qu'un client s'est présenté ou a profité d'une offre. */
R.add('POST', '/api/scan', async ctx => {
  const u = requireCsrf(ctx);
  await H.rateLimit('scan:' + u.id, 200, 60);
  const b = await H.readJson(ctx.req);
  const r = await ca(() => scan.scanner(u, b));
  audit(u.id, 'scan.' + (r.scan ? r.scan.motif : 'verification'), r.memberNo || String(r.badgeNo || ''), ctx.ip);
  return r;
});

/* ---------------------------------------------------------------------
   LES PRESTATIONS : deux scans qui encadrent un travail.

   Le prestataire scanne la carte du client AVANT, en saisissant le prix
   demandé ; il rescanne APRÈS pour attester qu'il a terminé. Le montant est
   arrêté au premier scan et n'est jamais relu au second : c'est la seule
   garantie que le client ait eue avant qu'on commence.

   Débit volontairement bas : une prestation est un geste de terrain, pas une
   boucle. Qui en ouvre soixante en une heure se trompe ou essaie autre chose.
   --------------------------------------------------------------------- */
R.add('POST', '/api/interventions/start', async ctx => {
  const u = requireCsrf(ctx);
  await H.rateLimit('itvstart:' + u.id, 60, 3600);
  const b = await H.readJson(ctx.req);
  const r = await ca(() => itv.ouvrir(u, b));
  audit(u.id, r.deja ? 'intervention.deja' : 'intervention.start', r.intervention.id, ctx.ip);
  return r;
});
R.add('POST', '/api/interventions/end', async ctx => {
  const u = requireCsrf(ctx);
  await H.rateLimit('itvend:' + u.id, 60, 3600);
  const b = await H.readJson(ctx.req);
  const r = await ca(() => itv.fermer(u, b));
  audit(u.id, 'intervention.end', r.intervention.id, ctx.ip);
  return r;
});
R.add('POST', '/api/interventions/:id/cancel', async ctx => {
  const u = requireCsrf(ctx);
  const b = await H.readJson(ctx.req);
  const r = await ca(() => itv.annuler(u, str(ctx.params.id, 40), b && b.motif));
  audit(u.id, 'intervention.cancel', r.intervention.id, ctx.ip);
  return r;
});
// Ce que le CLIENT retrouve sur sa page Réservations.
R.add('GET', '/api/interventions/mine', async ctx => {
  const u = requireUser(ctx);
  return { interventions: await ca(() => itv.pourClient(u.id)) };
});
// Ce que le PRESTATAIRE retrouve de son travail.
R.add('GET', '/api/interventions/provided', async ctx => {
  const u = requireUser(ctx);
  return { interventions: await ca(() => itv.pourPrestataire(u.id)) };
});

/* Ce que le journal garde d'une personne : à qui elle s'est présentée, quand,
   et à quel titre. Chacun voit le sien ; l'équipe voit celui des autres. */
R.add('GET', '/api/me/scans', async ctx => {
  const u = requireUser(ctx);
  return { scans: await scan.historique(u.id, 20) };
});

// Badge d'équipe : la carte d'identité de la société. Attribué au premier
// affichage, et seulement aux rôles qui y ont droit.
R.add('GET', '/api/me/badge', async ctx => {
  const u = requireUser(ctx);
  return await ca(() => badges.forUser(u));
});

/* Offres des cartes de membre : prix et avantages, par niveau. Publiques —
   on les montre avant même d'avoir un compte, c'est leur raison d'être. */
R.add('GET', '/api/card-offers', async ctx => {
  await H.rateLimit('offers:' + ctx.ip, 120, 60);
  return { offers: await cards.listOffres() };
});
R.add('POST', '/api/admin/card-offers', async ctx => {
  const a = requireCsrf(ctx);
  const b = await H.readJson(ctx.req);
  const o = await ca(() => cards.saveOffre(a, b));
  audit(a.id, 'card.offer', o.key, ctx.ip);
  return { offer: o };
});

// Niveau d'une carte : décision commerciale, réservée à l'administration.
R.add('POST', '/api/admin/users/:id/card-tier', async ctx => {
  const a = requireCsrf(ctx);
  if (a.role !== 'admin') throw new H.HttpError(403, 'Accès refusé.');
  const b = await H.readJson(ctx.req);
  const tier = cards.cleValide(b.tier);
  const r = await db.one(
    'UPDATE users SET card_tier = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id, card_tier',
    [str(ctx.params.id, 40), tier]);
  if (!r) throw new H.HttpError(404, 'Membre introuvable.');
  audit(a.id, 'card.tier', `${r.id}:${tier}`, ctx.ip);
  return { tier: cards.vue(r.card_tier) };
});

/* Carte de membre dans Apple Wallet / Google Wallet. Le pass ne porte rien de
   plus que le QR ci-dessus : une agence valide les deux par /api/agency/redeem. */
const memberOf = u => { const t = sec.memberToken(u.id, u.member_no, u.card_version); return { memberNo: String(u.member_no), qr: `DOUIRA|M|${u.member_no}|${t}`, since: u.created_at }; };
const WALLET_ICONS = (() => {
  const fs = require('fs'), path = require('path'), dir = path.join(__dirname, 'assets', 'wallet');
  const out = {};
  try { for (const f of fs.readdirSync(dir)) out[f] = fs.readFileSync(path.join(dir, f)); }
  catch (e) { console.error('Wallet : icônes du pass introuvables (api/assets/wallet).'); }
  return out;
})();

R.add('GET', '/api/me/card/apple', async ctx => {
  // Deux entrées : la session de l'appli, ou un lien signé de courte durée —
  // c'est le navigateur qui ouvre le .pkpass, et il n'a pas notre session.
  let u = ctx.session;
  if (!u) {
    const id = str(ctx.url.searchParams.get('u'), 40);
    const t = str(ctx.url.searchParams.get('t'), 60);
    if (!id || !sec.walletLinkUser(id, t)) throw new H.HttpError(401, 'Lien expiré. Rouvrez votre carte dans l’application.');
    u = await db.one('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!u) throw new H.HttpError(401, 'Lien expiré.');
    // La voie « session » vérifie déjà le compte suspendu : cette voie aussi.
    if (u.status === 'suspendu') throw new H.HttpError(403, 'Ce compte est suspendu.');
  }
  // Chaque appel lance openssl et écrit des fichiers temporaires : un lien
  // valide ne doit pas pouvoir saturer la machine.
  await H.rateLimit('applepass:' + u.id, 10, 600);
  let pkpass;
  try { pkpass = await wallet.applePass(memberOf(u), WALLET_ICONS); }
  catch (e) { throw new H.HttpError(e.code === 'NOT_CONFIGURED' ? 503 : 500, e.message); }
  ctx.res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.pkpass',
    'Content-Disposition': `attachment; filename="douira-${u.member_no}.pkpass"`,
    'Content-Length': pkpass.length,
    'Cache-Control': 'no-store',
  });
  ctx.res.end(pkpass);
});

R.add('GET', '/api/me/card/google', async ctx => {
  const u = requireUser(ctx);
  await H.rateLimit('googlepass:' + u.id, 20, 600);
  try { return { url: await wallet.googleSaveUrl(memberOf(u), process.env.SITE_URL || '') }; }
  catch (e) { throw new H.HttpError(e.code === 'NOT_CONFIGURED' ? 503 : 500, e.message); }
});

/* Ce que l'appli demande pour n'afficher que les boutons réellement utilisables. */
R.add('GET', '/api/me/card/wallets', async ctx => {
  const u = requireUser(ctx);
  const v = await wallet.publicView();
  const base = (process.env.SITE_URL || '').replace(/\/$/, '');
  const link = sec.walletLink(u.id, Date.now() + 3 * 60 * 1000); // 3 minutes : le temps d'ouvrir le navigateur
  return {
    apple: v.apple.ready,
    google: v.google.ready,
    appleUrl: v.apple.ready ? `${base}/api/me/card/apple?u=${encodeURIComponent(u.id)}&t=${link}` : null,
  };
});

R.add('GET', '/api/admin/wallet', async ctx => { const a = requireUser(ctx); if (a.role !== 'admin') throw new H.HttpError(403, 'Accès refusé.'); await H.rateLimit('wallet-read:' + a.id, 60, 60); return await wallet.publicView(); });
R.add('POST', '/api/admin/wallet', async ctx => { const a = requireCsrf(ctx); if (a.role !== 'admin') throw new H.HttpError(403, 'Accès refusé.'); await H.rateLimit('wallet-save:' + a.id, 20, 600); const b = await H.readJson(ctx.req, 200000); const v = await wallet.save(b); audit(a.id, 'wallet.save', '', ctx.ip); return v; });
R.add('PATCH', '/api/me', async ctx => { const u = requireCsrf(ctx); const b = await H.readJson(ctx.req); const name = str(b.name, 80) || u.name, phone = str(b.phone, 30); await db.query('UPDATE users SET name = $2, phone = $3, updated_at = now() WHERE id = $1', [u.id, name, phone]); return { user: publicUser(Object.assign(u, { name, phone })) }; });

/* ---------- Parrainage, carte de voyages, profil public ---------- */

/* Tableau de bord du parrainage : code, lien, nombre de filleuls, bons disponibles. */
R.add('GET', '/api/me/referrals', async ctx => {
  const u = requireUser(ctx);
  const s = await refs.summary(u.id);
  // Le lien d'invitation pointe vers le site, qui renvoie vers l'inscription avec le code pré-rempli.
  return { referral: Object.assign(s, { link: `${(process.env.SITE_URL || siteUrl(ctx.req)).replace(/\/$/, '')}/?parrain=${encodeURIComponent(s.code)}` }) };
});

/* Profil public : éteint par défaut, l'utilisateur l'allume s'il veut exposer sa
   carte de voyages aux autres membres. */
R.add('PUT', '/api/me/public-profile', async ctx => {
  const u = requireCsrf(ctx);
  const b = await H.readJson(ctx.req);
  const on = b.on === true;
  await db.query('UPDATE users SET public_profile = $2, updated_at = now() WHERE id = $1', [u.id, on]);
  return { publicProfile: on };
});

/* Les séjours confirmés d'un membre, pour la carte de voyages et le score de
   pays. On pose les marqueurs sur la VILLE (destination), jamais sur l'adresse
   exacte : l'adresse n'est connue que du client, la veille de l'arrivée. */
async function travelOf(userId) {
  await cat.refreshDb();
  const r = await db.query(
    "SELECT id, listing_id, start_date, end_date, status FROM bookings WHERE user_id = $1 AND status = 'confirmed' ORDER BY start_date DESC",
    [userId]);
  const stays = [];
  const pays = new Set();
  for (const b of r.rows) {
    const l = cat.listing(b.listing_id);
    const city = l ? l.city : '';
    const info = city ? dest.cityInfo(city) : null;
    const country = info ? info.country : '';
    if (country) pays.add(country.toLowerCase());
    stays.push({
      bookingId: b.id,
      title: l ? l.title : b.listing_id,
      city,
      country,
      lat: info && info.lat != null ? info.lat : (l && l.positionApprox ? l.positionApprox.lat : null),
      lng: info && info.lng != null ? info.lng : (l && l.positionApprox ? l.positionApprox.lng : null),
      photo: l && Array.isArray(l.photos) && l.photos.length ? l.photos[0] : (l && l.photo) || '',
      start: cat.dateStr(b.start_date),
      end: cat.dateStr(b.end_date),
      diamond: !!(l && l.diamond),
    });
  }
  return { stays, countryCount: pays.size };
}
R.add('GET', '/api/me/travel', async ctx => {
  const u = requireUser(ctx);
  const t = await travelOf(u.id);
  return Object.assign(t, { since: u.created_at });
});

/* Rechercher un membre par son nom pour voir sa carte de voyages. On ne renvoie
   QUE des membres qui ont activé leur profil public : on ne peut pas trouver
   quelqu'un qui ne s'est pas rendu visible. Réservé aux membres connectés (pas la
   démonstration), limité en débit, et on ne renvoie que le prénom et l'identifiant. */
R.add('GET', '/api/members/public', async ctx => {
  const u = requireUser(ctx);
  await H.rateLimit('memsearch:' + u.id, 60, 60);
  const q = str(ctx.url.searchParams.get('q') || '', 60).trim();
  if (q.length < 2) return { members: [] };
  // ILIKE insensible à la casse ; on échappe les jokers pour que « % » ou « _ »
  // saisis soient cherchés tels quels et non comme des jokers SQL.
  const motif = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
  const r = await db.query(
    "SELECT id, name FROM users WHERE public_profile = true AND deleted_at IS NULL AND id <> $1 AND name ILIKE $2 ESCAPE '\\' ORDER BY name LIMIT 15",
    [u.id, motif]);
  return { members: r.rows.map(x => ({ id: x.id, name: firstName(x.name) })) };
});

/* Profil public d'un autre membre : seulement s'il l'a activé. Prénom seul,
   score de pays et carte de voyages au niveau ville. Jamais l'e-mail, le
   téléphone, les références de réservation ni les dates. */
R.add('GET', '/api/users/:id/public', async ctx => {
  await H.rateLimit('pubprofile:' + ctx.ip, 120, 60);
  const id = str(ctx.params.id, 40);
  // L'identifiant est un UUID : un paramètre forgé ne doit pas faire planter la
  // requête (cast invalide), mais renvoyer le même 404 qu'un profil privé.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new H.HttpError(404, 'Profil introuvable ou privé.');
  const other = await db.one("SELECT id, name, created_at, public_profile FROM users WHERE id = $1 AND deleted_at IS NULL", [id]);
  if (!other || !other.public_profile) throw new H.HttpError(404, 'Profil introuvable ou privé.');
  const t = await travelOf(other.id);
  // On n'expose que ville + pays + photo (déjà publique sur le logement) : ni la
  // référence de réservation, ni les dates du séjour.
  const places = t.stays.map(s => ({ title: s.title, city: s.city, country: s.country, lat: s.lat, lng: s.lng, photo: s.photo, diamond: s.diamond }));
  return { profile: { name: firstName(other.name), since: other.created_at, countryCount: t.countryCount, places } };
});
// RGPD : export de toutes les données du compte, puis suppression (anonymisation : les factures restent dues au fisc)
/* Sa propre note : chacun voit la sienne, client comme propriétaire, même
   quand elle n'est pas encore publique. */
R.add('GET', '/api/me/rating', async ctx => {
  const u = requireUser(ctx);
  await H.rateLimit('myrating:' + u.id, 60, 60);
  return await ca(() => msg.myRating(u.id));
});
/* Droit d'accès et de portabilité : TOUT ce que la plateforme tient sur la
   personne, table par table. Les images des pièces et le selfie n'y sont pas
   (ils sont chiffrés et ont leur propre écran) ; leurs métadonnées, si. */
R.add('GET', '/api/me/export', async ctx => {
  const u = requireUser(ctx); await H.rateLimit('export:' + u.id, 5, 3600);
  const q = async (sql, p) => (await db.query(sql, p).catch(() => ({ rows: [] }))).rows;
  const [bk, au, msgs, avis, notesEchanges, notesArticles, passages, prestations, factures, offres, pieces, verifs, pushs] = await Promise.all([
    db.query('SELECT * FROM bookings WHERE user_id = $1', [u.id]),
    db.query('SELECT at, action, target FROM audit WHERE actor = $1 ORDER BY at DESC LIMIT 2000', [u.id]),
    q('SELECT conversation_id, body, at FROM messages WHERE sender_id = $1 ORDER BY at LIMIT 5000', [u.id]),
    q('SELECT booking_id, listing_id, rating, comment, at FROM reviews WHERE author_id = $1', [u.id]),
    q('SELECT conversation_id, target_part, rating, comment, at FROM conversation_ratings WHERE author_id = $1', [u.id]),
    q('SELECT kind, item_id, rating, comment, at FROM item_ratings WHERE author_id = $1', [u.id]),
    q('SELECT at, scanner_role, kind, activity_id, service_id, booking_id, motif FROM scans WHERE subject_id = $1 OR scanner_id = $1 ORDER BY at', [u.id]),
    q('SELECT id, service_id, status, amount, currency, city, started_at, ended_at, paid_at FROM interventions WHERE client_id = $1 OR provider_id = $1', [u.id]),
    q('SELECT i.number, i.booking_id, i.issued_at, i.amount, i.currency FROM invoices i JOIN bookings b ON b.id = i.booking_id WHERE b.user_id = $1', [u.id]),
    q('SELECT activity_id, pct, at FROM activity_redemptions WHERE client_id = $1', [u.id]),
    q('SELECT kind, status, mime, reviewed_at, expires_at, created_at FROM client_documents WHERE user_id = $1', [u.id]),
    q('SELECT status, provider, attempt, consent_at, decided_at, expires_at, created_at FROM kyc_checks WHERE user_id = $1', [u.id]),
    q('SELECT platform, created_at, last_seen FROM push_tokens WHERE user_id = $1', [u.id]),
  ]);
  audit(u.id, 'data.export', '', ctx.ip);
  return {
    exportedAt: new Date().toISOString(),
    user: Object.assign(publicUser(u), { hostBio: u.host_bio || '', hostLanguages: u.host_languages || '', hasHostPhoto: !!u.host_photo, cardTier: u.card_tier || null }),
    bookings: bk.rows.map(b => bookingView(b)), activity: au.rows,
    messages: msgs, reviews: avis, conversationRatings: notesEchanges, itemRatings: notesArticles,
    scans: passages, interventions: prestations, invoices: factures, redemptions: offres,
    documents: pieces, identityChecks: verifs, pushDevices: pushs,
  };
});
R.add('POST', '/api/me/delete', async ctx => {
  const u = requireCsrf(ctx); const b = await H.readJson(ctx.req);
  if (!sec.verifyPassword(b.password, u.pass_hash)) throw new H.HttpError(401, 'Mot de passe incorrect.');
  const active = await db.one("SELECT id FROM bookings WHERE user_id = $1 AND status = 'confirmed' AND end_date >= $2::date LIMIT 1", [u.id, cat.isoToday()]);
  if (active) throw new H.HttpError(400, 'Un séjour à venir est confirmé : annulez-le ou attendez sa fin avant de supprimer le compte.');
  // Ce qui identifie la personne part avec le compte : pièces d'identité (numéro
  // et image), selfie de vérification, appareils de notification, profil d'hôte.
  // Les réservations, factures et journaux restent, anonymisés par la ligne users.
  await db.tx(async t => {
    await t.query("UPDATE users SET email = $2, name = 'Compte supprimé', phone = '', pass_hash = 'deleted', host_bio = '', host_languages = '', host_photo = '', deleted_at = now() WHERE id = $1", [u.id, `deleted-${u.id}@invalid.local`]);
    await t.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
    await t.query('DELETE FROM password_resets WHERE user_id = $1', [u.id]);
    await t.query('DELETE FROM kyc_checks WHERE user_id = $1', [u.id]);
    await t.query('DELETE FROM client_documents WHERE user_id = $1', [u.id]);
    await t.query('DELETE FROM push_tokens WHERE user_id = $1', [u.id]);
  });
  audit(u.id, 'user.delete', '', ctx.ip); H.setCookie(ctx.res, SESSION_COOKIE, '', { secure: H.isHttps(ctx.req), maxAge: 0 }); return { ok: true };
});

/* ---------- Prestataires de paiement : webhooks et retours ---------- */
R.add('POST', '/api/webhooks/stripe', async ctx => {
  const raw = (await H.readBody(ctx.req, 256 * 1024)).toString('utf8');
  // Le détail (« STRIPE_WEBHOOK_SECRET manquante ») renseignerait un appelant
  // anonyme sur l'état de la configuration : il reste dans le journal.
  let ev;
  try { ev = PSPS.stripe.verifyWebhook(raw, ctx.req.headers['stripe-signature']); }
  catch (e) { console.error('Webhook Stripe :', e.message); throw new H.HttpError(500, 'Webhook indisponible.'); }
  if (!ev) throw new H.HttpError(400, 'Signature invalide.');
  // L'événement doit venir du MÊME environnement Stripe que la clé : avec une
  // clé réelle et, par erreur, le secret d'un webhook de test, un paiement de
  // test (sans un dirham) confirmerait un vrai séjour. On le refuse ici.
  const attendu = PSPS.stripe.mode() === 'live';
  if (!!ev.livemode !== attendu) { console.error(`Webhook Stripe : événement ${ev.livemode ? 'réel' : 'de test'} reçu alors que la clé est ${attendu ? 'réelle' : 'de test'} — ignoré (${ev.id}).`); throw new H.HttpError(400, 'Environnement Stripe inattendu.'); }
  const r = await applyPaymentEvent('stripe', PSPS.stripe.interpret(ev), ev.id);
  if (r.confirmed) notifyConfirmed(r.booking).catch(e => console.error('e-mail', e.message));
  if (r.stray) notifyStrayPayment(r.booking, r.stray).catch(e => console.error('e-mail', e.message));
  if (r.failed || r.expired) notifyPaymentFailed(r.booking, r.failed ? 'failed' : 'expired').catch(e => console.error('e-mail', e.message));
  return { received: true };
}, { noCsrf: true });
R.add('GET', '/api/psp/cmi/form/:id', async ctx => {
  const u = requireUser(ctx); const b = await db.one("SELECT * FROM bookings WHERE id = $1 AND user_id = $2 AND status = 'pending_payment' AND hold_until > now()", [str(ctx.params.id, 20), u.id]);
  if (!b) throw new H.HttpError(404, 'Réservation introuvable ou expirée.');
  const l = cat.listing(b.listing_id) || { title: b.listing_id };
  H.html(ctx.res, 200, PSPS.cmi.checkoutPage(PSPS.cmi.formParams({ booking: b, user: u, siteUrl: siteUrl(ctx.req), apiUrl: siteUrl(ctx.req), label: `${cat.siteName()} · ${l.title} · ${b.id}` })), { 'Content-Security-Policy': "default-src 'none'; form-action " + PSPS.cmi.gateway() + "; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
});
R.add('POST', '/api/webhooks/cmi', async ctx => {
  const p = await H.readForm(ctx.req, 64 * 1024);
  if (!PSPS.cmi.enabled() || !PSPS.cmi.verify(p)) { console.error('CMI : callback non signé ou signature invalide'); ctx.res.writeHead(400, { 'Content-Type': 'text/plain' }); return ctx.res.end('FAILURE'); }
  const ev = PSPS.cmi.interpret(p); const r = await applyPaymentEvent('cmi', ev, ev.eventId);
  if (r.confirmed) notifyConfirmed(r.booking).catch(e => console.error('e-mail', e.message));
  if (r.stray) notifyStrayPayment(r.booking, r.stray + ' — pré-autorisation CMI non capturée, vérifiez que rien n’a été prélevé').catch(e => console.error('e-mail', e.message));
  if (r.declined || r.failed) notifyPaymentFailed(r.booking, r.declined ? 'declined' : 'failed').catch(e => console.error('e-mail', e.message));
  // POSTAUTH capture les fonds : seulement quand CE paiement confirme le séjour.
  // Une réservation déjà payée (second formulaire, rechargement pendant la 3-D
  // Secure), inconnue ou annulée ne doit pas être encaissée une seconde fois :
  // APPROVED laisse tomber la pré-autorisation sans rien prélever.
  if (r.already || r.unknown || r.duplicate) console.error(`CMI : paiement ${ev.bookingId} non capturé (${Object.keys(r)[0]}), TransId ${p.TransId || '?'}`);
  ctx.res.writeHead(200, { 'Content-Type': 'text/plain' }); ctx.res.end(r.confirmed ? 'ACTION=POSTAUTH' : 'APPROVED');
}, { noCsrf: true });
R.add('*', '/api/psp/cmi/return', async ctx => { // retour du navigateur (okUrl/failUrl) : simple redirection, l'état vient du callback
  const p = ctx.req.method === 'POST' ? await H.readForm(ctx.req, 64 * 1024) : Object.fromEntries(ctx.url.searchParams);
  const id = str(p.oid || p.ReturnOid || '', 20).replace(/[^A-Z0-9-]/gi, '');
  H.redirect(ctx.res, `${siteUrl(ctx.req)}/#espace-c_booking~${id}`);
}, { noCsrf: true });
R.add('GET', '/api/psp/simulate/:id', async ctx => {
  if (!PSPS.simulate.enabled()) throw new H.HttpError(404, 'Introuvable.');
  const u = requireUser(ctx); const b = await db.one("SELECT * FROM bookings WHERE id = $1 AND user_id = $2 AND status = 'pending_payment'", [str(ctx.params.id, 20), u.id]);
  if (!b) throw new H.HttpError(404, 'Réservation introuvable.');
  H.html(ctx.res, 200, PSPS.simulate.page(b, u.csrf, siteUrl(ctx.req)), { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" });
});
R.add('POST', '/api/psp/simulate/:id/complete', async ctx => {
  if (!PSPS.simulate.enabled()) throw new H.HttpError(404, 'Introuvable.');
  const u = requireUser(ctx); const p = await H.readForm(ctx.req); if (!sec.safeEqual(p.csrf || '', u.csrf)) throw new H.HttpError(403, 'Jeton invalide.');
  const b = await db.one('SELECT * FROM bookings WHERE id = $1 AND user_id = $2', [str(ctx.params.id, 20), u.id]); if (!b) throw new H.HttpError(404, 'Réservation introuvable.');
  const r = await applyPaymentEvent('simulate', PSPS.simulate.interpret(p.result, b), 'sim-' + b.id + '-' + p.result);
  if (r.confirmed) notifyConfirmed(r.booking).catch(e => console.error('e-mail', e.message));
  if (r.failed) notifyPaymentFailed(r.booking, 'failed').catch(e => console.error('e-mail', e.message));
  H.redirect(ctx.res, `${siteUrl(ctx.req)}/#espace-c_booking~${b.id}`);
}, { noCsrf: true });

/* ---------- Équipe (rôle admin, double authentification) ---------- */
R.add('GET', '/api/admin/bookings', async ctx => { const u = requireUser(ctx); await ca(() => team.requireGate(u, 'bookings')); if (u.role !== 'admin' && u.role !== 'collaborator') throw new H.HttpError(403, 'Accès refusé.'); const r = await db.query("SELECT b.*, u.name AS client_name, u.email AS client_email, u.phone AS client_phone FROM bookings b JOIN users u ON u.id = b.user_id WHERE b.status IN ('confirmed', 'cancelled', 'pending_payment') ORDER BY b.start_date DESC LIMIT 500"); return { bookings: r.rows.map(b => Object.assign(bookingView(b), { client: { name: b.client_name, email: b.client_email, phone: b.client_phone } })) }; });
R.add('POST', '/api/admin/checkin', async ctx => {
  const a = requireCsrf(ctx); if (a.role !== 'admin') throw new H.HttpError(403, 'Accès refusé.');
  const b = await H.readJson(ctx.req); const m = /^DOUIRA\|M\|(\d{6})\|([A-Z0-9]{16})$/.exec(str(b.code, 60));
  if (!m) throw new H.HttpError(400, 'Code inconnu ou invalide.');
  const u = await db.one('SELECT * FROM users WHERE member_no = $1 AND deleted_at IS NULL', [Number(m[1])]);
  if (!u || !sec.safeEqual(sec.memberToken(u.id, u.member_no, u.card_version), m[2])) throw new H.HttpError(400, 'Code inconnu ou invalide.');
  const cur = await db.one("SELECT * FROM bookings WHERE user_id = $1 AND status = 'confirmed' AND start_date <= $2::date + 1 AND end_date >= $2::date ORDER BY start_date LIMIT 1", [u.id, cat.isoToday()]);
  if (b.record) { await db.query('INSERT INTO checkins (booking_id, user_id, by_user_id) VALUES ($1, $2, $3)', [cur ? cur.id : null, u.id, a.id]); audit(a.id, 'checkin', u.id, ctx.ip); }
  return { client: { name: u.name, memberNo: String(u.member_no) }, booking: cur ? bookingView(cur) : null, recorded: !!b.record };
});
/* Validation d'une offre d'activité : l'agence scanne la carte de membre du client et
   enregistre la promotion (une seule fois par client et par jour pour une même activité). */
/* ---------- Pièces justificatives (loi 09-08) ----------
   Le client dépose sa pièce d'identité (et son permis s'il loue un véhicule) ;
   l'équipe la vérifie. Numéro et image chiffrés, image purgée à l'échéance. */
R.add('GET', '/api/me/documents', async ctx => {
  const u = requireUser(ctx);
  return { documents: await docs.listMine(u.id), kinds: docs.KINDS, labels: docs.KIND_LABEL, keepDays: docs.KEEP_DAYS };
});
R.add('POST', '/api/me/documents', async ctx => {
  const u = requireCsrf(ctx);
  await H.rateLimit('docs:' + u.id, 20, 3600);
  const b = await H.readJson(ctx.req, 4 * 1024 * 1024);
  const d = await ca(() => docs.submit(u, b));
  audit(u.id, 'document.submit', d.kind, ctx.ip);
  return { document: d };
});
R.add('POST', '/api/me/documents/:kind/remove', async ctx => {
  const u = requireCsrf(ctx);
  return { documents: await ca(() => docs.remove(u, str(ctx.params.kind, 20))) };
});

/* Vérification par l'équipe : périmètre « bookings » (ou administrateur). */
R.add('GET', '/api/admin/documents', async ctx => {
  const u = requireUser(ctx); await ca(() => team.requireScope(u, 'bookings'));
  await H.rateLimit('docs-list:' + u.id, 120, 60);
  return { documents: await docs.listPending() };
});
/* L'image à vérifier, en clair et jamais mise en cache. Sans elle, l'équipe
   devrait décider sans rien voir. */
R.add('GET', '/api/admin/documents/:id/file', async ctx => {
  const u = requireUser(ctx); await ca(() => team.requireScope(u, 'bookings'));
  // Une pièce d'identité se regarde une fois pour décider, pas en boucle.
  await H.rateLimit('docfile:' + u.id, 60, 3600);
  const f = await ca(() => docs.fileFor(str(ctx.params.id, 20)));
  audit(u.id, 'document.view', str(ctx.params.id, 20), ctx.ip);
  return { mime: f.mime, number: f.number, dataUrl: `data:${f.mime};base64,${f.data.toString('base64')}` };
});

R.add('POST', '/api/admin/documents/:id/review', async ctx => {
  const u = requireCsrf(ctx); await ca(() => team.requireScope(u, 'bookings'));
  const b = await H.readJson(ctx.req);
  const d = await ca(() => docs.review(u, str(ctx.params.id, 20), str(b.status, 20), b.note));
  audit(u.id, 'document.' + str(b.status, 20), str(ctx.params.id, 20), ctx.ip);
  return { document: d };
});

/* ---------- Vérification du visage ----------
   La pièce prouve qu'un document existe ; le selfie prouve qu'il est bien
   celui de la personne. Le selfie est chiffré et effacé dès la décision. */
R.add('GET', '/api/me/kyc', async ctx => {
  const u = requireUser(ctx);
  return { kyc: await ca(() => kyc.mine(u.id)) };
});
R.add('POST', '/api/me/kyc', async ctx => {
  const u = requireCsrf(ctx);
  // Plus strict que le dépôt de pièce : une photo de visage par quart d'heure
  // suffit largement, et c'est la porte d'entrée d'une donnée sensible.
  await H.rateLimit('kyc:' + u.id, 6, 3600);
  const b = await H.readJson(ctx.req, 3 * 1024 * 1024);
  const k = await ca(() => kyc.submit(u, b));
  audit(u.id, 'kyc.submit', k.id, ctx.ip);
  return { check: k };
});

/* Examen par l'équipe : même périmètre que les pièces justificatives. */
R.add('GET', '/api/admin/kyc', async ctx => {
  const u = requireUser(ctx); await ca(() => team.requireScope(u, 'bookings'));
  await H.rateLimit('kyc-list:' + u.id, 120, 60);
  return { checks: await kyc.listPending() };
});
/* Les deux images à comparer. Jamais mises en cache, consultation tracée. */
R.add('GET', '/api/admin/kyc/:id/files', async ctx => {
  const u = requireUser(ctx); await ca(() => team.requireScope(u, 'bookings'));
  await H.rateLimit('kycfile:' + u.id, 60, 3600);
  const f = await ca(() => kyc.filesFor(str(ctx.params.id, 20)));
  audit(u.id, 'kyc.view', str(ctx.params.id, 20), ctx.ip);
  return f;
});
R.add('POST', '/api/admin/kyc/:id/review', async ctx => {
  const u = requireCsrf(ctx); await ca(() => team.requireScope(u, 'bookings'));
  const b = await H.readJson(ctx.req);
  const k = await ca(() => kyc.review(u, str(ctx.params.id, 20), str(b.status, 20), b.reason));
  audit(u.id, 'kyc.' + str(b.status, 20), str(ctx.params.id, 20), ctx.ip);
  return { check: k };
});

/* ---------- Voitures et motos ---------- */
R.add('GET', '/api/vehicles', async ctx => {
  await H.rateLimit('veh:' + ctx.ip, 120, 60);
  return veh.listPublic(str(ctx.url.searchParams.get('city'), 80));
});
R.add('GET', '/api/admin/vehicles', async ctx => {
  const u = requireUser(ctx); return { vehicles: await ca(() => veh.listAll(u)) };
});
R.add('POST', '/api/admin/vehicles', async ctx => {
  const u = requireCsrf(ctx); const b = await H.readJson(ctx.req);
  const v = await ca(() => veh.save(u, b));
  audit(u.id, 'vehicle.save', v.id, ctx.ip);
  return { vehicle: v };
});

/* ---------- Destinations (pays → villes) ----------
   Liste publique pour l'écran de choix de destination ; administration réservée
   au périmètre « destinations » (l'admin, ou qui il désigne). */
R.add('GET', '/api/destinations', async ctx => {
  await H.rateLimit('dest:' + ctx.ip, 120, 60);
  return dest.published();
});
R.add('GET', '/api/admin/destinations', async ctx => {
  const u = requireUser(ctx); return { destinations: await ca(() => dest.listAll(u)) };
});
R.add('POST', '/api/admin/destinations', async ctx => {
  const u = requireCsrf(ctx); const b = await H.readJson(ctx.req);
  const d = await ca(() => dest.save(u, b));
  audit(u.id, 'destination.save', d.id, ctx.ip);
  return { destination: d };
});

/* ---------- Comptes d'encaissement (admin) ----------
   Les secrets sont chiffrés en base et ne sont JAMAIS renvoyés : l'écran ne reçoit
   que « renseigné / non renseigné ». Un champ laissé vide conserve l'existant ;
   envoyer « - » retire le secret. */
R.add('GET', '/api/admin/settings/payments', async ctx => {
  requireUser(ctx, 'admin');
  return { payments: await pay.currentView(), cities: Object.keys(mny.CURRENCY_BY_CITY), currencies: mny.CURRENCY_BY_CITY };
});
R.add('PUT', '/api/admin/settings/payments', async ctx => {
  const a = requireCsrf(ctx); if (a.role !== 'admin') throw new H.HttpError(403, 'Accès refusé.');
  const b = await H.readJson(ctx.req);
  const view = await pay.save(a, b);
  audit(a.id, 'settings.payments', '', ctx.ip);
  return { payments: view };
});

/* ---------- Services (clients / propriétaires) ----------
   Les deux publics ne voient pas la même liste : l'audience est portée par le
   service, et « both » est un choix explicite de l'équipe (voir lib/team.js). */
R.add('GET', '/api/services', async ctx => {
  await H.rateLimit('services:' + ctx.ip, 120, 60);
  return svc.listPublic(ctx.session, str(ctx.url.searchParams.get('city'), 80));
});
/* ---- L'accès du prestataire : SA fiche, et rien d'autre ----
   Volontairement hors de /api/admin : ces deux routes ne demandent pas le
   périmètre « services », elles demandent que le service soit confié à celui
   qui écrit. Les ranger sous /admin ferait croire le contraire au prochain
   qui lira ce fichier. */
R.add('GET', '/api/services/mine', async ctx => {
  const u = requireUser(ctx); return { services: await ca(() => svc.listMine(u)) };
});
R.add('POST', '/api/services/:id/fiche', async ctx => {
  // Même plafond que la route d'administration : la photo voyage en base64.
  const u = requireCsrf(ctx); const b = await H.readJson(ctx.req, 3000000);
  await H.rateLimit('fiche:' + u.id, 60, 3600);
  const s = await ca(() => svc.saveFiche(u, str(ctx.params.id, 40), b));
  audit(u.id, 'service.fiche', s.id, ctx.ip);
  return { service: s };
});
R.add('GET', '/api/admin/services', async ctx => {
  const u = requireUser(ctx); return { services: await ca(() => svc.listAll(u)) };
});
R.add('POST', '/api/admin/services', async ctx => {
  // La photo du service voyage en base64 dans le corps : même plafond que le
  // portrait d'un hôte (2 Mo d'image, le reste pour les autres champs).
  const u = requireCsrf(ctx); const b = await H.readJson(ctx.req, 3000000);
  const s = await ca(() => svc.save(u, b));
  audit(u.id, 'service.save', s.id, ctx.ip);
  return { service: s };
});
R.add('POST', '/api/admin/services/:id/publish', async ctx => {
  const u = requireCsrf(ctx); const b = await H.readJson(ctx.req);
  const s = await ca(() => svc.publish(u, str(ctx.params.id, 40), !!b.publish));
  audit(u.id, b.publish ? 'service.publish' : 'service.unpublish', s.id, ctx.ip);
  return { service: s };
});

/* Catégories de services (sauna, massage, chef privé, baby-sitting, chauffeur…).
   Lecture publique — le client s'en sert pour filtrer la liste. Écriture
   réservée au périmètre « services » : l'admin, ou la personne qu'il a
   désignée. */
R.add('GET', '/api/services/categories', async ctx => {
  await H.rateLimit('svccat:' + ctx.ip, 120, 60);
  return { categories: await svc.categories() };
});
R.add('POST', '/api/admin/services/categories', async ctx => {
  const u = requireCsrf(ctx); const b = await H.readJson(ctx.req);
  const cat = await ca(() => svc.saveCategory(u, b));
  audit(u.id, 'service.category.save', cat.key, ctx.ip);
  return { category: cat };
});
R.add('DELETE', '/api/admin/services/categories/:key', async ctx => {
  const u = requireCsrf(ctx);
  const cat = await ca(() => svc.deleteCategory(u, str(ctx.params.key, 40)));
  audit(u.id, 'service.category.delete', cat.key, ctx.ip);
  return { ok: true, key: cat.key };
});

/* ---------- Équipe : répartition des tâches ----------
   L'admin confie les périmètres ; un chef d'équipe peut répartir à son tour,
   mais seulement ce qu'il détient, et désigner un autre chef d'équipe. */
R.add('GET', '/api/admin/team', async ctx => {
  const u = requireUser(ctx);
  await ca(() => team.requireScope(u, 'team'));
  return { team: await team.listTeam(), scopes: team.SCOPES, labels: team.SCOPE_LABEL };
});
R.add('POST', '/api/admin/team/:id/scopes', async ctx => {
  const u = requireCsrf(ctx); const b = await H.readJson(ctx.req);
  await ca(() => team.requireScope(u, 'team')); // la lecture l'exige : l'écriture aussi
  const t = await ca(() => team.setScopes(u, str(ctx.params.id, 40), b.scopes));
  audit(u.id, 'team.scopes', str(ctx.params.id, 40), ctx.ip);
  return { team: t };
});
R.add('POST', '/api/admin/team/:id/lead', async ctx => {
  const u = requireCsrf(ctx); const b = await H.readJson(ctx.req);
  await ca(() => team.requireScope(u, 'team')); // la lecture l'exige : l'écriture aussi
  const t = await ca(() => team.setTeamLead(u, str(ctx.params.id, 40), !!b.lead));
  audit(u.id, b.lead ? 'team.lead.set' : 'team.lead.unset', str(ctx.params.id, 40), ctx.ip);
  return { team: t };
});

/* ---------- Messagerie ----------
   Une conversation n'est lisible que par ses membres (voir lib/messaging.js) ;
   l'administrateur n'y a pas accès d'office. */
R.add('GET', '/api/conversations', async ctx => {
  const u = requireUser(ctx); return { conversations: await msg.listForUser(u.id) };
});
R.add('GET', '/api/conversations/:id', async ctx => {
  const u = requireUser(ctx); return ca(() => msg.readConversation(u.id, str(ctx.params.id, 20)));
});

/* ---------- Modération : signaler, bloquer ----------
   Toute personne peut signaler un message, un avis, une conversation ou un
   compte, et bloquer quelqu'un. L'équipe (admin, ou collaborateur portant le
   périmètre « support ») lit les signalements et les traite. */
R.add('POST', '/api/reports', async ctx => {
  const u = requireCsrf(ctx); const b = await H.readJson(ctx.req);
  await H.rateLimit('report:' + u.id, 20, 3600);
  const r = await ca(() => moderation.signaler(u.id, b));
  audit(u.id, 'report.' + String(b.kind || ''), String(b.targetId || '').slice(0, 40), ctx.ip);
  return { report: r };
});
R.add('GET', '/api/blocks', async ctx => {
  const u = requireUser(ctx); return { blocked: await ca(() => moderation.listerBloques(u.id)) };
});
R.add('POST', '/api/blocks/:id', async ctx => {
  const u = requireCsrf(ctx);
  await H.rateLimit('block:' + u.id, 30, 3600);
  const r = await ca(() => moderation.bloquer(u.id, str(ctx.params.id, 40)));
  audit(u.id, 'user.block', str(ctx.params.id, 40), ctx.ip);
  return r;
});
R.add('POST', '/api/blocks/:id/remove', async ctx => {
  const u = requireCsrf(ctx);
  const r = await ca(() => moderation.debloquer(u.id, str(ctx.params.id, 40)));
  audit(u.id, 'user.unblock', str(ctx.params.id, 40), ctx.ip);
  return r;
});
R.add('GET', '/api/admin/reports', async ctx => {
  const a = requireUser(ctx);
  if (a.role !== 'admin' && a.role !== 'collaborator') throw new H.HttpError(403, 'Accès refusé.');
  await ca(() => team.requireScope(a, 'support'));
  return { reports: await ca(() => moderation.listerSignalements(str(ctx.url.searchParams.get('status'), 20) || 'open')) };
});
R.add('POST', '/api/admin/reports/:id/review', async ctx => {
  const a = requireCsrf(ctx); const b = await H.readJson(ctx.req);
  if (a.role !== 'admin' && a.role !== 'collaborator') throw new H.HttpError(403, 'Accès refusé.');
  await ca(() => team.requireScope(a, 'support'));
  const r = await ca(() => moderation.traiter(a.id, str(ctx.params.id, 20), str(b.status, 20), b.note));
  audit(a.id, 'report.review', str(ctx.params.id, 20), ctx.ip);
  return r;
});
/* ---------- Profil public d'hôte ----------
   Ce qu'un propriétaire veut bien dire de lui : prénom (déjà son nom de
   compte), présentation, langues, photo. Rien n'est obligatoire. */
R.add('GET', '/api/me/host', async ctx => {
  const u = requireUser(ctx);
  return {
    bio: u.host_bio || '',
    langues: String(u.host_languages || '').split(',').map(x => x.trim()).filter(Boolean),
    photo: u.host_photo || '',
    depuis: u.created_at,
  };
});
R.add('PUT', '/api/me/host', async ctx => {
  const u = requireCsrf(ctx);
  if (!['owner', 'admin', 'collaborator'].includes(u.role)) throw new H.HttpError(403, 'Réservé aux propriétaires.');
  await H.rateLimit('host:' + u.id, 30, 3600);
  const b = await H.readJson(ctx.req, 3000000);

  // La photo est PUBLIQUE : on la borne, et on refuse ce qui n'est pas une image.
  let photo = u.host_photo || '';
  if (b.photo !== undefined) {
    const p = str(b.photo, 2000000);
    if (p && !/^data:image\/(jpeg|png|webp);base64,/.test(p)) {
      throw new H.HttpError(400, 'Photo invalide : une image JPEG, PNG ou WebP est attendue.');
    }
    photo = p;
  }
  const bio = b.bio !== undefined ? str(b.bio, 800) : (u.host_bio || '');
  const langues = b.langues !== undefined
    ? (Array.isArray(b.langues) ? b.langues : String(b.langues || '').split(','))
        // Chaque langue est un mot, pas un texte : bornée, et la liste entière
        // aussi — elle ressort sur la fiche PUBLIQUE du logement.
        .map(x => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 10).join(', ').slice(0, 200)
    : (u.host_languages || '');

  await db.query(
    'UPDATE users SET host_bio = $2, host_languages = $3, host_photo = $4, updated_at = now() WHERE id = $1',
    [u.id, bio, langues, photo]);
  return { bio, langues: langues.split(',').map(x => x.trim()).filter(Boolean), photo, depuis: u.created_at };
});

/* ---------- Notes des activités et des services ----------
   Les étoiles s'affichent sur des listes entières : une requête par carte
   serait intenable. `/api/ratings` renvoie donc toutes les moyennes
   publiables en un seul aller-retour, logements compris. */
R.add('GET', '/api/ratings', async ctx => {
  await H.rateLimit('ratings-pub:' + ctx.ip, 120, 60);
  return await ca(() => rat.publicSummary());
});
R.add('GET', '/api/ratings/:kind/:id', async ctx => {
  // Lisible sans compte : la moyenne est publique. L'état « puis-je noter »
  // n'a de sens que connecté.
  const u = ctx.session || null;
  await H.rateLimit('rating-item:' + ctx.ip, 120, 60);
  return await ca(() => rat.itemRating(str(ctx.params.kind, 20), str(ctx.params.id, 40), u ? u.id : null));
});
R.add('POST', '/api/ratings/:kind/:id', async ctx => {
  const u = requireCsrf(ctx);
  await H.rateLimit('rate-item:' + u.id, 60, 3600);
  const b = await H.readJson(ctx.req);
  const r = await ca(() => rat.rateItem(str(ctx.params.kind, 20), str(ctx.params.id, 40), u.id, b.rating, b.comment));
  return { rating: r };
});

/* ---------- Assistant des voyageurs ----------
   Cherche dans le catalogue et, quand il ne suffit plus, transmet à l'équipe un
   résumé de la demande — pour que le collaborateur n'ait pas à tout refaire
   répéter au client. */
R.add('GET', '/api/assistant', async ctx => {
  requireUser(ctx);
  return { enabled: assistant.enabled() };
});
R.add('POST', '/api/assistant', async ctx => {
  const u = requireCsrf(ctx);
  // Un échange coûte un appel au modèle : on borne, par compte et par IP, par
  // jour, et pour tout le site — un compteur en base, pas en mémoire, pour
  // valoir sur toutes les instances et survivre aux redémarrages.
  await H.rateLimit('ia:' + u.id, 60, 3600);
  await H.rateLimit('ia-day:' + u.id, 200, 86400);
  await H.rateLimit('ia-ip:' + ctx.ip, 120, 3600);
  await H.rateLimit('ia:global:' + cat.isoToday(), Math.max(100, Number(process.env.ASSISTANT_DAILY_MAX) || 3000), 86400);
  const b = await H.readJson(ctx.req, 200000);
  const r = await ca(() => assistant.chat(u, b.messages));
  if (r.handoffConversationId) audit(u.id, 'assistant.handoff', r.handoffConversationId, ctx.ip);
  return r;
});

/* Note d'un échange, en cinq étoiles : service client, collaborateur,
   propriétaire. Complète l'avis de séjour, qui note le logement. */
R.add('GET', '/api/conversations/:id/rating', async ctx => {
  const u = requireUser(ctx);
  return await ca(() => msg.conversationRating(u.id, str(ctx.params.id, 40), new Date().toISOString()));
});
R.add('POST', '/api/conversations/:id/rating', async ctx => {
  const u = requireCsrf(ctx);
  await H.rateLimit('rate:' + u.id, 60, 3600);
  const b = await H.readJson(ctx.req);
  const r = await ca(() => msg.rateConversation(u.id, str(ctx.params.id, 40), b.rating, b.comment, new Date().toISOString()));
  return { rating: r };
});

/* Ce qui fait la différence : moyennes par part et par personne.
   Périmètre « Équipe » (ou administrateur) : c'est un outil de pilotage. */
R.add('GET', '/api/admin/ratings', async ctx => {
  const u = requireUser(ctx);
  await ca(() => team.requireScope(u, 'team'));
  await H.rateLimit('ratings:' + u.id, 60, 60);
  return await ca(() => msg.ratingsSummary());
});

R.add('POST', '/api/conversations/:id/messages', async ctx => {
  const u = requireCsrf(ctx); const b = await H.readJson(ctx.req);
  await H.rateLimit('msg:' + u.id, 60, 60);
  const m = await ca(() => msg.postMessage(u.id, str(ctx.params.id, 20), b.body));
  return { message: m };
});
// Ouvre (ou retrouve) la conversation d'une réservation : client ↔ propriétaire.
R.add('POST', '/api/bookings/:id/conversation', async ctx => {
  const u = requireCsrf(ctx);
  return { conversationId: await ca(() => msg.openForBooking(u.id, str(ctx.params.id, 20))) };
});
// Écrire à l'agence qui propose une expérience : l'une des deux voies pour
// commander, l'autre étant l'appel au numéro qu'elle a indiqué.
R.add('POST', '/api/activities/:id/conversation', async ctx => {
  const u = requireCsrf(ctx);
  await H.rateLimit('activiteconv:' + u.id, 20, 3600);
  return { conversationId: await ca(() => msg.openForActivity(u.id, str(ctx.params.id, 40))) };
});
// Écrire à celui qui assurera un service : l'autre voie étant son numéro,
// par téléphone ou par WhatsApp.
R.add('POST', '/api/services/:id/conversation', async ctx => {
  const u = requireCsrf(ctx);
  await H.rateLimit('serviceconv:' + u.id, 20, 3600);
  return { conversationId: await ca(() => msg.openForService(u.id, str(ctx.params.id, 40))) };
});
// Écrire au loueur d'un véhicule : l'autre voie étant l'appel à son numéro.
R.add('POST', '/api/vehicles/:id/conversation', async ctx => {
  const u = requireCsrf(ctx);
  await H.rateLimit('vehiculeconv:' + u.id, 20, 3600);
  return { conversationId: await ca(() => msg.openForVehicle(u.id, str(ctx.params.id, 40))) };
});
// Contacter le service client (collaborateurs désignés par l'admin).
R.add('POST', '/api/support/conversation', async ctx => {
  const u = requireCsrf(ctx); const b = await H.readJson(ctx.req);
  await H.rateLimit('support:' + u.id, 10, 3600);
  return { conversationId: await ca(() => msg.openSupport(u.id, b.subject)) };
});

/* ---------- Avis de séjour ---------- */
/* Avis publics d'un logement, et réponse de l'hôte.
   La lecture est ouverte à tous — c'est ce que vient lire un voyageur avant de
   réserver. La réponse est réservée à l'hôte du logement (ou à l'équipe). */
R.add('GET', '/api/listings/:id/reviews', async ctx => {
  await H.rateLimit('reviews:' + ctx.ip, 120, 60);
  await cat.refreshDb();
  // Connecté, le lecteur ne voit pas les avis des personnes qu'il a bloquées.
  return { reviews: await ca(() => msg.listingReviews(cat.internalId(str(ctx.params.id, 40)), 20, ctx.session ? ctx.session.id : null)) };
});
R.add('POST', '/api/reviews/:id/reply', async ctx => {
  const u = requireCsrf(ctx); const b = await H.readJson(ctx.req);
  const r = await ca(() => msg.replyToReview(u, str(ctx.params.id, 20), b.reply));
  audit(u.id, 'review.reply', r.id, ctx.ip);
  return { review: r };
});

R.add('GET', '/api/bookings/:id/reviews', async ctx => {
  const u = requireUser(ctx);
  return ca(() => msg.reviewsForBooking(u.id, str(ctx.params.id, 20), cat.isoToday()));
});
R.add('POST', '/api/bookings/:id/reviews', async ctx => {
  const u = requireCsrf(ctx); const b = await H.readJson(ctx.req);
  const r = await ca(() => msg.addReview(u.id, str(ctx.params.id, 20), b.rating, b.comment, cat.isoToday()));
  audit(u.id, 'review.add', str(ctx.params.id, 20), ctx.ip);
  return { review: r };
});
R.add('GET', '/api/listings/:id/rating', async ctx => { await H.rateLimit('rating:' + ctx.ip, 120, 60); await cat.refreshDb(); return msg.listingRating(cat.internalId(str(ctx.params.id, 40))); });
/* Réputation publique : la note du logement, et celle de l'hôte quand elle
   repose sur assez d'avis pour vouloir dire quelque chose. */
R.add('GET', '/api/listings/:id/reputation', async ctx => { await H.rateLimit('rating:' + ctx.ip, 120, 60); await cat.refreshDb(); return msg.listingReputation(cat.internalId(str(ctx.params.id, 40))); });

/* ---------- Service client : qui tient le guichet ----------
   Le périmètre « Service client » ouvre l'administration de ce guichet, comme
   « Équipe » ouvre la répartition des tâches. Sans cela le périmètre était
   délégable mais n'ouvrait rien : seul l'admin pouvait désigner un agent.
   Conséquence assumée : un collaborateur porteur de ce périmètre peut se
   désigner lui-même, donc lire les conversations de support — c'est
   précisément le métier qu'on lui confie. */
R.add('GET', '/api/admin/support-agents', async ctx => {
  const u = requireUser(ctx);
  if (u.role !== 'admin' && u.role !== 'collaborator') throw new H.HttpError(403, 'Accès refusé.');
  await ca(() => team.requireScope(u, 'support'));
  return { agents: await msg.listSupportAgents() };
});
/* Candidats au guichet : les collaborateurs, rien de plus. Évite d'ouvrir
   l'annuaire complet des comptes à qui tient seulement le service client. */
R.add('GET', '/api/admin/support-agents/candidates', async ctx => {
  const u = requireUser(ctx);
  if (u.role !== 'admin' && u.role !== 'collaborator') throw new H.HttpError(403, 'Accès refusé.');
  await ca(() => team.requireScope(u, 'support'));
  // Nom et identifiant suffisent pour désigner quelqu'un : l'adresse e-mail de
  // tous les collaborateurs n'a pas à sortir pour qui tient seulement le guichet.
  const r = await db.query("SELECT id, name FROM users WHERE role = 'collaborator' AND deleted_at IS NULL AND status <> 'suspendu' ORDER BY name");
  return { candidates: r.rows };
});
R.add('POST', '/api/admin/support-agents', async ctx => {
  const a = requireCsrf(ctx);
  if (a.role !== 'admin' && a.role !== 'collaborator') throw new H.HttpError(403, 'Accès refusé.');
  await ca(() => team.requireScope(a, 'support'));
  const b = await H.readJson(ctx.req);
  // Se mettre soi-même au guichet est un acte ordinaire du périmètre « support ».
  // Y mettre QUELQU'UN D'AUTRE, c'est lui ouvrir tous les fils de support passés
  // et futurs : réservé à l'admin et aux chefs d'équipe, comme le retrait.
  if (str(b.userId, 40) !== a.id && !team.canDesignateLead(a)) throw new H.HttpError(403, 'Seul un administrateur ou un chef d’équipe peut désigner un autre agent.');
  const agents = await ca(() => msg.assignSupportAgent(a, str(b.userId, 40)));
  audit(a.id, 'support.assign', str(b.userId, 40), ctx.ip);
  return { agents };
});
R.add('POST', '/api/admin/support-agents/:id/remove', async ctx => {
  const a = requireCsrf(ctx);
  if (a.role !== 'admin' && a.role !== 'collaborator') throw new H.HttpError(403, 'Accès refusé.');
  await ca(() => team.requireScope(a, 'support'));
  // Désigner est réversible ; retirer peut vider le guichet et rendre le service
  // client injoignable. On le réserve donc à l'admin ou à un chef d'équipe.
  if (!team.canDesignateLead(a)) throw new H.HttpError(403, 'Seul un administrateur ou un chef d’équipe peut retirer un agent.');
  const agents = await ca(() => msg.removeSupportAgent(str(ctx.params.id, 40)));
  audit(a.id, 'support.remove', str(ctx.params.id, 40), ctx.ip);
  return { agents };
});

/* Recherche d'un membre par nom : SECOURS du scan, quand le client n'a pas son QR sous
   la main. Volontairement restreint (agence/admin, 3 caractères minimum, 8 résultats,
   débit limité) et ne renvoie que le prénom/nom et le n° de carte — jamais d'e-mail,
   de téléphone ni d'identifiant interne : une agence ne doit pas pouvoir recenser les membres. */
/* Révoquer la carte d'un membre : carte perdue, puce volée, jeton divulgué.
   Incrémenter la version invalide instantanément l'ancien QR et l'ancienne
   puce de CE membre, sans toucher aux cartes des autres. */
R.add('POST', '/api/admin/members/:memberNo/revoke-card', async ctx => {
  const a = requireCsrf(ctx);
  if (a.role !== 'admin') throw new H.HttpError(403, 'Accès refusé.');
  await H.rateLimit('revoke:' + a.id, 30, 3600);
  const no = str(ctx.params.memberNo, 10);
  if (!/^\d{6}$/.test(no)) throw new H.HttpError(400, 'Numéro de membre invalide.');
  const r = await db.one(
    "UPDATE users SET card_version = card_version + 1, updated_at = now() WHERE member_no = $1 AND deleted_at IS NULL AND role = 'client' RETURNING member_no, name, card_version",
    [Number(no)]);
  if (!r) throw new H.HttpError(404, 'Membre introuvable.');
  audit(a.id, 'card.revoke', String(r.member_no), ctx.ip);
  return { memberNo: String(r.member_no), name: r.name, cardVersion: r.card_version };
});



R.add('GET', '/api/agency/members', async ctx => {
  const a = requireUser(ctx);
  // Agences, et collaborateurs à qui le périmètre « Expériences » a été confié.
  if (a.role !== 'agency') await ca(() => team.requireGate(a, 'activities'));
  if (a.role !== 'agency' && a.role !== 'admin' && a.role !== 'collaborator') throw new H.HttpError(403, 'Accès refusé.');
  // Un secours se compte en dizaines par heure, pas en milliers : au-delà, c'est
  // un balayage. Et l'on cherche un DÉBUT de nom ou de prénom, pas trois lettres
  // au milieu — « ara » ne doit pas livrer tous les Sara, Farah et Karim.
  await H.rateLimit('members:' + a.id, 120, 3600);
  const q = str(ctx.url.searchParams.get('q'), 60);
  if (q.length < 3) throw new H.HttpError(400, 'Saisissez au moins 3 caractères.');
  const motif = q.replace(/[%_\\]/g, '');
  const r = await db.query(
    "SELECT name, member_no FROM users WHERE deleted_at IS NULL AND status <> 'suspendu' AND role = 'client' AND (name ILIKE $1 OR name ILIKE $2) ORDER BY name LIMIT 8",
    [motif + '%', '% ' + motif + '%']);
  audit(a.id, 'member.search', q, ctx.ip);
  return { members: r.rows.map(u => ({ name: u.name, memberNo: String(u.member_no) })) };
});
R.add('POST', '/api/agency/redeem', async ctx => {
  const a = requireCsrf(ctx);
  if (a.role !== 'agency') await ca(() => team.requireGate(a, 'activities'));
  if (a.role !== 'agency' && a.role !== 'admin' && a.role !== 'collaborator') throw new H.HttpError(403, 'Accès refusé.');
  await H.rateLimit('redeem:' + a.id, 120, 60);
  const b = await H.readJson(ctx.req);
  // Deux entrées possibles : le QR de la carte (preuve forte) ou un n° de carte trouvé
  // par recherche de nom (secours en agence, tracé séparément dans le journal).
  let client = null, manual = false;
  const m = /^DOUIRA\|M\|(\d{6})\|([A-Z0-9]{16})$/.exec(str(b.code, 60));
  if (m) {
    client = await db.one('SELECT * FROM users WHERE member_no = $1 AND deleted_at IS NULL', [Number(m[1])]);
    if (!client || !sec.safeEqual(sec.memberToken(client.id, client.member_no, client.card_version), m[2])) throw new H.HttpError(400, 'Carte inconnue ou invalide.');
  } else if (/^\d{6}$/.test(str(b.memberNo, 10))) {
    manual = true;
    client = await db.one("SELECT * FROM users WHERE member_no = $1 AND deleted_at IS NULL AND role = 'client'", [Number(str(b.memberNo, 10))]);
    if (!client) throw new H.HttpError(404, 'Membre introuvable.');
  } else {
    throw new H.HttpError(400, 'Carte inconnue ou invalide.');
  }
  if (client.status === 'suspendu') throw new H.HttpError(403, 'Ce compte membre est suspendu.');
  const act = await db.one('SELECT * FROM activities WHERE id = $1', [str(b.activityId, 40)]);
  if (!act) throw new H.HttpError(404, 'Activité introuvable.');
  if (a.role === 'agency' && act.agency_id !== a.id) throw new H.HttpError(403, 'Cette activité ne vous appartient pas.');
  const dup = await db.one('SELECT id FROM activity_redemptions WHERE activity_id = $1 AND client_id = $2 AND at::date = now()::date LIMIT 1', [act.id, client.id]);
  const pct = Number(act.discount_pct || 0);
  if (!dup) { await db.query('INSERT INTO activity_redemptions (activity_id, agency_id, client_id, pct) VALUES ($1, $2, $3, $4)', [act.id, a.id, client.id, pct]); audit(a.id, manual ? 'activity.redeem.manual' : 'activity.redeem', act.id + ':' + client.id, ctx.ip); }
  return { client: { name: client.name, memberNo: String(client.member_no) }, activity: { id: act.id, name: act.name }, pct, alreadyToday: !!dup, manual };
});
/* Relecture de ce qui est déjà enregistré, pour pouvoir le corriger. Mêmes
   droits que l'écriture. */
R.add('GET', '/api/admin/listings/:id/access', async ctx => {
  const a = requireUser(ctx);
  if (!['admin', 'collaborator', 'owner'].includes(a.role)) throw new H.HttpError(403, 'Accès refusé.');
  await ca(() => team.requireGate(a, 'listings'));
  const lid = str(ctx.params.id, 40);
  if (a.role === 'owner') {
    const own = await db.one('SELECT owner_id FROM listings WHERE id = $1', [lid]);
    if (!own) throw new H.HttpError(404, 'Bien introuvable.');
    if (own.owner_id !== a.id) throw new H.HttpError(403, 'Ce bien ne vous appartient pas.');
  }
  const r = await db.one('SELECT * FROM listing_access WHERE listing_id = $1', [lid]);
  const clear = v => { try { return v ? sec.decrypt(v) : ''; } catch (e) { return ''; } };
  return { access: { address: clear(r && r.address_enc), code: clear(r && r.code_enc), notes: clear(r && r.notes_enc) } };
});

/* Adresse exacte et code d'entrée. Mêmes droits que le reste du catalogue :
   l'admin, le collaborateur porteur du périmètre « Logements », et le
   propriétaire POUR SES PROPRES BIENS. Sans cela, personne hors admin ne
   pouvait renseigner le code, et le client n'en recevait jamais. */
R.add('PUT', '/api/admin/listings/:id/access', async ctx => {
  const a = requireCsrf(ctx);
  if (!['admin', 'collaborator', 'owner'].includes(a.role)) throw new H.HttpError(403, 'Accès refusé.');
  await ca(() => team.requireGate(a, 'listings'));
  const lid = str(ctx.params.id, 40);
  if (a.role === 'owner') {
    const own = await db.one('SELECT owner_id FROM listings WHERE id = $1', [lid]);
    if (!own) throw new H.HttpError(404, 'Bien introuvable.');
    if (own.owner_id !== a.id) throw new H.HttpError(403, 'Ce bien ne vous appartient pas.');
  }
  const b = await H.readJson(ctx.req); await db.query('INSERT INTO listing_access (listing_id, address_enc, code_enc, notes_enc) VALUES ($1, $2, $3, $4) ON CONFLICT (listing_id) DO UPDATE SET address_enc = EXCLUDED.address_enc, code_enc = EXCLUDED.code_enc, notes_enc = EXCLUDED.notes_enc, updated_at = now()', [lid, sec.encrypt(str(b.address, 300)), sec.encrypt(str(b.code, 40)), sec.encrypt(str(b.notes, 500))]); audit(a.id, 'access.set', lid, ctx.ip); return { ok: true }; });

/* Réglages e-mail (Administration > E-mails) : SMTP ou Resend, secrets chiffrés, jamais renvoyés */
/* ---------- Administration du catalogue (biens : admin/collaborateur/propriétaire ; activités : admin/agence) ---------- */
// Les droits par rôle (et « son propre bien / sa propre activité » pour propriétaire/agence) sont appliqués dans lib/catalog_admin.
R.add('GET', '/api/admin/catalog/listings', async ctx => { requireUser(ctx); return { listings: await ca(() => cadmin.listListings(ctx.session)) }; });
R.add('POST', '/api/admin/catalog/listings', async ctx => { const u = requireCsrf(ctx); const body = await H.readJson(ctx.req); const l = await ca(() => cadmin.saveListing(u, body)); audit(u.id, 'listing.save', l.id, ctx.ip); cat.refreshDb(true).catch(() => {}); return { listing: l }; });
R.add('POST', '/api/admin/catalog/listings/:id/publish', async ctx => { const u = requireCsrf(ctx); const b = await H.readJson(ctx.req); const l = await ca(() => cadmin.publishListing(u, str(ctx.params.id, 40), !!b.publish)); audit(u.id, b.publish ? 'listing.publish' : 'listing.unpublish', l.id, ctx.ip); cat.refreshDb(true).catch(() => {}); return { listing: l }; });
R.add('GET', '/api/admin/catalog/activities', async ctx => { requireUser(ctx); return { activities: await ca(() => cadmin.listActivities(ctx.session)) }; });
R.add('POST', '/api/admin/catalog/activities', async ctx => { const u = requireCsrf(ctx); const body = await H.readJson(ctx.req); const a = await ca(() => cadmin.saveActivity(u, body)); audit(u.id, 'activity.save', a.id, ctx.ip); cat.refreshDb(true).catch(() => {}); return { activity: a }; });
R.add('POST', '/api/admin/catalog/activities/:id/publish', async ctx => { const u = requireCsrf(ctx); const b = await H.readJson(ctx.req); const a = await ca(() => cadmin.publishActivity(u, str(ctx.params.id, 40), !!b.publish)); audit(u.id, b.publish ? 'activity.publish' : 'activity.unpublish', a.id, ctx.ip); cat.refreshDb(true).catch(() => {}); return { activity: a }; });

/* ---------- Administration des comptes (admin uniquement) : créer/inviter propriétaires, collaborateurs, agences ---------- */
// Construit le lien d'invitation et envoie l'e-mail si la messagerie est configurée ; renvoie toujours le lien à l'admin.
async function inviteResult(ctx, out, kind) {
  const link = `${siteUrl(ctx.req)}/#reinitialiser~${out.token}`;
  let emailed = false;
  try {
    const r = await mail.send({ to: out.user.email, subject: `${cat.siteName()} · votre accès`, text: `Bonjour ${out.user.name},\n\nUn accès ${cat.siteName()} a été créé pour vous (${ROLE_LABEL[out.user.role] || out.user.role}). Choisissez votre mot de passe (lien valable ${uadmin.INVITE_DAYS} jours) :\n${link}\n\nÀ bientôt,\n${cat.siteName()}` });
    emailed = !!(r && r.sent);
  } catch (e) { /* messagerie non configurée : l'admin transmet le lien manuellement */ }
  return { user: out.user, inviteUrl: link, emailed };
}
R.add('GET', '/api/admin/users', async ctx => { requireUser(ctx, 'admin'); return { users: await ca(() => uadmin.listUsers(ctx.session)) }; });
R.add('POST', '/api/admin/users', async ctx => { const a = requireCsrf(ctx); if (a.role !== 'admin') throw new H.HttpError(403, 'Accès refusé.'); const body = await H.readJson(ctx.req); const out = await ca(() => uadmin.createUser(a, body)); audit(a.id, 'user.create', out.user.id, ctx.ip); return inviteResult(ctx, out); });
R.add('POST', '/api/admin/users/:id/invite', async ctx => { const a = requireCsrf(ctx); if (a.role !== 'admin') throw new H.HttpError(403, 'Accès refusé.'); const out = await ca(() => uadmin.reinvite(a, str(ctx.params.id, 40))); audit(a.id, 'user.reinvite', out.user.id, ctx.ip); return inviteResult(ctx, out); });
R.add('POST', '/api/admin/users/:id/status', async ctx => { const a = requireCsrf(ctx); if (a.role !== 'admin') throw new H.HttpError(403, 'Accès refusé.'); const b = await H.readJson(ctx.req); const u = await ca(() => uadmin.setStatus(a, str(ctx.params.id, 40), str(b.status, 20))); audit(a.id, 'user.status', ctx.params.id + ':' + u.status, ctx.ip); return { user: u }; });
R.add('POST', '/api/admin/users/:id/role', async ctx => { const a = requireCsrf(ctx); if (a.role !== 'admin') throw new H.HttpError(403, 'Accès refusé.'); const b = await H.readJson(ctx.req); const u = await ca(() => uadmin.setRole(a, str(ctx.params.id, 40), str(b.role, 20))); audit(a.id, 'user.role', ctx.params.id + ':' + u.role, ctx.ip); return { user: u }; });

R.add('GET', '/api/admin/settings/mail', async ctx => { requireUser(ctx, 'admin'); return { mail: mail.publicView(await mail.config()) }; });
R.add('PUT', '/api/admin/settings/mail', async ctx => {
  const a = requireCsrf(ctx); if (a.role !== 'admin') throw new H.HttpError(403, 'Accès refusé.');
  const b = await H.readJson(ctx.req); const cur = (await mail.config()) || {}; const sm = b.smtp || {};
  const provider = ['smtp', 'resend', 'none'].includes(b.provider) ? b.provider : 'none';
  const from = str(b.from, 120), adminEmail = str(b.adminEmail, 254).toLowerCase();
  if (adminEmail && !EMAIL.test(adminEmail)) throw new H.HttpError(400, 'Adresse des alertes invalide.');
  if (provider !== 'none' && !/<?[^\s@]+@[^\s@]+\.[^\s@>]+>?$/.test(from)) throw new H.HttpError(400, 'Indiquez l\'adresse d\'expédition, par exemple « Douira <reservations@votre-domaine.ma> ».');
  const next = { provider, from, adminEmail,
    smtp: { host: str(sm.host, 200), port: Math.min(65535, Math.max(1, Number(sm.port) || 587)), secure: !!sm.secure, user: str(sm.user, 200), passwordEnc: typeof sm.password === 'string' && sm.password !== '' ? sec.encrypt(sm.password) : ((cur.smtp || {}).passwordEnc || '') },
    resendKeyEnc: typeof b.resendKey === 'string' && b.resendKey !== '' ? sec.encrypt(b.resendKey) : (cur.resendKeyEnc || '') };
  if (provider === 'smtp' && !next.smtp.host) throw new H.HttpError(400, 'Indiquez le serveur SMTP.');
  if (provider === 'resend' && !next.resendKeyEnc) throw new H.HttpError(400, 'Indiquez la clé API Resend.');
  await db.query("INSERT INTO settings (key, value, updated_by) VALUES ('mail', $1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by", [next, a.id]);
  mail.invalidate(); audit(a.id, 'settings.mail', provider, ctx.ip);
  return { mail: mail.publicView(next) };
});
R.add('POST', '/api/admin/settings/mail/test', async ctx => { const a = requireCsrf(ctx); if (a.role !== 'admin') throw new H.HttpError(403, 'Accès refusé.'); await H.rateLimit('mailtest:' + a.id, 5, 600); const r = await mail.send({ to: a.email, subject: `${cat.siteName()} · e-mail de test`, text: `Bonjour ${a.name},\n\nCe message confirme que l'envoi d'e-mails de ${cat.siteName()} fonctionne.` }); if (!r.sent) throw new H.HttpError(502, 'Envoi impossible : ' + (r.reason || 'vérifiez les réglages')); return { ok: true, provider: r.provider }; });

/* ---------- Point d'entrée : (req, res) → true si la requête a été traitée ---------- */
/* Compte administrateur principal : créé au premier démarrage s'il n'existe aucun administrateur.
   Identifiant ADMIN_EMAIL (obligatoire ; repli neutre admin@local.test hors production), mot de passe initial
   ADMIN_INITIAL_PASSWORD (défaut hors production : admin123) stocké haché (scrypt) et à changer obligatoirement
   à la première connexion. En production, pas de défaut : sans ADMIN_EMAIL ni ADMIN_INITIAL_PASSWORD solide, aucun compte n'est créé. */
async function seedAdmin() {
  const exists = await db.one("SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL LIMIT 1"); if (exists) return;
  // Les défauts de développement (admin@local.test / admin123) ne valent que
  // pour une base LOCALE. Une base distante est une vraie base, quel que soit
  // NODE_ENV : un poste de développement branché dessus sans la variable y
  // créerait un administrateur au mot de passe connu de tous.
  const baseLocale = /@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(process.env.DATABASE_URL || '');
  if (process.env.NODE_ENV === 'production' || !baseLocale) {
    const p = process.env.ADMIN_INITIAL_PASSWORD ? sec.passwordProblem(process.env.ADMIN_INITIAL_PASSWORD) : 'ADMIN_INITIAL_PASSWORD absente.';
    if (p) { console.error(`Administrateur non créé : ${p} Définissez ADMIN_INITIAL_PASSWORD (10 caractères min.) puis redémarrez.`); return; }
  }
  const email = String(process.env.ADMIN_EMAIL || (process.env.NODE_ENV === 'production' || !baseLocale ? '' : 'admin@local.test')).toLowerCase().trim();
  if (!email) { console.error('Administrateur non créé : ADMIN_EMAIL absente. Définissez ADMIN_EMAIL (adresse de l\'administrateur principal) puis redémarrez.'); return; }
  const pw = process.env.ADMIN_INITIAL_PASSWORD || 'admin123';
  // DO NOTHING, et non DO UPDATE : sinon un redémarrage sans administrateur
  // réécrivait le mot de passe du compte portant cette adresse et annulait sa
  // suppression. Qui connaît ADMIN_INITIAL_PASSWORD reprenait la main.
  // Le nom porté par ce compte : celui qui paraît sur son badge d'équipe et en
  // tête de ses messages. « Administrateur » tant que personne n'a dit qui
  // c'est — on n'invente pas un nom de personne.
  const nom = String(process.env.ADMIN_NAME || '').trim().slice(0, 120) || 'Administrateur';
  const r = await db.query("INSERT INTO users (email, name, role, pass_hash, consent_at, must_change_password) VALUES ($1, $2, 'admin', $3, now(), true) ON CONFLICT (email) DO NOTHING RETURNING id", [email, nom, sec.hashPassword(pw)]);
  if (r.rows.length) {
    console.warn(`Administrateur créé : ${email} avec le mot de passe initial — à changer dès la première connexion (obligatoire).`);
  } else {
    console.error(`Administrateur NON créé : un compte existe déjà avec ${email}, mais il n'est pas administrateur (ou il est supprimé). Promouvez-le en base, ou définissez une autre ADMIN_EMAIL.`);
  }
}
let startPromise = null;
function start() {
  if (startPromise) return startPromise;
  startPromise = (async () => {
  db.init(process.env.DATABASE_URL); await db.migrate();
  if (!process.env.DATA_KEY) console.error('DATA_KEY absente : adresses et codes d\'accès indisponibles.');
  // Sans elle, les liens de réinitialisation et d'invitation ne peuvent pas être
  // fabriqués sans faire confiance à l'en-tête Host — ce qu'on refuse.
  if (process.env.NODE_ENV === 'production' && !process.env.SITE_URL) {
    console.error('SITE_URL absente : réinitialisation de mot de passe et invitations indisponibles. Définissez SITE_URL puis redémarrez.');
  }
  await seedAdmin();
  await cat.refreshDb(true).catch(() => {}); // amorce le catalogue depuis la base (repli config.js si vide)
  await pay.refresh().catch(() => {});       // comptes d'encaissement réglés depuis l'administration
  await dest.refresh().catch(() => {});      // destinations ouvertes (pays → villes)
  console.log(`API : base connectée (${db.usingOfficialDriver ? 'pilote pg' : 'client intégré'}), catalogue : ${cat.usingDb() ? 'base' : 'config.js'}, paiement : ${(() => { try { return psp().name; } catch (e) { return 'non configuré'; } })()}`);
  setInterval(() => H.housekeeping().catch(() => {}), 10 * 60000).unref();
  setInterval(() => cat.refreshDb(true).catch(() => {}), 60000).unref(); // rafraîchit le catalogue en base
  })();
  return startPromise;
}
async function handle(req, res) {
  const url = new URL(req.url, 'http://x'); if (!url.pathname.startsWith('/api/')) return false;
  try { await start(); } catch (e) { H.json(res, 503, { error: 'Service indisponible (base de données).' }); return true; } // attend la fin des migrations
  const m = R.match(req.method, url.pathname);
  if (!m) { H.json(res, 404, { error: 'Introuvable.' }); return true; }
  const ctx = { req, res, url, params: m.params, ip: H.clientIp(req), session: null };
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !m.route.opts.noCsrf) checkOrigin(req);
    ctx.session = await currentSession(req);
    // Mot de passe initial non changé : tout est bloqué sauf le changement, la déconnexion et la lecture du profil
    if (ctx.session && ctx.session.must_change_password && !['/api/me', '/api/auth/password', '/api/auth/logout'].includes(url.pathname)) throw new H.HttpError(403, 'Changez votre mot de passe initial pour continuer.', { mustChangePassword: true });
    const out = await m.route.handler(ctx);
    if (!res.headersSent && out !== undefined) H.json(res, 200, out);
  } catch (e) {
    if (e instanceof H.HttpError) H.json(res, e.status, Object.assign({ error: e.message }, e.extra || {}));
    // Filet pour les erreurs métier qui n'ont pas traversé ca() : les modules
    // posent un `status` numérique et un message destiné à l'utilisateur. Sans
    // ce filet, un « La facture est établie une fois le paiement confirmé »
    // arrivait au client en « Erreur du serveur », et le vrai motif ne sortait
    // que dans les journaux — où il se confondait avec les vraies pannes.
    else if (e && typeof e.status === 'number' && e.status >= 400 && e.status < 600 && typeof e.message === 'string') {
      H.json(res, e.status, { error: e.message });
    }
    else { console.error(`API ${req.method} ${url.pathname} :`, e.message); if (!res.headersSent) H.json(res, 500, { error: 'Erreur du serveur.' }); }
  }
  return true;
}
module.exports = { start, handle, _internals: { applyPaymentEvent, createSession, bookingRef } };
