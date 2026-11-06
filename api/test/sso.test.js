/* Vérification des jetons SSO (Google/Apple), sans réseau ni base.
   Exécution : cd api && npm test

   On fabrique une PAIRE de clés RSA de test, on publie la clé publique comme un
   JWKS (via un faux fetch), et on signe des jetons avec la clé privée. On vérifie
   alors que verifyIdToken accepte un jeton correct et refuse : mauvaise signature,
   mauvaise audience, mauvais émetteur, jeton expiré, algorithme non RS256. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const sso = require('../lib/sso');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: KID, use: 'sig', alg: 'RS256' });

const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
function forge(payload, { kid = KID, alg = 'RS256', key = privateKey } = {}) {
  const head = b64({ alg, kid, typ: 'JWT' });
  const body = b64(payload);
  const data = head + '.' + body;
  const sig = alg === 'none' ? '' : crypto.sign('RSA-SHA256', Buffer.from(data), key).toString('base64url');
  return data + '.' + sig;
}

// Faux fetch : sert notre JWKS de test quelle que soit l'URL demandée.
const vraiFetch = global.fetch;
test.before(() => { global.fetch = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) }); });
test.after(() => { global.fetch = vraiFetch; });

const base = () => ({
  iss: 'https://appleid.apple.com',
  aud: 'ma.douira.appli',
  sub: 'user-123',
  email: 'client@exemple.ma',
  exp: Math.floor(Date.now() / 1000) + 600,
  iat: Math.floor(Date.now() / 1000),
});
const opts = { jwksUrl: 'https://x/keys', issuers: ['https://appleid.apple.com'], audiences: ['ma.douira.appli'] };

test('un jeton correct est accepté et sa charge utile renvoyée', async () => {
  const p = await sso.verifyIdToken(forge(base()), opts);
  assert.equal(p.sub, 'user-123');
  assert.equal(p.email, 'client@exemple.ma');
});

test('une signature falsifiée est refusée', async () => {
  const t = forge(base());
  const trafique = t.slice(0, -4) + (t.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  await assert.rejects(() => sso.verifyIdToken(trafique, opts), /signature/i);
});

test('un jeton signé par une AUTRE clé est refusé', async () => {
  const autre = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(() => sso.verifyIdToken(forge(base(), { key: autre }), opts), /signature/i);
});

test('une audience étrangère est refusée', async () => {
  await assert.rejects(() => sso.verifyIdToken(forge(Object.assign(base(), { aud: 'autre.app' })), opts), /autre application/i);
});

test('un émetteur inattendu est refusé', async () => {
  await assert.rejects(() => sso.verifyIdToken(forge(Object.assign(base(), { iss: 'https://evil.example' })), opts), /émetteur/i);
});

test('un jeton expiré est refusé', async () => {
  await assert.rejects(() => sso.verifyIdToken(forge(Object.assign(base(), { exp: Math.floor(Date.now() / 1000) - 120 })), opts), /expiré/i);
});

test('un algorithme non RS256 est refusé', async () => {
  await assert.rejects(() => sso.verifyIdToken(forge(base(), { alg: 'none' }), opts), /algorithme/i);
});

test('sans audience configurée, tout est refusé', async () => {
  await assert.rejects(() => sso.verifyIdToken(forge(base()), Object.assign({}, opts, { audiences: [] })), /audience/i);
});

test('aud en tableau : accepté si une des valeurs est la nôtre', async () => {
  const p = await sso.verifyIdToken(forge(Object.assign(base(), { aud: ['autre.app', 'ma.douira.appli'] })), opts);
  assert.equal(p.sub, 'user-123');
});
