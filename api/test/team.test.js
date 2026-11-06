/* Répartition des tâches et visibilité des services.
   Exécution : cd api && npm test (aucune base nécessaire : règles pures) */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/team');

const admin = { id: 'a', role: 'admin' };
const lead = (scopes = []) => ({ id: 'l', role: 'collaborator', team_lead: true, _scopes: scopes });
const collab = { id: 'c', role: 'collaborator', team_lead: false };
const owner = { id: 'o', role: 'owner' };
const client = { id: 'k', role: 'client' };

/* ---------- Détention d'un périmètre ---------- */

test('l\'administrateur détient tous les périmètres', () => {
  for (const s of T.SCOPES) assert.equal(T.hasScope(admin, [], s), true, s);
});

test('un collaborateur ne détient que ce qui lui a été confié', () => {
  assert.equal(T.hasScope(collab, ['services'], 'services'), true);
  assert.equal(T.hasScope(collab, ['services'], 'listings'), false);
  assert.equal(T.hasScope(collab, [], 'services'), false);
});

test('un propriétaire ou un client ne détient aucun périmètre d\'équipe', () => {
  assert.equal(T.hasScope(owner, ['services'], 'services'), false);
  assert.equal(T.hasScope(client, ['services'], 'services'), false);
  assert.equal(T.hasScope(null, ['services'], 'services'), false);
});

/* ---------- Qui peut confier un périmètre ---------- */

test('l\'administrateur peut confier n\'importe quel périmètre', () => {
  for (const s of T.SCOPES) assert.equal(T.canGrant(admin, [], s), true, s);
});

test('un chef d\'équipe ne confie que les périmètres qu\'il détient', () => {
  const l = lead();
  assert.equal(T.canGrant(l, ['services', 'support'], 'services'), true);
  assert.equal(T.canGrant(l, ['services', 'support'], 'support'), true);
  // Pas d'élévation de privilège : il ne peut pas confier ce qu'il n'a pas.
  assert.equal(T.canGrant(l, ['services'], 'listings'), false);
  assert.equal(T.canGrant(l, [], 'services'), false);
});

test('un collaborateur simple ne confie rien, même ce qu\'il détient', () => {
  assert.equal(T.canGrant(collab, ['services'], 'services'), false);
});

test('un périmètre inconnu est toujours refusé', () => {
  assert.equal(T.canGrant(admin, [], 'facturation'), false);
  assert.equal(T.canGrant(lead(), ['facturation'], 'facturation'), false);
});

/* ---------- Désignation d'un chef d'équipe ---------- */

test('l\'admin et un chef d\'équipe peuvent désigner un chef d\'équipe', () => {
  assert.equal(T.canDesignateLead(admin), true);
  assert.equal(T.canDesignateLead(lead()), true);
});

test('un collaborateur simple, un propriétaire ou un client ne désignent personne', () => {
  assert.equal(T.canDesignateLead(collab), false);
  assert.equal(T.canDesignateLead(owner), false);
  assert.equal(T.canDesignateLead(null), false);
});

/* ---------- Comptes modifiables ---------- */

test('on ne touche jamais à un compte administrateur', () => {
  assert.equal(T.canManage(admin, { id: 'x', role: 'admin' }), false);
  assert.equal(T.canManage(lead(), { id: 'x', role: 'admin' }), false);
});

test('on ne modifie pas son propre compte', () => {
  assert.equal(T.canManage(admin, { id: 'a', role: 'collaborator' }), false);
  assert.equal(T.canManage(lead(), { id: 'l', role: 'collaborator' }), false);
});

test('seuls les comptes collaborateur sont concernés par la répartition', () => {
  assert.equal(T.canManage(admin, { id: 'x', role: 'collaborator' }), true);
  assert.equal(T.canManage(admin, { id: 'x', role: 'owner' }), false);
  assert.equal(T.canManage(admin, { id: 'x', role: 'client' }), false);
});

test('un collaborateur simple ne gère aucun compte', () => {
  assert.equal(T.canManage(collab, { id: 'x', role: 'collaborator' }), false);
});

/* ---------- Filtre appliqué aux routes existantes ----------
   Il ne doit RESTREINDRE que les collaborateurs : jamais verrouiller un
   propriétaire ou une agence, jamais élargir un accès. */

test('le filtre laisse passer l\'administrateur', () => {
  for (const s of T.SCOPES) assert.equal(T.scopeGate(admin, [], s), true, s);
});

test('le filtre restreint le collaborateur à ses périmètres', () => {
  assert.equal(T.scopeGate(collab, ['listings'], 'listings'), true);
  assert.equal(T.scopeGate(collab, ['listings'], 'activities'), false);
  assert.equal(T.scopeGate(collab, [], 'listings'), false);
});

test('le filtre ne verrouille jamais un propriétaire ni une agence', () => {
  // Leur accès reste gouverné par la règle de rôle existante (son propre bien).
  assert.equal(T.scopeGate(owner, [], 'listings'), true);
  assert.equal(T.scopeGate({ id: 'g', role: 'agency' }, [], 'activities'), true);
});

test('le filtre refuse un visiteur sans compte', () => {
  assert.equal(T.scopeGate(null, [], 'listings'), false);
  assert.equal(T.scopeGate(undefined, ['listings'], 'listings'), false);
});

test('un chef d\'équipe reste soumis à ses propres périmètres', () => {
  // Être chef d'équipe permet de déléguer, pas d'accéder à tout.
  assert.equal(T.scopeGate(lead(), ['services'], 'services'), true);
  assert.equal(T.scopeGate(lead(), ['services'], 'listings'), false);
});

/* ---------- Services : clients et propriétaires ne voient pas les mêmes ---------- */

const svc = (audience, status = 'published') => ({ audience, status });

test('un client voit les services clients, pas ceux des propriétaires', () => {
  assert.equal(T.serviceVisibleTo(svc('client'), 'client'), true);
  assert.equal(T.serviceVisibleTo(svc('owner'), 'client'), false);
});

test('un propriétaire voit les services propriétaires, pas ceux des clients', () => {
  assert.equal(T.serviceVisibleTo(svc('owner'), 'owner'), true);
  assert.equal(T.serviceVisibleTo(svc('client'), 'owner'), false);
});

test('un service marqué « both » est visible des deux côtés', () => {
  assert.equal(T.serviceVisibleTo(svc('both'), 'client'), true);
  assert.equal(T.serviceVisibleTo(svc('both'), 'owner'), true);
});

test('une agence est traitée comme un propriétaire', () => {
  assert.equal(T.audienceFor('agency'), 'owner');
  assert.equal(T.audienceFor('owner'), 'owner');
  assert.equal(T.audienceFor('client'), 'client');
  assert.equal(T.audienceFor(undefined), 'client', 'visiteur : côté client par défaut');
});

test('un service non publié n\'est visible de personne', () => {
  for (const status of ['draft', 'archived']) {
    assert.equal(T.serviceVisibleTo(svc('both', status), 'client'), false, status);
    assert.equal(T.serviceVisibleTo(svc('both', status), 'owner'), false, status);
  }
  assert.equal(T.serviceVisibleTo(null, 'client'), false);
});
