/* =====================================================================
   Envoi d'e-mails (confirmation, réinitialisation, alerte équipe).
   La configuration est saisie par l'administrateur dans l'interface
   (Administration > E-mails) et stockée en base, mot de passe chiffré :
   - SMTP (serveur, port, identifiant, mot de passe, expéditeur) : client intégré smtp.js ;
   - ou Resend (clé API) par HTTPS.
   Aucun identifiant n'est codé en dur. Sans configuration, l'e-mail est
   journalisé (sans son contenu) et le site continue de fonctionner.
   ===================================================================== */
'use strict';
const db = require('./db');
const sec = require('./security');
const smtp = require('./smtp');

let cache = { at: 0, cfg: null };
async function config() {
  if (Date.now() - cache.at < 30000) return cache.cfg;
  const row = await db.one("SELECT value FROM settings WHERE key = 'mail'").catch(() => null);
  cache = { at: Date.now(), cfg: row ? row.value : null };
  return cache.cfg;
}
const invalidate = () => { cache.at = 0; };
// Vue publique des réglages (jamais le mot de passe ni la clé) pour l'écran d'administration
const publicView = c => c ? { provider: c.provider || 'none', from: c.from || '', adminEmail: c.adminEmail || '', smtp: { host: (c.smtp || {}).host || '', port: (c.smtp || {}).port || 587, secure: !!(c.smtp || {}).secure, user: (c.smtp || {}).user || '', hasPassword: !!(c.smtp || {}).passwordEnc }, resend: { hasKey: !!c.resendKeyEnc } } : { provider: 'none', from: '', adminEmail: '', smtp: { host: '', port: 587, secure: false, user: '', hasPassword: false }, resend: { hasKey: false } };

async function send({ to, subject, text, html }) {
  const c = await config();
  const masked = String(to).replace(/(.).+(@.*)/, '$1***$2');
  try {
    if (c && c.provider === 'smtp' && c.smtp && c.smtp.host) {
      await smtp.send({ host: c.smtp.host, port: c.smtp.port, secure: !!c.smtp.secure, user: c.smtp.user, password: c.smtp.passwordEnc ? sec.decrypt(c.smtp.passwordEnc) : '', from: c.from, rejectUnauthorized: c.smtp.rejectUnauthorized !== false }, { to, subject, text, html });
      return { sent: true, provider: 'smtp' };
    }
    if (c && c.provider === 'resend' && c.resendKeyEnc) {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
      try {
        const r = await fetch('https://api.resend.com/emails', { method: 'POST', signal: ctl.signal, headers: { authorization: 'Bearer ' + sec.decrypt(c.resendKeyEnc), 'content-type': 'application/json' }, body: JSON.stringify({ from: c.from, to: [to], subject, text, html: html || undefined }) });
        if (!r.ok) throw new Error('réponse ' + r.status);
        return { sent: true, provider: 'resend' };
      } finally { clearTimeout(t); }
    }
    console.log(`E-mail (non envoyé : aucun service configuré dans Administration > E-mails) → ${masked} : ${subject}`);
    return { sent: false, reason: 'non configuré' };
  } catch (e) {
    console.error(`E-mail : échec vers ${masked} (« ${subject} ») : ${e.message}`);
    return { sent: false, reason: e.message };
  }
}
// Destinataire des alertes équipe : réglage de l'administration, sinon variable d'environnement
async function adminEmail() { const c = await config(); return (c && c.adminEmail) || process.env.ADMIN_EMAIL || ''; }
module.exports = { send, config, invalidate, publicView, adminEmail };
