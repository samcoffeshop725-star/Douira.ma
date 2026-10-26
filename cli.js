#!/usr/bin/env node
/* =====================================================================
   Outils d'administration (à lancer sur le serveur ou avec DATABASE_URL) :
     node api/cli.js migrate                       applique les migrations
     node api/cli.js create-admin <email> <nom>    crée un administrateur (mot de passe demandé ou ADMIN_PASSWORD)
     node api/cli.js set-password <email>          nouveau mot de passe (demandé), changement obligatoire au prochain login
     node api/cli.js set-access <bienId> "<adresse>" "<code>" ["<notes>"]   adresse/code chiffrés d'un bien (b1, b2…)
     node api/cli.js bookings [statut]             liste les réservations (sans adresse)
     node api/cli.js export-user <email>           export RGPD d'un compte (JSON)
     node api/cli.js backup <dossier>              sauvegarde chiffrée (pg_dump | gzip | AES-256) avec DATA_KEY
     node api/cli.js keygen                        génère une DATA_KEY
   ===================================================================== */
'use strict';
const db = require('./lib/db');
const sec = require('./lib/security');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

async function main() {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === 'keygen') { console.log(crypto.randomBytes(32).toString('base64')); return; }
  db.init(process.env.DATABASE_URL); await db.migrate();
  if (cmd === 'migrate') { console.log('Migrations à jour.'); return; }
  if (cmd === 'create-admin') {
    const [email, name] = a; const pw = process.env.ADMIN_PASSWORD || await ask('Mot de passe (10 caractères min.) : ');
    const p = sec.passwordProblem(pw); if (p) throw new Error(p);
    await db.query("INSERT INTO users (email, name, role, pass_hash, consent_at, must_change_password) VALUES ($1, $2, 'admin', $3, now(), true) ON CONFLICT (email) DO UPDATE SET role = 'admin', pass_hash = EXCLUDED.pass_hash, must_change_password = true, deleted_at = NULL", [email.toLowerCase(), name || 'Administrateur', sec.hashPassword(pw)]);
    console.log('Administrateur créé : ' + email + ' (changement de mot de passe demandé à la première connexion).'); return;
  }
  if (cmd === 'set-password') { const u = await user(a[0]); const pw = process.env.ADMIN_PASSWORD || await ask('Nouveau mot de passe : '); await db.query('UPDATE users SET pass_hash = $2, must_change_password = true, updated_at = now() WHERE id = $1', [u.id, sec.hashPassword(pw)]); await db.query('DELETE FROM sessions WHERE user_id = $1', [u.id]); console.log('Mot de passe remplacé ; changement demandé à la prochaine connexion.'); return; }
  if (cmd === 'set-access') { const [id, address, code, notes] = a; if (!id || !address) throw new Error('set-access <bienId> "<adresse>" "<code>"'); await db.query('INSERT INTO listing_access (listing_id, address_enc, code_enc, notes_enc) VALUES ($1, $2, $3, $4) ON CONFLICT (listing_id) DO UPDATE SET address_enc = EXCLUDED.address_enc, code_enc = EXCLUDED.code_enc, notes_enc = EXCLUDED.notes_enc, updated_at = now()', [id, sec.encrypt(address), sec.encrypt(code || ''), sec.encrypt(notes || '')]); console.log('Accès enregistré (chiffré) pour ' + id); return; }
  if (cmd === 'bookings') { const r = await db.query(a[0] ? 'SELECT b.id, b.listing_id, b.start_date, b.end_date, b.guests, b.status, b.amount, b.currency, u.name, u.email FROM bookings b JOIN users u ON u.id = b.user_id WHERE b.status = $1 ORDER BY b.start_date DESC LIMIT 200' : 'SELECT b.id, b.listing_id, b.start_date, b.end_date, b.guests, b.status, b.amount, b.currency, u.name, u.email FROM bookings b JOIN users u ON u.id = b.user_id ORDER BY b.start_date DESC LIMIT 200', a[0] ? [a[0]] : []); console.table(r.rows.map(x => Object.assign(x, { amount: x.amount / 100 }))); return; }
  if (cmd === 'export-user') { const u = await user(a[0]); const bk = await db.query('SELECT * FROM bookings WHERE user_id = $1', [u.id]); delete u.pass_hash; console.log(JSON.stringify({ user: u, bookings: bk.rows }, null, 2)); return; }
  if (cmd === 'backup') {
    // pg_dump → gzip → AES-256-GCM avec DATA_KEY ; à déposer hors de l'hébergeur (stockage objet). Restauration : voir MISE-EN-LIGNE.md
    const dir = a[0] || '.'; fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `douira-${new Date().toISOString().replace(/[:.]/g, '-')}.sql.gz.enc`);
    const dump = execFileSync('pg_dump', ['--no-owner', '--format=plain', process.env.DATABASE_URL], { maxBuffer: 1024 * 1024 * 1024 });
    const gz = require('zlib').gzipSync(dump); const iv = crypto.randomBytes(12), key = Buffer.from(process.env.DATA_KEY, 'base64');
    const c = crypto.createCipheriv('aes-256-gcm', key, iv); const enc = Buffer.concat([iv, c.update(gz), c.final(), c.getAuthTag()]);
    fs.writeFileSync(out, enc, { mode: 0o600 }); console.log('Sauvegarde chiffrée : ' + out + ' (' + enc.length + ' octets)'); return;
  }
  if (cmd === 'restore-decrypt') { const b = fs.readFileSync(a[0]); const key = Buffer.from(process.env.DATA_KEY, 'base64'); const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(-16)); process.stdout.write(require('zlib').gunzipSync(Buffer.concat([d.update(b.subarray(12, -16)), d.final()]))); return; }
  throw new Error('Commande inconnue. Voir l\'en-tête de api/cli.js');
}
async function user(email) { const u = await db.one('SELECT * FROM users WHERE email = $1', [String(email || '').toLowerCase()]); if (!u) throw new Error('Compte introuvable : ' + email); return u; }
function ask(q) { return new Promise(r => { const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, v => { rl.close(); r(v); }); }); }
main().then(() => db.end()).catch(e => { console.error('Erreur : ' + e.message); process.exit(1); });
