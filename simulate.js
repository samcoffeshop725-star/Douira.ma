/* =====================================================================
   Prestataire simulé : page de paiement locale avec deux boutons (payer /
   refuser). Réservé aux essais (PSP=simulate) ; refusé en production
   (NODE_ENV=production) pour qu'aucune réservation réelle ne soit confirmée
   sans paiement. Aucune donnée de carte n'est demandée.
   ===================================================================== */
'use strict';
const enabled = () => process.env.PSP === 'simulate' && process.env.NODE_ENV !== 'production';
async function createCheckout({ booking, apiUrl }) { return { ref: 'sim-' + booking.id, url: `${apiUrl}/api/psp/simulate/${encodeURIComponent(booking.id)}` }; }
function page(booking, csrf, siteUrl) {
  const h = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const mad = (booking.amount / 100).toLocaleString('fr-FR') + ' ' + booking.currency;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paiement simulé</title><meta name="robots" content="noindex">
<style>body{font-family:system-ui;max-width:460px;margin:40px auto;padding:0 16px;color:#2B1E1C}button{font:inherit;padding:12px 22px;border-radius:999px;border:1px solid #2B1E1C;background:#fff;cursor:pointer;margin:6px}.p{background:#A8432A;color:#fff;border-color:#A8432A}</style></head>
<body><h1>Paiement simulé</h1><p><b>Mode essai</b> : aucune carte n'est demandée. Réservation <b>${h(booking.id)}</b> · ${h(mad)}.</p>
<form method="post" action="${h(booking.id)}/complete"><input type="hidden" name="csrf" value="${h(csrf)}">
<button class="p" name="result" value="paid">Payer (succès)</button><button name="result" value="failed">Refuser (échec)</button></form>
<p><a href="${h(siteUrl)}/#espace-c_booking~${h(booking.id)}">Retour au site</a></p></body></html>`;
}
function interpret(result, booking) { return { kind: result === 'paid' ? 'paid' : 'failed', bookingId: booking.id, ref: 'sim-' + booking.id, amount: booking.amount, eventId: 'sim-' + booking.id + '-' + result + '-' + Date.now() }; }
async function refund(booking, amount) { return { ref: 'sim-refund-' + booking.id, status: 'succeeded', amount }; }
module.exports = { name: 'simulate', enabled, createCheckout, page, interpret, refund };
