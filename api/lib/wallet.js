/* =====================================================================
   Carte de membre dans Apple Wallet et Google Wallet.

   Même principe que les réglages e-mail et encaissement : la configuration vit
   dans la table `settings`, les secrets y sont CHIFFRÉS et ne sont jamais
   renvoyés à l'écran — seul un booléen dit s'ils sont renseignés.

   Ce que porte le pass est exactement ce que porte déjà le QR de l'appli :
   « DOUIRA|M|<n°>|<jeton> ». Rien de nouveau n'est signé ici, donc une agence
   valide un pass Wallet, un QR à l'écran ou une carte plastique de la même
   façon, par /api/agency/redeem.

   Deux niveaux d'ambition, et le premier suffit :
   - sans rien demander à personne, le pass s'ajoute au Wallet et affiche le QR.
     Il est alors consultable hors ligne, ce qui est le vrai gain ;
   - le « tap » sans contact exige en plus un certificat NFC qu'Apple accorde au
     cas par cas (protocole VAS) et un lecteur compatible en agence. Tant qu'il
     n'est pas accordé, le bloc `nfc` est simplement omis — un pass qui le
     contiendrait sans y avoir droit serait refusé par Wallet.
   ===================================================================== */
'use strict';
const crypto = require('crypto');
const { execFile } = require('child_process');
const db = require('./db');
const sec = require('./security');

const KEY = 'wallet';

/* Secrets gérés : champ stocké <-> libellé affiché. */
const SECRETS = {
  apple: [
    { field: 'certEnc', label: 'Certificat du pass (PEM)' },
    { field: 'keyEnc', label: 'Clé privée du pass (PEM)' },
    { field: 'wwdrEnc', label: 'Certificat intermédiaire Apple WWDR (PEM)' },
    { field: 'nfcKeyEnc', label: 'Clé publique NFC (VAS)' },
  ],
  google: [{ field: 'saKeyEnc', label: 'Clé privée du compte de service' }],
};

const str = (v, max) => String(v == null ? '' : v).slice(0, max);

/* ---------- Configuration ---------- */

async function read() {
  const row = await db.one('SELECT value FROM settings WHERE key = $1', [KEY]).catch(() => null);
  return row ? row.value : null;
}

/** Vue sans secret, pour l'écran d'administration. */
async function publicView() {
  const cfg = (await read()) || {};
  const a = cfg.apple || {};
  const g = cfg.google || {};
  return {
    apple: {
      passTypeId: a.passTypeId || '',
      teamId: a.teamId || '',
      hasCert: !!a.certEnc,
      hasKey: !!a.keyEnc,
      hasWwdr: !!a.wwdrEnc,
      hasNfcKey: !!a.nfcKeyEnc,
      ready: !!(a.passTypeId && a.teamId && a.certEnc && a.keyEnc && a.wwdrEnc),
    },
    google: {
      issuerId: g.issuerId || '',
      classSuffix: g.classSuffix || '',
      saEmail: g.saEmail || '',
      hasKey: !!g.saKeyEnc,
      ready: !!(g.issuerId && g.classSuffix && g.saEmail && g.saKeyEnc),
    },
  };
}

/** Enregistre la configuration. Un secret absent du corps est CONSERVÉ. */
async function save(body) {
  const cur = (await read()) || {};
  const next = { apple: Object.assign({}, cur.apple), google: Object.assign({}, cur.google) };

  const a = body.apple || {};
  if (a.passTypeId !== undefined) next.apple.passTypeId = str(a.passTypeId, 120);
  if (a.teamId !== undefined) next.apple.teamId = str(a.teamId, 40);
  for (const s of SECRETS.apple) {
    const plain = a[s.field.replace(/Enc$/, '')];
    if (plain !== undefined) next.apple[s.field] = plain ? sec.encrypt(str(plain, 20000)) : null;
  }

  const g = body.google || {};
  if (g.issuerId !== undefined) next.google.issuerId = str(g.issuerId, 40);
  if (g.classSuffix !== undefined) next.google.classSuffix = str(g.classSuffix, 60);
  if (g.saEmail !== undefined) next.google.saEmail = str(g.saEmail, 200);
  for (const s of SECRETS.google) {
    const plain = g[s.field.replace(/Enc$/, '')];
    if (plain !== undefined) next.google[s.field] = plain ? sec.encrypt(str(plain, 20000)) : null;
  }

  await db.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [KEY, JSON.stringify(next)],
  );
  return publicView();
}

/* ---------- Apple Wallet ---------- */

/** Contenu de pass.json. Pur : c'est ce que les tests vérifient. */
function applePassJson(member, cfg) {
  const pass = {
    formatVersion: 1,
    passTypeIdentifier: cfg.passTypeId,
    teamIdentifier: cfg.teamId,
    organizationName: cfg.orgName || 'Douira',
    serialNumber: String(member.memberNo),
    description: 'Carte de membre Douira',
    logoText: 'Douira',
    backgroundColor: 'rgb(42,30,26)',
    foregroundColor: 'rgb(246,237,227)',
    labelColor: 'rgb(193,168,142)',
    barcodes: [
      { format: 'PKBarcodeFormatQR', message: member.qr, messageEncoding: 'iso-8859-1' },
    ],
    storeCard: {
      primaryFields: [{ key: 'member', label: 'N° DE MEMBRE', value: String(member.memberNo) }],
      secondaryFields: member.since
        ? [{ key: 'since', label: 'MEMBRE DEPUIS', value: member.since, dateStyle: 'PKDateStyleMedium' }]
        : [],
      backFields: [
        {
          key: 'usage',
          label: 'Comment s’en servir',
          value:
            'Présentez cette carte à nos agences partenaires : elles la lisent et votre réduction est appliquée immédiatement.',
        },
        { key: 'privacy', label: 'Confidentialité', value: 'Ce code vous est personnel, ne le partagez pas.' },
      ],
    },
  };
  // Le bloc NFC n'est légitime qu'avec le certificat VAS accordé par Apple.
  if (cfg.nfcKey) pass.nfc = { message: member.qr, encryptionPublicKey: cfg.nfcKey };
  return pass;
}

/** manifest.json : empreinte SHA-1 de chaque fichier du pass. */
function appleManifest(files) {
  const out = {};
  for (const [name, buf] of Object.entries(files)) {
    out[name] = crypto.createHash('sha1').update(buf).digest('hex');
  }
  return out;
}

/* ZIP « stocké » (sans compression) : un .pkpass n'est qu'une archive, et le
   format stocké se décrit en quelques dizaines de lignes — cela évite une
   dépendance pour un besoin aussi simple. */
function zip(files) {
  const names = Object.keys(files);
  const locals = [];
  const central = [];
  let offset = 0;

  for (const name of names) {
    const data = files[name];
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version nécessaire
    local.writeUInt16LE(0, 6); // drapeaux
    local.writeUInt16LE(0, 8); // méthode : stocké
    local.writeUInt16LE(0, 10); // heure
    local.writeUInt16LE(0x21, 12); // date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // champ supplémentaire
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const dir = Buffer.alloc(46 + nameBuf.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version d'écriture
    dir.writeUInt16LE(20, 6); // version nécessaire
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30); // champ supplémentaire
    dir.writeUInt16LE(0, 32); // commentaire
    dir.writeUInt16LE(0, 34); // disque
    dir.writeUInt16LE(0, 36); // attributs internes
    dir.writeUInt32LE(0, 38); // attributs externes
    dir.writeUInt32LE(offset, 42);
    nameBuf.copy(dir, 46);
    central.push(dir);

    offset += local.length + data.length;
  }

  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disque
  end.writeUInt16LE(0, 6); // disque du répertoire
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // commentaire
  return Buffer.concat([...locals, dirBuf, end]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* La signature d'un .pkpass est un PKCS#7 détaché. Node ne sait pas en produire :
   on délègue à openssl, présent sur les images de déploiement courantes.

   Le certificat ET la clé privée doivent transiter par des fichiers. On les écrit
   donc dans un répertoire temporaire à nous (0700), détruit dans un `finally` :
   si openssl échoue — ou se bloque, ce qu'une clé protégée par phrase de passe
   provoquait en attendant une saisie qui ne vient jamais — la clé ne reste pas
   en clair sur le disque. `-passin pass:` refuse d'emblée une telle clé, et le
   délai d'attente borne le processus. */
function signManifest(manifest, { cert, key, wwdr }) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douira-pass-'));
    fs.chmodSync(dir, 0o700);
  } catch (e) {
    return Promise.reject(new Error('Signature du pass impossible : écriture temporaire refusée.'));
  }

  const f = (name) => path.join(dir, name);
  const done = (resolve, reject, err, value) => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* déjà parti */ }
    if (err) reject(err); else resolve(value);
  };

  return new Promise((resolve, reject) => {
    try {
      fs.writeFileSync(f('manifest.json'), manifest, { mode: 0o600 });
      fs.writeFileSync(f('cert.pem'), cert, { mode: 0o600 });
      fs.writeFileSync(f('key.pem'), key, { mode: 0o600 });
      fs.writeFileSync(f('wwdr.pem'), wwdr, { mode: 0o600 });
    } catch (e) {
      return done(resolve, reject, new Error('Signature du pass impossible : écriture temporaire refusée.'));
    }

    execFile(
      'openssl',
      ['smime', '-binary', '-sign', '-certfile', f('wwdr.pem'), '-signer', f('cert.pem'),
        '-inkey', f('key.pem'), '-passin', 'pass:', '-in', f('manifest.json'),
        '-out', f('signature'), '-outform', 'DER', '-noattr'],
      { timeout: 10000, killSignal: 'SIGKILL' },
      (err) => {
        if (err) {
          const why = err.killed
            ? 'Signature du pass impossible : openssl n’a pas répondu. La clé privée est-elle protégée par une phrase de passe ?'
            : 'Signature du pass impossible : vérifiez le certificat Apple.';
          return done(resolve, reject, new Error(why));
        }
        let sig = null;
        try { sig = fs.readFileSync(f('signature')); } catch (e) { /* lecture impossible */ }
        if (!sig) return done(resolve, reject, new Error('Signature du pass impossible.'));
        done(resolve, reject, null, sig);
      },
    );
  });
}

/** Construit le .pkpass complet. `images` : { 'icon.png': Buffer, … }. */
async function applePass(member, images) {
  const cfg = (await read()) || {};
  const a = cfg.apple || {};
  if (!a.passTypeId || !a.teamId || !a.certEnc || !a.keyEnc || !a.wwdrEnc) {
    const e = new Error('Apple Wallet n’est pas configuré.');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }
  const pass = applePassJson(member, {
    passTypeId: a.passTypeId,
    teamId: a.teamId,
    nfcKey: a.nfcKeyEnc ? sec.decrypt(a.nfcKeyEnc) : null,
  });

  const files = Object.assign({}, images);
  files['pass.json'] = Buffer.from(JSON.stringify(pass), 'utf8');
  const manifest = Buffer.from(JSON.stringify(appleManifest(files)), 'utf8');
  files['manifest.json'] = manifest;
  files.signature = await signManifest(manifest, {
    cert: sec.decrypt(a.certEnc),
    key: sec.decrypt(a.keyEnc),
    wwdr: sec.decrypt(a.wwdrEnc),
  });
  return zip(files);
}

/* ---------- Google Wallet ---------- */

/** L'objet « carte générique » présenté à Google. Pur. */
function googleObject(member, cfg) {
  return {
    id: `${cfg.issuerId}.${member.memberNo}`,
    classId: `${cfg.issuerId}.${cfg.classSuffix}`,
    genericType: 'GENERIC_MEMBERSHIP',
    state: 'ACTIVE',
    hexBackgroundColor: '#2A1E1A',
    cardTitle: { defaultValue: { language: 'fr', value: 'Douira' } },
    header: { defaultValue: { language: 'fr', value: 'Carte de membre' } },
    subheader: { defaultValue: { language: 'fr', value: `N° ${member.memberNo}` } },
    barcode: { type: 'QR_CODE', value: member.qr, alternateText: String(member.memberNo) },
    textModulesData: [
      {
        id: 'usage',
        header: 'Comment s’en servir',
        body: 'Présentez cette carte à nos agences partenaires : votre réduction est appliquée immédiatement.',
      },
    ],
  };
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Jeton « save to wallet », signé RS256 par le compte de service. Pur hors signature. */
function googleJwt(object, { saEmail, saKey, origins }, now) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: saEmail,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor((now || Date.now()) / 1000),
    origins: origins || [],
    payload: { genericObjects: [object] },
  };
  const signing = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = crypto.createSign('RSA-SHA256').update(signing).sign(saKey);
  return `${signing}.${b64url(sig)}`;
}

/** URL à ouvrir pour ajouter la carte à Google Wallet. */
async function googleSaveUrl(member, siteUrl) {
  const cfg = (await read()) || {};
  const g = cfg.google || {};
  if (!g.issuerId || !g.classSuffix || !g.saEmail || !g.saKeyEnc) {
    const e = new Error('Google Wallet n’est pas configuré.');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }
  const jwt = googleJwt(googleObject(member, g), {
    saEmail: g.saEmail,
    saKey: sec.decrypt(g.saKeyEnc),
    origins: siteUrl ? [siteUrl] : [],
  });
  return `https://pay.google.com/gp/v/save/${jwt}`;
}

module.exports = {
  KEY,
  SECRETS,
  publicView,
  save,
  applePassJson,
  appleManifest,
  signManifest,
  zip,
  crc32,
  applePass,
  googleObject,
  googleJwt,
  googleSaveUrl,
};
