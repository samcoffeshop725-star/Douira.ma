/* =====================================================================
   Ce que Douira gagne, levier par levier.

   Quatre sources de revenu, et une seule était chiffrée jusqu'ici :

     1. le logement   — majoration sur le prix propriétaire (`markupPct`) ;
     2. les services   — marge entre le prix de vente et le prix d'achat ;
     3. les véhicules  — idem, par jour de location ;
     4. les remises    — commission facturée au partenaire sur l'addition.

   ⚠️ Majoration ≠ taux de prise. Une majoration de 12,5 % appliquée AU PRIX
   PROPRIÉTAIRE ne laisse pas 12,5 % du prix public mais 12,5/112,5 = 11,1 %.
   C'est `takeRate()` qui fait la conversion, et `markupFor()` l'inverse.

   ⚠️ Une remise consentie au client est prélevée sur la marge, pas sur la part
   du propriétaire : celui-ci est payé sur son prix quoi qu'il arrive. La remise
   soutenable est donc bornée, et cette borne vaut exactement le taux de prise
   (`breakEvenDiscountPct()`). Au-delà, la réservation perd de l'argent, ce que
   `accommodation()` signale par `loss: true`.

   Unités : montants entiers dans l'unité principale de la devise de la ville
   (dirham, euro…), comme `listings.owner_price`, `services.price` et
   `vehicles.price_per_day`. Ce n'est PAS la convention en centièmes de
   `bookings.amount` (voir money.js) : ne pas mélanger les deux.

   Module pur : aucune base, aucun HTTP — testable directement (api/test/).
   ===================================================================== */
'use strict';

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pct = v => Math.min(100, Math.max(0, num(v)));
/** Coût laissé vide = inconnu. On ne suppose jamais une marge à sa place. */
const cost = v => (v === null || v === undefined || v === '' ? null : Math.max(0, num(v)));
const round = v => Math.round(v);

/** Part du prix public qui reste à Douira, pour une majoration donnée. */
const takeRate = markupPct => { const m = pct(markupPct); return (m / (100 + m)) * 100; };

/** Majoration à appliquer pour atteindre un taux de prise visé (inverse de takeRate). */
const markupFor = takePct => { const t = Math.min(99.9, Math.max(0, num(takePct))); return (t / (100 - t)) * 100; };

/**
 * Remise maximale qu'une réservation supporte avant de perdre de l'argent.
 * Le propriétaire étant payé sur son prix, toute la remise sort de la marge :
 * la borne est donc le taux de prise lui-même.
 */
const breakEvenDiscountPct = markupPct => takeRate(markupPct);

/**
 * Logement : prix public, part du propriétaire, marge.
 * `discountPct` est la remise affichée au client (listings.discount_pct).
 */
function accommodation({ nightly, nights, markupPct, discountPct = 0 } = {}) {
  const owner = Math.max(0, num(nightly)), qty = Math.max(0, Math.round(num(nights)));
  const m = pct(markupPct), d = pct(discountPct);
  const unitPrice = round(owner * (1 + m / 100));
  const gross = qty * unitPrice;
  const discount = round(gross * d / 100);
  const revenue = gross - discount;          // ce que le client paie
  const payout = qty * owner;                // ce que le propriétaire touche, remise ou pas
  const margin = revenue - payout;
  return {
    unitPrice, nights: qty, gross, discountPct: d, discount, revenue, payout, margin,
    takeRatePct: revenue > 0 ? (margin / revenue) * 100 : 0,
    breakEvenDiscountPct: breakEvenDiscountPct(m),
    loss: margin < 0,
  };
}

/**
 * Service à prix fixe : marge sur le prix d'achat prestataire.
 * `netPrice` absent → `margin: null` et `known: false` (coût non renseigné).
 */
function service({ price, netPrice, qty = 1 } = {}) {
  const n = Math.max(0, Math.round(num(qty)));
  const sell = Math.max(0, num(price)) * n;
  const buy = cost(netPrice);
  if (buy === null) return { revenue: sell, payout: null, margin: null, known: false };
  const payout = buy * n;
  return { revenue: sell, payout, margin: sell - payout, known: true };
}

/** Véhicule : même calcul, à la journée. */
function vehicle({ pricePerDay, netPricePerDay, days = 1 } = {}) {
  return service({ price: pricePerDay, netPrice: netPricePerDay, qty: days });
}

/**
 * Service « remise » : le client paie le partenaire, Douira facture une
 * commission sur l'addition. Sans montant d'addition relevé, rien à facturer.
 */
function partnerCommission({ billAmount, commissionPct } = {}) {
  const bill = cost(billAmount);
  const c = pct(commissionPct);
  if (bill === null) return { revenue: 0, bill: null, commissionPct: c, known: false };
  return { revenue: round(bill * c / 100), bill, commissionPct: c, known: true };
}

/**
 * Panier complet d'un séjour : addition des quatre leviers et taux de prise
 * mélangé. `blendedTakeRatePct` se calcule sur le seul chiffre d'affaires
 * encaissé par Douira (logement, services, véhicules) : les additions réglées
 * directement au partenaire n'y figurent pas, seule la commission compte.
 */
function basket({ stay, services = [], vehicles = [], redemptions = [] } = {}) {
  const parts = [];
  if (stay) parts.push({ kind: 'logement', ...accommodation(stay) });
  for (const s of services) parts.push({ kind: 'service', ...service(s) });
  for (const v of vehicles) parts.push({ kind: 'vehicule', ...vehicle(v) });

  let revenue = 0, margin = 0, unknown = 0;
  for (const p of parts) {
    revenue += p.revenue;
    if (p.margin === null) unknown++; else margin += p.margin;
  }
  let commission = 0;
  for (const r of redemptions) {
    const c = partnerCommission(r);
    parts.push({ kind: 'remise', ...c, margin: c.revenue, payout: 0 });
    commission += c.revenue;
  }
  const total = margin + commission;
  return {
    parts, revenue, margin, commission, total,
    // Marges non chiffrables (prix d'achat manquant) : le total est alors un plancher.
    unknownCosts: unknown,
    blendedTakeRatePct: revenue > 0 ? (total / revenue) * 100 : 0,
  };
}

module.exports = { takeRate, markupFor, breakEvenDiscountPct, accommodation, service, vehicle, partnerCommission, basket };
