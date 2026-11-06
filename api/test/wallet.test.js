/* Règles métier des cartes Wallet : contenu du pass, empreintes, archive, jeton
   Google. Rien ici ne touche la base ni le réseau. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

const w = require('../lib/wallet');

const MEMBER = {
  memberNo: '482913',
  qr: 'DOUIRA|M|482913|A1B2C3D4E5F60718',
  since: '2026-03-14T10:00:00.000Z',
};

/* ---------- Apple : pass.json ---------- */

test('le pass porte exactement le QR déjà utilisé en agence', () => {
  const p = w.applePassJson(MEMBER, { passTypeId: 'pass.ma.douira.membre', teamId: 'ABCDE12345' });
  assert.equal(p.barcodes[0].message, MEMBER.qr);
  assert.equal(p.barcodes[0].format, 'PKBarcodeFormatQR');
  assert.equal(p.serialNumber, '482913');
  assert.equal(p.passTypeIdentifier, 'pass.ma.douira.membre');
  assert.equal(p.teamIdentifier, 'ABCDE12345');
});

test('sans certificat NFC accordé, le pass ne contient aucun bloc nfc', () => {
  const p = w.applePassJson(MEMBER, { passTypeId: 'pass.x', teamId: 'T' });
  assert.equal(p.nfc, undefined);
});

test('avec la clé NFC, le bloc nfc porte le même message que le QR', () => {
  const p = w.applePassJson(MEMBER, { passTypeId: 'pass.x', teamId: 'T', nfcKey: 'MFkwEwYH...' });
  assert.equal(p.nfc.message, MEMBER.qr);
  assert.equal(p.nfc.encryptionPublicKey, 'MFkwEwYH...');
});

test('un membre sans date d’adhésion ne produit pas de champ vide', () => {
  const p = w.applePassJson({ memberNo: '1', qr: 'x' }, { passTypeId: 'p', teamId: 't' });
  assert.deepEqual(p.storeCard.secondaryFields, []);
});

/* ---------- Apple : manifeste ---------- */

test('le manifeste donne le SHA-1 de chaque fichier', () => {
  const files = { 'pass.json': Buffer.from('{}'), 'icon.png': Buffer.from('PNG') };
  const m = w.appleManifest(files);
  assert.equal(m['pass.json'], crypto.createHash('sha1').update('{}').digest('hex'));
  assert.equal(m['icon.png'], crypto.createHash('sha1').update('PNG').digest('hex'));
  assert.equal(Object.keys(m).length, 2);
});

test('deux contenus différents n’ont pas la même empreinte', () => {
  const a = w.appleManifest({ 'pass.json': Buffer.from('{"a":1}') });
  const b = w.appleManifest({ 'pass.json': Buffer.from('{"a":2}') });
  assert.notEqual(a['pass.json'], b['pass.json']);
});

/* ---------- Apple : archive ---------- */

test('le CRC32 est celui attendu pour une entrée connue', () => {
  // Valeur de référence du CRC-32 de « 123456789 ».
  assert.equal(w.crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('l’archive produite est lisible par unzip et contient les fichiers', (t) => {
  let unzip = true;
  try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch (e) { unzip = false; }
  if (!unzip) return t.skip('unzip absent de la machine');

  const files = {
    'pass.json': Buffer.from(JSON.stringify({ formatVersion: 1 }), 'utf8'),
    'icon.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    'manifest.json': Buffer.from('{}', 'utf8'),
  };
  const buf = w.zip(files);
  const p = `${os.tmpdir()}/douira-test-${crypto.randomBytes(6).toString('hex')}.zip`;
  fs.writeFileSync(p, buf);
  try {
    execFileSync('unzip', ['-t', p], { stdio: 'ignore' }); // l'archive est saine
    const listing = execFileSync('unzip', ['-Z1', p]).toString();
    assert.deepEqual(listing.trim().split('\n').sort(), ['icon.png', 'manifest.json', 'pass.json']);
    const out = execFileSync('unzip', ['-p', p, 'pass.json']).toString();
    assert.equal(out, JSON.stringify({ formatVersion: 1 }));
  } finally {
    fs.unlinkSync(p);
  }
});

/* ---------- Google ---------- */

test('l’objet Google reprend l’identifiant d’émetteur et le QR', () => {
  const o = w.googleObject(MEMBER, { issuerId: '3388000000000000001', classSuffix: 'membre' });
  assert.equal(o.id, '3388000000000000001.482913');
  assert.equal(o.classId, '3388000000000000001.membre');
  assert.equal(o.barcode.value, MEMBER.qr);
  assert.equal(o.state, 'ACTIVE');
});

test('le jeton Google est signé et vérifiable avec la clé publique', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const obj = w.googleObject(MEMBER, { issuerId: '338', classSuffix: 'membre' });
  const jwt = w.googleJwt(obj, { saEmail: 'douira@projet.iam.gserviceaccount.com', saKey: privateKey, origins: ['https://douira.ma'] }, 1767225600000);

  const [h, c, s] = jwt.split('.');
  assert.ok(h && c && s);

  const unb64 = (x) => Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const header = JSON.parse(unb64(h).toString('utf8'));
  const claims = JSON.parse(unb64(c).toString('utf8'));
  assert.equal(header.alg, 'RS256');
  assert.equal(claims.aud, 'google');
  assert.equal(claims.typ, 'savetowallet');
  assert.equal(claims.iss, 'douira@projet.iam.gserviceaccount.com');
  assert.equal(claims.iat, 1767225600);
  assert.deepEqual(claims.origins, ['https://douira.ma']);
  assert.equal(claims.payload.genericObjects[0].barcode.value, MEMBER.qr);

  const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, unb64(s));
  assert.ok(ok, 'la signature doit être vérifiable');
});

test('le jeton ne contient aucun caractère hors base64url', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const obj = w.googleObject(MEMBER, { issuerId: '338', classSuffix: 'membre' });
  const jwt = w.googleJwt(obj, { saEmail: 'a@b.c', saKey: privateKey });
  assert.match(jwt, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('modifier une seule lettre du jeton invalide la signature', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const obj = w.googleObject(MEMBER, { issuerId: '338', classSuffix: 'membre' });
  const jwt = w.googleJwt(obj, { saEmail: 'a@b.c', saKey: privateKey });
  const [h, c, s] = jwt.split('.');
  const unb64 = (x) => Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const falsified = `${h}.${c.slice(0, -1)}${c.slice(-1) === 'A' ? 'B' : 'A'}`;
  assert.equal(crypto.createVerify('RSA-SHA256').update(falsified).verify(publicKey, unb64(s)), false);
});

/* ---------- Lien signé de téléchargement du pass ---------- */

process.env.CARD_SECRET = process.env.CARD_SECRET || 'secret-de-test-douira';
const sec = require('../lib/security');

test('un lien tout juste émis est accepté pour son propriétaire', () => {
  const now = Date.now();
  assert.equal(sec.walletLinkUser('u-1', sec.walletLink('u-1', now + 600000), now), true);
});

test('le lien d’un membre ne vaut pas pour un autre', () => {
  const now = Date.now();
  assert.equal(sec.walletLinkUser('u-2', sec.walletLink('u-1', now + 600000), now), false);
});

test('un lien périmé est refusé', () => {
  const now = Date.now();
  assert.equal(sec.walletLinkUser('u-1', sec.walletLink('u-1', now - 1), now), false);
});

test('repousser l’échéance sans resigner ne marche pas', () => {
  const now = Date.now();
  const sig = sec.walletLink('u-1', now + 1000).split('.')[1];
  assert.equal(sec.walletLinkUser('u-1', `${now + 999999}.${sig}`, now), false);
});

test('un lien mal formé est refusé sans lever d’erreur', () => {
  for (const bad of ['', 'x', '123', '123.', '.abc', 'abc.def', null, undefined, '1'.repeat(40)]) {
    assert.equal(sec.walletLinkUser('u-1', bad), false);
  }
});

/* ---------- Signature du pass : le secret ne doit pas rester sur le disque ---------- */

const { execFileSync: run } = require('node:child_process');
const path = require('node:path');

/** Autorité et certificat jetables, pour signer sans compte Apple. */
function fauxCertificats() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douira-test-'));
  const f = (n) => path.join(dir, n);
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('ca-key.pem'),
    '-out', f('ca.pem'), '-days', '2', '-subj', '/CN=Faux WWDR'], { stdio: 'ignore' });
  run('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('key.pem'),
    '-out', f('x.csr'), '-subj', '/CN=Pass Test'], { stdio: 'ignore' });
  run('openssl', ['x509', '-req', '-in', f('x.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca-key.pem'),
    '-CAcreateserial', '-out', f('cert.pem'), '-days', '2'], { stdio: 'ignore' });
  run('openssl', ['rsa', '-in', f('key.pem'), '-aes256', '-passout', 'pass:secret',
    '-out', f('key-chiffree.pem')], { stdio: 'ignore' });
  return { dir, f };
}

const residus = () =>
  fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('douira-pass-')).length;

test('la signature aboutit et ne laisse aucun fichier temporaire', async (t) => {
  try { run('openssl', ['version'], { stdio: 'ignore' }); } catch (e) { return t.skip('openssl absent'); }
  const { dir, f } = fauxCertificats();
  const avant = residus();
  try {
    const manifest = Buffer.from(JSON.stringify({ 'pass.json': 'abc' }), 'utf8');
    const sig = await w.signManifest(manifest, {
      cert: fs.readFileSync(f('cert.pem'), 'utf8'),
      key: fs.readFileSync(f('key.pem'), 'utf8'),
      wwdr: fs.readFileSync(f('ca.pem'), 'utf8'),
    });
    assert.ok(sig.length > 100, 'la signature doit avoir du contenu');
    assert.equal(residus(), avant, 'aucun répertoire temporaire ne doit subsister');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('une clé protégée par phrase de passe est refusée sans bloquer, et sans résidu', async (t) => {
  try { run('openssl', ['version'], { stdio: 'ignore' }); } catch (e) { return t.skip('openssl absent'); }
  const { dir, f } = fauxCertificats();
  const avant = residus();
  try {
    const manifest = Buffer.from('{}', 'utf8');
    await assert.rejects(
      () => w.signManifest(manifest, {
        cert: fs.readFileSync(f('cert.pem'), 'utf8'),
        key: fs.readFileSync(f('key-chiffree.pem'), 'utf8'),
        wwdr: fs.readFileSync(f('ca.pem'), 'utf8'),
      }),
      /Signature du pass impossible/,
    );
    assert.equal(residus(), avant, 'la clé privée ne doit pas rester dans /tmp');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- Révocation d'une carte de membre ---------- */

test('la version 1 reproduit exactement l’ancien jeton : les cartes en circulation restent valables', () => {
  const avant = crypto.createHmac('sha256', process.env.CARD_SECRET).update('u-1|482913').digest('hex').slice(0, 16).toUpperCase();
  assert.equal(sec.memberToken('u-1', 482913, 1), avant);
  assert.equal(sec.memberToken('u-1', 482913, undefined), avant, 'une version absente vaut 1');
  assert.equal(sec.memberToken('u-1', 482913, 0), avant, 'une version nulle vaut 1');
});

test('incrémenter la version change le jeton, donc révoque la carte', () => {
  const v1 = sec.memberToken('u-1', 482913, 1);
  const v2 = sec.memberToken('u-1', 482913, 2);
  const v3 = sec.memberToken('u-1', 482913, 3);
  assert.notEqual(v1, v2);
  assert.notEqual(v2, v3);
  assert.notEqual(v1, v3);
});

test('révoquer la carte d’un membre ne touche pas celle des autres', () => {
  const autreAvant = sec.memberToken('u-2', 999111, 1);
  sec.memberToken('u-1', 482913, 2); // u-1 passe en v2
  assert.equal(sec.memberToken('u-2', 999111, 1), autreAvant);
});

test('le jeton garde sa forme : 16 caractères hexadécimaux majuscules', () => {
  for (const v of [1, 2, 7, 42]) {
    assert.match(sec.memberToken('u-1', 482913, v), /^[0-9A-F]{16}$/);
  }
});
