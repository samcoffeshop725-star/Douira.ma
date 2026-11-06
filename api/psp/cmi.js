/* =====================================================================
   Adaptateur CMI (Centre Monétique Interbancaire, Maroc) : page de paiement
   hébergée « 3D_PAY_HOSTING » avec signature « ver3 » (SHA-512). La carte est
   saisie sur la page du CMI, jamais chez nous.
   Flux : notre serveur renvoie un formulaire auto-soumis vers la passerelle →
   le client paie → le CMI appelle callbackUrl (serveur à serveur, signé) → nous
   vérifions la signature et confirmons → le client revient sur okUrl/failUrl.
   Variables : CMI_CLIENT_ID, CMI_STORE_KEY, CMI_GATEWAY_URL
   (test : https://testpayment.cmi.co.ma/fim/est3Dgate ; production : https://payment.cmi.co.ma/fim/est3Dgate).
   À VALIDER sur l'environnement de test du CMI : noms exacts des champs de
   retour et réponse attendue au callback (ACTION=POSTAUTH) selon votre contrat.
   Les remboursements se font depuis le back-office CMI (pas d'API de remboursement ici).
   ===================================================================== */
'use strict';
const crypto = require('crypto');
const pay = require('../lib/payments');

// Devises acceptées par la passerelle (codes ISO 4217 numériques). Le franc CFA n'en
// fait pas partie : une réservation dans cette devise est refusée en amont (lib/money.js).
const CMI_ISO = { MAD: '504', EUR: '978' };

const enabled = () => !!(pay.env('CMI_CLIENT_ID') && pay.env('CMI_STORE_KEY'));
// Sans URL réglée : la plateforme de TEST hors production — et celle de
// production en production. Un administrateur qui saisit ses identifiants
// marchands sans l'URL envoyait chaque client réel payer sur testpayment, où
// une carte de test publique « confirmait » un séjour sans un dirham.
const gateway = () => pay.env('CMI_GATEWAY_URL')
  || (process.env.NODE_ENV === 'production' ? 'https://payment.cmi.co.ma/fim/est3Dgate' : 'https://testpayment.cmi.co.ma/fim/est3Dgate');
const esc = v => String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

/* Signature ver3 : paramètres triés par nom (insensible à la casse), hors « hash » et « encoding », valeurs jointes par « | », puis la clé */
function sign(params, storeKey = pay.env('CMI_STORE_KEY')) {
  const keys = Object.keys(params).filter(k => !['hash', 'encoding'].includes(k.toLowerCase())).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const plain = keys.map(k => esc(params[k])).join('|') + '|' + esc(storeKey);
  return crypto.createHash('sha512').update(plain, 'utf8').digest('base64');
}
function verify(params) {
  const given = params.HASH || params.hash || '';
  const expected = sign(params);
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/* Paramètres du formulaire de paiement (montant « 1234.00 », devise ISO 504 = MAD) */
function formParams({ booking, user, siteUrl, apiUrl, label }) {
  const p = {
    clientid: pay.env('CMI_CLIENT_ID'), storetype: '3D_PAY_HOSTING', hashAlgorithm: 'ver3', TranType: 'PreAuth', lang: 'fr',
    oid: booking.id, amount: (booking.amount / 100).toFixed(2), currency: CMI_ISO[booking.currency] || '504',
    okUrl: `${apiUrl}/api/psp/cmi/return`, failUrl: `${apiUrl}/api/psp/cmi/return`, callbackUrl: `${apiUrl}/api/webhooks/cmi`, shopurl: siteUrl,
    email: user.email, BillToName: user.name.slice(0, 50), description: label.slice(0, 100), rnd: crypto.randomBytes(8).toString('hex'), encoding: 'UTF-8'
  };
  p.hash = sign(p);
  return p;
}
/* Page HTML qui soumet le formulaire vers la passerelle (le navigateur quitte notre site) */
function checkoutPage(params) {
  const h = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Redirection vers le paiement sécurisé</title><meta name="robots" content="noindex"></head>
<body style="font-family:system-ui;text-align:center;padding:40px"><p>Redirection vers la page de paiement sécurisée du CMI…</p>
<form id="f" method="post" action="${h(gateway())}">${Object.entries(params).map(([k, v]) => `<input type="hidden" name="${h(k)}" value="${h(v)}">`).join('')}
<noscript><button type="submit">Continuer vers le paiement</button></noscript></form><script>document.getElementById('f').submit()</script></body></html>`;
}
async function createCheckout(ctx) {
  // Le formulaire est servi par notre API : l'URL renvoyée au client déclenche la redirection
  return { ref: 'cmi-' + ctx.booking.id, url: `${ctx.apiUrl}/api/psp/cmi/form/${encodeURIComponent(ctx.booking.id)}` };
}
/* Interprétation du callback : code « 00 » = approuvé.
   Un refus (carte refusée, 3-D Secure abandonné) n'engage à rien : le client
   peut représenter le formulaire tant que les dates sont bloquées — d'où
   « retryable », qui dit à l'API de ne PAS clore la réservation au premier refus. */
function interpret(params) {
  const ok = String(params.ProcReturnCode || '') === '00' && /approved/i.test(params.Response || 'Approved');
  const iso = String(params.currency || ''); const currency = Object.keys(CMI_ISO).find(k => CMI_ISO[k] === iso) || '';
  return { kind: ok ? 'paid' : 'failed', retryable: !ok, bookingId: params.oid || params.ReturnOid || '', ref: params.TransId || '', amount: Math.round(Number(params.amount || 0) * 100), currency: currency.toLowerCase(), eventId: 'cmi-' + (params.TransId || params.oid) + '-' + (params.ProcReturnCode || '') };
}
async function refund() { throw new Error('Remboursement CMI : à effectuer depuis le back-office CMI'); }
module.exports = { name: 'cmi', enabled, gateway, sign, verify, formParams, checkoutPage, createCheckout, interpret, refund };
