/* =====================================================================
   Comptes d'encaissement, réglables depuis l'administration.

   Même principe que les réglages e-mail (lib/mail.js) : la configuration vit dans
   la table `settings`, les secrets y sont CHIFFRÉS et ne sont jamais renvoyés à
   l'écran — seul un booléen dit s'ils sont renseignés.

   Deux niveaux :
   - un prestataire par défaut ;
   - un prestataire PAR VILLE, pour encaisser Marrakech sur un compte marocain et
     une autre ville sur un autre compte (Stripe par exemple).

   Les variables d'environnement restent le repli : si rien n'est configuré en
   base, le comportement actuel est conservé. Les modules api/psp/* lisent leurs
   identifiants via `env()`, qui regarde d'abord la base puis l'environnement.
   ===================================================================== */
'use strict';
const db = require('./db');
const sec = require('./security');

const KEY = 'payments';
const PROVIDERS = ['stripe', 'cmi', 'simulate'];

/* Secrets gérés, par prestataire : nom de variable d'environnement <-> champ stocké. */
const SECRETS = {
  stripe: [
    { env: 'STRIPE_SECRET_KEY', field: 'secretEnc', label: 'Clé secrète' },
    { env: 'STRIPE_WEBHOOK_SECRET', field: 'webhookEnc', label: 'Secret de webhook' },
  ],
  cmi: [
    { env: 'CMI_CLIENT_ID', field: 'clientIdEnc', label: 'Identifiant marchand' },
    { env: 'CMI_STORE_KEY', field: 'storeKeyEnc', label: 'Clé de boutique' },
    { env: 'CMI_GATEWAY_URL', field: 'gatewayEnc', label: 'URL de la passerelle' },
  ],
};

/* Instantané déchiffré, lisible de façon SYNCHRONE par les modules de paiement
   (leurs accesseurs sont synchrones). Rafraîchi au démarrage et après chaque
   enregistrement. */
let live = { cfg: null, creds: {} };

async function read() {
  const row = await db.one('SELECT value FROM settings WHERE key = $1', [KEY]).catch(() => null);
  return row ? row.value : null;
}

/** Recharge l'instantané depuis la base. À appeler au démarrage et après save(). */
async function refresh() {
  const cfg = await read();
  const creds = {};
  for (const provider of Object.keys(SECRETS)) {
    const node = (cfg && cfg[provider]) || {};
    for (const s of SECRETS[provider]) {
      if (node[s.field]) {
        try { creds[s.env] = sec.decrypt(node[s.field]); }
        catch (e) { console.error(`paiement : déchiffrement impossible (${s.env}) — DATA_KEY ?`); }
      }
    }
  }
  live = { cfg, creds };
  return cfg;
}

/** Identifiant : base d'abord, variable d'environnement en repli. */
function env(name) {
  return live.creds[name] || process.env[name] || '';
}

/** Prestataire à utiliser pour une ville donnée (sinon le défaut, sinon l'environnement). */
function providerFor(city) {
  const cfg = live.cfg || {};
  const byCity = cfg.byCity || {};
  const key = String(city || '').trim().toLowerCase();
  const chosen = byCity[key] || cfg.default || process.env.PSP || '';
  return PROVIDERS.includes(chosen) ? chosen : '';
}

/** Vue d'administration : jamais un secret, seulement s'il est renseigné. */
function publicView(cfg) {
  const c = cfg || {};
  const k = env('STRIPE_SECRET_KEY');
  const out = {
    providers: PROVIDERS, default: c.default || process.env.PSP || '', byCity: c.byCity || {}, secrets: {},
    // Mode de la clé Stripe en service (jamais la clé) : l'équipe voit d'un coup
    // d'œil si les clients paient pour de vrai ou sur l'environnement de test.
    stripeMode: /^sk_test_/.test(k) ? 'test' : /^sk_live_/.test(k) ? 'live' : '',
  };
  for (const provider of Object.keys(SECRETS)) {
    out.secrets[provider] = SECRETS[provider].map(s => ({
      env: s.env,
      label: s.label,
      // Renseigné en base, ou hérité de l'environnement du serveur.
      set: !!((c[provider] || {})[s.field]),
      fromEnv: !((c[provider] || {})[s.field]) && !!process.env[s.env],
    }));
  }
  return out;
}

/**
 * Enregistre les réglages. Un secret laissé vide n'écrase PAS l'existant ;
 * pour en retirer un, envoyer la chaîne '-'.
 */
async function save(admin, data) {
  const d = data || {};
  const current = (await read()) || {};
  const next = { default: current.default || '', byCity: Object.assign({}, current.byCity), };

  if (typeof d.default === 'string' && (PROVIDERS.includes(d.default) || d.default === '')) next.default = d.default;

  if (d.byCity && typeof d.byCity === 'object') {
    for (const [city, provider] of Object.entries(d.byCity)) {
      const key = String(city).trim().toLowerCase().slice(0, 60);
      if (!key) continue;
      if (provider === '' || provider === null) delete next.byCity[key];
      else if (PROVIDERS.includes(provider)) next.byCity[key] = provider;
    }
  }

  for (const provider of Object.keys(SECRETS)) {
    const incoming = d[provider] || {};
    const node = Object.assign({}, current[provider]);
    for (const s of SECRETS[provider]) {
      const v = incoming[s.env];
      if (typeof v !== 'string' || v === '') continue;     // vide : on garde l'existant
      if (v === '-') { delete node[s.field]; continue; }    // '-' : on retire le secret
      node[s.field] = sec.encrypt(v.trim());
    }
    if (Object.keys(node).length) next[provider] = node;
  }

  await db.query(
    `INSERT INTO settings (key, value, updated_by) VALUES ($3, $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(next), admin ? admin.id : null, KEY]);
  await refresh();
  return publicView(next);
}

async function currentView() {
  return publicView(await read());
}

module.exports = { PROVIDERS, SECRETS, refresh, env, providerFor, publicView, save, currentView };
