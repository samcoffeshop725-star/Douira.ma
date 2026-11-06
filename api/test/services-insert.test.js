// L'enregistrement d'un service : l'INSERT doit rester cohérent.
//
// Le défaut d'origine : la migration 026 avait ajouté six colonnes (quartier,
// position, horaires, inclus, galerie) à la liste des valeurs mais pas à la
// liste des colonnes. L'ordre partait avec dix-sept valeurs pour onze
// colonnes, PostgreSQL le refusait en entier, et PLUS AUCUN service n'était
// enregistrable — ni créé, ni modifié.
//
// Un désaccord de ce genre ne se voit pas à la lecture et ne se voit pas non
// plus au typage : il n'apparaît qu'au moment où la base répond. Ces tests le
// font apparaître sans base, de deux façons :
//
//   1. en appelant save() avec une fausse base qui retient l'ordre envoyé, et
//      en vérifiant que chaque colonne reçoit bien SA valeur — ce qui attrape
//      aussi un simple décalage, pire qu'un refus car il écrirait le quartier
//      dans les horaires sans rien signaler ;
//   2. en relisant tous les INSERT de lib/ pour vérifier que le nombre de
//      colonnes égale le nombre de valeurs.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/* ---------- Fausse base et faux périmètres ----------
   Posés dans le cache de modules AVANT de charger lib/services, pour que
   celui-ci reçoive les doublures au lieu des vrais modules. Chaque fichier de
   test tourne dans son propre processus : rien ne fuit vers les autres. */

let dernierInsert = null;

const fausseBase = {
  async query() { return { rows: [] }; },          // catégories : repli
  async one(sql, params) {
    if (/INSERT\s+INTO\s+services/i.test(sql)) {
      dernierInsert = { sql, params };
      return { id: params[0] };
    }
    if (/MAX\(/i.test(sql)) return { n: 7 };       // nextId -> « s7 »
    return null;
  },
};

const fauxTeam = {
  async requireScope() { return { actor: { role: 'admin' }, scopes: [] }; },
  audienceFor() { return 'client'; },
};

const doubler = (chemin, exports) => {
  const resolu = require.resolve(chemin);
  require.cache[resolu] = { id: resolu, filename: resolu, loaded: true, children: [], paths: [], exports };
};
doubler('../lib/db', fausseBase);
doubler('../lib/team', fauxTeam);

const svc = require('../lib/services');

/* ---------- Ce que l'INSERT doit écrire, colonne par colonne ----------
   Chaque valeur est reconnaissable : si deux colonnes étaient permutées, la
   comparaison le dirait au lieu de passer. */

const ATTENDU = [
  ['id', 's7'],
  ['name', 'Service Témoin'],
  ['category', 'massage'],
  ['audience', 'both'],
  ['status', 'published'],
  ['city', 'Marrakech'],
  ['price', 350],
  ['unit', 'séance'],
  ['description', 'Description témoin.'],
  ['photo', 'photos/temoin.jpg'],
  ['assignee_id', null],
  ['area', 'Guéliz'],
  ['lat', 31.63],
  ['lng', -8.01],
  ['hours', '["09:00-18:00"]'],
  ['includes', '["Serviettes"]'],
  ['photos', '["photos/g1.jpg"]'],
  ['phone', '+212 6 61 00 00 00'],
];

const ENTREE = {
  name: 'Service Témoin',
  category: 'massage',
  audience: 'both',
  status: 'published',
  city: 'Marrakech',
  price: 350,
  unit: 'séance',
  description: 'Description témoin.',
  photo: 'photos/temoin.jpg',
  quartier: 'Guéliz',
  lat: 31.63,
  lng: -8.01,
  horaires: ['09:00-18:00'],
  inclus: ['Serviettes'],
  photos: ['photos/g1.jpg'],
  telephone: '+212 6 61 00 00 00',
};

const admin = { id: 'u-admin', role: 'admin' };

// Découpe une liste SQL sur les virgules de profondeur zéro : « a, f(b, c), d »
// donne trois éléments, pas quatre.
function decouperListe(s) {
  const out = [];
  let courant = '', profondeur = 0, quote = null;
  for (const c of s) {
    if (quote) { courant += c; if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; courant += c; continue; }
    if (c === '(') profondeur++;
    if (c === ')') profondeur--;
    if (c === ',' && profondeur === 0) { out.push(courant.trim()); courant = ''; continue; }
    courant += c;
  }
  if (courant.trim()) out.push(courant.trim());
  return out;
}

// Extrait les INSERT d'un source JavaScript. Les parenthèses sont équilibrées
// à la main : une expression SQL comme make_interval(secs => $2) en contient.
function lireInserts(src) {
  const res = [];
  const re = /INSERT\s+INTO\s+([a-z_]+)\s*\(/gi;
  let m;
  while ((m = re.exec(src))) {
    const bloc = (depuis) => {
      let i = depuis, profondeur = 1, quote = null, texte = '';
      for (; i < src.length; i++) {
        const c = src[i];
        if (quote) { texte += c; if (c === quote) quote = null; continue; }
        if (c === "'" || c === '"') { quote = c; texte += c; continue; }
        if (c === '(') profondeur++;
        if (c === ')') { profondeur--; if (profondeur === 0) break; }
        texte += c;
      }
      return { texte, fin: i + 1 };
    };
    const cols = bloc(re.lastIndex);
    const apres = /^\s*VALUES\s*\(/i.exec(src.slice(cols.fin));
    if (!apres) continue;                       // INSERT ... SELECT : hors sujet
    const vals = bloc(cols.fin + apres[0].length);
    res.push({ table: m[1], colonnes: decouperListe(cols.texte), valeurs: decouperListe(vals.texte) });
  }
  return res;
}

/* ---------- Les tests ---------- */

test('l’INSERT des services annonce autant de colonnes que de valeurs', async () => {
  dernierInsert = null;
  await svc.save(admin, ENTREE);
  assert.ok(dernierInsert, 'aucun INSERT n’a été envoyé');

  const [ins] = lireInserts(dernierInsert.sql);
  assert.ok(ins, 'l’INSERT n’a pas pu être relu');
  assert.equal(
    ins.colonnes.length, ins.valeurs.length,
    `${ins.colonnes.length} colonnes pour ${ins.valeurs.length} valeurs`);
});

test('le nombre de paramètres envoyés suit le nombre de colonnes', async () => {
  dernierInsert = null;
  await svc.save(admin, ENTREE);
  const [ins] = lireInserts(dernierInsert.sql);
  const marqueurs = new Set(dernierInsert.sql.match(/\$\d+/g) || []);
  assert.equal(ins.colonnes.length, marqueurs.size,
    `${ins.colonnes.length} colonnes pour ${marqueurs.size} marqueurs $n`);
  assert.equal(dernierInsert.params.length, ins.colonnes.length,
    `${dernierInsert.params.length} valeurs transmises pour ${ins.colonnes.length} colonnes`);
});

test('les colonnes de l’INSERT sont exactement celles attendues, dans cet ordre', async () => {
  dernierInsert = null;
  await svc.save(admin, ENTREE);
  const [ins] = lireInserts(dernierInsert.sql);
  assert.deepEqual(ins.colonnes, ATTENDU.map(([c]) => c));
});

test('chaque colonne reçoit sa propre valeur, sans décalage', async () => {
  // Un décalage est plus grave qu'un refus : la base accepterait l'ordre et
  // rangerait le quartier dans les horaires, sans que rien ne le signale.
  dernierInsert = null;
  await svc.save(admin, ENTREE);
  const [ins] = lireInserts(dernierInsert.sql);
  ATTENDU.forEach(([colonne, valeur], i) => {
    assert.equal(ins.colonnes[i], colonne, `colonne ${i + 1} déplacée`);
    assert.deepEqual(dernierInsert.params[i], valeur,
      `la colonne « ${colonne} » reçoit ${JSON.stringify(dernierInsert.params[i])}`);
  });
});

test('les six colonnes de la migration 026 sont bien dans l’INSERT', async () => {
  // Celles qu'on avait oubliées. Nommées une à une pour que leur disparition
  // soit lisible dans le rapport de test, pas seulement un compte qui change.
  dernierInsert = null;
  await svc.save(admin, ENTREE);
  const [ins] = lireInserts(dernierInsert.sql);
  for (const c of ['area', 'lat', 'lng', 'hours', 'includes', 'photos', 'phone']) {
    assert.ok(ins.colonnes.includes(c), `colonne « ${c} » absente de l’INSERT`);
  }
});

test('aucun INSERT de lib/ n’annonce un nombre de valeurs différent', () => {
  // Le même défaut ailleurs serait aussi invisible. On relit tout le dossier.
  const dossier = path.join(__dirname, '..', 'lib');
  const desaccords = [];
  let examines = 0;
  for (const f of fs.readdirSync(dossier).filter(x => x.endsWith('.js'))) {
    for (const ins of lireInserts(fs.readFileSync(path.join(dossier, f), 'utf8'))) {
      examines++;
      if (ins.colonnes.length !== ins.valeurs.length) {
        desaccords.push(`${f} — ${ins.table} : ${ins.colonnes.length} colonnes / ${ins.valeurs.length} valeurs`);
      }
    }
  }
  assert.ok(examines > 20, `seuls ${examines} INSERT relus : la lecture a échoué`);
  assert.deepEqual(desaccords, [], 'INSERT incohérents :\n' + desaccords.join('\n'));
});
