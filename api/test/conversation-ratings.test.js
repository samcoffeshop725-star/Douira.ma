/* Note d'un échange en cinq étoiles : qui peut noter, quand, et qui est noté.
   Règles pures — ni base, ni réseau. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const m = require('../lib/messaging');

const CLIENT = 'u-client';
const AGENT = 'u-agent';
const AGENT2 = 'u-agent2';
const OWNER = 'u-owner';
const AUJOURDHUI = '2026-10-31';

const support = {
  conv: { id: 1, kind: 'support' },
  membres: [
    { user_id: CLIENT, part: 'client' },
    { user_id: AGENT, part: 'support' },
  ],
  repondu: [{ sender_id: CLIENT }, { sender_id: AGENT }],
};

/* ---------- Qui peut noter ---------- */

test('un membre peut noter un échange auquel on lui a répondu', () => {
  const r = m.canRateConversation(support.conv, support.membres, support.repondu, CLIENT, AUJOURDHUI, null, null);
  assert.equal(r.ok, true);
});

test('un tiers ne peut pas noter un échange auquel il ne participe pas', () => {
  const r = m.canRateConversation(support.conv, support.membres, support.repondu, 'u-inconnu', AUJOURDHUI, null, null);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('on ne note pas deux fois le même échange', () => {
  const r = m.canRateConversation(support.conv, support.membres, support.repondu, CLIENT, AUJOURDHUI, null, { rating: 4 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
});

test('un fil sans réponse ne se note pas : ce serait mesurer le silence', () => {
  const r = m.canRateConversation(support.conv, support.membres, [{ sender_id: CLIENT }], CLIENT, AUJOURDHUI, null, null);
  assert.equal(r.ok, false);
  assert.match(r.reason, /répondu/);
});

test('un échange sans interlocuteur ne se note pas', () => {
  const r = m.canRateConversation(support.conv, [{ user_id: CLIENT, part: 'client' }], support.repondu, CLIENT, AUJOURDHUI, null, null);
  assert.equal(r.ok, false);
  assert.match(r.reason, /interlocuteur/);
});

/* ---------- Le cas du séjour ---------- */

const sejour = {
  conv: { id: 2, kind: 'booking' },
  membres: [
    { user_id: CLIENT, part: 'client' },
    { user_id: OWNER, part: 'owner' },
  ],
  repondu: [{ sender_id: CLIENT }, { sender_id: OWNER }],
};

test('la note d’un échange de séjour attend la fin du séjour', () => {
  const r = m.canRateConversation(sejour.conv, sejour.membres, sejour.repondu, CLIENT, AUJOURDHUI, { end_date: '2026-11-10' }, null);
  assert.equal(r.ok, false);
  assert.match(r.reason, /fin du séjour/);
});

test('le jour du départ, l’échange de séjour est notable', () => {
  const r = m.canRateConversation(sejour.conv, sejour.membres, sejour.repondu, CLIENT, AUJOURDHUI, { end_date: AUJOURDHUI }, null);
  assert.equal(r.ok, true);
});

test('sans réservation, un échange de séjour ne se note pas', () => {
  const r = m.canRateConversation(sejour.conv, sejour.membres, sejour.repondu, CLIENT, AUJOURDHUI, null, null);
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

/* ---------- Qui est noté ---------- */

test('le client note le service, et l’agent unique est identifié', () => {
  const r = m.canRateConversation(support.conv, support.membres, support.repondu, CLIENT, AUJOURDHUI, null, null);
  assert.equal(r.targetPart, 'support');
  assert.equal(r.targetId, AGENT);
});

test('à plusieurs agents, c’est le service qu’on note, pas quelqu’un', () => {
  const membres = [...support.membres, { user_id: AGENT2, part: 'support' }];
  const r = m.canRateConversation(support.conv, membres, support.repondu, CLIENT, AUJOURDHUI, null, null);
  assert.equal(r.targetPart, 'support');
  assert.equal(r.targetId, null, 'aucun agent ne doit porter seul la note du service');
});

test('le client note le propriétaire, et le propriétaire note le client', () => {
  const b = { end_date: AUJOURDHUI };
  const parClient = m.canRateConversation(sejour.conv, sejour.membres, sejour.repondu, CLIENT, AUJOURDHUI, b, null);
  assert.equal(parClient.targetPart, 'owner');
  assert.equal(parClient.targetId, OWNER);

  const parProprio = m.canRateConversation(sejour.conv, sejour.membres, sejour.repondu, OWNER, AUJOURDHUI, b, null);
  assert.equal(parProprio.targetPart, 'client');
  assert.equal(parProprio.targetId, CLIENT);
});

test('le support prime quand l’échange mêle plusieurs parts', () => {
  const membres = [
    { user_id: OWNER, part: 'owner' },
    { user_id: CLIENT, part: 'client' },
    { user_id: AGENT, part: 'support' },
  ];
  const r = m.canRateConversation({ id: 3, kind: 'listing' }, membres, [{ sender_id: AGENT }], OWNER, AUJOURDHUI, null, null);
  assert.equal(r.targetPart, 'support');
});

test('une conversation absente renvoie 404 plutôt que de lever', () => {
  const r = m.canRateConversation(null, [], [], CLIENT, AUJOURDHUI, null, null);
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

/* ---------- Seuil de publication de la note d'un hôte ---------- */

test('le seuil de publication est posé à un niveau qui veut dire quelque chose', () => {
  // Une moyenne sur un ou deux avis expose surtout celui qui débute.
  assert.ok(m.HOST_MIN_REVIEWS >= 3, 'moins de trois avis ne mesure rien');
});
