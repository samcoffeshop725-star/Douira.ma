/* Règles métier de la messagerie et des avis.
   Exécution : node --test api/test/  (aucune base nécessaire : règles pures) */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/messaging');

const CLIENT = 'u-client';
const OWNER = 'u-owner';
const TIERS = 'u-tiers';

// Séjour confirmé du 10 au 15 mars, logement appartenant à OWNER.
const booking = (over = {}) => Object.assign({
  id: 'B1', user_id: CLIENT, owner_id: OWNER, listing_id: 'b1',
  start_date: '2026-03-10', end_date: '2026-03-15', status: 'confirmed',
}, over);

/* ---------- Fin de séjour ---------- */

test('le séjour est terminé le jour du départ, pas avant', () => {
  const b = booking();
  assert.equal(M.stayIsOver(b, '2026-03-14'), false, 'la veille du départ');
  assert.equal(M.stayIsOver(b, '2026-03-15'), true, 'le jour du départ');
  assert.equal(M.stayIsOver(b, '2026-03-20'), true, 'après le départ');
});

test('stayIsOver accepte une date (objet Date) comme une chaîne ISO', () => {
  const b = booking({ end_date: new Date('2026-03-15T00:00:00Z') });
  assert.equal(M.stayIsOver(b, '2026-03-15'), true);
  assert.equal(M.stayIsOver(b, '2026-03-01'), false);
});

/* ---------- Avis : seulement après la fin du séjour ---------- */

test('aucun avis avant la fin du séjour', () => {
  const r = M.canReview(booking(), CLIENT, '2026-03-12', null);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.reason, /fin du séjour/);
});

test('le client et le propriétaire peuvent tous deux évaluer après le séjour', () => {
  const asClient = M.canReview(booking(), CLIENT, '2026-03-16', null);
  const asOwner = M.canReview(booking(), OWNER, '2026-03-16', null);
  assert.equal(asClient.ok, true);
  assert.equal(asClient.part, 'client');
  assert.equal(asOwner.ok, true);
  assert.equal(asOwner.part, 'owner');
});

/* ---------- Avis : un seul par participant ---------- */

test('un participant ne peut évaluer qu\'une fois le même séjour', () => {
  const dejaVu = { id: 7, author_id: CLIENT };
  const r = M.canReview(booking(), CLIENT, '2026-03-16', dejaVu);
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.match(r.reason, /déjà donné votre avis/);
});

test('l\'avis du client n\'empêche pas celui du propriétaire', () => {
  // `existing` est l'avis de CET auteur : côté propriétaire, il n'y en a pas.
  const r = M.canReview(booking(), OWNER, '2026-03-16', null);
  assert.equal(r.ok, true);
});

/* ---------- Avis : qui a le droit ---------- */

test('un tiers ne peut pas évaluer un séjour auquel il n\'a pas participé', () => {
  const r = M.canReview(booking(), TIERS, '2026-03-16', null);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('un séjour annulé ou non confirmé n\'est pas évaluable', () => {
  for (const status of ['cancelled', 'pending_payment', 'expired', 'failed']) {
    const r = M.canReview(booking({ status }), CLIENT, '2026-03-16', null);
    assert.equal(r.ok, false, status);
    assert.equal(r.status, 400, status);
  }
});

test('une réservation inexistante renvoie 404', () => {
  const r = M.canReview(null, CLIENT, '2026-03-16', null);
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

/* ---------- Notes ---------- */

test('la note doit être un entier de 1 à 5', () => {
  for (const ok of [1, 2, 3, 4, 5]) assert.equal(M.validRating(ok), true, String(ok));
  for (const ko of [0, 6, -1, 2.5, NaN, null, undefined, '', 'cinq']) {
    assert.equal(M.validRating(ko), false, JSON.stringify(ko));
  }
  assert.equal(M.validRating('4'), true, 'une note transmise en chaîne reste acceptée');
});

/* ---------- Accès aux conversations ---------- */

test('seuls les membres accèdent à une conversation', () => {
  const members = [{ user_id: CLIENT, part: 'client' }, { user_id: OWNER, part: 'owner' }];
  assert.equal(M.isMember(members, CLIENT), true);
  assert.equal(M.isMember(members, OWNER), true);
  assert.equal(M.isMember(members, TIERS), false, 'un tiers n\'est pas membre');
  assert.equal(M.isMember(members, undefined), false);
  assert.equal(M.isMember([], CLIENT), false);
  assert.equal(M.isMember(null, CLIENT), false);
});

test('la conversation d\'une réservation réunit le client et le propriétaire', () => {
  const parts = M.bookingParticipants(booking());
  assert.deepEqual(parts, [
    { user_id: CLIENT, part: 'client' },
    { user_id: OWNER, part: 'owner' },
  ]);
});

test('un logement sans propriétaire ne crée pas de membre fantôme', () => {
  const parts = M.bookingParticipants(booking({ owner_id: null }));
  assert.deepEqual(parts, [{ user_id: CLIENT, part: 'client' }]);
});

test('le propriétaire de son propre séjour n\'est pas ajouté deux fois', () => {
  const parts = M.bookingParticipants(booking({ owner_id: CLIENT }));
  assert.deepEqual(parts, [{ user_id: CLIENT, part: 'client' }]);
});

/* ---------- Corps des messages ---------- */

test('un message vide est refusé, les espaces sont retirés', () => {
  assert.equal(M.cleanBody('   '), null);
  assert.equal(M.cleanBody(''), null);
  assert.equal(M.cleanBody(null), null);
  assert.equal(M.cleanBody('  bonjour  '), 'bonjour');
});

test('un message trop long est tronqué', () => {
  const long = 'a'.repeat(5000);
  assert.equal(M.cleanBody(long).length, 4000);
});
