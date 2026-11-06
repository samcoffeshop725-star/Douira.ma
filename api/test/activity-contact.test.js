// Date, heure et téléphone d'une expérience.
//
// Ces trois champs décident de ce que le voyageur lit avant de commander : à
// quelle date il doit se présenter, à quelle heure, et quel numéro composer.
// Une saisie fausse qui passerait en silence lui ferait manquer l'expérience
// ou appeler dans le vide. On refuse donc, avec le motif.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const ca = require('../lib/catalog_admin');

/* ---------------- Date ---------------- */

test('pas de date est un état normal : l’expérience a lieu tous les jours', () => {
  assert.equal(ca.dateExperience(''), null);
  assert.equal(ca.dateExperience('   '), null);
  assert.equal(ca.dateExperience(undefined), null);
  assert.equal(ca.dateExperience(null), null);
});

test('une date du calendrier est acceptée', () => {
  assert.equal(ca.dateExperience('2026-11-28'), '2026-11-28');
  assert.equal(ca.dateExperience('2028-02-29'), '2028-02-29'); // année bissextile
});

test('une date qui n’existe pas est refusée', () => {
  // La forme est bonne, le calendrier non : sans ce contrôle, le 30 février
  // deviendrait le 2 mars en silence.
  assert.throws(() => ca.dateExperience('2026-02-30'), /n'existe pas/);
  assert.throws(() => ca.dateExperience('2026-13-01'), /n'existe pas/);
  assert.throws(() => ca.dateExperience('2027-02-29'), /n'existe pas/);
});

test('une date mal écrite est refusée avec le format attendu', () => {
  assert.throws(() => ca.dateExperience('28/11/2026'), /AAAA-MM-JJ/);
  assert.throws(() => ca.dateExperience('demain'), /AAAA-MM-JJ/);
});

/* ---------------- Heure ---------------- */

test('pas d’heure est un état normal', () => {
  assert.equal(ca.heureExperience(''), '');
  assert.equal(ca.heureExperience(undefined), '');
});

test('l’heure est normalisée sur deux chiffres', () => {
  assert.equal(ca.heureExperience('9:30'), '09:30');
  assert.equal(ca.heureExperience('09:30'), '09:30');
  assert.equal(ca.heureExperience('9h30'), '09:30'); // écriture française courante
  assert.equal(ca.heureExperience('23:59'), '23:59');
  assert.equal(ca.heureExperience('00:00'), '00:00');
});

test('une heure impossible est refusée', () => {
  assert.throws(() => ca.heureExperience('24:00'), /HH:MM/);
  assert.throws(() => ca.heureExperience('09:60'), /HH:MM/);
  assert.throws(() => ca.heureExperience('matin'), /HH:MM/);
});

/* ---------------- Téléphone ---------------- */

test('pas de numéro est un état normal : il n’y en a pas par défaut', () => {
  // Le numéro de l'équipe ne doit pas se retrouver sur l'expérience d'une
  // agence à son insu.
  assert.equal(ca.telephoneExperience(''), '');
  assert.equal(ca.telephoneExperience(undefined), '');
});

test('le numéro garde la forme écrite par l’agence', () => {
  assert.equal(ca.telephoneExperience('+212 6 12 34 56 78'), '+212 6 12 34 56 78');
  assert.equal(ca.telephoneExperience('0612-345678'), '0612-345678');
  assert.equal(ca.telephoneExperience('(212) 524 123456'), '(212) 524 123456');
});

test('un numéro trop court ou trop long est refusé', () => {
  assert.throws(() => ca.telephoneExperience('12345'), /invalide/);
  assert.throws(() => ca.telephoneExperience('1'.repeat(16)), /invalide/);
});

test('ce qui n’est pas un numéro est refusé', () => {
  assert.throws(() => ca.telephoneExperience('appelez-nous'), /invalide/);
  assert.throws(() => ca.telephoneExperience('tel:+212612345678'), /invalide/);
  assert.throws(() => ca.telephoneExperience('06 12 34 56 78 <script>'), /invalide/);
});
