// La règle du robot : il accepte seul, il ne refuse jamais seul.
//
// Ces essais ne touchent ni au réseau ni à aucune clé : la mesure est donnée,
// et on vérifie la décision qu'elle entraîne. C'est la seule partie qui
// décide — les pilotes ne font que mesurer, et on peut les changer sans
// toucher à ce qui suit.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const auto = require('../lib/kyc_auto');

const mesure = (o) => Object.assign({ visages: 1, piece: true, similarite: 100 }, o);

test('une concordance franche est acceptée sans humain', () => {
  const d = auto.decision(mesure({ similarite: 99.4 }), 99);
  assert.equal(d.issue, 'passed');
  assert.equal(d.reason, '');
});

test('SOUS LE SEUIL, ON NE REFUSE PAS — un humain tranche', () => {
  // La règle qui tient tout le dispositif : jamais de refus automatique.
  for (const s of [0, 40, 85, 98.9]) {
    const d = auto.decision(mesure({ similarite: s }), 99);
    assert.equal(d.issue, 'review', `similarité ${s}`);
    assert.notEqual(d.issue, 'failed');
  }
});

test('aucune décision possible ne vaut « refusé »', () => {
  const issues = [
    auto.decision(mesure({ visages: 0 })).issue,
    auto.decision(mesure({ visages: 3 })).issue,
    auto.decision(mesure({ piece: false })).issue,
    auto.decision(mesure({ similarite: null })).issue,
    auto.decision(mesure({ similarite: 10 })).issue,
    auto.decision({}).issue,
    auto.decision(null).issue,
  ];
  assert.ok(!issues.includes('failed'), issues.join(','));
});

test('une photo sans visage se refait, elle ne dérange personne', () => {
  const d = auto.decision(mesure({ visages: 0 }));
  assert.equal(d.issue, 'retry');
  assert.match(d.reason, /Aucun visage/);
});

test('plusieurs visages : on redemande une photo seul', () => {
  const d = auto.decision(mesure({ visages: 2 }));
  assert.equal(d.issue, 'retry');
  assert.match(d.reason, /seul/);
});

test('une pièce illisible envoie à l’humain, pas au client', () => {
  // Ce n'est pas sa faute : le lui reprocher serait injuste, et le renvoyer
  // refaire une photo ne changerait rien.
  const d = auto.decision(mesure({ piece: false }));
  assert.equal(d.issue, 'review');
});

test('le seuil est borné : jamais au-dessous de 90', () => {
  const avant = process.env.KYC_MIN_SIMILARITY;
  process.env.KYC_MIN_SIMILARITY = '50';
  assert.equal(auto.seuil(), 90);
  process.env.KYC_MIN_SIMILARITY = '140';
  assert.equal(auto.seuil(), 100);
  delete process.env.KYC_MIN_SIMILARITY;
  assert.equal(auto.seuil(), 99); // la valeur recommandée pour une identité
  if (avant !== undefined) process.env.KYC_MIN_SIMILARITY = avant;
});

test('sans réglage, aucun automatisme : l’équipe tranche', () => {
  const avant = process.env.KYC_PROVIDER;
  delete process.env.KYC_PROVIDER;
  assert.equal(auto.pilote(), 'humain');
  assert.equal(auto.automatique(), false);
  if (avant !== undefined) process.env.KYC_PROVIDER = avant;
});

test('un pilote inconnu retombe sur l’humain, il ne laisse pas passer', () => {
  const avant = process.env.KYC_PROVIDER;
  process.env.KYC_PROVIDER = 'magie';
  assert.equal(auto.pilote(), 'humain');
  if (avant === undefined) delete process.env.KYC_PROVIDER; else process.env.KYC_PROVIDER = avant;
});

test('rekognition sans identifiants retombe sur l’humain', () => {
  const avant = { p: process.env.KYC_PROVIDER, k: process.env.AWS_ACCESS_KEY_ID, s: process.env.AWS_SECRET_ACCESS_KEY };
  process.env.KYC_PROVIDER = 'rekognition';
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  assert.equal(auto.pilote(), 'humain');
  for (const [k, v] of [['KYC_PROVIDER', avant.p], ['AWS_ACCESS_KEY_ID', avant.k], ['AWS_SECRET_ACCESS_KEY', avant.s]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('la simulation est refusée en production', () => {
  const avant = { p: process.env.KYC_PROVIDER, n: process.env.NODE_ENV };
  process.env.KYC_PROVIDER = 'simulate';
  process.env.NODE_ENV = 'production';
  // Un verdict d'identité inventé sur une personne réelle : jamais.
  assert.equal(auto.pilote(), 'humain');
  process.env.NODE_ENV = 'development';
  assert.equal(auto.pilote(), 'simulate');
  for (const [k, v] of [['KYC_PROVIDER', avant.p], ['NODE_ENV', avant.n]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
