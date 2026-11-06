/* =====================================================================
   Les règles d'une prestation.

   Ce qui est éprouvé ici est précisément ce qui protège le client : le prix
   annoncé avant le travail, le bon prestataire, la bonne carte aux deux
   bouts, et un état qui ne ment pas sur ce qui a été payé.
   ===================================================================== */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const iv = require('../lib/interventions');

/* ---------------- Le montant demandé ---------------- */

test('un prix entier passe, et le zéro aussi', () => {
  assert.equal(iv.montantValide(350), 350);
  assert.equal(iv.montantValide('350'), 350);
  // Un geste commercial est un montant, pas une absence de montant : il doit
  // s'enregistrer, sans quoi la prestation paraîtrait n'avoir jamais eu lieu.
  assert.equal(iv.montantValide(0), 0);
});

test('un prix manquant est refusé : on ne commence pas sans l’annoncer', () => {
  for (const v of [null, undefined, '']) {
    assert.throws(() => iv.montantValide(v), /Indiquez le prix demandé/);
  }
});

test('un prix négatif ou non numérique est refusé', () => {
  assert.throws(() => iv.montantValide(-1), /négatif/);
  assert.throws(() => iv.montantValide('abc'), /nombre/);
  assert.throws(() => iv.montantValide(NaN), /nombre/);
  assert.throws(() => iv.montantValide(Infinity), /nombre/);
});

test('les centimes sont refusés plutôt qu’arrondis en silence', () => {
  // Arrondir, c'est annoncer un prix que personne n'a saisi.
  assert.throws(() => iv.montantValide(350.5), /unités entières/);
});

test('une faute de frappe démesurée est refusée', () => {
  assert.throws(() => iv.montantValide(99999999), /maximum/);
});

test('le refus porte un code HTTP utilisable, pas une erreur nue', () => {
  try { iv.montantValide(-1); assert.fail('aurait dû lever'); }
  catch (e) { assert.equal(e.status, 400); }
});

/* ---------------- Qui a le droit de scanner ---------------- */

const service = (assignee) => ({ id: 's1', assignee_id: assignee });

test('le prestataire à qui le service est confié peut intervenir', () => {
  assert.equal(iv.peutIntervenir({ id: 'u1', role: 'collaborator' }, service('u1')), true);
});

test('un collaborateur ne facture pas au nom d’un autre', () => {
  // Sans cette règle, le journal des scans désignerait le mauvais responsable.
  assert.equal(iv.peutIntervenir({ id: 'u2', role: 'collaborator' }, service('u1')), false);
});

test('un service confié à personne n’est pas à prendre', () => {
  assert.equal(iv.peutIntervenir({ id: 'u1', role: 'collaborator' }, service(null)), false);
});

test('l’administration passe partout : elle doit pouvoir dépanner sur place', () => {
  assert.equal(iv.peutIntervenir({ id: 'a', role: 'admin' }, service(null)), true);
  assert.equal(iv.peutIntervenir({ id: 'a', role: 'admin' }, service('u1')), true);
});

test('ni un client ni un propriétaire ne scannent une prestation', () => {
  assert.equal(iv.peutIntervenir({ id: 'c1', role: 'client' }, service('c1')), false);
  assert.equal(iv.peutIntervenir({ id: 'o1', role: 'owner' }, service('o1')), false);
  assert.equal(iv.peutIntervenir({ id: 'g1', role: 'agency' }, service('g1')), false);
});

test('sans utilisateur ou sans service, c’est non', () => {
  assert.equal(iv.peutIntervenir(null, service('u1')), false);
  assert.equal(iv.peutIntervenir({ id: 'u1', role: 'collaborator' }, null), false);
});

test('la comparaison des identifiants ne dépend pas du type', () => {
  assert.equal(iv.peutIntervenir({ id: 7, role: 'collaborator' }, { id: 's1', assignee_id: '7' }), true);
});

/* ---------------- La même carte aux deux bouts ---------------- */

test('on ne ferme qu’avec la carte du client qu’on a ouvert', () => {
  const p = { client_id: 'c1' };
  assert.equal(iv.memeClient(p, 'c1'), true);
  assert.equal(iv.memeClient(p, 'c2'), false);
});

test('une prestation ou un client absent ne valide rien', () => {
  assert.equal(iv.memeClient(null, 'c1'), false);
  assert.equal(iv.memeClient({ client_id: 'c1' }, null), false);
  assert.equal(iv.memeClient({ client_id: 'c1' }, ''), false);
});

/* ---------------- L'état que lit le client ---------------- */

test('une prestation en cours se dit « en cours »', () => {
  assert.equal(iv.etatClient({ status: 'en_cours', paid_at: null }), 'en_cours');
});

test('terminée et non réglée se lit « à payer »', () => {
  assert.equal(iv.etatClient({ status: 'terminee', paid_at: null }), 'a_payer');
});

test('terminée et réglée se lit « réglée »', () => {
  assert.equal(iv.etatClient({ status: 'terminee', paid_at: '2026-11-02T10:00:00Z' }), 'reglee');
});

test('annulée l’emporte sur tout le reste', () => {
  // Même réglée par erreur, une prestation annulée n'a pas eu lieu : dire
  // « réglée » laisserait croire qu'un travail a été fait.
  assert.equal(iv.etatClient({ status: 'annulee', paid_at: '2026-11-02T10:00:00Z' }), 'annulee');
});

test('chaque état a son libellé français, aucun ne manque', () => {
  for (const e of ['en_cours', 'a_payer', 'reglee', 'annulee']) {
    assert.ok(iv.LIBELLE[e], `libellé manquant pour ${e}`);
  }
});

test('une prestation absente ne produit pas d’état inventé', () => {
  assert.equal(iv.etatClient(null), '');
  assert.equal(iv.etatClient(undefined), '');
});

/* ---------------- La devise ---------------- */

test('la devise suit la ville, et c’est LA MÊME que pour les séjours (lib/money.js)', () => {
  // Dakar est facturé en euros partout ailleurs : une table à part disait
  // « francs CFA » ici, et un ménage à 50 devenait 50 XOF — huit centimes.
  const mny = require('../lib/money');
  assert.equal(iv.deviseDe('Marrakech'), mny.currencyForCity('Marrakech'));
  assert.equal(iv.deviseDe('Dakar'), mny.currencyForCity('Dakar'));
  assert.equal(iv.deviseDe('dakar'), iv.deviseDe(' Dakar '));
  assert.equal(iv.deviseDe('Dakar'), 'EUR');
});

test('sans ville connue, on retombe sur le dirham plutôt que sur rien', () => {
  // Une devise vide rendrait tous les montants illisibles ; le siège est au
  // Maroc, c'est le repli le moins surprenant.
  assert.equal(iv.deviseDe(''), 'MAD');
  assert.equal(iv.deviseDe(null), 'MAD');
  assert.equal(iv.deviseDe('Essaouira'), 'MAD');
});
