// Règles de facturation.
//
// Une facture est un document comptable : elle doit annoncer exactement ce qui
// a été payé, et ne jamais inventer d'identifiant légal. Ce sont les deux
// choses que ces tests tiennent.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const inv = require('../lib/invoices');

const DEVIS = {
  unit: 'nuit', qty: 3, price: 750, gross: 2250,
  discountPct: 20, discount: 450, base: 1800,
  serviceFee: 0, tax: 0, total: 1800,
  guests: 2, policy: 'moderee', listingId: 'b1', title: 'Riad au cœur de la médina', currency: 'MAD',
};

const RESA = {
  id: 'DR-123456', user_id: 'u1', listing_id: 'b1',
  start_date: '2026-11-28', end_date: '2026-12-01', guests: 2,
  status: 'confirmed', quote: DEVIS, amount: 180000, currency: 'MAD',
  paid_at: '2026-10-31T10:00:00Z', psp: 'stripe',
};

const CLIENT = { id: 'u1', name: 'Hajar S.', email: 'hajar@exemple.ma' };

/* ---------------- Numérotation ---------------- */

test('le numéro est séquentiel, cadré, et porte l’année d’émission', () => {
  assert.equal(inv.numeroFacture(42, '2026-10-31T10:00:00Z'), 'F-2026-000042');
  assert.equal(inv.numeroFacture(1, '2027-01-02T00:00:00Z'), 'F-2027-000001');
});

test('le numéro garde l’année d’émission, pas l’année courante', () => {
  // Une facture relue plus tard ne doit pas changer de numéro.
  assert.equal(inv.numeroFacture(7, '2024-03-01T00:00:00Z'), 'F-2024-000007');
});

test('une date illisible ne produit pas un numéro cassé', () => {
  const n = inv.numeroFacture(5, 'pas une date');
  assert.match(n, /^F-\d{4}-000005$/);
});

/* ---------------- Lignes ---------------- */

test('la remise paraît en négatif, sous l’hébergement', () => {
  const l = inv.lignes(DEVIS);
  assert.equal(l.length, 2);
  assert.equal(l[0].montant, 225000);
  assert.match(l[0].libelle, /3 nuits/);
  assert.equal(l[1].montant, -45000);
  assert.match(l[1].libelle, /20 %/);
});

test('sans remise ni frais, une seule ligne', () => {
  const l = inv.lignes({ ...DEVIS, discount: 0, discountPct: 0 });
  assert.equal(l.length, 1);
});

test('frais de service et taxes apparaissent quand ils existent', () => {
  const l = inv.lignes({ ...DEVIS, serviceFee: 100, tax: 50 });
  assert.deepEqual(l.map(x => x.montant), [225000, -45000, 10000, 5000]);
});

test('une nuit s’écrit au singulier', () => {
  assert.match(inv.lignes({ ...DEVIS, qty: 1 })[0].libelle, /1 nuit$/);
});

test('un devis vide ne lève pas et ne produit aucune ligne', () => {
  assert.deepEqual(inv.lignes(null), []);
  assert.deepEqual(inv.lignes({}), []);
});

/* ---------------- Construction ---------------- */

test('le total facturé est le montant encaissé, pas la somme des lignes', () => {
  // Si les deux divergeaient, c'est le paiement qui fait foi : le client ne
  // doit jamais lire sur sa facture autre chose que ce qu'il a payé.
  const f = inv.buildInvoice({
    booking: { ...RESA, amount: 175000 }, user: CLIENT, listing: null, vendeur: {}, numero: 1,
    emiseLe: '2026-10-31T10:00:00Z',
  });
  assert.equal(f.total, 175000);
  assert.notEqual(f.total, f.lignes.reduce((s, l) => s + l.montant, 0));
});

test('la facture recopie le client et le séjour au moment de l’émission', () => {
  const f = inv.buildInvoice({
    booking: RESA, user: CLIENT,
    listing: { title: 'Riad au cœur de la médina', city: 'Marrakech' },
    vendeur: {}, numero: 1, emiseLe: '2026-10-31T10:00:00Z',
  });
  assert.equal(f.client.nom, 'Hajar S.');
  assert.equal(f.sejour.logement, 'Riad au cœur de la médina');
  assert.equal(f.sejour.ville, 'Marrakech');
  assert.equal(f.sejour.arrivee, '2026-11-28');
  assert.equal(f.reference, 'DR-123456');
});

test('un logement retiré du catalogue laisse le titre du devis', () => {
  const f = inv.buildInvoice({
    booking: RESA, user: CLIENT, listing: null, vendeur: {}, numero: 1, emiseLe: '2026-10-31T10:00:00Z',
  });
  assert.equal(f.sejour.logement, 'Riad au cœur de la médina');
});

/* ---------------- Identité du vendeur ---------------- */

test('aucun identifiant légal n’est inventé', () => {
  const f = inv.buildInvoice({
    booking: RESA, user: CLIENT, listing: null, vendeur: {}, numero: 1, emiseLe: '2026-10-31T10:00:00Z',
  });
  assert.equal(f.vendeur.ice, '');
  assert.equal(f.vendeur.rc, '');
  assert.equal(f.vendeur.if, '');
  // Et ils ne paraissent pas non plus dans le document.
  const html = inv.invoiceHtml(f);
  assert.ok(!/ICE/.test(html), 'une mention ICE vide ne doit pas s’imprimer');
});

test('les identifiants renseignés sont repris tels quels', () => {
  const f = inv.buildInvoice({
    booking: RESA, user: CLIENT, listing: null,
    vendeur: { nom: 'Douira SARL', ice: '002345678000091', rc: '12345', adresse: 'Guéliz' },
    numero: 1, emiseLe: '2026-10-31T10:00:00Z',
  });
  assert.equal(f.vendeur.ice, '002345678000091');
  assert.match(inv.invoiceHtml(f), /ICE 002345678000091/);
});

/* ---------------- Rendu ---------------- */

test('le HTML échappe ce qui vient du client', () => {
  const f = inv.buildInvoice({
    booking: RESA, user: { name: '<script>alert(1)</script>', email: 'x@y.z' },
    listing: null, vendeur: {}, numero: 1, emiseLe: '2026-10-31T10:00:00Z',
  });
  const html = inv.invoiceHtml(f);
  assert.ok(!html.includes('<script>'), 'un nom ne doit jamais devenir du balisage');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('le montant n’est jamais converti : la devise reste celle du paiement', () => {
  // Le séparateur de milliers dépend de la plateforme (espace fine insécable) :
  // on vérifie les chiffres et la devise, pas la typographie.
  const mad = inv.montant(180000, 'MAD');
  assert.equal(mad.replace(/\s/g, ' '), '1 800 MAD');
  assert.equal(inv.montant(180000, 'XOF').replace(/\s/g, ' '), '1 800 XOF');
  // Les centimes ne paraissent que s'il y en a.
  assert.equal(inv.montant(180050, 'MAD').replace(/\s/g, ' '), '1 800,5 MAD');
});

test('la version texte reprend le total et la référence', () => {
  const f = inv.buildInvoice({
    booking: RESA, user: CLIENT, listing: null, vendeur: {}, numero: 9, emiseLe: '2026-10-31T10:00:00Z',
  });
  const t = inv.invoiceText(f);
  assert.match(t, /F-2026-000009/);
  assert.match(t, /DR-123456/);
  assert.match(t, /Total payé/);
});
