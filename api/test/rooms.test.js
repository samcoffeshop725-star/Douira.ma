/* Détail des couchages (« Où vous dormirez ») : normalisation du formulaire.
   Ce champ est saisi librement par le propriétaire et s'affiche tel quel sur la
   fiche publique : ce qui entre doit être borné, et ce qui ne dit rien jeté. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ca = require('../lib/catalog_admin');

const n = ca.normalizeRooms;

test('une pièce saisie normalement ressort intacte, sans les espaces', () => {
  assert.deepEqual(n([{ name: '  Chambre 1 ', beds: ' 1 lit king size  ' }]),
    [{ name: 'Chambre 1', beds: '1 lit king size' }]);
});

test('une ligne entièrement vide est jetée : elle afficherait une carte muette', () => {
  assert.deepEqual(n([{ name: '', beds: '' }, { name: '   ', beds: '' }]), []);
});

test('une ligne à moitié remplie est gardée : le propriétaire a dit quelque chose', () => {
  assert.deepEqual(n([{ name: 'Salon', beds: '' }]), [{ name: 'Salon', beds: '' }]);
  assert.deepEqual(n([{ name: '', beds: '2 lits simples' }]), [{ name: '', beds: '2 lits simples' }]);
});

test('les textes sont tronqués : la fiche ne doit pas pouvoir enfler', () => {
  const r = n([{ name: 'A'.repeat(500), beds: 'B'.repeat(500) }]);
  assert.equal(r[0].name.length, 60);
  assert.equal(r[0].beds.length, 80);
});

test(`au-delà de ${ca.ROOMS_MAX} pièces, le surplus est coupé`, () => {
  const trop = Array.from({ length: ca.ROOMS_MAX + 8 }, (_, i) => ({ name: `P${i}`, beds: '1 lit' }));
  assert.equal(n(trop).length, ca.ROOMS_MAX);
  assert.equal(n(trop)[ca.ROOMS_MAX - 1].name, `P${ca.ROOMS_MAX - 1}`);
});

test('ce qui n’est pas une liste de pièces ne fait pas tomber la sauvegarde', () => {
  assert.deepEqual(n(undefined), []);
  assert.deepEqual(n(null), []);
  assert.deepEqual(n('Chambre 1'), []);
  assert.deepEqual(n([null, 42, 'x', { beds: 'ok' }]), [{ name: '', beds: 'ok' }]);
});
