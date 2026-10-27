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
     node api/cli.js check                         vérifie la base (tables, verrou Supabase, administrateur, DATA_KEY)
     node api/cli.js seed <fichier.json>           enregistre les adresses/codes des biens (voir supabase/seed.example.json)
     node api/cli.js import-catalog                importe les biens et activités de config.js dans la base
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
  if (cmd === 'check') {
    let bad = 0; const t = (ok, msg) => { if (!ok) bad++; console.log((ok ? '  ✓ ' : '  ✗ ') + msg); };
    const u = new URL(process.env.DATABASE_URL), v = await db.one("SELECT current_setting('server_version') AS v, current_user AS r, current_database() AS d");
    console.log(`Base ${v.d} sur ${u.hostname}:${u.port || 5432} (PostgreSQL ${v.v}, rôle ${v.r})`);
    if (/\.pooler\.supabase\.com$/.test(u.hostname) && u.port === '6543') console.log('  ! port 6543 (mode transaction) : préférez le port 5432 (mode session) du pooler');
    const rls = Object.fromEntries((await db.query("SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'")).rows.map(r => [r.relname, r.relrowsecurity]));
    for (const name of ['users', 'sessions', 'password_resets', 'rate_limits', 'bookings', 'payment_events', 'listing_access', 'checkins', 'audit', 'settings', 'schema_migrations']) t(rls[name] === true, `table ${name}` + (name in rls ? (rls[name] ? '' : ' : RLS désactivée') : ' absente'));
    for (const { rolname } of (await db.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')")).rows) {
      const g = await db.one("SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee = $1", [rolname]);
      t(g.n === 0, `rôle Supabase ${rolname} : ` + (g.n ? g.n + ' droit(s) sur les tables' : 'aucun accès aux tables'));
    }
    const adm = await db.one("SELECT count(*)::int AS n, bool_or(must_change_password) AS pending FROM users WHERE role = 'admin' AND deleted_at IS NULL");
    t(adm.n > 0, adm.n ? `${adm.n} administrateur(s)` + (adm.pending ? ' (mot de passe initial à changer)' : '') : 'aucun administrateur : ADMIN_EMAIL + ADMIN_INITIAL_PASSWORD au démarrage du serveur, ou create-admin');
    let key = true; try { sec.decrypt(sec.encrypt('x')); } catch (e) { key = false; }
    t(key, key ? 'DATA_KEY valide' : 'DATA_KEY absente ou invalide (32 octets en base64)');
    const acc = (await db.query('SELECT listing_id, address_enc FROM listing_access ORDER BY listing_id')).rows;
    if (key) for (const r of acc) { let ok = true; try { sec.decrypt(r.address_enc); } catch (e) { ok = false; } t(ok, `accès ${r.listing_id} ` + (ok ? 'lisible' : 'illisible : chiffré avec une autre DATA_KEY')); }
    if (!acc.length) console.log('  · aucune adresse de bien enregistrée');
    if (bad) throw new Error(bad + ' point(s) à corriger'); console.log('Base prête.'); return;
  }
  if (cmd === 'seed') {
    // Données réelles uniquement (aucune donnée d'exemple) : adresses et codes chiffrés avec DATA_KEY, comme set-access
    if (!a[0]) throw new Error('seed <fichier.json>');
    const data = JSON.parse(fs.readFileSync(a[0], 'utf8')), rows = Array.isArray(data.acces) ? data.acces : [];
    const known = new Set(require('./lib/catalog').listings().map(l => l.id));
    for (const r of rows) {
      const id = String(r.bien || '').trim(); if (!/^b[\w-]{1,38}$/.test(id) || !String(r.adresse || '').trim()) throw new Error('entrée invalide : ' + JSON.stringify({ bien: r.bien }) + ' (bien « b1 », « b2 »… et adresse obligatoires)');
      if (!known.has(id)) console.warn(`  ! ${id} n'est pas (encore) dans config.js`);
    }
    await db.tx(async t => { for (const r of rows) await t.query('INSERT INTO listing_access (listing_id, address_enc, code_enc, notes_enc) VALUES ($1, $2, $3, $4) ON CONFLICT (listing_id) DO UPDATE SET address_enc = EXCLUDED.address_enc, code_enc = EXCLUDED.code_enc, notes_enc = EXCLUDED.notes_enc, updated_at = now()', [String(r.bien).trim(), sec.encrypt(String(r.adresse).trim()), sec.encrypt(String(r.code || '')), sec.encrypt(String(r.notes || ''))]); });
    console.log(rows.length + ' accès enregistré(s), chiffrés. Supprimez maintenant ' + a[0] + ' (il contient les adresses en clair).'); return;
  }
  if (cmd === 'import-catalog') {
    // Importe les biens et activités de config.js dans la base (tables listings / activities). Idempotent (ON CONFLICT).
    const vm = require('vm');
    const root = process.env.SITE_ROOT || path.join(__dirname, '..');
    let cfgPath = null;
    for (const p of [path.join(root, '..', 'config.js'), path.join(root, 'config.js'), path.join(root, '..', 'site', 'config.js')]) if (fs.existsSync(p)) { cfgPath = p; break; }
    if (!cfgPath) throw new Error('config.js introuvable');
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(cfgPath, 'utf8'), sandbox, { timeout: 1000, filename: 'config.js' });
    const cfg = sandbox.window.DOUIRA_CONFIG || {};
    const city = (Array.isArray(cfg.villes) && cfg.villes[0]) || 'Marrakech';
    const biens = Array.isArray(cfg.biens) ? cfg.biens : [], acts = Array.isArray(cfg.activites) ? cfg.activites : [];
    const stripV = s => String(s || '').replace(/\?.*$/, '');   // retire l'éventuel ?v=2 des chemins de photos
    const ACT_CATS = ['culture', 'souks', 'gastronomie', 'bienetre', 'excursions', 'sport', 'pratique'];
    const num = (v, d = null) => (v === 0 || (v != null && v !== '' && !isNaN(Number(v)))) ? Number(v) : d;
    const upsert = async (t, table, row) => { // noms de colonnes maîtrisés (pas d'entrée utilisateur) ; valeurs paramétrées
      const cols = Object.keys(row), ph = cols.map((_, i) => '$' + (i + 1)).join(', ');
      const set = cols.filter(c => c !== 'id').map(c => `${c} = EXCLUDED.${c}`).join(', ');
      await t.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph}) ON CONFLICT (id) DO UPDATE SET ${set}`, cols.map(c => row[c]));
    };
    let nl = 0, na = 0;
    await db.tx(async t => {
      for (let i = 0; i < biens.length; i++) {
        const b = biens[i], pos = b.positionApprox || {}, r = b.remise || {};
        await upsert(t, 'listings', {
          id: 'b' + (b.id || (i + 1)), category: /villa/i.test(b.type || '') ? 'villa' : 'appartement', status: 'published',
          management_mode: b.modeGestion === 'autonome' ? 'autonome' : 'delegue',
          title: b.titre || 'Logement', title_en: b.titreEn || '', description: b.description || '', description_en: b.descriptionEn || '',
          city: b.ville || city, area: b.quartier || '', lat: num(pos.lat), lng: num(pos.lng),
          guests: Math.max(1, num(b.voyageurs, 2)), bedrooms: num(b.chambres, 0), bathrooms: num(b.sallesDeBain, 0), surface: num(b.surface),
          amenities: JSON.stringify(Array.isArray(b.equipements) ? b.equipements : []),
          photos: JSON.stringify((Array.isArray(b.photos) ? b.photos : []).map(stripV)),
          owner_price: Math.max(0, Math.round(num(b.prixNuit, 0))),
          policy: ['flexible', 'moderee', 'stricte'].includes(b.annulation) ? b.annulation : 'moderee',
          check_in: b.arrivee || '15:00', check_out: b.depart || '11:00', min_nights: Math.max(1, num(b.nuitsMin, 1)),
          registration_no: b.numeroAutorisation || '', contact_phone: b.telephone || '', diamond: !!b.diamond,
          discount_pct: num(r.pourcentage, 0) > 0 ? Math.min(90, Math.round(num(r.pourcentage, 0))) : 0,
          discount_label: r.libelle || '', discount_from: r.du || null, discount_to: r.au || null,
          published_at: new Date().toISOString()
        });
        nl++;
      }
      for (let i = 0; i < acts.length; i++) {
        const a2 = acts[i], pos = a2.position || {};
        await upsert(t, 'activities', {
          id: 'a' + (a2.id || (i + 1)), name: a2.nom || 'Activité', category: ACT_CATS.includes(a2.categorie) ? a2.categorie : 'culture', status: 'published',
          agency_name: a2.agence || '', agency_desc: a2.agenceDesc || '', lat: num(pos.lat), lng: num(pos.lng),
          price: num(a2.prix), discount_pct: num(a2.reduction, 0) > 0 ? Math.min(90, Math.round(num(a2.reduction, 0))) : 0,
          note: a2.note || '', parcours: a2.parcours || '', photo: stripV(a2.photo)
        });
        na++;
      }
    });
    console.log(`${nl} bien(s) et ${na} activité(s) importés dans la base (tables listings / activities).`); return;
  }
  if (cmd === 'restore-decrypt') { const b = fs.readFileSync(a[0]); const key = Buffer.from(process.env.DATA_KEY, 'base64'); const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(-16)); process.stdout.write(require('zlib').gunzipSync(Buffer.concat([d.update(b.subarray(12, -16)), d.final()]))); return; }
  throw new Error('Commande inconnue. Voir l\'en-tête de api/cli.js');
}
async function user(email) { const u = await db.one('SELECT * FROM users WHERE email = $1', [String(email || '').toLowerCase()]); if (!u) throw new Error('Compte introuvable : ' + email); return u; }
function ask(q) { return new Promise(r => { const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, v => { rl.close(); r(v); }); }); }
main().then(() => db.end()).catch(e => { console.error('Erreur : ' + e.message); process.exit(1); });
