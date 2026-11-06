// Lecture d'un code Douira.
//
// Ce qui se joue ici : qui a le droit de scanner, ce qu'un code mal formé
// doit devenir (rien), et ce que le scanneur lit au comptoir. Une erreur de
// jugement ici se traduit par une offre refusée à un client en règle, ou
// accordée à quelqu'un qui n'y a pas droit.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const scan = require('../lib/scan');

/* ---------------- Qui peut scanner ---------------- */

test('propriétaires, équipe, administration et agences peuvent scanner', () => {
  for (const role of ['admin', 'collaborator', 'owner', 'agency']) {
    assert.ok(scan.peutScanner({ role }), role);
  }
});

test('un client ne scanne pas : il présente', () => {
  assert.ok(!scan.peutScanner({ role: 'client' }));
  assert.ok(!scan.peutScanner(null));
  assert.ok(!scan.peutScanner({}));
});

/* ---------------- Lecture du code ---------------- */

test('une carte de membre est reconnue', () => {
  const r = scan.lireCode('DOUIRA|M|482913|A1B2C3D4E5F60718');
  assert.deepEqual(r, { kind: 'member', numero: 482913, jeton: 'A1B2C3D4E5F60718' });
});

test('un badge d’équipe est reconnu, quel que soit le nombre de chiffres', () => {
  assert.deepEqual(scan.lireCode('DOUIRA|B|1|A1B2C3D4E5F60718'),
    { kind: 'badge', numero: 1, jeton: 'A1B2C3D4E5F60718' });
  assert.equal(scan.lireCode('DOUIRA|B|142|A1B2C3D4E5F60718').numero, 142);
});

test('un code d’un autre système n’est pas interprété', () => {
  // Surtout ne pas deviner : un QR de restaurant n'est pas une carte.
  assert.equal(scan.lireCode('https://exemple.com/x'), null);
  assert.equal(scan.lireCode('DOUIRA'), null);
  assert.equal(scan.lireCode(''), null);
  assert.equal(scan.lireCode(null), null);
});

test('un code Douira déformé est refusé, pas rattrapé', () => {
  assert.equal(scan.lireCode('DOUIRA|M|48291|A1B2C3D4E5F60718'), null, 'cinq chiffres');
  assert.equal(scan.lireCode('DOUIRA|M|482913|a1b2c3d4e5f60718'), null, 'jeton en minuscules');
  assert.equal(scan.lireCode('DOUIRA|M|482913|TROPCOURT'), null);
  assert.equal(scan.lireCode('DOUIRA|X|482913|A1B2C3D4E5F60718'), null, 'type inconnu');
});

test('les espaces autour du code sont tolérés', () => {
  // Un lecteur ajoute parfois un retour à la ligne : ce n'est pas la faute
  // du porteur de la carte.
  assert.ok(scan.lireCode('  DOUIRA|M|482913|A1B2C3D4E5F60718\n'));
});

/* ---------------- Droit aux offres ---------------- */

test('un client en règle a droit aux offres', () => {
  assert.deepEqual(scan.droitAuxOffres({ role: 'client', status: 'actif' }), { ok: true, raison: '' });
});

test('un compte suspendu est refusé avec son motif', () => {
  const r = scan.droitAuxOffres({ role: 'client', status: 'suspendu' });
  assert.equal(r.ok, false);
  assert.match(r.raison, /suspendu/);
});

test('un compte supprimé est refusé, même si le statut semble bon', () => {
  const r = scan.droitAuxOffres({ role: 'client', status: 'actif', deleted_at: '2026-01-01' });
  assert.equal(r.ok, false);
  assert.match(r.raison, /supprimé/);
});

test('un compte qui n’est pas un compte client n’utilise pas les offres membres', () => {
  // Un propriétaire a un compte, pas une carte de membre à faire valoir.
  for (const role of ['owner', 'agency', 'collaborator', 'admin']) {
    assert.equal(scan.droitAuxOffres({ role, status: 'actif' }).ok, false, role);
  }
});

/* ---------------- Séjours ---------------- */

const RESA = (id, start, end, status = 'confirmed') => ({
  id, listing_id: 'b1', start_date: start, end_date: end, status,
});

test('le séjour en cours est celui du jour', () => {
  const r = scan.resumeSejours([RESA('DR-1', '2026-11-01', '2026-11-10')], '2026-11-05');
  assert.equal(r.enCours.id, 'DR-1');
  assert.equal(r.aVenir, null);
});

test('le jour du départ, le séjour est terminé', () => {
  // La date de départ est exclusive : le client rend les clés ce matin-là.
  const r = scan.resumeSejours([RESA('DR-1', '2026-11-01', '2026-11-10')], '2026-11-10');
  assert.equal(r.enCours, null);
});

test('le jour de l’arrivée, le séjour est en cours', () => {
  const r = scan.resumeSejours([RESA('DR-1', '2026-11-01', '2026-11-10')], '2026-11-01');
  assert.equal(r.enCours.id, 'DR-1');
});

test('sans séjour en cours, on annonce le prochain — le plus proche', () => {
  const r = scan.resumeSejours(
    [RESA('DR-2', '2027-02-01', '2027-02-05'), RESA('DR-1', '2026-12-01', '2026-12-04')],
    '2026-11-05');
  assert.equal(r.enCours, null);
  assert.equal(r.aVenir.id, 'DR-1');
});

test('les réservations non confirmées ne comptent pas', () => {
  // Une réservation en attente de paiement n'ouvre aucun droit.
  const r = scan.resumeSejours(
    [RESA('DR-1', '2026-11-01', '2026-11-10', 'pending_payment'),
     RESA('DR-2', '2026-11-01', '2026-11-10', 'cancelled')],
    '2026-11-05');
  assert.equal(r.enCours, null);
  assert.equal(r.total, 0);
});

test('aucune réservation ne lève pas d’erreur', () => {
  const r = scan.resumeSejours([], '2026-11-05');
  assert.deepEqual(r, { enCours: null, aVenir: null, total: 0 });
  assert.deepEqual(scan.resumeSejours(null, '2026-11-05'), { enCours: null, aVenir: null, total: 0 });
});
