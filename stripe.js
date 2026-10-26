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

const API = 'https://api.stripe.com/v1';
const key = () => process.env.STRIPE_SECRET_KEY || '';
const enabled = () => /^sk_(test|live)_/.test(key());

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

/* Crée la session de paiement ; renvoie { ref, url } */
async function createCheckout({ booking, user, siteUrl, label }) {
  const s = await call('POST', '/checkout/sessions', {
    mode: 'payment',
    customer_email: user.email,
    client_reference_id: booking.id,
    line_items: { 0: { quantity: 1, price_data: { currency: booking.currency.toLowerCase(), unit_amount: booking.amount, product_data: { name: label } } } },
    metadata: { bookingId: booking.id },
    payment_intent_data: { metadata: { bookingId: booking.id }, description: label },
    success_url: `${siteUrl}/#espace-c_booking~${booking.id}`,
    cancel_url: `${siteUrl}/#espace-c_booking~${booking.id}`,
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,   // minimum Stripe : 30 min ; aligné sur la durée de blocage des dates
    locale: 'auto'
  }, 'checkout-' + booking.id);
  return { ref: s.id, url: s.url };
}

/* Vérification de la signature d'un webhook : en-tête "t=…,v1=…" ; corps brut obligatoire */
function verifyWebhook(rawBody, header, secret = process.env.STRIPE_WEBHOOK_SECRET || '') {
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET manquante');
  const parts = Object.fromEntries(String(header || '').split(',').map(p => p.split('=')));
  const t = Number(parts.t), v1 = parts.v1;
  if (!t || !v1 || Math.abs(Date.now() / 1000 - t) > 300) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(v1);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return JSON.parse(rawBody);
}
/* Interprétation d'un événement : { kind: 'paid'|'failed'|'expired'|'refunded'|null, bookingId, ref, amount } */
function interpret(event) {
  const o = event.data && event.data.object || {};
  const bookingId = (o.metadata && o.metadata.bookingId) || o.client_reference_id || '';
  if (event.type === 'checkout.session.completed' && o.payment_status === 'paid') return { kind: 'paid', bookingId, ref: o.payment_intent || o.id, amount: o.amount_total };
  if (event.type === 'checkout.session.async_payment_succeeded') return { kind: 'paid', bookingId, ref: o.payment_intent || o.id, amount: o.amount_total };
  if (event.type === 'checkout.session.async_payment_failed') return { kind: 'failed', bookingId, ref: o.id };
  if (event.type === 'checkout.session.expired') return { kind: 'expired', bookingId, ref: o.id };
  if (event.type === 'charge.refunded') return { kind: 'refunded', bookingId, ref: o.payment_intent, amount: o.amount_refunded };
  return { kind: null, bookingId };
}
/* Remboursement partiel ou total du PaymentIntent */
async function refund(booking, amount) {
  if (!/^pi_/.test(booking.psp_ref)) throw new Error('Référence de paiement absente');
  const r = await call('POST', '/refunds', { payment_intent: booking.psp_ref, amount }, 'refund-' + booking.id + '-' + amount);
  return { ref: r.id, status: r.status };
}
module.exports = { name: 'stripe', enabled, createCheckout, verifyWebhook, interpret, refund, _form: form };
