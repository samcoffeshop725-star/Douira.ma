// Validation de la photo d'un service.
//
// Cette photo est publique : elle part dans l'appli et sur le site. Ce qu'on
// accepte ici décide donc de ce qu'un visiteur peut être amené à charger.
// Deux refus comptent plus que les autres : une URL vers un domaine tiers
// (qui donnerait l'adresse IP de chaque visiteur à ce tiers), et un chemin
// qui remonte les dossiers.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const svc = require('../lib/services');

const b64 = (n = 40) => 'data:image/jpeg;base64,' + 'A'.repeat(n);

test('pas de photo est un état normal', () => {
  assert.equal(svc.photoValide(''), '');
  assert.equal(svc.photoValide('   '), '');
  assert.equal(svc.photoValide(undefined), '');
  assert.equal(svc.photoValide(null), '');
});

test('une image déposée depuis l’appli est acceptée', () => {
  assert.equal(svc.photoValide(b64()), b64());
  assert.ok(svc.photoValide('data:image/png;base64,AAAA'));
  assert.ok(svc.photoValide('data:image/webp;base64,AAAA'));
});

test('une image trop lourde est refusée, avec le motif', () => {
  assert.throws(() => svc.photoValide(b64(2_100_000)), /2 Mo/);
});

test('un format d’image non géré est refusé', () => {
  assert.throws(() => svc.photoValide('data:image/svg+xml;base64,AAAA'), /invalide/);
  assert.throws(() => svc.photoValide('data:text/html;base64,AAAA'), /invalide/);
});

test('un chemin relatif du site est accepté', () => {
  assert.equal(svc.photoValide('photos/svc-1.jpg'), 'photos/svc-1.jpg');
  assert.equal(svc.photoValide('photos/hammam.webp?v=2'), 'photos/hammam.webp?v=2');
});

test('une adresse vers un autre domaine est refusée', () => {
  // Elle ferait charger au visiteur une image que le site ne maîtrise pas, et
  // livrerait son adresse IP à ce domaine.
  assert.throws(() => svc.photoValide('https://exemple.com/x.jpg'), /invalide/);
  assert.throws(() => svc.photoValide('//exemple.com/x.jpg'), /invalide/);
  assert.throws(() => svc.photoValide('javascript:alert(1)'), /invalide/);
});

test('un chemin qui remonte les dossiers est refusé', () => {
  assert.throws(() => svc.photoValide('../../etc/passwd.jpg'), /invalide/);
  assert.throws(() => svc.photoValide('/etc/passwd.jpg'), /invalide/);
});

test('un fichier qui n’est pas une image est refusé', () => {
  assert.throws(() => svc.photoValide('photos/script.js'), /invalide/);
  assert.throws(() => svc.photoValide('photos/archive.zip'), /invalide/);
});
