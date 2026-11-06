/* Parrainage : les règles qui tiennent sans base.
   Exécution : cd api && npm test

   Deux volets :
   1. les fonctions PURES (code, application d'un bon à un devis) ;
   2. la logique de crédit et de plafond, avec une fausse base qui retient les
      écritures — pour vérifier qu'un filleul ne crédite qu'un parrain, qu'on ne
      se parraine pas soi-même, et qu'au plafond aucun nouveau bon n'est émis. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

/* Fausse base posée AVANT le require du module (comme services-insert.test.js). */
const doubler = (chemin, exports) => {
  const resolu = require.resolve(chemin);
  require.cache[resolu] = { id: resolu, filename: resolu, loaded: true, children: [], paths: [], exports };
};
doubler('../lib/db', { async one() { return null; }, async query() { return { rows: [] }; } });

const refs = require('../lib/referrals');

/* ---------- Fonctions pures ---------- */

test('normCode : majuscules, sans espaces ni tirets, borné', () => {
  assert.equal(refs.normCode(' ab-cd ef '), 'ABCDEF');
  assert.equal(refs.normCode('aaaaaaaaaaaaaaaaaaaa').length, 16);
  assert.equal(refs.normCode(null), '');
});

test('genCode : longueur fixe, alphabet lisible (ni 0/O ni 1/I/L)', () => {
  const c = refs.genCode();
  assert.equal(c.length, 8);
  assert.ok(/^[A-Z2-9]+$/.test(c));
  assert.ok(!/[01OIL]/.test(c));
});

test('applyReferral : réduit le total, pose les champs de facture', () => {
  const q = { total: 2000, currency: 'MAD', base: 2000 };
  const a = refs.applyReferral(q, 5);
  assert.equal(a.total, 1900);
  assert.equal(a.referralPct, 5);
  assert.equal(a.referralDiscount, 100);
  // Le devis d'origine n'est pas modifié (fonction pure).
  assert.equal(q.total, 2000);
  assert.equal(q.referralPct, undefined);
});

test('applyReferral : sans bon, total inchangé et réduction nulle', () => {
  const a = refs.applyReferral({ total: 2000, currency: 'MAD' }, 0);
  assert.equal(a.total, 2000);
  assert.equal(a.referralDiscount, 0);
});

test('applyReferral : le total ne descend jamais sous zéro', () => {
  const a = refs.applyReferral({ total: 10, currency: 'MAD' }, 100);
  assert.equal(a.total, 0);
  assert.equal(a.referralDiscount, 10);
});

/* ---------- Crédit à l'inscription, avec une fausse transaction ---------- */

/* Une fausse transaction qui joue les quelques requêtes de creditOnRegister :
   recherche du parrain par code, insertion du filleul, comptage des bons, insert
   du bon. On enregistre ce qui est écrit pour l'affirmer ensuite. */
function fakeTx({ parrainId = 'P1', dejaInsert = false, bonsDispo = 0 } = {}) {
  const ecrits = { referrals: 0, rewards: 0 };
  const t = {
    async one(sql, params) {
      if (/FROM users WHERE referral_code/i.test(sql)) return parrainId ? { id: parrainId } : null;
      if (/INSERT INTO referrals/i.test(sql)) {
        if (dejaInsert) return null;             // ON CONFLICT DO NOTHING : filleul déjà parrainé
        ecrits.referrals++; return { id: 42 };
      }
      if (/count\(\*\).*referral_rewards/i.test(sql)) return { n: bonsDispo };
      return null;
    },
    async query(sql) {
      if (/INSERT INTO referral_rewards/i.test(sql)) ecrits.rewards++;
      return { rows: [] };
    },
  };
  return { t, ecrits };
}

test('un code valide crédite le parrain : un filleul, un bon', async () => {
  const { t, ecrits } = fakeTx({ parrainId: 'P1', bonsDispo: 0 });
  const r = await refs.creditOnRegister(t, 'F1', 'abcd1234');
  assert.deepEqual(r, { credited: true, capped: false });
  assert.equal(ecrits.referrals, 1);
  assert.equal(ecrits.rewards, 1);
});

test('code absent ou inconnu : rien, et l’inscription n’échoue pas', async () => {
  const vide = fakeTx({ parrainId: 'P1' });
  assert.deepEqual(await refs.creditOnRegister(vide.t, 'F1', ''), { credited: false });
  assert.equal(vide.ecrits.referrals, 0);

  const inconnu = fakeTx({ parrainId: null });
  assert.deepEqual(await refs.creditOnRegister(inconnu.t, 'F1', 'ZZZZ9999'), { credited: false });
  assert.equal(inconnu.ecrits.rewards, 0);
});

test('on ne se parraine pas soi-même', async () => {
  const { t, ecrits } = fakeTx({ parrainId: 'MOI' });
  const r = await refs.creditOnRegister(t, 'MOI', 'moncode1');
  assert.deepEqual(r, { credited: false });
  assert.equal(ecrits.referrals, 0);
});

test('un filleul déjà parrainé ne crédite pas une seconde fois', async () => {
  const { t, ecrits } = fakeTx({ parrainId: 'P1', dejaInsert: true });
  const r = await refs.creditOnRegister(t, 'F1', 'abcd1234');
  assert.deepEqual(r, { credited: false });
  assert.equal(ecrits.rewards, 0);
});

test('au plafond, le filleul est compté mais aucun bon n’est émis', async () => {
  const { t, ecrits } = fakeTx({ parrainId: 'P1', bonsDispo: refs.CAP });
  const r = await refs.creditOnRegister(t, 'F1', 'abcd1234');
  assert.deepEqual(r, { credited: true, capped: true });
  assert.equal(ecrits.referrals, 1);
  assert.equal(ecrits.rewards, 0);   // plafond atteint
});

test('les constantes sont celles annoncées (5 % par filleul, 5 bons max)', () => {
  assert.equal(refs.PCT, 5);
  assert.equal(refs.CAP, 5);
});
