// L'identifiant d'un bien : celui que le client connaît n'est pas celui de
// la base.
//
// Le catalogue public ne publie que les chiffres de l'identifiant (« b1 »
// devient « 1 »), pour que les liens du site restent les mêmes quand la base
// prend le relais de config.js. Le serveur, lui, range tout par « b1 ».
//
// Sans la correspondance, deux choses cassent, et la seconde en silence :
//   - devis et réservation répondent « Logement introuvable » ;
//   - le calendrier d'un bien complet paraît entièrement libre.
//
// C'est ce que ces essais empêchent de revenir.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const cat = require('../lib/catalog');

const BIENS = [{ id: 'b1' }, { id: 'b2' }, { id: 'b10' }];

test('l’identifiant public « 1 » retrouve le bien interne « b1 »', () => {
  assert.equal(cat.trouverBien(BIENS, '1').id, 'b1');
  assert.equal(cat.trouverBien(BIENS, '2').id, 'b2');
  assert.equal(cat.trouverBien(BIENS, '10').id, 'b10');
});

test('l’identifiant interne continue de fonctionner', () => {
  assert.equal(cat.trouverBien(BIENS, 'b1').id, 'b1');
  assert.equal(cat.trouverBien(BIENS, 'b10').id, 'b10');
});

test('une correspondance EXACTE prime sur la correspondance par chiffres', () => {
  // Sinon un bien réellement nommé « 1 » serait détourné vers « b1 ».
  const melange = [{ id: 'b1' }, { id: '1' }];
  assert.equal(cat.trouverBien(melange, '1').id, '1');
  assert.equal(cat.trouverBien(melange, 'b1').id, 'b1');
});

test('un identifiant vide, absent ou sans chiffre ne trouve rien', () => {
  for (const v of ['', null, undefined, 'abc', '   ']) {
    assert.equal(cat.trouverBien(BIENS, v), null, 'valeur : ' + JSON.stringify(v));
  }
});

test('une liste vide ou absente ne lève pas', () => {
  assert.equal(cat.trouverBien([], '1'), null);
  assert.equal(cat.trouverBien(null, '1'), null);
});

test('un bien inconnu reste inconnu', () => {
  assert.equal(cat.trouverBien(BIENS, '99'), null);
  assert.equal(cat.trouverBien(BIENS, 'b99'), null);
});

test('internalId rend ce qu’on lui donne quand le bien est inconnu', () => {
  // L'appelant doit pouvoir lever sa propre erreur, pas recevoir du vide.
  assert.equal(cat.internalId('inexistant-42'), 'inexistant-42');
  assert.equal(cat.internalId(''), '');
});

test('le catalogue réellement chargé se retrouve par son identifiant public', () => {
  // Épreuve de bout en bout sur le vrai repli config.js : c'est exactement ce
  // que l'appli envoie (« 1 ») contre ce que le serveur range (« b1 »).
  const list = cat.listings();
  if (!list.length) return; // pas de config.js ici : rien à prouver
  const interne = list[0].id;
  const publie = String(interne).replace(/\D/g, '');
  assert.equal(cat.listing(publie).id, interne, `public ${publie} → interne ${interne}`);
  assert.equal(cat.internalId(publie), interne);
});
