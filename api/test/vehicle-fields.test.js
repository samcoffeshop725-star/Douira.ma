// Fiche d'un véhicule : les listes saisies par l'équipe, et sa vignette.
//
// L'écran d'administration saisit la galerie et les équipements ligne à ligne.
// Ce qui est vérifié ici, c'est ce que le serveur garde de cette saisie : les
// lignes vides se jettent, les longueurs se bornent, et le nombre d'éléments
// est plafonné — sinon la onzième photo disparaîtrait en silence sans que
// personne ne sache pourquoi.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const veh = require('../lib/vehicles');
const svc = require('../lib/services');

test('un texte à lignes devient une liste propre', () => {
  assert.deepEqual(
    veh.normaliserListe('  Climatisation \n\n GPS \n', veh.EQUIPEMENTS_MAX, 60),
    ['Climatisation', 'GPS']);
});

test('un tableau est accepté tel quel, ce qui n’est pas du texte est jeté', () => {
  assert.deepEqual(veh.normaliserListe(['GPS', null, 42, 'Sièges enfant'], 10, 60), ['GPS', 'Sièges enfant']);
});

test('rien de saisi donne une liste vide, pas une ligne vide', () => {
  assert.deepEqual(veh.normaliserListe('', 10, 60), []);
  assert.deepEqual(veh.normaliserListe('   \n  \n', 10, 60), []);
  assert.deepEqual(veh.normaliserListe(undefined, 10, 60), []);
});

test('le nombre d’éléments et leur longueur sont bornés', () => {
  const beaucoup = Array.from({ length: 30 }, (_, i) => 'photo-' + i + '.jpg');
  assert.equal(veh.normaliserListe(beaucoup, veh.PHOTOS_MAX, 300).length, veh.PHOTOS_MAX);
  assert.equal(veh.normaliserListe(['x'.repeat(200)], 10, 60)[0].length, 60);
});

test('la vignette d’un véhicule suit la règle des photos de service', () => {
  // Une seule règle pour une seule chose : si l'une des deux change, les deux
  // changent. Une agence dépose son image depuis l'appli, et aucune adresse
  // vers un domaine tiers ne passe.
  assert.equal(veh.photoValide, svc.photoValide);
  assert.ok(veh.photoValide('data:image/jpeg;base64,AAAA'));
  assert.equal(veh.photoValide('photos/duster.jpg'), 'photos/duster.jpg');
  assert.throws(() => veh.photoValide('https://exemple.com/x.jpg'), /invalide/);
});
