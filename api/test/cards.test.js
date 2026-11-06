// Niveaux de la carte de membre.
//
// Deux choses comptent ici : l'ORDRE (un black ne doit jamais valoir moins
// qu'un gold) et le REPLI (une valeur inconnue en base ne doit pas priver
// quelqu'un de sa carte).

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const cards = require('../lib/cards');

test('la hiérarchie est celle annoncée', () => {
  assert.deepEqual(cards.NIVEAUX.map((n) => n.key), ['classique', 'bronze', 'gold', 'black']);
  assert.ok(cards.rang('black') > cards.rang('gold'));
  assert.ok(cards.rang('gold') > cards.rang('bronze'));
  assert.ok(cards.rang('bronze') > cards.rang('classique'));
});

test('un niveau inconnu retombe sur classique plutôt que de disparaître', () => {
  // Une carte sans niveau n'existe pas : personne ne doit se retrouver sans
  // carte parce que la base contient une valeur inattendue.
  assert.equal(cards.cleValide('platine'), 'classique');
  assert.equal(cards.cleValide(''), 'classique');
  assert.equal(cards.cleValide(null), 'classique');
  assert.equal(cards.cleValide(undefined), 'classique');
  assert.equal(cards.cleValide(42), 'classique');
});

test('la casse et les espaces ne changent rien', () => {
  assert.equal(cards.cleValide('  GOLD '), 'gold');
  assert.equal(cards.cleValide('Black'), 'black');
});

test('auMoins compare des niveaux, pas des chaînes', () => {
  assert.ok(cards.auMoins('black', 'gold'));
  assert.ok(cards.auMoins('gold', 'gold'));
  assert.ok(!cards.auMoins('bronze', 'gold'));
  assert.ok(cards.auMoins('classique', 'classique'));
});

test('un niveau inconnu n’ouvre aucun droit réservé', () => {
  // Le repli protège l'affichage, pas les privilèges.
  assert.ok(!cards.auMoins('platine', 'gold'));
  assert.ok(!cards.auMoins(null, 'bronze'));
});

test('le service client monte avec le niveau, sans jamais redescendre', () => {
  const supports = cards.NIVEAUX.map((n) => n.support);
  for (let i = 1; i < supports.length; i += 1) {
    assert.ok(supports[i] >= supports[i - 1], `${cards.NIVEAUX[i].key} ne doit pas offrir moins`);
  }
  assert.ok(cards.vue('gold').supportPrioritaire);
  assert.ok(cards.vue('black').supportPrioritaire);
  assert.ok(!cards.vue('bronze').supportPrioritaire);
  assert.ok(!cards.vue('classique').supportPrioritaire);
});

test('la vue publique porte tout ce que l’appli affiche', () => {
  const v = cards.vue('gold');
  assert.equal(v.key, 'gold');
  assert.equal(v.label, 'Gold');
  assert.equal(v.rang, 2);
  assert.equal(typeof v.supportLabel, 'string');
  assert.ok(v.supportLabel.length > 0);
});

test('aucun niveau n’annonce de pourcentage de réduction', () => {
  // Les offres par niveau ne sont pas arrêtées : une remise annoncée puis
  // démentie coûte plus cher qu'une remise absente.
  for (const n of cards.NIVEAUX) {
    assert.ok(!/%/.test(JSON.stringify(n)), `${n.key} ne doit pas promettre de pourcentage`);
  }
});
