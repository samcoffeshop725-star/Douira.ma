/* Qui peut répondre à un avis. Règle pure : ni base, ni réseau.
   Un avis est public et définitif ; la réponse est le seul droit de l'hôte. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const msg = require('../lib/messaging');

const PROPRIO = 'u-proprio';

test('le propriétaire du logement peut répondre', () => {
  assert.equal(msg.canReply({ id: PROPRIO, role: 'owner' }, PROPRIO), true);
});

test('un autre propriétaire ne répond pas chez le voisin', () => {
  assert.equal(msg.canReply({ id: 'u-autre', role: 'owner' }, PROPRIO), false);
});

test('l’administrateur répond au nom de la plateforme', () => {
  assert.equal(msg.canReply({ id: 'u-admin', role: 'admin' }, PROPRIO), true);
});

test('un collaborateur ne répond que s’il porte le périmètre « listings »', () => {
  assert.equal(msg.canReply({ id: 'u-c', role: 'collaborator', scopes: [] }, PROPRIO), false);
  assert.equal(msg.canReply({ id: 'u-c', role: 'collaborator', scopes: ['services'] }, PROPRIO), false);
  assert.equal(msg.canReply({ id: 'u-c', role: 'collaborator', scopes: ['listings'] }, PROPRIO), true);
});

test('un voyageur ne répond jamais à l’avis d’un autre', () => {
  assert.equal(msg.canReply({ id: 'u-client', role: 'client' }, PROPRIO), false);
});

test('sans session, personne ne répond', () => {
  assert.equal(msg.canReply(null, PROPRIO), false);
  assert.equal(msg.canReply(undefined, PROPRIO), false);
});

test('un logement sans propriétaire ne laisse pas répondre n’importe qui', () => {
  assert.equal(msg.canReply({ id: 'u-x', role: 'owner' }, null), false);
});
