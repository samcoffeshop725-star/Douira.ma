/* Prestataires de paiement : ce qui se vérifie SANS Stripe ni base.
   Exécution : cd api && npm test

   Ce que ces tests tiennent :
   - le prix envoyé au prestataire est celui de la RÉSERVATION (calculé par le
     serveur), jamais une valeur venue du navigateur ;
   - une signature de webhook fausse, absente ou périmée est refusée ;
   - une clé Stripe réelle n'encaisse pas hors production ;
   - un refus de carte au CMI reste rattrapable, pas chez Stripe. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

/* lib/payments lit ses secrets en base : on lui donne une base vide, les
   variables d'environnement font le reste. */
const doubler = (chemin, exports) => {
  const resolu = require.resolve(chemin);
  require.cache[resolu] = { id: resolu, filename: resolu, loaded: true, children: [], paths: [], exports };
};
doubler('../lib/db', { async one() { return null; }, async query() { return { rows: [] }; } });

const stripe = require('../psp/stripe');
const cmi = require('../psp/cmi');
const simulate = require('../psp/simulate');

const SECRET = 'whsec_test_secret';
const signer = (body, t = Math.floor(Date.now() / 1000), secret = SECRET) =>
  `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const evenement = (type, objet, livemode = false) => JSON.stringify({ id: 'evt_1', type, livemode, data: { object: objet } });

/* ---------- Mode de la clé ---------- */

test('une clé réelle est refusée hors production, une clé de test acceptée', () => {
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  process.env.STRIPE_SECRET_KEY = 'sk_live_abc';
  assert.equal(stripe.mode(), 'live');
  assert.equal(stripe.enabled(), false);
  process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
  assert.equal(stripe.mode(), 'test');
  assert.equal(stripe.enabled(), true);
  process.env.STRIPE_SECRET_KEY = 'pk_test_abc';     // clé publiable : pas une clé secrète
  assert.equal(stripe.mode(), '');
  assert.equal(stripe.enabled(), false);
  process.env.NODE_ENV = env;
});

test('en production, la clé réelle encaisse', () => {
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  process.env.STRIPE_SECRET_KEY = 'sk_live_abc';
  assert.equal(stripe.enabled(), true);
  process.env.NODE_ENV = env;
  process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
});

/* ---------- Session de paiement : le prix vient du serveur ---------- */

test('la session Checkout porte le montant et la devise de la réservation', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
  const appels = [];
  const fetchOrigine = global.fetch;
  global.fetch = async (url, init) => {
    appels.push({ url, init });
    return { ok: true, json: async () => ({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }) };
  };
  try {
    const booking = { id: 'DR-ABC123', amount: 150000, currency: 'MAD' };   // 1 500,00 MAD en centimes
    const r = await stripe.createCheckout({ booking, user: { email: 'client@exemple.ma' }, siteUrl: 'https://douira.ma', label: 'Douira · Riad · 2 nuits · DR-ABC123' });
    assert.equal(r.ref, 'cs_test_1');
    assert.equal(appels.length, 1);
    const corps = new URLSearchParams(appels[0].init.body);
    assert.equal(corps.get('line_items[0][price_data][unit_amount]'), '150000');
    assert.equal(corps.get('line_items[0][price_data][currency]'), 'mad');
    assert.equal(corps.get('mode'), 'payment');
    assert.equal(corps.get('metadata[bookingId]'), 'DR-ABC123');
    assert.equal(corps.get('payment_intent_data[statement_descriptor_suffix]'), 'DR ABC123');
    // Même réservation = même clé d'idempotence : un double clic ne crée pas deux sessions.
    assert.equal(appels[0].init.headers['idempotency-key'], 'checkout-DR-ABC123');
    assert.equal(appels[0].init.headers.authorization, 'Bearer sk_test_abc');
  } finally { global.fetch = fetchOrigine; }
});

test('le libellé du relevé ne garde que lettres, chiffres et espaces', () => {
  assert.equal(stripe.statementSuffix('DR-ABC123'), 'DR ABC123');
  assert.equal(stripe.statementSuffix('x*<y>"z\''), 'X Y Z');
  assert.equal(stripe.statementSuffix(''), '');
  assert.ok(stripe.statementSuffix('DR-ABCDEFGHIJKLMNOP').length <= 12);
});

/* ---------- Signature du webhook ---------- */

test('une signature valide est acceptée, le corps est rendu tel quel', () => {
  const body = evenement('checkout.session.expired', { id: 'cs_1' });
  const ev = stripe.verifyWebhook(body, signer(body), SECRET);
  assert.equal(ev.type, 'checkout.session.expired');
});

test('mauvais secret, en-tête absent ou corps modifié : refusés', () => {
  const body = evenement('checkout.session.completed', { id: 'cs_1', payment_status: 'paid' });
  assert.equal(stripe.verifyWebhook(body, signer(body, undefined, 'whsec_autre'), SECRET), null);
  assert.equal(stripe.verifyWebhook(body, '', SECRET), null);
  assert.equal(stripe.verifyWebhook(body, 't=1,v1=abc', SECRET), null);
  assert.equal(stripe.verifyWebhook(body + ' ', signer(body), SECRET), null);
});

test('une signature de plus de cinq minutes est refusée (rejeu)', () => {
  const body = evenement('checkout.session.completed', { id: 'cs_1', payment_status: 'paid' });
  const t = Math.floor(Date.now() / 1000) - 301;
  assert.equal(stripe.verifyWebhook(body, signer(body, t), SECRET), null);
  const recent = Math.floor(Date.now() / 1000) - 299;
  assert.ok(stripe.verifyWebhook(body, signer(body, recent), SECRET));
});

test('pendant une rotation, il suffit qu’une des signatures corresponde', () => {
  const body = evenement('checkout.session.expired', { id: 'cs_1' });
  const t = Math.floor(Date.now() / 1000);
  const bonne = crypto.createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
  const ancienne = crypto.createHmac('sha256', 'whsec_ancien').update(`${t}.${body}`).digest('hex');
  assert.ok(stripe.verifyWebhook(body, `t=${t},v1=${ancienne},v1=${bonne}`, SECRET));
  assert.equal(stripe.verifyWebhook(body, `t=${t},v1=${ancienne}`, SECRET), null);
});

test('sans secret configuré, la vérification échoue bruyamment', () => {
  assert.throws(() => stripe.verifyWebhook('{}', 't=1,v1=a', ''), /STRIPE_WEBHOOK_SECRET/);
});

/* ---------- Lecture des événements ---------- */

test('un paiement réglé donne « paid » avec montant, devise et environnement', () => {
  const ev = JSON.parse(evenement('checkout.session.completed', { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 150000, currency: 'mad', metadata: { bookingId: 'DR-1' } }, true));
  const r = stripe.interpret(ev);
  assert.deepEqual(r, { bookingId: 'DR-1', currency: 'mad', livemode: true, kind: 'paid', ref: 'pi_1', amount: 150000 });
});

test('une session terminée mais non payée (paiement différé) ne confirme rien', () => {
  const ev = JSON.parse(evenement('checkout.session.completed', { id: 'cs_1', payment_status: 'unpaid', metadata: { bookingId: 'DR-1' } }));
  assert.equal(stripe.interpret(ev).kind, null);
});

test('échec différé, expiration, remboursement, inconnu', () => {
  assert.equal(stripe.interpret(JSON.parse(evenement('checkout.session.async_payment_failed', { id: 'cs_1', metadata: { bookingId: 'DR-1' } }))).kind, 'failed');
  assert.equal(stripe.interpret(JSON.parse(evenement('checkout.session.expired', { id: 'cs_1', client_reference_id: 'DR-1' }))).kind, 'expired');
  const rb = stripe.interpret(JSON.parse(evenement('charge.refunded', { id: 'ch_1', payment_intent: 'pi_1', amount_refunded: 75000, metadata: { bookingId: 'DR-1' } })));
  assert.equal(rb.kind, 'refunded'); assert.equal(rb.amount, 75000); assert.equal(rb.ref, 'pi_1');
  assert.equal(stripe.interpret(JSON.parse(evenement('payment_intent.created', { id: 'pi_1' }))).kind, null);
  // Un échec Stripe n'est PAS rattrapable : la session est close.
  assert.ok(!stripe.interpret(JSON.parse(evenement('checkout.session.async_payment_failed', { id: 'cs_1' }))).retryable);
});

/* ---------- CMI ---------- */

test('CMI : approuvé = payé, refusé = échec rattrapable', () => {
  const ok = cmi.interpret({ ProcReturnCode: '00', Response: 'Approved', oid: 'DR-1', TransId: 'T1', amount: '1500.00', currency: '504' });
  assert.equal(ok.kind, 'paid'); assert.equal(ok.retryable, false); assert.equal(ok.amount, 150000); assert.equal(ok.currency, 'mad');
  assert.equal(ok.eventId, 'cmi-T1-00');
  const ko = cmi.interpret({ ProcReturnCode: '05', Response: 'Declined', oid: 'DR-1', TransId: 'T2', amount: '1500.00', currency: '504' });
  assert.equal(ko.kind, 'failed'); assert.equal(ko.retryable, true);
  assert.notEqual(ok.eventId, ko.eventId);   // deux tentatives = deux événements
});

test('CMI : un callback sans signature valide est refusé', () => {
  process.env.CMI_STORE_KEY = 'cle-de-test';
  const p = { ProcReturnCode: '00', oid: 'DR-1', amount: '10.00' };
  assert.equal(cmi.verify(Object.assign({}, p, { HASH: 'faux' })), false);
  assert.equal(cmi.verify(Object.assign({}, p, { HASH: cmi.sign(p) })), true);
  assert.equal(cmi.verify(Object.assign({}, p, { amount: '1.00', HASH: cmi.sign(p) })), false);   // montant modifié après signature
  delete process.env.CMI_STORE_KEY;
});

/* ---------- Simulation ---------- */

test('le prestataire simulé renvoie le montant dans l’unité du prestataire', () => {
  assert.equal(simulate.interpret('paid', { id: 'DR-1', amount: 150000, currency: 'MAD' }).amount, 150000);
  assert.equal(simulate.interpret('paid', { id: 'DR-1', amount: 1500000, currency: 'XOF' }).amount, 15000);   // le franc CFA n'a pas de centimes
  assert.equal(simulate.interpret('failed', { id: 'DR-1', amount: 1, currency: 'MAD' }).kind, 'failed');
});

test('le prestataire simulé n’existe jamais en production', () => {
  const env = process.env.NODE_ENV, psp = process.env.PSP;
  process.env.PSP = 'simulate'; process.env.NODE_ENV = 'production';
  assert.equal(simulate.enabled(), false);
  process.env.NODE_ENV = 'development';
  assert.equal(simulate.enabled(), true);
  process.env.NODE_ENV = env; process.env.PSP = psp;
});
