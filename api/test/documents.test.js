/* Pièces justificatives exigées avant réservation (loi 09-08).
   Exécution : cd api && npm test (règles pures, aucune base) */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/documents');

const doc = (kind, status = 'verified') => ({ kind, status });

/* ---------- Ce qui est exigé ---------- */

test('un séjour exige une pièce d\'identité', () => {
  assert.deepEqual(D.requiredKinds(false), ['identity']);
});

test('louer un véhicule exige en plus le permis', () => {
  assert.deepEqual(D.requiredKinds(true), ['identity', 'permis']);
});

/* ---------- Dossier complet ou non ---------- */

test('la CIN ou le passeport suffit, indifféremment', () => {
  assert.deepEqual(D.missing([doc('cin')], false), []);
  assert.deepEqual(D.missing([doc('passeport')], false), []);
});

test('sans aucune pièce, l\'identité manque', () => {
  assert.deepEqual(D.missing([], false), ['identity']);
  assert.deepEqual(D.missing(null, false), ['identity']);
});

test('une pièce en attente de vérification ne suffit pas', () => {
  assert.deepEqual(D.missing([doc('cin', 'pending')], false), ['identity']);
});

test('une pièce refusée ne suffit pas', () => {
  assert.deepEqual(D.missing([doc('passeport', 'rejected')], false), ['identity']);
});

test('le permis seul ne remplace pas une pièce d\'identité', () => {
  assert.deepEqual(D.missing([doc('permis')], false), ['identity']);
});

test('pour un véhicule, il faut identité ET permis', () => {
  assert.deepEqual(D.missing([doc('cin')], true), ['permis']);
  assert.deepEqual(D.missing([doc('permis')], true), ['identity']);
  assert.deepEqual(D.missing([doc('cin'), doc('permis')], true), []);
});

test('un permis non vérifié bloque la location de véhicule', () => {
  assert.deepEqual(D.missing([doc('cin'), doc('permis', 'pending')], true), ['permis']);
});

/* ---------- Message rendu au client ---------- */

test('le message nomme précisément ce qui manque', () => {
  assert.match(D.missingLabel(['identity']), /pièce d'identité/);
  assert.match(D.missingLabel(['permis']), /permis/);
  const deux = D.missingLabel(['identity', 'permis']);
  assert.match(deux, /pièce d'identité/);
  assert.match(deux, / et /, 'les deux manques sont énumérés');
  assert.equal(D.missingLabel([]), '');
});

/* ---------- Fichiers acceptés ---------- */

const b64 = (n) => 'A'.repeat(n);

test('une photo JPEG, PNG, WebP ou un PDF est accepté', () => {
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) {
    const r = D.checkFile(`data:${mime};base64,${b64(100)}`);
    assert.equal(r.ok, true, mime);
    assert.equal(r.mime, mime);
  }
});

test('l\'absence de fichier est acceptée (numéro seul)', () => {
  for (const v of ['', null, undefined]) {
    const r = D.checkFile(v);
    assert.equal(r.ok, true, JSON.stringify(v));
    assert.equal(r.data, null);
  }
});

test('un format non prévu est refusé', () => {
  assert.equal(D.checkFile('data:text/html;base64,AAAA').ok, false);
  assert.equal(D.checkFile('pas une image').ok, false);
  assert.equal(D.checkFile(42).ok, false);
});

test('un fichier trop lourd est refusé', () => {
  const trop = D.checkFile(`data:image/jpeg;base64,${b64(D.MAX_FILE + 1)}`);
  assert.equal(trop.ok, false);
  assert.match(trop.reason, /2 Mo/);
});

/* ---------- Validité ---------- */

test('seule une pièce vérifiée est utilisable', () => {
  assert.equal(D.isUsable(doc('cin', 'verified')), true);
  assert.equal(D.isUsable(doc('cin', 'pending')), false);
  assert.equal(D.isUsable(doc('cin', 'rejected')), false);
  assert.equal(D.isUsable(null), false);
});
