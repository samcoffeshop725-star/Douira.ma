/* =====================================================================
   Devises.

   Convention interne : `bookings.amount` est TOUJOURS stocké en centièmes
   (montant × 100), quelle que soit la devise. C'est uniforme et sans perte.

   ⚠️ Certaines devises n'ont PAS de sous-division : le franc CFA (XOF/XAF),
   le yen, le won… Pour celles-là, un prestataire de paiement attend le montant
   SANS les centièmes. Envoyer 15 000 F CFA comme « 1500000 » facturerait cent
   fois trop. `pspAmount()` fait cette conversion à la frontière du prestataire,
   et `pspSupports()` refuse une devise que le prestataire ne sait pas traiter.

   Module pur : aucune base, aucun HTTP — testable directement (api/test/).
   ===================================================================== */
'use strict';

/** Devise par ville d'exploitation. Ajouter une ville ouverte = ajouter une ligne. */
const CURRENCY_BY_CITY = {
  marrakech: 'MAD',
  // Dakar est facturé en EUROS : aucun prestataire branché n'encaisse le franc CFA,
  // et Stripe gère l'euro. À rebasculer en 'XOF' le jour où un prestataire local
  // (Wave, PayDunya, Orange Money…) sera branché — le reste suivra tout seul.
  dakar: 'EUR',
};

/** Devises sans sous-unité (le « centime » n'existe pas). */
const ZERO_DECIMAL = new Set(['XOF', 'XAF', 'JPY', 'KRW', 'CLP', 'ISK', 'VND']);

/** Devises que chaque prestataire sait encaisser dans cette intégration. */
const PSP_CURRENCIES = {
  // Passerelle marocaine : dirham, et euro pour les cartes étrangères.
  cmi: new Set(['MAD', 'EUR']),
  // Stripe n'encaisse pas le franc CFA ; on reste sur ce que l'intégration gère.
  stripe: new Set(['MAD', 'EUR', 'USD', 'GBP', 'CAD', 'CHF']),
  // Prestataire de simulation (développement) : tout accepté.
  simulate: null,
};

const norm = v => String(v || '').trim().toUpperCase();
const cityKey = v => String(v || '').trim().toLowerCase();

/* Source des destinations, injectée au démarrage (lib/destinations.js). On évite
   un require croisé : money.js reste pur et testable sans base. */
let lookup = null;
function useDestinations(fn) { lookup = typeof fn === 'function' ? fn : null; }

/**
 * Devise d'une ville. D'abord les destinations réglées en administration, puis la
 * table figée ci-dessus, puis `fallback`.
 */
function currencyForCity(city, fallback = 'MAD') {
  if (lookup) {
    const fromDb = lookup(city);
    if (fromDb) return norm(fromDb);
  }
  return CURRENCY_BY_CITY[cityKey(city)] || norm(fallback) || 'MAD';
}

/** La devise a-t-elle des centimes ? */
function hasDecimals(currency) {
  return !ZERO_DECIMAL.has(norm(currency));
}

/** Montant affichable (unité principale) depuis le stockage en centièmes. */
function toMajor(minor, currency) {
  const n = Number(minor) || 0;
  return hasDecimals(currency) ? n / 100 : Math.round(n / 100);
}

/** Stockage en centièmes depuis un montant en unité principale. */
function toMinor(major, currency) {
  const n = Number(major) || 0;
  return hasDecimals(currency) ? Math.round(n * 100) : Math.round(n) * 100;
}

/**
 * Montant à transmettre au prestataire de paiement, depuis le stockage en centièmes.
 * Devise à décimales → inchangé (centimes). Devise sans décimale → divisé par 100.
 */
function pspAmount(minor, currency) {
  const n = Number(minor) || 0;
  return hasDecimals(currency) ? Math.round(n) : Math.round(n / 100);
}

/** Le prestataire sait-il encaisser cette devise ? */
function pspSupports(psp, currency) {
  const allowed = PSP_CURRENCIES[String(psp || '').toLowerCase()];
  if (allowed === null) return true;        // prestataire de simulation
  if (!allowed) return false;               // prestataire inconnu
  return allowed.has(norm(currency));
}

module.exports = {
  CURRENCY_BY_CITY, ZERO_DECIMAL, PSP_CURRENCIES,
  currencyForCity, hasDecimals, toMajor, toMinor, pspAmount, pspSupports, useDestinations,
};
