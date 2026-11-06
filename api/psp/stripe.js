/* =====================================================================
   Adaptateur Stripe : Checkout hébergé (la carte est saisie chez Stripe,
   jamais sur notre serveur → périmètre PCI DSS SAQ A). Apple Pay et Google
   Pay sont proposés automatiquement par Checkout sur les appareils compatibles
   une fois le domaine enregistré (voir MISE-EN-LIGNE.md).
   API REST appelée directement (pas de SDK requis) ; webhook vérifié par
   signature HMAC-SHA256 avec tolérance de 5 minutes.
   Variables : STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
   ===================================================================== */
'use strict';
const crypto = require('crypto');
const mny = require('../lib/money');
const pay = require('../lib/payments');

const API = 'https://api.stripe.com/v1';
const key = () => pay.env('STRIPE_SECRET_KEY');
/* Mode de la clé : 'test' (sk_test_…), 'live' (sk_live_…) ou '' (absente ou
   inconnue). Le mode ne révèle rien du secret ; il est affiché à l'équipe. */
const mode = () => /^sk_test_/.test(key()) ? 'test' : /^sk_live_/.test(key()) ? 'live' : '';
/* Une clé RÉELLE n'est acceptée qu'en production (NODE_ENV=production). Hors
   production — poste de développement, serveur d'essai — seule une clé de test
   encaisse : une session d'essai qui débiterait de vraies cartes serait une
   erreur qu'on ne peut pas rattraper. L'écart est signalé une fois au journal. */
let liveRefuseeSignalee = false;
const enabled = () => {
  const m = mode();
  if (!m) return false;
  if (m === 'live' && process.env.NODE_ENV !== 'production') {
    if (!liveRefuseeSignalee) { liveRefuseeSignalee = true; console.error('Stripe : clé RÉELLE (sk_live_) refusée hors production — utilisez une clé de test (sk_test_) ou NODE_ENV=production.'); }
    return false;
  }
  return true;
};

// Encodage « form » imbriqué attendu par l'API Stripe (line_items[0][price_data][currency]=…)
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const name = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') form(v, name, out); else out.append(name, String(v));
  }
  return out;
}
async function call(method, pathname, body, idempotencyKey) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const headers = { authorization: 'Bearer ' + key(), 'content-type': 'application/x-www-form-urlencoded', 'stripe-version': '2024-06-20' };
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const r = await fetch(API + pathname, { method, headers, body: body ? form(body).toString() : undefined, signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error('Stripe : ' + ((j.error && j.error.message) || r.status)); e.stripe = j.error; throw e; }
    return j;
  } finally { clearTimeout(t); }
}

/* Libellé sur le relevé bancaire du client. Stripe compose « PRÉFIXE* SUFFIXE » :
   le préfixe (le nom de l'entreprise, « DOUIRA ») se règle UNE fois dans le
   tableau de bord Stripe (Settings > Public details > Statement descriptor) ;
   le suffixe est la référence du séjour, pour que le client reconnaisse la
   ligne. Stripe n'accepte que lettres, chiffres et espaces, 22 caractères au
   total : une référence « DR-ABC123 » devient « DR ABC123 ». */
function statementSuffix(ref) {
  return String(ref || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 12);
}
/* Crée la session de paiement ; renvoie { ref, url } */
async function createCheckout({ booking, user, siteUrl, label }) {
  const s = await call('POST', '/checkout/sessions', {
    mode: 'payment',
    customer_email: user.email,
    client_reference_id: booking.id,
    // unit_amount : en centimes pour une devise à décimales, en unités entières sinon
    // (une devise sans sous-unité serait facturée 100× trop, voir lib/money.js).
    line_items: { 0: { quantity: 1, price_data: { currency: booking.currency.toLowerCase(), unit_amount: mny.pspAmount(booking.amount, booking.currency), product_data: { name: label } } } },
    metadata: { bookingId: booking.id },
    payment_intent_data: { metadata: { bookingId: booking.id }, description: label, statement_descriptor_suffix: statementSuffix(booking.id) || undefined },
    success_url: `${siteUrl}/#espace-c_booking~${booking.id}`,
    cancel_url: `${siteUrl}/#espace-c_booking~${booking.id}`,
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,   // minimum Stripe : 30 min ; aligné sur la durée de blocage des dates
    locale: 'auto'
  }, 'checkout-' + booking.id);
  return { ref: s.id, url: s.url };
}

/* Vérification de la signature d'un webhook : en-tête "t=…,v1=…" ; corps brut obligatoire */
function verifyWebhook(rawBody, header, secret = pay.env('STRIPE_WEBHOOK_SECRET'), now = Date.now()) {
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET manquante');
  // En-tête « t=…,v1=…,v1=… » : pendant une rotation du secret, Stripe signe
  // avec l'ancien ET le nouveau. Il suffit qu'UNE signature corresponde.
  let t = 0; const sigs = [];
  for (const part of String(header || '').split(',')) {
    const i = part.indexOf('='); if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') t = Number(v); else if (k === 'v1') sigs.push(v);
  }
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return null;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  const ok = sigs.some(v1 => { const b = Buffer.from(v1); return b.length === expected.length && crypto.timingSafeEqual(expected, b); });
  if (!ok) return null;
  return JSON.parse(rawBody);
}
/* Interprétation d'un événement :
   { kind: 'paid'|'failed'|'expired'|'refunded'|null, bookingId, ref, amount, currency, livemode }
   - amount est dans l'unité de Stripe (centimes pour une devise à décimales) ;
   - currency est en minuscules (« mad ») ;
   - livemode dit si l'événement vient de l'environnement RÉEL de Stripe.
   Une carte refusée sur la page Checkout ne produit AUCUN événement : le client
   réessaie sur place, et la session expire d'elle-même (checkout.session.expired)
   s'il abandonne. « failed » ne concerne que les moyens de paiement différés. */
function interpret(event) {
  const o = event.data && event.data.object || {};
  const bookingId = (o.metadata && o.metadata.bookingId) || o.client_reference_id || '';
  const base = { bookingId, currency: o.currency ? String(o.currency).toLowerCase() : '', livemode: !!event.livemode };
  if (event.type === 'checkout.session.completed' && o.payment_status === 'paid') return Object.assign(base, { kind: 'paid', ref: o.payment_intent || o.id, amount: o.amount_total });
  if (event.type === 'checkout.session.async_payment_succeeded') return Object.assign(base, { kind: 'paid', ref: o.payment_intent || o.id, amount: o.amount_total });
  if (event.type === 'checkout.session.async_payment_failed') return Object.assign(base, { kind: 'failed', ref: o.id });
  if (event.type === 'checkout.session.expired') return Object.assign(base, { kind: 'expired', ref: o.id });
  if (event.type === 'charge.refunded') return Object.assign(base, { kind: 'refunded', ref: o.payment_intent, amount: o.amount_refunded });
  return Object.assign(base, { kind: null });
}
/* Remboursement partiel ou total du PaymentIntent */
async function refund(booking, amount) {
  if (!/^pi_/.test(booking.psp_ref)) throw new Error('Référence de paiement absente');
  const r = await call('POST', '/refunds', { payment_intent: booking.psp_ref, amount }, 'refund-' + booking.id + '-' + amount);
  return { ref: r.id, status: r.status };
}
/* Ferme une session de paiement encore ouverte (réservation annulée avant d'avoir payé) :
   la page Checkout cesse d'accepter la carte. Sans effet si elle est déjà close. */
async function expireCheckout(ref) {
  if (!/^cs_/.test(String(ref || ''))) return null;
  const r = await call('POST', `/checkout/sessions/${encodeURIComponent(ref)}/expire`);
  return { ref: r.id, status: r.status };
}
module.exports = { name: 'stripe', enabled, mode, createCheckout, verifyWebhook, interpret, refund, expireCheckout, statementSuffix, _form: form };
