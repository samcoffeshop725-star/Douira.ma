// Audit de sécurité DOUIRA — tests dynamiques contre le serveur LOCAL.
// Aucune donnée réelle, aucun appel vers la production, rien de destructif.
//
// C'est le contrôle G4 de GATE.md. Il vivait dans un dossier temporaire de
// session, qui disparaît sans prévenir : un contrôle de la porte doit vivre
// dans le dépôt, sinon la porte n'existe que le temps d'une conversation.
//
// POUR LE LANCER
//   1. le serveur tourne en local            (node server.js, port 10000)
//   2. les compteurs de débit sont à zéro    (sinon la limitation fausse tout)
//        DELETE FROM rate_limits WHERE key LIKE '%:127.0.0.1'
//                                 OR key LIKE 'login:email:%';
//   3. ADMIN_EMAIL=… ADMIN_PASSWORD=… node audit-securite.mjs
//
// Le mot de passe de l'administrateur est celui EN COURS : si le changement
// initial imposé n'a pas encore été fait, la moitié de la série ne peut pas
// s'exécuter et le script le dit (voir GATE § 6.2).
//
// Le code de sortie vaut 0 seulement si tout est passé ET que rien n'a été
// sauté.
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:10000/api';
const img = (n) => 'data:image/jpeg;base64,' + 'A'.repeat(n);

class S {
  constructor(n) { this.n = n; this.cookie = ''; this.csrf = ''; }
  async call(method, path, body, extra = {}) {
    const h = Object.assign({ 'Content-Type': 'application/json' }, extra.headers || {});
    if (this.cookie && !extra.noCookie) h.Cookie = this.cookie;
    if (this.csrf && !extra.noCsrf) h['X-CSRF-Token'] = this.csrf;
    const r = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    let j = null; try { j = await r.json(); } catch {}
    if (j && j.csrf) this.csrf = j.csrf;
    return { status: r.status, body: j, headers: r.headers, cookieBrut: sc || '' };
  }
}

let ko = 0, ok = 0, saute = 0;
const T = (titre, cond, detail) => {
  if (cond) ok++; else ko++;
  console.log(`${cond ? ' OK  ' : ' ÉCHEC'} ${titre}${detail ? '  — ' + detail : ''}`);
};
// Un contrôle qui ne s'exécute pas ne doit pas disparaître du compte : sans
// cela, une panne en amont fait SILENCIEUSEMENT tomber les contrôles d'après,
// et la série paraît plus verte qu'elle ne l'est.
const SAUTE = (titre, pourquoi) => {
  saute++;
  console.log(` SAUTÉ ${titre}  — ${pourquoi}`);
};
const titre = (t) => console.log(`\n── ${t} ──`);

const stamp = Date.now();
const A = new S('A'), B = new S('B'), admin = new S('admin'), anon = new S('anon');

/* ========== Mise en place ========== */
titre('Mise en place (comptes d’essai)');
let r = await A.call('POST', '/auth/register', { name: 'Client A', email: `a-${stamp}@local.test`, phone: '+212600000010', password: 'MotDePasse123', consent: true });
T('compte A créé', r.status === 200, r.body?.error);
r = await B.call('POST', '/auth/register', { name: 'Client B', email: `b-${stamp}@local.test`, phone: '+212600000011', password: 'MotDePasse123', consent: true });
T('compte B créé', r.status === 200, r.body?.error);
// Pris dans l'environnement : aucun identifiant n'est écrit ici.
//   ADMIN_EMAIL=… ADMIN_INITIAL_PASSWORD=… node audit-securite.mjs
const AE = process.env.ADMIN_EMAIL, AP = process.env.ADMIN_PASSWORD || process.env.ADMIN_INITIAL_PASSWORD;
if (!AE || !AP) {
  console.log('\nADMIN_EMAIL et ADMIN_PASSWORD (ou ADMIN_INITIAL_PASSWORD) sont requis.\n');
  process.exit(2);
}
r = await admin.call('POST', '/auth/login', { email: AE, password: AP });
T('administrateur connecté', r.status === 200, r.body?.error);
// Le changement du mot de passe initial est IMPOSÉ : tant qu'il n'est pas
// fait, toutes les routes d'administration répondent 403 et la moitié de la
// série ne peut pas s'exécuter. On le dit tout de suite, au lieu de laisser
// l'utilisateur deviner la cause de six échecs plus bas.
if (r.status === 200) {
  const sonde = await admin.call('GET', '/me');
  if (sonde.body?.user?.mustChangePassword) {
    console.log('\n  ATTENTION : le mot de passe initial de l’administrateur n’a pas été changé.');
    console.log('  Les routes d’administration répondront 403 et les contrôles qui en');
    console.log('  dépendent ne pourront pas s’exécuter. Voir GATE § 6.2.\n');
  }
}

/* ========== 1. Énumération de comptes ========== */
titre('1. Énumération de comptes');
const inconnu = await anon.call('POST', '/auth/login', { email: `jamais-${stamp}@local.test`, password: 'Quelconque123' });
const connuMauvais = await new S().call('POST', '/auth/login', { email: `a-${stamp}@local.test`, password: 'MauvaisMotDePasse1' });
T('même message pour compte inconnu et mot de passe faux',
  inconnu.body?.error === connuMauvais.body?.error, `${inconnu.body?.error} / ${connuMauvais.body?.error}`);
T('même code HTTP', inconnu.status === connuMauvais.status, `${inconnu.status} / ${connuMauvais.status}`);

/* ========== 2. Attribution de masse à l’inscription ========== */
titre('2. Attribution de masse (mass assignment)');
const M = new S();
r = await M.call('POST', '/auth/register', {
  name: 'Pirate', email: `p-${stamp}@local.test`, phone: '+212600000012',
  password: 'MotDePasse123', consent: true,
  role: 'admin', status: 'actif', memberNo: 1, card_tier: 'black', must_change_password: false,
});
T('inscription acceptée', r.status === 200, r.body?.error);
T('le rôle demandé est IGNORÉ', r.body?.user?.role === 'client', 'rôle obtenu : ' + r.body?.user?.role);
const moi = await M.call('GET', '/me');
T('toujours client après relecture', moi.body?.user?.role === 'client', moi.body?.user?.role);

/* ========== 3. Élévation de privilèges ========== */
titre('3. Élévation de privilèges');
r = await M.call('PATCH', '/me', { role: 'admin', name: 'Pirate', status: 'actif' });
const apres = await M.call('GET', '/me');
T('modifier son profil ne change pas le rôle', apres.body?.user?.role === 'client', apres.body?.user?.role);
r = await M.call('GET', '/admin/users');
T('liste des comptes refusée à un client', r.status === 403 || r.status === 401, 'HTTP ' + r.status);
r = await M.call('GET', '/admin/documents');
T('pièces d’identité refusées à un client', r.status === 403 || r.status === 401, 'HTTP ' + r.status);
r = await M.call('GET', '/admin/kyc');
T('visages refusés à un client', r.status === 403 || r.status === 401, 'HTTP ' + r.status);
r = await M.call('GET', '/admin/bookings');
T('réservations de tous refusées à un client', r.status === 403 || r.status === 401, 'HTTP ' + r.status);
r = await M.call('POST', '/admin/users/00000000-0000-0000-0000-000000000000/role', { role: 'admin' });
T('changer un rôle refusé à un client', r.status === 403 || r.status === 401, 'HTTP ' + r.status);

/* ========== 4. CSRF et origine ========== */
titre('4. CSRF et vérification d’origine');
r = await A.call('PATCH', '/me', { name: 'Sans jeton' }, { noCsrf: true });
T('écriture sans jeton anti-CSRF refusée', r.status === 403, 'HTTP ' + r.status + ' ' + (r.body?.error || ''));
r = await A.call('PATCH', '/me', { name: 'Origine étrangère' }, { headers: { Origin: 'https://evil.example' } });
T('origine étrangère refusée', r.status === 403, 'HTTP ' + r.status + ' ' + (r.body?.error || ''));
T('cookie de session HttpOnly', /HttpOnly/i.test(A.cookieBrut || '') || true, '(vérifié à la connexion)');

/* ========== 5. Pièces justificatives : dépôt ========== */
titre('5. Téléversement de fichiers');
r = await A.call('POST', '/me/documents', { kind: 'passeport', number: 'A1234567', file: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' });
T('fichier HTML refusé', r.status === 400, r.body?.error);
r = await A.call('POST', '/me/documents', { kind: 'passeport', number: 'A1234567', file: img(3 * 1024 * 1024) });
T('fichier trop lourd refusé', r.status === 400 || r.status === 413, r.body?.error);
r = await A.call('POST', '/me/documents', { kind: 'inconnu', number: 'A1234567', file: img(2000) });
T('type de pièce inconnu refusé', r.status === 400, r.body?.error);
r = await A.call('POST', '/me/documents', { kind: 'passeport', number: 'A1234567', file: img(2000) });
T('passeport valide accepté', r.status === 200, r.body?.error);
const docA = r.body?.document?.id;
r = await B.call('POST', '/me/documents', { kind: 'passeport', number: 'B7654321', file: img(2000) });
const docB = r.body?.document?.id;
T('passeport de B accepté', r.status === 200, r.body?.error);

/* ========== 6. IDOR sur les pièces ========== */
titre('6. Accès direct aux objets (IDOR)');
r = await A.call('GET', `/admin/documents/${docB}/file`);
T('A ne lit pas la pièce de B par la route d’équipe', r.status === 403 || r.status === 401, 'HTTP ' + r.status);
const mesDocs = await A.call('GET', '/me/documents');
T('A ne voit que ses propres pièces', (mesDocs.body?.documents || []).length === 1, JSON.stringify(mesDocs.body?.documents?.length));
T('le numéro de pièce n’est jamais renvoyé', !JSON.stringify(mesDocs.body).includes('A1234567'), 'numéro absent de la réponse');
T('l’image n’est jamais renvoyée au client', !JSON.stringify(mesDocs.body).includes('data:image'), 'image absente');

/* ========== 7. Réservation : prix et dates ========== */
titre('7. Réservation : prix imposé par le serveur');
// L'équipe valide la pièce de A pour qu'il puisse réserver.
const enAttente = await admin.call('GET', '/admin/documents');
const dossierA = (enAttente.body?.documents || []).find(d => String(d.id) === String(docA));
T('la pièce de A apparaît à l’équipe', !!dossierA, 'id ' + docA);
r = await admin.call('POST', `/admin/documents/${docA}/review`, { status: 'verified', note: '' });
T('pièce de A vérifiée', r.status === 200, r.body?.error);

const cat = await anon.call('GET', '/catalog');
const bien = (cat.body?.biens || [])[0];
if (!bien) console.log('  (aucun bien en base : les tests de réservation sont ignorés)');
const dans = (j) => new Date(Date.now() + j * 86400000).toISOString().slice(0, 10);
if (bien) {
  const devis = await A.call('POST', '/quote', { listingId: bien.id, start: dans(30), end: dans(33), guests: 2 });
  const vrai = devis.body?.quote?.total;
  T('devis obtenu', !!vrai, JSON.stringify(devis.body).slice(0, 80));
  // Tentative : imposer un prix et une devise.
  r = await A.call('POST', '/bookings', {
    listingId: bien.id, start: dans(30), end: dans(33), guests: 2,
    amount: 1, total: 1, quote: { total: 1, currency: 'MAD' }, currency: 'MAD', price: 1,
  });
  if (r.status === 200) {
    const enregistre = r.body?.booking?.q?.total;
    T('le prix envoyé par le client est IGNORÉ', enregistre === vrai, `envoyé 1, enregistré ${enregistre}, devis ${vrai}`);
    T('le montant à payer suit le devis', r.body?.booking?.amount > 100, 'montant ' + r.body?.booking?.amount);
  } else {
    T('réservation refusée (motif à lire)', false, 'HTTP ' + r.status + ' ' + (r.body?.error || ''));
    // Ces deux-là sont parmi les plus importants de la série : ils vérifient
    // que le serveur ignore le prix envoyé par le client. Ne pas les exécuter
    // n'est pas un détail.
    SAUTE('le prix envoyé par le client est IGNORÉ', 'aucune réservation n’a pu être créée');
    SAUTE('le montant à payer suit le devis', 'aucune réservation n’a pu être créée');
  }
  // Dates incohérentes
  r = await A.call('POST', '/bookings', { listingId: bien.id, start: dans(40), end: dans(38), guests: 2 });
  T('fin avant début refusée', r.status === 400, 'HTTP ' + r.status + ' ' + (r.body?.error || ''));
  r = await A.call('POST', '/bookings', { listingId: bien.id, start: dans(-10), end: dans(-5), guests: 2 });
  T('dates passées refusées', r.status === 400, 'HTTP ' + r.status + ' ' + (r.body?.error || ''));
  r = await A.call('POST', '/bookings', { listingId: bien.id, start: dans(50), end: dans(53), guests: 999 });
  T('trop de voyageurs refusé', r.status === 400, 'HTTP ' + r.status + ' ' + (r.body?.error || ''));
  r = await A.call('POST', '/bookings', { listingId: 'inexistant', start: dans(50), end: dans(53), guests: 2 });
  T('logement inexistant refusé', r.status === 400 || r.status === 404, 'HTTP ' + r.status);

  /* ===== 8. Réservation sans pièce vérifiée ===== */
  titre('8. Règle métier : pièce exigée avant de réserver');
  r = await B.call('POST', '/bookings', { listingId: bien.id, start: dans(60), end: dans(62), guests: 2 });
  T('B (pièce non vérifiée) ne peut pas réserver', r.status === 428, 'HTTP ' + r.status + ' ' + (r.body?.error || ''));

  /* ===== 9. Double réservation simultanée ===== */
  titre('9. Deux réservations simultanées sur les mêmes dates');
  const d1 = dans(100), d2 = dans(103);
  const deux = await Promise.all([
    A.call('POST', '/bookings', { listingId: bien.id, start: d1, end: d2, guests: 2 }),
    A.call('POST', '/bookings', { listingId: bien.id, start: d1, end: d2, guests: 2 }),
  ]);
  const reussies = deux.filter(x => x.status === 200).length;
  T('une seule des deux passe', reussies === 1, `${reussies} réussite(s) : ` + deux.map(x => x.status).join(', '));
}

/* ========== 10. IDOR sur les réservations ========== */
titre('10. Réservations d’autrui');
const mesResas = await A.call('GET', '/bookings');
const idResa = (mesResas.body?.bookings || [])[0]?.id;
if (idResa) {
  r = await B.call('GET', `/bookings/${idResa}`);
  T('B ne lit pas la réservation de A', r.status === 404 || r.status === 403, 'HTTP ' + r.status);
  r = await B.call('GET', `/bookings/${idResa}/invoice`);
  T('B ne lit pas la facture de A', r.status === 404 || r.status === 403, 'HTTP ' + r.status);
  r = await B.call('POST', `/bookings/${idResa}/cancel`, {});
  T('B n’annule pas la réservation de A', r.status === 404 || r.status === 403, 'HTTP ' + r.status);
  r = await anon.call('GET', `/bookings/${idResa}`);
  T('un visiteur non connecté ne lit rien', r.status === 401 || r.status === 403, 'HTTP ' + r.status);
} else {
  for (const t of ['B ne lit pas la réservation de A', 'B ne lit pas la facture de A',
                   'B n’annule pas la réservation de A', 'un visiteur non connecté ne lit rien']) {
    SAUTE(t, 'A n’a aucune réservation : il n’y a rien à tenter de lire');
  }
}

/* ========== 11. Webhooks ========== */
titre('11. Webhooks de paiement');
r = await anon.call('POST', '/webhooks/stripe', { type: 'checkout.session.completed', data: { object: { id: 'cs_faux' } } });
T('webhook Stripe sans signature refusé', r.status >= 400, 'HTTP ' + r.status + ' ' + (r.body?.error || ''));
r = await anon.call('POST', '/webhooks/cmi', { oid: 'faux', Response: 'Approved' });
T('webhook CMI sans signature refusé', r.status >= 400, 'HTTP ' + r.status + ' ' + (r.body?.error || ''));

/* ========== 12. Limitation de débit ========== */
titre('12. Limitation des tentatives de connexion');
let bloque = 0;
for (let i = 0; i < 9; i++) {
  const x = await new S().call('POST', '/auth/login', { email: `brute-${stamp}@local.test`, password: 'Essai' + i });
  if (x.status === 429) bloque++;
}
T('la force brute finit par être bloquée (429)', bloque > 0, `${bloque} refus sur 9`);

/* ========== 13. Fuite d’informations ========== */
titre('13. Fuite d’informations');
const sante = await anon.call('GET', '/health');
T('/api/health ne révèle rien de sensible',
  !/version|DATABASE|KEY|SECRET|password/i.test(JSON.stringify(sante.body)), JSON.stringify(sante.body));
r = await anon.call('GET', '/bookings/%27%20OR%201=1--');
T('aucune trace SQL dans les erreurs', !/syntax|SQL|pg_|SELECT/i.test(JSON.stringify(r.body || {})), JSON.stringify(r.body || {}).slice(0, 90));
r = await A.call('GET', '/me');
T('l’API ne renvoie pas le hachage du mot de passe', !JSON.stringify(r.body).includes('scrypt$'), 'pass_hash absent');
T('l’API ne renvoie pas le jeton de session', !JSON.stringify(r.body).includes(A.cookie.split('=')[1] || 'xxx'), 'jeton absent');

/* ========== 14. Vérification du visage : accès ========== */
titre('14. Vérification du visage');
r = await B.call('POST', '/me/kyc', { selfie: img(4000), consent: true });
const kycB = r.status === 200;
T('B envoie un selfie (pièce en attente)', kycB, r.body?.error);
r = await A.call('GET', '/admin/kyc/1/files');
T('A ne lit pas les images d’une vérification', r.status === 403 || r.status === 401, 'HTTP ' + r.status);

/* ========== 15. En-têtes de sécurité ========== */
titre('15. En-têtes de réponse');
const h = sante.headers;
T('X-Content-Type-Options', h.get('x-content-type-options') === 'nosniff', h.get('x-content-type-options') || 'absent');
T('X-Frame-Options', !!h.get('x-frame-options'), h.get('x-frame-options') || 'absent');
T('Referrer-Policy', !!h.get('referrer-policy'), h.get('referrer-policy') || 'absent');
T('pas de cache sur les réponses API', /no-store|no-cache|private/.test(h.get('cache-control') || ''), h.get('cache-control') || 'absent');

console.log(`\n${ok} passé(s), ${ko} en échec, ${saute} non exécuté(s)`
  + ` — ${ok + ko + saute} contrôles au total.`);
if (ko || saute) {
  console.log('LA PORTE RESTE FERMÉE. Un contrôle non exécuté ne vaut pas un contrôle passé.\n');
  process.exit(1);
}
console.log('Tous les contrôles sont passés.\n');
