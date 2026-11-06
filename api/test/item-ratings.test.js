/* Notes des activités et des services : qui peut noter, et ce qui se publie.
   Règles pures — ni base, ni réseau. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const r = require('../lib/ratings');

/* ---------- Qui peut noter ---------- */

test('on ne note une activité qu’après en avoir profité', () => {
  assert.equal(r.canRateItem('activity', { aUtilise: false }, null).ok, false);
  assert.equal(r.canRateItem('activity', { aUtilise: true }, null).ok, true);
});

test('le refus d’une activité explique quoi faire', () => {
  const x = r.canRateItem('activity', { aUtilise: false }, null);
  assert.equal(x.status, 403);
  assert.match(x.reason, /après avoir profité/);
});

test('un service se note si l’on est déjà client', () => {
  assert.equal(r.canRateItem('service', { estClient: false }, null).ok, false);
  assert.equal(r.canRateItem('service', { estClient: true }, null).ok, true);
});

test('la preuve d’une activité ne vaut pas pour un service, et inversement', () => {
  // Un client sans réservation qui aurait profité d'une activité ne peut pas
  // pour autant noter un service.
  assert.equal(r.canRateItem('service', { aUtilise: true }, null).ok, false);
  assert.equal(r.canRateItem('activity', { estClient: true }, null).ok, false);
});

test('on ne note pas deux fois le même élément', () => {
  const x = r.canRateItem('activity', { aUtilise: true }, { rating: 5 });
  assert.equal(x.ok, false);
  assert.equal(x.status, 409);
});

test('un type inconnu est refusé plutôt qu’accepté par défaut', () => {
  for (const k of ['listing', 'vehicle', '', null, 'ACTIVITY']) {
    assert.equal(r.canRateItem(k, { aUtilise: true }, null).ok, false, `${k} ne doit pas passer`);
  }
});

test('une preuve absente ne fait pas tomber la règle', () => {
  assert.equal(r.canRateItem('activity', null, null).ok, false);
  assert.equal(r.canRateItem('service', undefined, null).ok, false);
});

/* ---------- Validité de la note ---------- */

test('la note est un entier de 1 à 5', () => {
  for (const v of [1, 2, 3, 4, 5]) assert.equal(r.validRating(v), true, `${v} doit passer`);
  for (const v of [0, 6, -1, 2.5, null, undefined, NaN, Infinity, 'cinq', {}]) {
    assert.equal(r.validRating(v), false, `${v} ne doit pas passer`);
  }
});

test('un nombre envoyé en texte est accepté, comme ailleurs dans l’API', () => {
  // Volontaire : le JSON d'un client peut porter « 3 ». La valeur est convertie
  // avant l'écriture, et c'est le comportement de validRating déjà en place
  // pour les avis de séjour — deux règles différentes seraient pires.
  assert.equal(r.validRating('3'), true);
  assert.equal(r.validRating('3.5'), false);
});

/* ---------- Seuil de publication ---------- */

test('une moyenne sur trop peu d’avis n’est pas publiée', () => {
  assert.equal(r.publishable(5, 1), null, 'un seul avis ne mesure rien');
  assert.equal(r.publishable(5, 0), null);
  assert.equal(r.publishable(null, 0), null);
});

test('à partir du seuil, la moyenne et le compte sortent', () => {
  const p = r.publishable(4.5, r.MIN_RATINGS);
  assert.deepEqual(p, { average: 4.5, count: r.MIN_RATINGS });
});

test('le seuil reste au-dessus d’un avis isolé', () => {
  assert.ok(r.MIN_RATINGS >= 2);
});

/* ---------- Identifiant public des activités ---------- */

test('la forme publique d’un identifiant d’activité n’en garde que les chiffres', () => {
  // C'est ce que fait le catalogue public (toCfgActivite) : l'appli ne connaît
  // que cette forme, et la note doit malgré tout retomber sur la bonne ligne.
  assert.equal(r.publicActivityId('act-7'), '7');
  assert.equal(r.publicActivityId('activite_12'), '12');
  assert.equal(r.publicActivityId('7'), '7');
});

test('un identifiant sans chiffre est laissé tel quel plutôt que vidé', () => {
  assert.equal(r.publicActivityId('majorelle'), 'majorelle');
  assert.equal(r.publicActivityId('abc'), 'abc');
});

test('deux activités différentes ne doivent pas se réduire au même identifiant', () => {
  // Signal d'alerte : si cela arrivait en base, les notes se mélangeraient.
  assert.notEqual(r.publicActivityId('act-7'), r.publicActivityId('act-8'));
});

/* ---------- Distinction « Superhôte » ---------- */

test('une excellente moyenne sur trop peu d’avis ne distingue personne', () => {
  assert.equal(r.isSuperhost(5, 1), false);
  assert.equal(r.isSuperhost(5, r.SUPERHOTE.avis - 1), false);
});

test('il faut la note ET le volume', () => {
  assert.equal(r.isSuperhost(r.SUPERHOTE.note, r.SUPERHOTE.avis), true);
  assert.equal(r.isSuperhost(r.SUPERHOTE.note - 0.1, 50), false, 'bien noté mais pas assez');
  assert.equal(r.isSuperhost(5, 50), true);
});

test('une absence de note ne distingue pas par défaut', () => {
  assert.equal(r.isSuperhost(null, 10), false);
  assert.equal(r.isSuperhost(5, 0), false);
  assert.equal(r.isSuperhost(undefined, undefined), false);
});

test('le seuil reste exigeant : une distinction que tous obtiennent n’en est plus une', () => {
  assert.ok(r.SUPERHOTE.note >= 4.5);
  assert.ok(r.SUPERHOTE.avis >= 5);
});

/* ---------- Distinction « Perle rare » ---------- */

test('un logement dont la plupart des nuits sont prises est recherché', () => {
  assert.equal(r.isRareFind(60, 60), true);
  assert.equal(r.isRareFind(36, 60), true, '60 % exactement doit passer');
});

test('un logement largement libre ne l’est pas', () => {
  assert.equal(r.isRareFind(0, 60), false);
  assert.equal(r.isRareFind(35, 60), false);
});

test('une fenêtre vide ne distingue rien, plutôt que de diviser par zéro', () => {
  assert.equal(r.isRareFind(10, 0), false);
  assert.equal(r.isRareFind(0, 0), false);
  assert.equal(r.isRareFind(5, -3), false);
});

test('des nuits prises aberrantes ne créent pas une fausse distinction', () => {
  assert.equal(r.isRareFind(-10, 60), false, 'un compte négatif vaut zéro');
  assert.equal(r.isRareFind(NaN, 60), false);
});
