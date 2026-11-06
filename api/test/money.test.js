/* Règles de devise. Exécution : cd api && npm test (aucune base nécessaire) */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const money = require('../lib/money');

/* ---------- Devise par ville ---------- */

test('chaque ville ouverte a sa devise', () => {
  assert.equal(money.currencyForCity('Marrakech'), 'MAD');
  // Dakar est facturé en euros tant qu'aucun prestataire n'encaisse le franc CFA.
  assert.equal(money.currencyForCity('Dakar'), 'EUR');
});

test('la ville est reconnue quelle que soit la casse ou les espaces', () => {
  assert.equal(money.currencyForCity('  dakar '), 'EUR');
  assert.equal(money.currencyForCity('MARRAKECH'), 'MAD');
});

test('une ville inconnue retombe sur la devise par défaut', () => {
  assert.equal(money.currencyForCity('Tombouctou'), 'MAD');
  assert.equal(money.currencyForCity('Tombouctou', 'EUR'), 'EUR');
  assert.equal(money.currencyForCity(''), 'MAD');
  assert.equal(money.currencyForCity(undefined), 'MAD');
});

/* ---------- Devises sans décimale ---------- */

test('le franc CFA n\'a pas de centimes, le dirham si', () => {
  assert.equal(money.hasDecimals('MAD'), true);
  assert.equal(money.hasDecimals('EUR'), true);
  assert.equal(money.hasDecimals('XOF'), false);
  assert.equal(money.hasDecimals('xof'), false, 'casse indifférente');
  assert.equal(money.hasDecimals('JPY'), false);
});

/* ---------- Conversions ---------- */

test('stockage et affichage se correspondent (dirham)', () => {
  assert.equal(money.toMinor(750, 'MAD'), 75000);
  assert.equal(money.toMajor(75000, 'MAD'), 750);
  assert.equal(money.toMinor(750.5, 'MAD'), 75050, 'les centimes sont conservés');
  assert.equal(money.toMajor(75050, 'MAD'), 750.5);
});

test('stockage et affichage se correspondent (franc CFA)', () => {
  assert.equal(money.toMinor(15000, 'XOF'), 1500000);
  assert.equal(money.toMajor(1500000, 'XOF'), 15000);
  // Pas de centimes en XOF : un montant fractionnaire est arrondi à l'unité la plus proche.
  assert.equal(money.toMinor(15000.7, 'XOF'), 1500100);
  assert.equal(money.toMinor(15000.2, 'XOF'), 1500000);
});

/* ---------- Montant transmis au prestataire ---------- */

test('le montant envoyé au prestataire garde les centimes en dirham', () => {
  assert.equal(money.pspAmount(75000, 'MAD'), 75000);
});

test('le montant envoyé au prestataire retire les centièmes en franc CFA', () => {
  // 15 000 F CFA stockés en 1 500 000 : envoyer 1 500 000 facturerait 100× trop.
  assert.equal(money.pspAmount(1500000, 'XOF'), 15000);
});

test('pspAmount tolère les valeurs vides sans produire NaN', () => {
  assert.equal(money.pspAmount(0, 'XOF'), 0);
  assert.equal(money.pspAmount(undefined, 'MAD'), 0);
  assert.equal(money.pspAmount(null, 'XOF'), 0);
});

/* ---------- Compatibilité prestataire / devise ---------- */

test('CMI encaisse le dirham et l\'euro, pas le franc CFA', () => {
  assert.equal(money.pspSupports('cmi', 'MAD'), true);
  assert.equal(money.pspSupports('cmi', 'EUR'), true);
  assert.equal(money.pspSupports('cmi', 'XOF'), false);
});

test('Stripe n\'encaisse pas le franc CFA dans cette intégration', () => {
  assert.equal(money.pspSupports('stripe', 'MAD'), true);
  assert.equal(money.pspSupports('stripe', 'EUR'), true);
  assert.equal(money.pspSupports('stripe', 'XOF'), false);
});

test('le prestataire de simulation accepte tout, un prestataire inconnu rien', () => {
  assert.equal(money.pspSupports('simulate', 'XOF'), true);
  assert.equal(money.pspSupports('inconnu', 'MAD'), false);
  assert.equal(money.pspSupports('', 'MAD'), false);
});

test('aucune ville ouverte ne doit rester sans moyen d\'encaissement silencieux', () => {
  // Garde-fou : si une ville utilise une devise qu'aucun prestataire réel ne gère,
  // le test le signale — il faudra brancher un prestataire local avant d'ouvrir.
  const reels = ['cmi', 'stripe'];
  const sansPsp = Object.entries(money.CURRENCY_BY_CITY)
    .filter(([, cur]) => !reels.some(p => money.pspSupports(p, cur)))
    .map(([ville, cur]) => `${ville} (${cur})`);
  assert.deepEqual(
    sansPsp,
    [],
    'Une ville ouverte sans prestataire capable de sa devise : brancher un prestataire local, ou facturer dans une devise encaissable.',
  );
});
