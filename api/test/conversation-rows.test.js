// Mise en forme d'une ligne de la liste des conversations.
//
// Cette fonction décide de ce que le voyageur lit sans ouvrir l'échange :
// de quel logement il s'agit, quelles dates, et qui a parlé en dernier. Une
// erreur ici se voit tout de suite, et se voit mal — « Vous : » devant le
// message de l'hôte, par exemple.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { toConversationRow } = require('../lib/messaging');

const MOI = '11111111-1111-1111-1111-111111111111';
const AUTRE = '22222222-2222-2222-2222-222222222222';

/** Ligne SQL minimale, que chaque cas vient surcharger. */
const ligne = (over = {}) => ({
  id: 'c1', kind: 'booking', booking_id: 'DR-1', listing_id: 'b1',
  subject: 'Riad', last_at: '2026-10-15T09:00:00Z', last_body: 'Bonjour',
  part: 'client', unread: 0, others: 'Karim',
  listing_title: 'Riad au cœur de la médina', listing_city: 'Marrakech',
  listing_photos: '["photos/riad-cour.jpg","photos/riad-patio.jpg"]',
  start_date: '2026-10-15', end_date: '2026-10-16',
  last_sender: AUTRE,
  ...over,
});

test('le dernier message de l’autre n’est pas marqué comme mien', () => {
  assert.equal(toConversationRow(ligne(), MOI).lastMine, false);
});

test('mon propre dernier message est reconnu', () => {
  assert.equal(toConversationRow(ligne({ last_sender: MOI }), MOI).lastMine, true);
});

test('un identifiant numérique est comparé comme du texte', () => {
  // Selon le pilote, un uuid peut revenir en objet ; la comparaison passe par
  // String() des deux côtés pour ne jamais dépendre du type renvoyé.
  assert.equal(toConversationRow(ligne({ last_sender: 7 }), 7).lastMine, true);
  assert.equal(toConversationRow(ligne({ last_sender: 7 }), '7').lastMine, true);
});

test('une conversation sans aucun message n’est de personne', () => {
  assert.equal(toConversationRow(ligne({ last_sender: null }), MOI).lastMine, false);
});

test('la vignette est la première photo du logement', () => {
  assert.equal(toConversationRow(ligne(), MOI).listingPhoto, 'photos/riad-cour.jpg');
});

test('un logement sans photo ne casse rien', () => {
  assert.equal(toConversationRow(ligne({ listing_photos: '[]' }), MOI).listingPhoto, '');
  assert.equal(toConversationRow(ligne({ listing_photos: null }), MOI).listingPhoto, '');
});

test('des photos illisibles ne font pas échouer la liste entière', () => {
  // Une colonne abîmée ne doit pas priver le voyageur de ses conversations.
  assert.equal(toConversationRow(ligne({ listing_photos: 'pas du json' }), MOI).listingPhoto, '');
});

test('les photos déjà décodées par le pilote sont acceptées telles quelles', () => {
  const r = toConversationRow(ligne({ listing_photos: ['photos/a.jpg'] }), MOI);
  assert.equal(r.listingPhoto, 'photos/a.jpg');
});

test('les dates du séjour sont réduites au jour', () => {
  const r = toConversationRow(ligne({ start_date: new Date('2026-10-15T00:00:00Z') }), MOI);
  assert.equal(r.start, '2026-10-15');
  assert.equal(r.end, '2026-10-16');
});

test('une conversation hors séjour n’invente pas de dates', () => {
  const r = toConversationRow(
    ligne({ kind: 'support', booking_id: null, listing_id: null, start_date: null, end_date: null,
            listing_title: null, listing_city: null, listing_photos: null }), MOI);
  assert.equal(r.start, '');
  assert.equal(r.end, '');
  assert.equal(r.listingTitle, '');
  assert.equal(r.listingCity, '');
});

test('le nombre de non-lus est toujours un nombre', () => {
  assert.equal(toConversationRow(ligne({ unread: '3' }), MOI).unread, 3);
  assert.equal(toConversationRow(ligne({ unread: null }), MOI).unread, 0);
});
