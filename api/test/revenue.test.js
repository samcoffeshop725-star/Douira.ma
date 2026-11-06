/* Règles de revenu : majoration, marges, commissions. Exécution : cd api && npm test */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rev = require('../lib/revenue');
const catalog = require('../lib/catalog');

const near = (a, b, eps = 0.05) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

/* ---------- Majoration et taux de prise ---------- */

test('la majoration du site (12,5 %) ne laisse que 11,1 % du prix public', () => {
  // Le piège : 12,5 % s'applique au prix PROPRIÉTAIRE, pas au prix public.
  near(rev.takeRate(12.5), 11.11);
  near(rev.takeRate(0), 0);
});

test('markupFor est l\'inverse exact de takeRate', () => {
  for (const m of [0, 5, 12.5, 20, 50]) near(rev.markupFor(rev.takeRate(m)), m);
  // Pour encaisser autant qu'Airbnb (13,2 % réels), il faut majorer de 15,2 %.
  near(rev.markupFor(13.2), 15.21);
});

/* ---------- Logement ---------- */

test('un séjour sans remise rapporte la majoration, et le propriétaire est payé sur son prix', () => {
  const r = rev.accommodation({ nightly: 1200, nights: 5, markupPct: 12.5 });
  assert.equal(r.unitPrice, 1350);
  assert.equal(r.revenue, 6750);
  assert.equal(r.payout, 6000);
  assert.equal(r.margin, 750);
  near(r.takeRatePct, 11.11);
  assert.equal(r.loss, false);
});

test('la remise sort de la marge, pas de la part du propriétaire', () => {
  const r = rev.accommodation({ nightly: 1200, nights: 5, markupPct: 12.5, discountPct: 10 });
  assert.equal(r.payout, 6000);          // inchangé : le propriétaire ne finance pas la remise
  assert.equal(r.revenue, 6075);
  assert.equal(r.margin, 75);            // 750 → 75 : dix fois moins pour 10 % de remise
  assert.equal(r.loss, false);
});

test('au-delà du point mort la réservation perd de l\'argent', () => {
  // La borne vaut exactement le taux de prise : 11,1 % ici.
  const r = rev.accommodation({ nightly: 1200, nights: 5, markupPct: 12.5, discountPct: 15 });
  assert.ok(r.margin < 0, 'marge négative attendue');
  assert.equal(r.loss, true);
  near(r.breakEvenDiscountPct, 11.11);
});

test('le point mort est atteint pile au taux de prise', () => {
  const r = rev.accommodation({ nightly: 1000, nights: 10, markupPct: 12.5, discountPct: rev.takeRate(12.5) });
  assert.ok(Math.abs(r.margin) <= 1, `marge quasi nulle attendue, obtenue ${r.margin}`);
});

test('la remise maximale permise par la base (90 %) est très au-delà du point mort', () => {
  // La contrainte SQL autorise 0..90 : rien n'empêche aujourd'hui de publier une remise ruineuse.
  const r = rev.accommodation({ nightly: 1200, nights: 5, markupPct: 12.5, discountPct: 90 });
  assert.equal(r.loss, true);
  assert.ok(r.margin < -5000);
});

test('le prix public du module est celui que calcule le devis du site', () => {
  // Garde-fou : si quote() change de formule, ce test tombe.
  const l = { id: 'b1', nightly: 1200, capacity: 4, policy: 'moderee', minNights: 1, title: 'Test', city: 'Marrakech', discount: null };
  const q = catalog.quote(l, '2030-06-01', '2030-06-06', 2);
  const r = rev.accommodation({ nightly: 1200, nights: 5, markupPct: catalog.markupPct() });
  assert.equal(q.price, r.unitPrice);
  assert.equal(q.total, r.revenue);
});

/* ---------- Services et véhicules ---------- */

test('un service rapporte la différence entre prix de vente et prix d\'achat', () => {
  const s = rev.service({ price: 350, netPrice: 220, qty: 4 });
  assert.equal(s.revenue, 1400);
  assert.equal(s.payout, 880);
  assert.equal(s.margin, 520);
  assert.equal(s.known, true);
});

test('sans prix d\'achat renseigné, la marge est inconnue et non supposée nulle', () => {
  const s = rev.service({ price: 350, qty: 2 });
  assert.equal(s.revenue, 700);
  assert.equal(s.margin, null);
  assert.equal(s.known, false);
  // Un prix d'achat de 0 est une information, pas une absence.
  assert.equal(rev.service({ price: 350, netPrice: 0 }).margin, 350);
});

test('un véhicule se chiffre à la journée', () => {
  const v = rev.vehicle({ pricePerDay: 600, netPricePerDay: 480, days: 5 });
  assert.equal(v.revenue, 3000);
  assert.equal(v.margin, 600);
});

/* ---------- Remises partenaires ---------- */

test('la commission partenaire se calcule sur l\'addition relevée', () => {
  const c = rev.partnerCommission({ billAmount: 600, commissionPct: 7 });
  assert.equal(c.revenue, 42);
  assert.equal(c.known, true);
});

test('sans addition relevée, une remise activée ne rapporte rien', () => {
  // C'est l'état actuel de activity_redemptions : un compteur, pas une facture.
  const c = rev.partnerCommission({ commissionPct: 7 });
  assert.equal(c.revenue, 0);
  assert.equal(c.known, false);
});

/* ---------- Panier complet ---------- */

test('le panier hybride double le taux de prise du logement seul', () => {
  const b = rev.basket({
    stay: { nightly: 1200, nights: 5, markupPct: 12.5 },
    services: [{ price: 350, netPrice: 220, qty: 4 }],
    vehicles: [{ pricePerDay: 600, netPricePerDay: 480, days: 5 }],
    redemptions: [{ billAmount: 1800, commissionPct: 7 }],
  });
  assert.equal(b.revenue, 11150);        // 6750 + 1400 + 3000
  assert.equal(b.margin, 1870);          // 750 + 520 + 600
  assert.equal(b.commission, 126);       // 7 % de 1800
  assert.equal(b.total, 1996);
  near(b.blendedTakeRatePct, 17.9, 0.1); // contre 11,1 % sur le logement seul
  assert.equal(b.unknownCosts, 0);
});

test('un coût manquant est signalé et le total devient un plancher', () => {
  const b = rev.basket({
    stay: { nightly: 1000, nights: 2, markupPct: 12.5 },
    services: [{ price: 350 }],
  });
  assert.equal(b.unknownCosts, 1);
  assert.equal(b.margin, 250);           // la seule marge chiffrable
});

test('un panier vide ne divise pas par zéro', () => {
  const b = rev.basket({});
  assert.equal(b.total, 0);
  assert.equal(b.blendedTakeRatePct, 0);
});
