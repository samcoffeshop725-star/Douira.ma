// Offres des cartes de membre : prix et avantages.
//
// Ce que ces règles protègent : ne jamais annoncer une gratuité que personne
// n'a décidée, et ne jamais afficher une liste d'avantages si longue qu'elle
// ne promet plus rien.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const cards = require('../lib/cards');

/* ---------------- Prix ---------------- */

test('un prix absent reste absent : ce n’est pas la gratuité', () => {
  // « Pas encore fixé » et « gratuit » sont deux promesses différentes.
  assert.equal(cards.prixValide(null), null);
  assert.equal(cards.prixValide(undefined), null);
  assert.equal(cards.prixValide(''), null);
});

test('la gratuité se dit explicitement', () => {
  assert.equal(cards.prixValide(0), 0);
  assert.equal(cards.prixValide('0'), 0);
});

test('un prix est arrondi au centime', () => {
  assert.equal(cards.prixValide(49900), 49900);
  assert.equal(cards.prixValide('49900'), 49900);
  assert.equal(cards.prixValide(49900.4), 49900);
});

test('un prix absurde est refusé, pas corrigé', () => {
  assert.throws(() => cards.prixValide(-1), /invalide/);
  assert.throws(() => cards.prixValide('cher'), /invalide/);
  assert.throws(() => cards.prixValide(Infinity), /invalide/);
});

/* ---------------- Avantages ---------------- */

test('les lignes vides sont écartées', () => {
  assert.deepEqual(
    cards.normaliserAvantages(['  ', 'Accès prioritaire', '', '   Transferts offerts  ']),
    ['Accès prioritaire', 'Transferts offerts'],
  );
});

test('une saisie en texte libre se découpe par lignes', () => {
  // L'administration tape dans un champ multiligne, pas dans un tableau.
  assert.deepEqual(
    cards.normaliserAvantages('Premier\nDeuxième\n\nTroisième'),
    ['Premier', 'Deuxième', 'Troisième'],
  );
});

test('une carte ne promet pas trente choses', () => {
  const trente = Array.from({ length: 30 }, (_, i) => `Avantage ${i + 1}`);
  const r = cards.normaliserAvantages(trente);
  assert.equal(r.length, cards.AVANTAGES_MAX);
  assert.equal(r[0], 'Avantage 1');
});

test('un avantage interminable est coupé', () => {
  const long = 'x'.repeat(400);
  assert.equal(cards.normaliserAvantages([long])[0].length, 140);
});

test('une entrée absurde ne lève pas', () => {
  assert.deepEqual(cards.normaliserAvantages(null), []);
  assert.deepEqual(cards.normaliserAvantages(undefined), []);
  assert.deepEqual(cards.normaliserAvantages([null, undefined, 0]), []);
});

/* ---------------- Vue ---------------- */

test('un niveau sans ligne en base reste un niveau valide', () => {
  // Tant que l'administration n'a rien saisi, la carte existe sans prix ni
  // avantage — et l'appli devra le dire plutôt qu'inventer.
  const v = cards.vueOffre({ key: 'gold' });
  assert.equal(v.key, 'gold');
  assert.equal(v.label, 'Gold');
  assert.equal(v.prix, null);
  assert.deepEqual(v.avantages, []);
  assert.equal(v.accroche, '');
});

test('la vue porte toujours le service client, qui lui est décidé', () => {
  assert.ok(cards.vueOffre({ key: 'black' }).supportLabel.length > 0);
  assert.equal(cards.vueOffre({ key: 'gold' }).supportPrioritaire, true);
  assert.equal(cards.vueOffre({ key: 'bronze' }).supportPrioritaire, false);
});

test('des avantages illisibles en base ne cassent pas la page', () => {
  assert.deepEqual(cards.vueOffre({ key: 'gold', benefits: 'pas du json' }).avantages, []);
  assert.deepEqual(cards.vueOffre({ key: 'gold', benefits: '["Un","Deux"]' }).avantages, ['Un', 'Deux']);
});

test('un niveau inconnu retombe sur classique', () => {
  assert.equal(cards.vueOffre({ key: 'platine' }).key, 'classique');
});
