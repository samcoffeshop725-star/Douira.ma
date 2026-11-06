/* =====================================================================
   La frontière entre ce que remplit le prestataire et ce que décide l'équipe.

   C'est la règle la plus facile à desserrer sans s'en apercevoir : il suffit
   d'ajouter un champ à un formulaire. Ces tests disent ce qui passe, ce qui
   est refusé, et SURTOUT que le refus est bruyant — un prix silencieusement
   ignoré ferait croire au prestataire qu'il l'a changé.
   ===================================================================== */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const svc = require('../lib/services');
const { filtrerChampsPrestataire, peutRemplirFiche, CHAMPS_PRESTATAIRE, CHAMPS_EQUIPE } = svc;

/* ---------------- Ce qui passe ---------------- */

test('le prestataire remplit ce que l’équipe ne peut pas savoir à sa place', () => {
  const { champs, refuses } = filtrerChampsPrestataire({
    telephone: '+212 661 234 567',
    lat: 31.63,
    lng: -8.01,
    quartier: 'Guéliz',
    photo: 'photos/hammam.jpg',
    photos: ['photos/h1.jpg'],
    horaires: ['9 h – 19 h'],
    inclus: ['Serviettes'],
    description: 'Gommage au savon noir.',
  });
  assert.deepEqual(refuses, []);
  assert.equal(Object.keys(champs).length, 9);
  assert.equal(champs.telephone, '+212 661 234 567');
  assert.equal(champs.lat, 31.63);
});

test('l’identifiant du corps est ignoré : il vient de l’URL', () => {
  // Sans cela, on pourrait viser la fiche d'un autre en passant par la sienne.
  const { champs, refuses } = filtrerChampsPrestataire({ id: 's99', telephone: '+212661234567' });
  assert.equal(champs.id, undefined);
  assert.deepEqual(refuses, []);
});

test('un champ inconnu est ignoré sans bruit : il ne promettait rien', () => {
  const { champs, refuses } = filtrerChampsPrestataire({ couleur: 'bleu', quartier: 'Médina' });
  assert.deepEqual(Object.keys(champs), ['quartier']);
  assert.deepEqual(refuses, []);
});

/* ---------------- Ce qui est refusé, et bruyamment ---------------- */

test('le prix est refusé, et le refus est signalé — jamais ignoré en silence', () => {
  const { champs, refuses } = filtrerChampsPrestataire({ price: 1, telephone: '+212661234567' });
  assert.equal(champs.price, undefined, 'le prix ne doit pas passer');
  assert.ok(refuses.includes('price'), 'le refus doit être signalé');
});

test('publier, changer d’audience ou se réattribuer un service est refusé', () => {
  for (const champ of ['status', 'audience', 'assigneeId', 'name', 'category', 'city', 'unit']) {
    const { champs, refuses } = filtrerChampsPrestataire({ [champ]: 'x' });
    assert.equal(champs[champ], undefined, `${champ} ne doit pas passer`);
    assert.ok(refuses.includes(champ), `${champ} doit être signalé comme refusé`);
  }
});

test('les deux listes ne se recouvrent pas : un champ ne peut pas être des deux côtés', () => {
  const commun = CHAMPS_PRESTATAIRE.filter((k) => CHAMPS_EQUIPE.includes(k));
  assert.deepEqual(commun, [], 'un champ à la fois libre et réservé serait un trou');
});

test('un corps vide, nul ou mal formé ne lève pas et ne laisse rien passer', () => {
  for (const entree of [null, undefined, 'texte', 42, []]) {
    const { champs, refuses } = filtrerChampsPrestataire(entree);
    assert.deepEqual(champs, {});
    assert.deepEqual(refuses, []);
  }
});

/* ---------------- À qui la fiche appartient ---------------- */

const service = (assignee) => ({ id: 's1', assignee_id: assignee });

test('le prestataire à qui le service est confié peut remplir sa fiche', () => {
  assert.equal(peutRemplirFiche({ id: 'u1', role: 'collaborator' }, service('u1')), true);
});

test('un collaborateur ne touche pas à la fiche d’un autre', () => {
  assert.equal(peutRemplirFiche({ id: 'u2', role: 'collaborator' }, service('u1')), false);
});

test('un service confié à personne n’est pas à prendre', () => {
  // Sans cela, le premier collaborateur venu s'approprierait toute fiche libre.
  assert.equal(peutRemplirFiche({ id: 'u1', role: 'collaborator' }, service(null)), false);
});

test('l’administration passe partout, y compris sur un service sans titulaire', () => {
  assert.equal(peutRemplirFiche({ id: 'a', role: 'admin' }, service(null)), true);
  assert.equal(peutRemplirFiche({ id: 'a', role: 'admin' }, service('u1')), true);
});

test('un client ne remplit jamais une fiche, même en se nommant titulaire', () => {
  // Le rôle ne suffit pas : c'est l'identifiant qui décide. Un client dont
  // l'identifiant figurerait par accident en assignee_id reste un client —
  // mais le cas ne doit pas exister, et `save` refuse déjà de confier un
  // service à autre chose qu'un collaborateur.
  assert.equal(peutRemplirFiche({ id: 'c1', role: 'client' }, service('autre')), false);
});

test('sans utilisateur ou sans service, c’est non', () => {
  assert.equal(peutRemplirFiche(null, service('u1')), false);
  assert.equal(peutRemplirFiche({ id: 'u1', role: 'collaborator' }, null), false);
  assert.equal(peutRemplirFiche(undefined, undefined), false);
});

test('la comparaison des identifiants ne dépend pas du type', () => {
  // Un identifiant peut revenir en nombre d'un pilote, en texte d'un autre.
  assert.equal(peutRemplirFiche({ id: 7, role: 'collaborator' }, { id: 's1', assignee_id: '7' }), true);
});

/* ---------------- Les coordonnées ---------------- */

test('une coordonnée hors limites est refusée, pas écrite', () => {
  // Sans bornes, une latitude de 500 passait : le service se posait là où
  // aucune carte ne va, et il disparaissait sans explication.
  assert.throws(() => svc.coordValide(500, 'La latitude', 90), /entre -90 et 90/);
  assert.throws(() => svc.coordValide(-181, 'La longitude', 180), /entre -180 et 180/);
});

test('les coordonnées réelles de Marrakech et Dakar passent', () => {
  assert.equal(svc.coordValide(31.6295, 'La latitude', 90), 31.6295);
  assert.equal(svc.coordValide(-7.9811, 'La longitude', 180), -7.9811);
  assert.equal(svc.coordValide(14.7167, 'La latitude', 90), 14.7167);
  assert.equal(svc.coordValide(-17.4677, 'La longitude', 180), -17.4677);
});

test('les bornes elles-mêmes sont admises, et le vide reste vide', () => {
  assert.equal(svc.coordValide(90, 'La latitude', 90), 90);
  assert.equal(svc.coordValide(-90, 'La latitude', 90), -90);
  assert.equal(svc.coordValide('', 'La latitude', 90), null);
  assert.equal(svc.coordValide(null, 'La latitude', 90), null);
});

test('zéro est une coordonnée valide, pas une absence', () => {
  // Golfe de Guinée : le point zéro existe, et le confondre avec « vide »
  // effacerait une position légitime.
  assert.equal(svc.coordValide(0, 'La latitude', 90), 0);
});
