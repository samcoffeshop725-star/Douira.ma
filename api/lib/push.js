/* =====================================================================
   Notifications push (Expo). Aucune dépendance : appel HTTPS direct à
   l'API Expo Push, qui relaie vers APNs / FCM.
   - un compte peut avoir plusieurs appareils (table push_tokens) ;
   - les jetons refusés (DeviceNotRegistered) sont supprimés ;
   - jamais de données sensibles dans le corps d'une notification
     (ni adresse, ni code d'accès) : seulement de quoi ouvrir le bon écran.
   ===================================================================== */
'use strict';
const db = require('./db');

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
const isExpoToken = t => /^Expo(nent)?PushToken\[[^\]]+\]$/.test(String(t || ''));

async function tokensFor(userId) {
  const r = await db.query('SELECT token FROM push_tokens WHERE user_id = $1', [userId]);
  return r.rows.map(x => x.token).filter(isExpoToken);
}

async function forget(tokens) {
  if (!tokens.length) return;
  await db.query('DELETE FROM push_tokens WHERE token = ANY($1)', [tokens]).catch(e => console.error('push.forget', e.message));
}

/* Envoie une notification à tous les appareils d'un compte.
   `data` sert à la navigation dans l'appli (ex. { url: '/booking/XYZ' }). */
async function toUser(userId, { title, body, data }) {
  const tokens = await tokensFor(userId);
  if (!tokens.length) return { sent: 0 };
  const messages = tokens.map(to => ({ to, title, body, data: data || {}, sound: 'default' }));
  let res;
  try {
    res = await fetch(EXPO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    });
  } catch (e) {
    console.error('push: envoi impossible', e.message);
    return { sent: 0 };
  }
  if (!res.ok) { console.error('push: Expo a répondu', res.status); return { sent: 0 }; }
  let out = null;
  try { out = await res.json(); } catch (e) { return { sent: 0 }; }
  // Purge des appareils désinstallés / jetons périmés
  const dead = [];
  (out && Array.isArray(out.data) ? out.data : []).forEach((r, i) => {
    if (r && r.status === 'error' && r.details && r.details.error === 'DeviceNotRegistered') dead.push(tokens[i]);
  });
  await forget(dead);
  return { sent: tokens.length - dead.length };
}

module.exports = { toUser, isExpoToken };
