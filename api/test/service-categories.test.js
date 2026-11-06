/* Catégories de services : la clé tirée du libellé, et le refus d'une catégorie
   inconnue. Sans base disponible, `categories()` sert la liste de repli —
   c'est elle qu'on exerce ici. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../lib/services');

/* ---------- Clé technique ---------- */

test('la clé ignore accents, casse, espaces et ponctuation', () => {
  assert.equal(svc.slug('Baby-sitting'), 'babysitting');
  assert.equal(svc.slug('Sauna & hammam'), 'saunahammam');
  assert.equal(svc.slug('  Chauffeur  '), 'chauffeur');
  assert.equal(svc.slug('Ménage'), 'menage');
});

test('deux écritures du même nom donnent la même clé', () => {
  assert.equal(svc.slug('Chef privé'), svc.slug('chef prive'));
  assert.equal(svc.slug('BABY SITTING'), svc.slug('baby-sitting'));
});

test('un libellé sans lettre ni chiffre ne donne pas de clé', () => {
  assert.equal(svc.slug('—'), '');
  assert.equal(svc.slug(''), '');
  assert.equal(svc.slug(null), '');
});

/* ---------- Catégories servies ---------- */

test('les catégories demandées sont présentes dès le repli', async () => {
  const cles = (await svc.categories()).map((x) => x.key);
  for (const k of ['sauna', 'massage', 'chef', 'babysitting', 'chauffeur']) {
    assert.ok(cles.includes(k), `catégorie manquante : ${k}`);
  }
});

test('« Autre » existe toujours et ferme la liste', async () => {
  const list = await svc.categories();
  assert.ok(list.some((x) => x.key === svc.CATEGORIE_DEFAUT));
  assert.equal(list[list.length - 1].key, svc.CATEGORIE_DEFAUT);
});

/* ---------- Catégorie d'un service ---------- */

test('une catégorie connue est retenue, quelle que soit son écriture', async () => {
  assert.equal(await svc.categorieValide('sauna', null), 'sauna');
  assert.equal(await svc.categorieValide('Baby-sitting', null), 'babysitting');
});

test('une catégorie inconnue est refusée, pas rangée dans « Autre »', async () => {
  await assert.rejects(() => svc.categorieValide('yoga-aerien', null), (e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /inconnue/i);
    return true;
  });
});

test('sans catégorie fournie, on garde celle déjà en place', async () => {
  assert.equal(await svc.categorieValide(undefined, 'massage'), 'massage');
  assert.equal(await svc.categorieValide('', 'chauffeur'), 'chauffeur');
});

test('un service tout neuf sans catégorie tombe dans « Autre »', async () => {
  assert.equal(await svc.categorieValide(undefined, null), svc.CATEGORIE_DEFAUT);
});
