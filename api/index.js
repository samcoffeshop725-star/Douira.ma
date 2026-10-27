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
const mail = require('./lib/mail');
const H = require('./lib/http');
const PSPS = { stripe: require('./psp/stripe'), cmi: require('./psp/cmi'), simulate: require('./psp/simulate') };

const SESSION_COOKIE = 'douira_s';
const sessionTtlH = role => role === 'admin' ? Math.max(1, Number(process.env.ADMIN_SESSION_HOURS) || 8) : Math.max(1, Number(process.env.SESSION_HOURS) || 24 * 14);
const HOLD_MIN = Math.max(10, Number(process.env.HOLD_MINUTES) || 30);
const siteUrl = req => (process.env.SITE_URL || '').replace(/\/$/, '') || `${H.isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
const psp = () => { const name = process.env.PSP || (PSPS.stripe.enabled() ? 'stripe' : PSPS.cmi.enabled() ? 'cmi' : 'simulate'); const p = PSPS[name]; if (!p || !p.enabled()) throw new H.HttpError(503, 'Paiement en ligne indisponible pour le moment.'); return p; };
const audit = (actor, action, target, ip) => db.query('INSERT INTO audit (actor, action, target, ip) VALUES ($1, $2, $3, $4)', [actor || null, action, String(target || '').slice(0, 120), ip || '']).catch(e => console.error('audit', e.message));
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, memberNo: u.member_no, createdAt: u.created_at, mustChangePassword: !!u.must_change_password });
const str = (v, max) => (typeof v === 'string' ? v : '').trim().slice(0, max);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/* ---------- Sessions ---------- */
async function createSession(res, req, user) {
  const tok = sec.token(32), csrf = sec.token(24), ttl = sessionTtlH(user.role);
  await db.query('INSERT INTO sessions (id, user_id, csrf, expires_at, ip, ua) VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5, $6)', [sec.sha256(tok), user.id, csrf, ttl, H.clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200)]);
  H.setCookie(res, SESSION_COOKIE, tok, { secure: H.isHttps(req) || process.env.NODE_ENV === 'production', maxAge: ttl * 3600 });
  return csrf;
}
async function currentSession(req) {
  const tok = H.cookies(req)[SESSION_COOKIE]; if (!tok) return null;
  const s = await db.one('SELECT s.id AS session_id, s.csrf, s.expires_at, s.last_seen, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.expires_at > now() AND u.deleted_at IS NULL', [sec.sha256(tok)]);
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
  const l = cat.listing(str(body.listingId, 40)); const start = str(body.start, 10), end = str(body.end, 10), guests = Number(body.guests);
  const problem = cat.validate(l, start, end, guests); if (problem) throw new H.HttpError(400, problem);
  const q = cat.quote(l, start, end, guests); const amount = Math.round(q.total * 100);
  const booking = await db.tx(async t => {
    await t.query('SELECT pg_advisory_xact_lock(hashtext($1))', [l.id]); // sérialise les réservations d'un même bien
    const clash = await t.one("SELECT id FROM bookings WHERE listing_id = $1 AND start_date < $3 AND end_date > $2 AND (status = 'confirmed' OR (status = 'pending_payment' AND hold_until > now())) LIMIT 1", [l.id, start, end]);
    if (clash) throw new H.HttpError(409, 'Ces dates ne sont plus disponibles.');
    for (let i = 0; i < 5; i++) {
      const id = bookingRef();
      const r = await t.one('INSERT INTO bookings (id, user_id, listing_id, start_date, end_date, guests, status, quote, amount, currency, hold_until, psp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(mins => $11), $12) ON CONFLICT (id) DO NOTHING RETURNING *', [id, user.id, l.id, start, end, guests, 'pending_payment', q, amount, q.currency, HOLD_MIN, psp().name]);
      if (r) return r;
    }
    throw new H.HttpError(500, 'Référence indisponible, réessayez.');
  });
  audit(user.id, 'booking.create', booking.id, ctx.ip);
  const label = `${cat.siteName()} · ${l.title} · ${cat.nights(start, end)} nuit(s) · ${booking.id}`;
  try {
    const co = await psp().createCheckout({ booking, user, siteUrl: siteUrl(ctx.req), apiUrl: siteUrl(ctx.req), label });
    await db.query('UPDATE bookings SET psp_ref = $2, pay_url = $3, updated_at = now() WHERE id = $1', [booking.id, co.ref, co.url]);
    return { booking: bookingView(booking), url: co.url };
  } catch (e) {
    await db.query("UPDATE bookings SET status = 'failed', updated_at = now() WHERE id = $1", [booking.id]);
    console.error('Paiement : création impossible', e.message); throw e instanceof H.HttpError ? e : new H.HttpError(502, 'Paiement indisponible, réessayez dans quelques minutes.');
  }
}
/* Application idempotente d'un événement de paiement (webhook signé, callback vérifié ou simulation) */
async function applyPaymentEvent(pspName, ev, eventId) {
  if (!ev.kind || !ev.bookingId) return { ignored: true };
  return db.tx(async t => {
    const seen = await t.one('INSERT INTO payment_events (id, booking_id, type) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING id', [eventId, ev.bookingId, ev.kind]);
    if (!seen) return { duplicate: true };
    const b = await t.one('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [ev.bookingId]); if (!b) return { unknown: true };
    if (ev.kind === 'paid') {
      if (b.status === 'confirmed') return { already: true };
      if (ev.amount && ev.amount !== b.amount) { console.error(`Paiement ${b.id} : montant reçu ${ev.amount} ≠ attendu ${b.amount}`); await t.query("UPDATE bookings SET status = 'failed', psp_ref = $2, updated_at = now() WHERE id = $1", [b.id, ev.ref || b.psp_ref]); return { mismatch: true }; }
      await t.query("UPDATE bookings SET status = 'confirmed', paid_at = now(), psp = $2, psp_ref = $3, updated_at = now() WHERE id = $1", [b.id, pspName, ev.ref || b.psp_ref]);
      return { confirmed: true, booking: Object.assign(b, { status: 'confirmed' }) };
    }
    if ((ev.kind === 'failed' || ev.kind === 'expired') && b.status === 'pending_payment') { await t.query('UPDATE bookings SET status = $2, updated_at = now() WHERE id = $1', [b.id, ev.kind]); return { [ev.kind]: true }; }
    if (ev.kind === 'refunded') { await t.query('UPDATE bookings SET refund_amount = GREATEST(refund_amount, $2), updated_at = now() WHERE id = $1', [b.id, ev.amount || 0]); return { refunded: true }; }
    return { noop: true };
  });
}
async function notifyConfirmed(booking) {
  const u = await db.one('SELECT * FROM users WHERE id = $1', [booking.user_id]); const l = cat.listing(booking.listing_id) || { title: booking.listing_id };
  const site = process.env.SITE_URL || '';
  const text = `Bonjour ${u.name},\n\nVotre réservation ${booking.id} est confirmée : ${l.title}, du ${booking.start_date} au ${booking.end_date}, ${booking.guests} voyageur(s), ${(booking.amount / 100).toFixed(0)} ${booking.currency}.\n\nL'adresse exacte et le code d'accès apparaîtront dans votre espace (« Mes réservations ») la veille de votre arrivée : ${site}/#espace-c_booking~${booking.id}\n\n${cat.siteName()}`;
  await mail.send({ to: u.email, subject: `Réservation confirmée · ${booking.id}`, text });
  const adm = await mail.adminEmail(); if (adm) await mail.send({ to: adm, subject: `[${cat.siteName()}] Nouvelle réservation ${booking.id}`, text: `${l.title} · ${booking.start_date} → ${booking.end_date} · ${booking.guests} pers. · ${(booking.amount / 100).toFixed(0)} ${booking.currency} · client ${u.name} (${u.email}${u.phone ? ', ' + u.phone : ''}).` });
}

/* ---------- Routes ---------- */
const R = new H.Router();
R.add('GET', '/api/health', async () => ({ ok: true, psp: (() => { try { return psp().name; } catch (e) { return null; } })(), time: new Date().toISOString() }));
R.add('GET', '/api/me', async ctx => ctx.session ? { user: publicUser(ctx.session), csrf: ctx.session.csrf } : { user: null });

R.add('POST', '/api/auth/register', async ctx => {
  const b = await H.readJson(ctx.req); await H.rateLimit('register:' + ctx.ip, 10, 3600);
  const name = str(b.name, 80), email = str(b.email, 254).toLowerCase(), phone = str(b.phone, 30), pw = b.password;
  if (name.length < 2) throw new H.HttpError(400, 'Indiquez votre nom.');
  if (!EMAIL.test(email)) throw new H.HttpError(400, 'Adresse e-mail invalide.');
  if (b.consent !== true) throw new H.HttpError(400, 'Acceptez les conditions et la politique de confidentialité.');
  const pp = sec.passwordProblem(pw); if (pp) throw new H.HttpError(400, pp);
  const exists = await db.one('SELECT id FROM users WHERE email = $1', [email]);
  if (exists) throw new H.HttpError(409, 'Un compte existe déjà avec cette adresse. Connectez-vous ou réinitialisez votre mot de passe.');
  const u = await db.one('INSERT INTO users (email, name, phone, pass_hash, consent_at) VALUES ($1, $2, $3, $4, now()) RETURNING *', [email, name, phone, sec.hashPassword(pw)]);
  const csrf = await createSession(ctx.res, ctx.req, u); audit(u.id, 'user.register', '', ctx.ip);
  return { user: publicUser(u), csrf };
});
R.add('POST', '/api/auth/login', async ctx => {
  const b = await H.readJson(ctx.req); const email = str(b.email, 254).toLowerCase();
  await H.rateLimit('login:ip:' + ctx.ip, 20, 900); await H.rateLimit('login:email:' + sec.sha256(email).slice(0, 24), 5, 900);
  const u = await db.one('SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
  const ok = u ? sec.verifyPassword(b.password, u.pass_hash) : (sec.verifyPassword('x', 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='), false); // temps constant
  if (!ok) { audit(null, 'login.fail', '', ctx.ip); throw new H.HttpError(401, 'E-mail ou mot de passe incorrect.'); }
  const csrf = await createSession(ctx.res, ctx.req, u); audit(u.id, 'login', '', ctx.ip);
  return { user: publicUser(u), csrf };
});
R.add('POST', '/api/auth/logout', async ctx => { if (ctx.session) audit(ctx.session.id, 'logout', '', ctx.ip); await destroySession(ctx.req, ctx.res); return { ok: true }; });
R.add('POST', '/api/auth/forgot', async ctx => {
  const b = await H.readJson(ctx.req); const email = str(b.email, 254).toLowerCase();
  await H.rateLimit('forgot:' + ctx.ip, 5, 3600);
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
  await db.tx(async t => { await t.query('UPDATE password_resets SET used_at = now() WHERE token_hash = $1', [r.token_hash]); await t.query('UPDATE users SET pass_hash = $2, updated_at = now() WHERE id = $1', [r.user_id, sec.hashPassword(b.password)]); await t.query('DELETE FROM sessions WHERE user_id = $1', [r.user_id]); });
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
R.add('GET', '/api/listings/:id/unavailable', async ctx => { await H.rateLimit('cal:' + ctx.ip, 120, 60); return { listingId: ctx.params.id, ranges: await unavailable(str(ctx.params.id, 40)) }; });
R.add('POST', '/api/quote', async ctx => { await H.rateLimit('quote:' + ctx.ip, 60, 60); const b = await H.readJson(ctx.req); const l = cat.listing(str(b.listingId, 40)); const p = cat.validate(l, str(b.start, 10), str(b.end, 10), Number(b.guests)); if (p) throw new H.HttpError(400, p); const taken = (await unavailable(l.id)).some(([s, e]) => s < b.end && e > b.start); if (taken) throw new H.HttpError(409, 'Ces dates ne sont plus disponibles.'); return { quote: cat.quote(l, b.start, b.end, Number(b.guests)) }; });
R.add('POST', '/api/bookings', async ctx => createBooking(ctx, await H.readJson(ctx.req)));
R.add('GET', '/api/bookings', async ctx => { const u = requireUser(ctx); const r = await db.query('SELECT * FROM bookings WHERE user_id = $1 ORDER BY start_date DESC', [u.id]); return { bookings: r.rows.map(b => bookingView(b)) }; });
R.add('GET', '/api/bookings/:id', async ctx => {
  const u = requireUser(ctx); const b = await db.one('SELECT * FROM bookings WHERE id = $1 AND user_id = $2', [str(ctx.params.id, 20), u.id]);
  if (!b) throw new H.HttpError(404, 'Réservation introuvable.');
  if (b.status === 'pending_payment' && new Date(b.hold_until) < new Date()) { await db.query("UPDATE bookings SET status = 'expired' WHERE id = $1 AND status = 'pending_payment'", [b.id]); b.status = 'expired'; }
  const access = await accessFor(b); if (access) audit(u.id, 'access.view', b.id, ctx.ip);
  return { booking: bookingView(b, access), refund: b.status === 'confirmed' ? cat.refundFor(b) : null };
});
R.add('POST', '/api/bookings/:id/cancel', async ctx => {
  const u = requireCsrf(ctx); const b = await db.one('SELECT * FROM bookings WHERE id = $1 AND user_id = $2', [str(ctx.params.id, 20), u.id]);
  if (!b) throw new H.HttpError(404, 'Réservation introuvable.');
  if (b.status === 'pending_payment') { await db.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE id = $1", [b.id]); return { ok: true, refund: 0 }; }
  if (b.status !== 'confirmed') throw new H.HttpError(400, 'Cette réservation ne peut plus être annulée.');
  if (cat.dateStr(b.end_date) < cat.isoToday()) throw new H.HttpError(400, 'Séjour terminé.');
  const rf = cat.refundFor(b); let refundNote = '';
  if (rf.amount > 0) { try { await PSPS[b.psp].refund(b, rf.amount); } catch (e) { console.error('Remboursement : ' + e.message); refundNote = 'Le remboursement sera traité manuellement par notre équipe.'; } }
  await db.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now(), refund_amount = $2, updated_at = now() WHERE id = $1", [b.id, rf.amount]);
  audit(u.id, 'booking.cancel', b.id, ctx.ip);
  await mail.send({ to: u.email, subject: `Annulation · ${b.id}`, text: `Votre réservation ${b.id} est annulée. Remboursement selon la politique ${rf.policy} : ${(rf.amount / 100).toFixed(0)} ${b.currency}. ${refundNote}`.trim() });
  const adm = await mail.adminEmail(); if (adm) await mail.send({ to: adm, subject: `[${cat.siteName()}] Annulation ${b.id}`, text: `Réservation ${b.id} annulée par le client. Remboursement ${(rf.amount / 100).toFixed(0)} ${b.currency} (${rf.pct} %). ${refundNote}` });
  return { ok: true, refund: rf.amount, note: refundNote };
});

/* Carte de membre : numéro et jeton signé (HMAC), QR « DOUIRA|M|<n°>|<jeton> » */
R.add('GET', '/api/me/card', async ctx => { const u = requireUser(ctx); const t = sec.memberToken(u.id, u.member_no); return { memberNo: String(u.member_no), token: t, qr: `DOUIRA|M|${u.member_no}|${t}`, since: u.created_at, renewal: new Date(new Date(u.created_at).setFullYear(new Date(u.created_at).getFullYear() + 1)).toISOString() }; });
R.add('PATCH', '/api/me', async ctx => { const u = requireCsrf(ctx); const b = await H.readJson(ctx.req); const name = str(b.name, 80) || u.name, phone = str(b.phone, 30); await db.query('UPDATE users SET name = $2, phone = $3, updated_at = now() WHERE id = $1', [u.id, name, phone]); return { user: publicUser(Object.assign(u, { name, phone })) }; });
// RGPD : export de toutes les données du compte, puis suppression (anonymisation : les factures restent dues au fisc)
R.add('GET', '/api/me/export', async ctx => { const u = requireUser(ctx); const bk = await db.query('SELECT * FROM bookings WHERE user_id = $1', [u.id]); const au = await db.query('SELECT at, action, target FROM audit WHERE actor = $1 ORDER BY at', [u.id]); audit(u.id, 'data.export', '', ctx.ip); return { exportedAt: new Date().toISOString(), user: publicUser(u), bookings: bk.rows.map(b => bookingView(b)), activity: au.rows }; });
R.add('POST', '/api/me/delete', async ctx => {
  const u = requireCsrf(ctx); const b = await H.readJson(ctx.req);
  if (!sec.verifyPassword(b.password, u.pass_hash)) throw new H.HttpError(401, 'Mot de passe incorrect.');
  const active = await db.one("SELECT id FROM bookings WHERE user_id = $1 AND status = 'confirmed' AND end_date >= $2::date LIMIT 1", [u.id, cat.isoToday()]);
  if (active) throw new H.HttpError(400, 'Un séjour à venir est confirmé : annulez-le ou attendez sa fin avant de supprimer le compte.');
  await db.tx(async t => { await t.query("UPDATE users SET email = $2, name = 'Compte supprimé', phone = '', pass_hash = 'deleted', deleted_at = now() WHERE id = $1", [u.id, `deleted-${u.id}@invalid.local`]); await t.query('DELETE FROM sessions WHERE user_id = $1', [u.id]); await t.query('DELETE FROM password_resets WHERE user_id = $1', [u.id]); });
  audit(u.id, 'user.delete', '', ctx.ip); H.setCookie(ctx.res, SESSION_COOKIE, '', { secure: H.isHttps(ctx.req), maxAge: 0 }); return { ok: true };
});

/* ---------- Prestataires de paiement : webhooks et retours ---------- */
R.add('POST', '/api/webhooks/stripe', async ctx => {
  const raw = (await H.readBody(ctx.req, 256 * 1024)).toString('utf8');
  let ev; try { ev = PSPS.stripe.verifyWebhook(raw, ctx.req.headers['stripe-signature']); } catch (e) { throw new H.HttpError(500, e.message); }
  if (!ev) throw new H.HttpError(400, 'Signature invalide.');
  const r = await applyPaymentEvent('stripe', PSPS.stripe.interpret(ev), ev.id);
  if (r.confirmed) notifyConfirmed(r.booking).catch(e => console.error('e-mail', e.message));
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
  ctx.res.writeHead(200, { 'Content-Type': 'text/plain' }); ctx.res.end(ev.kind === 'paid' && !r.mismatch ? 'ACTION=POSTAUTH' : 'APPROVED');
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
  H.redirect(ctx.res, `${siteUrl(ctx.req)}/#espace-c_booking~${b.id}`);
}, { noCsrf: true });

/* ---------- Équipe (rôle admin, double authentification) ---------- */
R.add('GET', '/api/admin/bookings', async ctx => { requireUser(ctx, 'admin'); const r = await db.query("SELECT b.*, u.name AS client_name, u.email AS client_email, u.phone AS client_phone FROM bookings b JOIN users u ON u.id = b.user_id WHERE b.status IN ('confirmed', 'cancelled', 'pending_payment') ORDER BY b.start_date DESC LIMIT 500"); return { bookings: r.rows.map(b => Object.assign(bookingView(b), { client: { name: b.client_name, email: b.client_email, phone: b.client_phone } })) }; });
R.add('POST', '/api/admin/checkin', async ctx => {
  const a = requireCsrf(ctx); if (a.role !== 'admin') throw new H.HttpError(403, 'Accès refusé.');
  const b = await H.readJson(ctx.req); const m = /^DOUIRA\|M\|(\d{6})\|([A-Z0-9]{16})$/.exec(str(b.code, 60));
  if (!m) throw new H.HttpError(400, 'Code inconnu ou invalide.');
  const u = await db.one('SELECT * FROM users WHERE member_no = $1 AND deleted_at IS NULL', [Number(m[1])]);
  if (!u || !sec.safeEqual(sec.memberToken(u.id, u.member_no), m[2])) throw new H.HttpError(400, 'Code inconnu ou invalide.');
  const cur = await db.one("SELECT * FROM bookings WHERE user_id = $1 AND status = 'confirmed' AND start_date <= $2::date + 1 AND end_date >= $2::date ORDER BY start_date LIMIT 1", [u.id, cat.isoToday()]);
  if (b.record) { await db.query('INSERT INTO checkins (booking_id, user_id, by_user_id) VALUES ($1, $2, $3)', [cur ? cur.id : null, u.id, a.id]); audit(a.id, 'checkin', u.id, ctx.ip); }
  return { client: { name: u.name, memberNo: String(u.member_no) }, booking: cur ? bookingView(cur) : null, recorded: !!b.record };
});
R.add('PUT', '/api/admin/listings/:id/access', async ctx => { const a = requireCsrf(ctx); if (a.role !== 'admin') throw new H.HttpError(403, 'Accès refusé.'); const b = await H.readJson(ctx.req); await db.query('INSERT INTO listing_access (listing_id, address_enc, code_enc, notes_enc) VALUES ($1, $2, $3, $4) ON CONFLICT (listing_id) DO UPDATE SET address_enc = EXCLUDED.address_enc, code_enc = EXCLUDED.code_enc, notes_enc = EXCLUDED.notes_enc, updated_at = now()', [str(ctx.params.id, 40), sec.encrypt(str(b.address, 300)), sec.encrypt(str(b.code, 40)), sec.encrypt(str(b.notes, 500))]); audit(a.id, 'access.set', ctx.params.id, ctx.ip); return { ok: true }; });

/* Réglages e-mail (Administration > E-mails) : SMTP ou Resend, secrets chiffrés, jamais renvoyés */
/* ---------- Administration du catalogue (biens : admin/collaborateur/propriétaire ; activités : admin/agence) ---------- */
// Les droits par rôle (et « son propre bien / sa propre activité » pour propriétaire/agence) sont appliqués dans lib/catalog_admin.
R.add('GET', '/api/admin/catalog/listings', async ctx => { requireUser(ctx); return { listings: await ca(() => cadmin.listListings(ctx.session)) }; });
R.add('POST', '/api/admin/catalog/listings', async ctx => { const u = requireCsrf(ctx); const body = await H.readJson(ctx.req); const l = await ca(() => cadmin.saveListing(u, body)); audit(u.id, 'listing.save', l.id, ctx.ip); return { listing: l }; });
R.add('POST', '/api/admin/catalog/listings/:id/publish', async ctx => { const u = requireCsrf(ctx); const b = await H.readJson(ctx.req); const l = await ca(() => cadmin.publishListing(u, str(ctx.params.id, 40), !!b.publish)); audit(u.id, b.publish ? 'listing.publish' : 'listing.unpublish', l.id, ctx.ip); return { listing: l }; });
R.add('GET', '/api/admin/catalog/activities', async ctx => { requireUser(ctx); return { activities: await ca(() => cadmin.listActivities(ctx.session)) }; });
R.add('POST', '/api/admin/catalog/activities', async ctx => { const u = requireCsrf(ctx); const body = await H.readJson(ctx.req); const a = await ca(() => cadmin.saveActivity(u, body)); audit(u.id, 'activity.save', a.id, ctx.ip); return { activity: a }; });
R.add('POST', '/api/admin/catalog/activities/:id/publish', async ctx => { const u = requireCsrf(ctx); const b = await H.readJson(ctx.req); const a = await ca(() => cadmin.publishActivity(u, str(ctx.params.id, 40), !!b.publish)); audit(u.id, b.publish ? 'activity.publish' : 'activity.unpublish', a.id, ctx.ip); return { activity: a }; });

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
   Identifiant ADMIN_EMAIL (défaut : mohmed.anas.mosseddaq@gmail.com), mot de passe initial ADMIN_INITIAL_PASSWORD
   (défaut hors production : admin123) stocké haché (scrypt) et à changer obligatoirement à la première connexion.
   En production, pas de mot de passe par défaut : sans ADMIN_INITIAL_PASSWORD solide, aucun compte n'est créé. */
async function seedAdmin() {
  const exists = await db.one("SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL LIMIT 1"); if (exists) return;
  if (process.env.NODE_ENV === 'production') {
    const p = process.env.ADMIN_INITIAL_PASSWORD ? sec.passwordProblem(process.env.ADMIN_INITIAL_PASSWORD) : 'ADMIN_INITIAL_PASSWORD absente.';
    if (p) { console.error(`Administrateur non créé : ${p} Définissez ADMIN_INITIAL_PASSWORD (10 caractères min.) puis redémarrez.`); return; }
  }
  const email = String(process.env.ADMIN_EMAIL || 'mohmed.anas.mosseddaq@gmail.com').toLowerCase(), pw = process.env.ADMIN_INITIAL_PASSWORD || 'admin123';
  await db.query("INSERT INTO users (email, name, role, pass_hash, consent_at, must_change_password) VALUES ($1, $2, 'admin', $3, now(), true) ON CONFLICT (email) DO UPDATE SET role = 'admin', pass_hash = EXCLUDED.pass_hash, must_change_password = true, deleted_at = NULL", [email, 'Administrateur', sec.hashPassword(pw)]);
  console.warn(`Administrateur créé : ${email} avec le mot de passe initial — à changer dès la première connexion (obligatoire).`);
}
let startPromise = null;
function start() {
  if (startPromise) return startPromise;
  startPromise = (async () => {
  db.init(process.env.DATABASE_URL); await db.migrate();
  if (!process.env.DATA_KEY) console.error('DATA_KEY absente : adresses et codes d\'accès indisponibles.');
  await seedAdmin();
  console.log(`API : base connectée (${db.usingOfficialDriver ? 'pilote pg' : 'client intégré'}), paiement : ${(() => { try { return psp().name; } catch (e) { return 'non configuré'; } })()}`);
  setInterval(() => H.housekeeping().catch(() => {}), 10 * 60000).unref();
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
    else { console.error(`API ${req.method} ${url.pathname} :`, e.message); if (!res.headersSent) H.json(res, 500, { error: 'Erreur du serveur.' }); }
  }
  return true;
}
module.exports = { start, handle, _internals: { applyPaymentEvent, createSession, bookingRef } };
