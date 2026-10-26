/* =====================================================================
   Catalogue et tarifs côté serveur. Les biens viennent du même config.js que
   le site (lu dans un bac à sable, rechargé quand le fichier change) : le prix
   est donc TOUJOURS recalculé par le serveur, jamais pris du navigateur.
   Règles identiques au site (b_core.js : quote / activeDiscount / POLICIES).
   ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const POLICIES = { // remboursement de l'hébergement selon le délai avant l'arrivée
  flexible: { label: 'Flexible', rules: [[24, 100], [0, 0]] },
  moderee: { label: 'Modérée', rules: [[120, 100], [0, 50]] },
  stricte: { label: 'Stricte', rules: [[168, 50], [0, 0]] }
};
let cache = { mtime: -1, cfg: null, listings: [] };

function configPath() {
  const root = process.env.SITE_ROOT || path.join(__dirname, '..', '..');
  for (const p of [path.join(root, 'config.js'), path.join(root, 'Douira.com.site', 'config.js'), path.join(root, 'site', 'config.js')]) if (fs.existsSync(p)) return p;
  return null;
}
function load() {
  const p = configPath(); if (!p) return cache;
  const st = fs.statSync(p); if (st.mtimeMs === cache.mtime) return cache;
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(p, 'utf8'), sandbox, { timeout: 1000, filename: 'config.js' });
  const cfg = sandbox.window.DOUIRA_CONFIG || {};
  const city = (Array.isArray(cfg.villes) && cfg.villes[0]) || 'Marrakech';
  const listings = (Array.isArray(cfg.biens) ? cfg.biens : []).map((b, i) => ({
    id: 'b' + (b.id || i + 1), title: b.titre || 'Logement', titleEn: b.titreEn || '', city: b.ville || city, area: b.quartier || '',
    nightly: Number(b.prixNuit || 0), capacity: Number(b.voyageurs || 2), checkIn: b.arrivee || '15:00', checkOut: b.depart || '11:00',
    policy: ['flexible', 'moderee', 'stricte'].includes(b.annulation) ? b.annulation : 'moderee',
    discount: b.remise && Number(b.remise.pourcentage) > 0 ? { pct: Number(b.remise.pourcentage), from: b.remise.du || '', to: b.remise.au || '' } : null,
    minNights: Math.max(1, Number(b.nuitsMin || 1))
  })).filter(l => l.nightly > 0);
  cache = { mtime: st.mtimeMs, cfg, listings, path: p };
  return cache;
}
const config = () => load().cfg || {};
const listings = () => load().listings;
const listing = id => listings().find(l => l.id === id) || null;
const markupPct = () => { const m = Number(config().markupPct); return Number.isFinite(m) ? m : 12.5; };
const siteName = () => config().siteName || 'Douira';
const currency = () => String(config().devise || 'MAD').toUpperCase();

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const parseD = s => new Date(s + 'T00:00:00Z');
// « Aujourd'hui » au fuseau du site (Maroc par défaut, SITE_TZ pour un autre pays) : les séjours, les codes
// d'accès et les annulations suivent la date locale du voyageur, pas l'heure UTC du serveur.
const TZ = process.env.SITE_TZ || 'Africa/Casablanca';
const isoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dateStr = v => typeof v === 'string' ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10);
const shiftDays = (iso, n) => new Date(parseD(iso).getTime() + n * 864e5).toISOString().slice(0, 10);
const nights = (a, b) => Math.round((parseD(b) - parseD(a)) / 864e5);

function activeDiscount(l, start) { const d = l.discount; if (!d) return 0; if (d.from && start < d.from) return 0; if (d.to && start > d.to) return 0; return d.pct; }
// Devis : prix public = prix propriétaire + majoration (jamais affichée), remise éventuelle, pas de frais de ménage ni de taxe
function quote(l, start, end, guests) {
  const qty = nights(start, end);
  const price = Math.round(l.nightly * (1 + markupPct() / 100));
  const gross = qty * price, discountPct = activeDiscount(l, start), discount = Math.round(gross * discountPct / 100);
  const base = gross - discount;
  return { unit: 'nuit', qty, price, gross, discountPct, discount, base, serviceFee: 0, tax: 0, total: base, guests, policy: l.policy, listingId: l.id, title: l.title, currency: currency() };
}
function validate(l, start, end, guests) {
  if (!l) return 'Logement introuvable.';
  if (!ISO.test(start || '') || !ISO.test(end || '') || isNaN(parseD(start)) || isNaN(parseD(end))) return 'Dates invalides.';
  if (start < isoToday()) return "La date d'arrivée est passée.";
  const n = nights(start, end);
  if (n < 1) return 'La date de départ doit suivre la date d\'arrivée.';
  if (n < l.minNights) return `Séjour minimum : ${l.minNights} nuits.`;
  if (n > 90) return 'Séjour de 90 nuits maximum : contactez-nous pour un long séjour.';
  if (!Number.isInteger(guests) || guests < 1 || guests > l.capacity) return `Ce logement accueille ${l.capacity} personne${l.capacity > 1 ? 's' : ''} au maximum.`;
  return '';
}
// Remboursement de l'hébergement à l'annulation, selon la politique du bien et le délai avant l'arrivée (heure d'arrivée incluse)
// Décalage horaire courant du site (+01:00 au Maroc), calculé depuis le fuseau configuré
function tzOffset() {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(new Date()).find(x => x.type === 'timeZoneName');
  const m = /GMT([+-]\d{2}:\d{2})/.exec((p && p.value) || ''); return m ? m[1] : '+00:00';
}
function refundFor(booking, now = new Date()) {
  const l = listing(booking.listing_id); const pol = POLICIES[(l && l.policy) || booking.quote.policy] || POLICIES.moderee;
  const arrival = new Date(`${dateStr(booking.start_date)}T${(l && l.checkIn) || '15:00'}:00${tzOffset()}`);
  const hoursBefore = (arrival - now) / 36e5;
  const rule = pol.rules.find(([h]) => hoursBefore >= h) || [0, 0];
  return { pct: rule[1], amount: Math.round(booking.amount * rule[1] / 100), policy: pol.label };
}
module.exports = { load, config, listings, listing, markupPct, siteName, currency, quote, validate, nights, refundFor, POLICIES, ISO, isoToday, dateStr, shiftDays, TZ };
