// Vérification du visage : les règles qui décident, avant toute base.
//
// Ce qui est vérifié ici compte plus que la moyenne : ce sont les règles qui
// ouvrent ou ferment l'accès à une location, et celles qui bornent le
// traitement d'une donnée biométrique. Une erreur de l'autre côté n'est pas un
// affichage de travers, c'est un client bloqué ou une photo gardée trop
// longtemps.

'use strict';
process.env.DATA_KEY = process.env.DATA_KEY || Buffer.alloc(32, 7).toString('base64');
const { test } = require('node:test');
const assert = require('node:assert');
const kyc = require('../lib/kyc');

const jpeg = (n = 40) => 'data:image/jpeg;base64,' + 'A'.repeat(n);
const ilya = (h) => new Date(Date.now() - h * 3600000).toISOString();

/* ---------------- Le selfie ---------------- */

test('un selfie JPEG, PNG ou WebP est accepté', () => {
  assert.equal(kyc.checkSelfie(jpeg()).ok, true);
  assert.equal(kyc.checkSelfie('data:image/png;base64,AAAA').ok, true);
  assert.equal(kyc.checkSelfie('data:image/webp;base64,AAAA').ok, true);
});

test('un PDF est refusé : un visage n’est pas un document scanné', () => {
  const r = kyc.checkSelfie('data:application/pdf;base64,AAAA');
  assert.equal(r.ok, false);
  assert.match(r.reason, /JPEG/);
});

test('rien, ou n’importe quoi, est refusé avec un motif', () => {
  assert.equal(kyc.checkSelfie('').ok, false);
  assert.equal(kyc.checkSelfie(null).ok, false);
  assert.equal(kyc.checkSelfie('https://exemple.com/x.jpg').ok, false);
  assert.match(kyc.checkSelfie('').reason, /Aucune photo/);
});

test('une photo trop lourde est refusée, avec la limite dans le message', () => {
  const r = kyc.checkSelfie(jpeg(2_000_000));
  assert.equal(r.ok, false);
  assert.match(r.reason, /1,5 Mo/);
});

/* ---------------- La pièce à comparer ---------------- */

test('on compare au portrait d’une pièce d’identité, pas au permis', () => {
  const p = kyc.pieceAComparer([
    { id: '1', kind: 'permis', status: 'verified' },
    { id: '2', kind: 'passeport', status: 'verified' },
  ]);
  assert.equal(p.id, '2');
});

test('une pièce vérifiée prime sur une pièce encore en attente', () => {
  const p = kyc.pieceAComparer([
    { id: '1', kind: 'cin', status: 'pending' },
    { id: '2', kind: 'passeport', status: 'verified' },
  ]);
  assert.equal(p.id, '2');
});

test('sans pièce d’identité, il n’y a rien à comparer', () => {
  assert.equal(kyc.pieceAComparer([{ id: '1', kind: 'permis', status: 'verified' }]), null);
  assert.equal(kyc.pieceAComparer([]), null);
  assert.equal(kyc.pieceAComparer(null), null);
});

/* ---------------- L'état ---------------- */

test('sans contrôle, l’état est « absente » — pas « refusée »', () => {
  assert.equal(kyc.etat([]).statut, 'absente');
  assert.equal(kyc.etat(null).statut, 'absente');
});

test('une vérification acceptée vaut un an, puis expire', () => {
  const recent = [{ status: 'passed', decided_at: ilya(24), created_at: ilya(25) }];
  assert.equal(kyc.etat(recent).statut, 'validee');

  const vieux = [{ status: 'passed', decided_at: ilya(24 * 400), created_at: ilya(24 * 400) }];
  // Expirée, pas refusée : on la redemande sans rien reprocher.
  assert.equal(kyc.etat(vieux).statut, 'expiree');
});

test('un refus porte son motif', () => {
  const e = kyc.etat([{ status: 'failed', reason: 'Visage non concordant.', decided_at: ilya(1), created_at: ilya(2) }]);
  assert.equal(e.statut, 'refusee');
  assert.equal(e.motif, 'Visage non concordant.');
});

test('seul le contrôle le plus récent décide', () => {
  const rows = [
    { status: 'passed', decided_at: ilya(1), created_at: ilya(2) },
    { status: 'failed', reason: 'ancien', decided_at: ilya(48), created_at: ilya(49) },
  ];
  assert.equal(kyc.etat(rows).statut, 'validee');
});

/* ---------------- Les tentatives ---------------- */

test('trois tentatives par jour, pas quatre', () => {
  const trois = [1, 2, 3].map(h => ({ status: 'failed', reason: 'x', created_at: ilya(h), decided_at: ilya(h) }));
  const r = kyc.peutTenter(trois);
  assert.equal(r.ok, false);
  assert.match(r.raison, /Trop de tentatives/);
});

test('les tentatives d’hier ne comptent plus aujourd’hui', () => {
  const vieilles = [26, 30, 40].map(h => ({ status: 'failed', reason: 'x', created_at: ilya(h), decided_at: ilya(h) }));
  assert.equal(kyc.peutTenter(vieilles).ok, true);
});

test('un dossier en cours d’examen n’en ouvre pas un second', () => {
  const r = kyc.peutTenter([{ status: 'review', created_at: ilya(1) }]);
  assert.equal(r.ok, false);
  assert.match(r.raison, /examen/);
});

test('une identité déjà confirmée ne se revérifie pas', () => {
  const r = kyc.peutTenter([{ status: 'passed', decided_at: ilya(1), created_at: ilya(2) }]);
  assert.equal(r.ok, false);
  assert.match(r.raison, /déjà confirmée/);
});

test('après un refus, on peut réessayer — et le rang de la tentative suit', () => {
  const r = kyc.peutTenter([{ status: 'failed', reason: 'x', created_at: ilya(1), decided_at: ilya(1) }]);
  assert.equal(r.ok, true);
  assert.equal(r.tentative, 2);
});

test('une vérification expirée se refait sans être comptée comme un échec', () => {
  const r = kyc.peutTenter([{ status: 'passed', decided_at: ilya(24 * 400), created_at: ilya(24 * 400) }]);
  assert.equal(r.ok, true);
});
