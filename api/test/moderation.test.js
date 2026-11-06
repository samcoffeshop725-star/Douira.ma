// Règles pures de la modération : filtre de mots et normalisation.
// Sans base : seules les fonctions sans accès base sont exercées ici.
const test = require('node:test');
const assert = require('node:assert/strict');
const mod = require('../lib/moderation');

test('normaliser : minuscules, sans accents, un espace entre les mots', () => {
  assert.equal(mod.normaliser('  Énervé,   TRÈS !! '), 'enerve tres');
  assert.equal(mod.normaliser(null), '');
});

test('un mot refusé est trouvé quel que soit l’accent, la casse ou la ponctuation', () => {
  assert.ok(mod.motRefuse('Espèce de CONNARD.'));
  assert.ok(mod.motRefuse('t es un enculé'));
  assert.ok(mod.motRefuse('fuck you'));
});

test('on cherche des mots entiers : un mot ordinaire qui contient la suite n’est pas refusé', () => {
  // « pd » est refusé, « pdf » ne l'est pas ; « retard » n'attrape pas « retardé ».
  assert.equal(mod.motRefuse('Je vous envoie le pdf du contrat.'), null);
  assert.equal(mod.motRefuse('Le train a du retard, on arrivera à 16 h.'), 'retard');
  assert.equal(mod.motRefuse('Nous serons retardés de dix minutes.'), null);
});

test('un message ordinaire passe', () => {
  assert.equal(mod.motRefuse('Bonjour, à quelle heure pouvons-nous arriver ? Merci.'), null);
  assert.doesNotThrow(() => mod.exigerPublicable('Le riad est magnifique, merci pour l’accueil.'));
});

test('exigerPublicable lève 400 avec un motif pour l’utilisateur, sans citer le mot', () => {
  try {
    mod.exigerPublicable('Sale connard');
    assert.fail('aurait dû lever');
  } catch (e) {
    assert.equal(e.status, 400);
    assert.match(e.message, /ne peuvent pas être publiés/);
    assert.doesNotMatch(e.message, /connard/);
  }
});

test('les natures de signalement et les statuts sont des listes fermées', () => {
  assert.deepEqual(mod.KINDS, ['message', 'review', 'conversation', 'user']);
  assert.deepEqual(mod.STATUTS, ['open', 'reviewed', 'dismissed']);
});
