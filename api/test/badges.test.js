// Badge d'équipe.
//
// Un badge affirme « cette personne travaille ici ». Deux choses doivent donc
// tenir : il ne se distribue pas à n'importe qui, et deux personnes ne peuvent
// pas porter le même numéro — même après un départ.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const b = require('../lib/badges');

/* ---------------- Qui en porte un ---------------- */

test('seuls l’administration et les collaborateurs portent un badge', () => {
  assert.ok(b.porteBadge({ role: 'admin' }));
  assert.ok(b.porteBadge({ role: 'collaborator' }));
  assert.ok(!b.porteBadge({ role: 'client' }));
  assert.ok(!b.porteBadge({ role: 'owner' }));
  assert.ok(!b.porteBadge({ role: 'agency' }));
  assert.ok(!b.porteBadge(null));
  assert.ok(!b.porteBadge({}));
});

/* ---------------- Fonction imprimée ---------------- */

test('le chef d’équipe se distingue par son drapeau, pas par son rôle', () => {
  assert.equal(b.fonction({ role: 'admin' }), 'Administration');
  assert.equal(b.fonction({ role: 'collaborator', team_lead: true }), 'Chef d’équipe');
  assert.equal(b.fonction({ role: 'collaborator' }), 'Collaborateur');
  assert.equal(b.fonction({ role: 'collaborator', team_lead: false }), 'Collaborateur');
});

/* ---------------- Numérotation ---------------- */

test('le numéro 1 revient à l’administration quand il est libre', () => {
  assert.equal(b.prochainNumero('admin', 0, true), 1);
  assert.equal(b.prochainNumero('admin', 7, true), 1);
});

test('un second administrateur prend un numéro ordinaire', () => {
  // Le 1 est unique : il n'y a qu'une administration à le porter.
  assert.equal(b.prochainNumero('admin', 5, false), 6);
});

test('un collaborateur ne prend jamais le 1, même en premier', () => {
  assert.equal(b.prochainNumero('collaborator', 0, true), 2);
  assert.equal(b.prochainNumero('collaborator', 0, false), 2);
});

test('un numéro rendu n’est jamais redistribué', () => {
  // On prend au-dessus du plus grand attribué, pas dans les trous : sinon on
  // ne saurait plus qui a présenté quel badge.
  assert.equal(b.prochainNumero('collaborator', 9, false), 10);
  assert.equal(b.prochainNumero('collaborator', 42, false), 43);
});

test('un maximum absurde ne casse pas la suite', () => {
  assert.equal(b.prochainNumero('collaborator', null, false), 2);
  assert.equal(b.prochainNumero('collaborator', 'douze', false), 2);
});

/* ---------------- Habillage ---------------- */

test('l’administration porte le badge noir', () => {
  assert.equal(b.livree({ role: 'admin' }), 'black');
  assert.equal(b.livree({ role: 'collaborator' }), 'equipe');
  assert.equal(b.livree({ role: 'collaborator', team_lead: true }), 'equipe');
});

/* ---------------- Jeton ---------------- */

// Même clé de test que les autres suites : la signature ne dépend pas d'un
// secret de production.
process.env.CARD_SECRET = process.env.CARD_SECRET || 'secret-de-test-douira';

test('un badge ne peut pas être présenté comme une carte de membre', () => {
  // Les deux jetons sont signés sur des messages différents : même numéro,
  // même personne, signature différente.
  const sec = require('../lib/security');
  const membre = sec.memberToken('u1', 7, 1);
  const badge = sec.badgeToken('u1', 7, 1);
  assert.notEqual(membre, badge);
});
