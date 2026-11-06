/* =====================================================================
   Factures.

   Trois principes, qui décident de tout ce qui suit.

     Une facture est émise au paiement, une seule fois par réservation.
     Tant que le séjour n'est pas payé, il n'y a rien à facturer.

     Une facture est FIGÉE. On recopie à l'émission le nom du client, le
     titre du logement et le détail du prix. Si le logement est renommé
     ensuite, la facture envoyée reste celle qu'on a envoyée.

     Les montants ne sont jamais recalculés. Ils viennent du devis stocké
     avec la réservation et du montant réellement encaissé. Une facture
     qui recalculerait pourrait annoncer autre chose que ce qui a été payé.

   Comme ailleurs, les RÈGLES sont des fonctions pures (testables sans base,
   voir api/test/invoices.test.js) et les ACCÈS BASE s'appuient dessus.
   ===================================================================== */
'use strict';
const db = require('./db');
const cat = require('./catalog');

function err(status, msg) { const e = new Error(msg); e.status = status; return e; }

/* ---------------- Règles pures ---------------- */

/**
 * Numéro affiché : « F-2026-000042 ».
 *
 * La séquence donne un entier croissant ; l'année vient de la date
 * d'émission, pas de l'heure courante — une facture relue l'an prochain
 * garde son numéro.
 */
function numeroFacture(n, emiseLe) {
  const d = emiseLe instanceof Date ? emiseLe : new Date(emiseLe || Date.now());
  const annee = Number.isNaN(d.getTime()) ? new Date().getFullYear() : d.getFullYear();
  return `F-${annee}-${String(Math.max(1, Math.trunc(Number(n) || 1))).padStart(6, '0')}`;
}

/** Arrondi au centime, en nombre sûr. */
const cents = v => Math.round(Number(v) || 0);
/** Centimes → unités de la devise, pour l'affichage. */
const enUnites = c => cents(c) / 100;

/**
 * Lignes de la facture, depuis le devis stocké.
 *
 * Le devis est en unités de la devise (dirhams), le montant encaissé en
 * centimes : on ramène tout en centimes, une seule fois, ici.
 */
function lignes(devis) {
  const q = devis && typeof devis === 'object' ? devis : {};
  const qty = Math.max(0, Math.trunc(Number(q.qty) || 0));
  const out = [];
  if (qty > 0) {
    out.push({
      libelle: `Hébergement — ${qty} ${q.unit === 'nuit' || !q.unit ? 'nuit' : q.unit}${qty > 1 ? 's' : ''}`,
      detail: `${enUnites(cents(Number(q.price) * 100))} × ${qty}`,
      montant: cents(Number(q.gross) * 100),
    });
  }
  const remise = cents(Number(q.discount) * 100);
  if (remise > 0) {
    const pct = Math.round(Number(q.discountPct) || 0);
    out.push({ libelle: `Remise${pct ? ` ${pct} %` : ''}`, detail: '', montant: -remise });
  }
  // Bon de parrainage éventuel : une ligne distincte, pour qu'on voie d'où vient
  // la réduction sur la facture (c'est le filleul qui l'a value au parrain).
  const parrainage = cents(Number(q.referralDiscount) * 100);
  if (parrainage > 0) {
    const pct = Math.round(Number(q.referralPct) || 0);
    out.push({ libelle: `Bon de parrainage${pct ? ` ${pct} %` : ''}`, detail: '', montant: -parrainage });
  }
  const frais = cents(Number(q.serviceFee) * 100);
  if (frais > 0) out.push({ libelle: 'Frais de service', detail: '', montant: frais });
  const taxe = cents(Number(q.tax) * 100);
  if (taxe > 0) out.push({ libelle: 'Taxes', detail: '', montant: taxe });
  return out;
}

/**
 * Construit la facture figée.
 *
 * @param booking  ligne `bookings` (devis + montant encaissé)
 * @param user     le client, tel qu'il est au moment de l'émission
 * @param listing  le logement, idem — peut manquer s'il a été retiré
 * @param vendeur  identité légale du vendeur (réglages) ; rien n'est inventé
 * @param numero   entier de la séquence
 * @param emiseLe  date d'émission
 */
function buildInvoice({ booking, user, listing, vendeur, numero, emiseLe }) {
  const b = booking || {};
  const devis = b.quote && typeof b.quote === 'object' ? b.quote : {};
  const d = emiseLe instanceof Date ? emiseLe : new Date(emiseLe || Date.now());
  const date = Number.isNaN(d.getTime()) ? new Date() : d;
  return {
    numero: numeroFacture(numero, date),
    emiseLe: date.toISOString(),
    reference: String(b.id || ''),
    vendeur: nettoyerVendeur(vendeur),
    client: {
      nom: String((user && user.name) || '').trim(),
      email: String((user && user.email) || '').trim(),
    },
    sejour: {
      logement: String((listing && listing.title) || devis.title || b.listing_id || '').trim(),
      ville: String((listing && listing.city) || '').trim(),
      arrivee: cat.dateStr(b.start_date),
      depart: cat.dateStr(b.end_date),
      voyageurs: Math.max(1, Math.trunc(Number(b.guests) || 1)),
    },
    lignes: lignes(devis),
    // Le total est celui qui a été encaissé, pas la somme des lignes : si
    // jamais les deux divergeaient, c'est le paiement qui fait foi.
    total: cents(b.amount),
    devise: String(b.currency || 'MAD'),
    payeLe: b.paid_at ? new Date(b.paid_at).toISOString() : null,
    moyen: String(b.psp || '').trim(),
  };
}

/**
 * Identité du vendeur : on ne garde que ce qui est renseigné.
 *
 * Un numéro d'identification inventé serait pire qu'absent — il vaut mieux
 * une facture incomplète qu'une facture fausse. L'administrateur les saisit
 * dans les réglages ; tant qu'ils n'y sont pas, les lignes ne paraissent pas.
 */
function nettoyerVendeur(v) {
  const s = v && typeof v === 'object' ? v : {};
  const t = (k, max = 120) => String(s[k] || '').trim().slice(0, max);
  return {
    nom: t('nom') || cat.siteName(),
    adresse: t('adresse', 240),
    ville: t('ville'),
    pays: t('pays'),
    email: t('email', 254),
    telephone: t('telephone', 30),
    ice: t('ice', 40),
    rc: t('rc', 40),
    if: t('if', 40),
    tva: t('tva', 40),
  };
}

/** Montant lisible : « 1 200 MAD ». Les factures ne convertissent jamais. */
function montant(c, devise) {
  const v = enUnites(c);
  const s = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: v % 1 === 0 ? 0 : 2 }).format(v);
  return `${s} ${devise}`;
}

const jour = iso => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
};

const echapper = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Facture en HTML : corps de l'e-mail, et source du PDF côté appli. */
function invoiceHtml(f) {
  const v = f.vendeur;
  const ids = [
    v.ice && `ICE ${echapper(v.ice)}`,
    v.rc && `RC ${echapper(v.rc)}`,
    v.if && `IF ${echapper(v.if)}`,
    v.tva && `TVA ${echapper(v.tva)}`,
  ].filter(Boolean).join(' · ');
  const lignesHtml = f.lignes.map(l => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #EADFD2">
          ${echapper(l.libelle)}${l.detail ? `<br><span style="color:#8A7A6A;font-size:13px">${echapper(l.detail)}</span>` : ''}
        </td>
        <td style="padding:10px 0;border-bottom:1px solid #EADFD2;text-align:right;white-space:nowrap">
          ${echapper(montant(l.montant, f.devise))}
        </td>
      </tr>`).join('');
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Facture ${echapper(f.numero)}</title></head>
<body style="margin:0;padding:28px;background:#FBF6EF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#2A1D14">
  <div style="max-width:640px;margin:0 auto;background:#FFFCF8;border:1px solid #EADFD2;border-radius:14px;padding:28px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div style="font-size:20px;font-weight:600;letter-spacing:3px">${echapper(v.nom).toUpperCase()}</div>
        ${v.adresse ? `<div style="color:#8A7A6A;font-size:13px;margin-top:4px">${echapper(v.adresse)}${v.ville ? `, ${echapper(v.ville)}` : ''}${v.pays ? `, ${echapper(v.pays)}` : ''}</div>` : ''}
        ${v.email || v.telephone ? `<div style="color:#8A7A6A;font-size:13px">${echapper([v.email, v.telephone].filter(Boolean).join(' · '))}</div>` : ''}
        ${ids ? `<div style="color:#8A7A6A;font-size:13px">${ids}</div>` : ''}
      </div>
    </div>

    <h1 style="font-size:22px;margin:24px 0 2px">Facture ${echapper(f.numero)}</h1>
    <div style="color:#8A7A6A;font-size:14px">Émise le ${echapper(jour(f.emiseLe))} · réservation ${echapper(f.reference)}</div>

    <div style="margin:22px 0;padding:14px;background:#F6EEE4;border-radius:10px">
      <div style="font-size:13px;color:#8A7A6A;text-transform:uppercase;letter-spacing:1px">Facturé à</div>
      <div style="font-weight:600;margin-top:4px">${echapper(f.client.nom)}</div>
      <div style="color:#8A7A6A;font-size:14px">${echapper(f.client.email)}</div>
    </div>

    <div style="font-size:13px;color:#8A7A6A;text-transform:uppercase;letter-spacing:1px">Séjour</div>
    <div style="font-weight:600;margin:4px 0 2px">${echapper(f.sejour.logement)}${f.sejour.ville ? ` · ${echapper(f.sejour.ville)}` : ''}</div>
    <div style="color:#8A7A6A;font-size:14px;margin-bottom:18px">
      Du ${echapper(jour(f.sejour.arrivee))} au ${echapper(jour(f.sejour.depart))} · ${f.sejour.voyageurs} voyageur${f.sejour.voyageurs > 1 ? 's' : ''}
    </div>

    <table style="width:100%;border-collapse:collapse;font-size:15px">
      ${lignesHtml}
      <tr>
        <td style="padding:14px 0;font-weight:600;font-size:17px">Total payé</td>
        <td style="padding:14px 0;text-align:right;font-weight:600;font-size:17px;color:#9C4221;white-space:nowrap">
          ${echapper(montant(f.total, f.devise))}
        </td>
      </tr>
    </table>

    ${f.payeLe ? `<div style="color:#8A7A6A;font-size:13px">Payé le ${echapper(jour(f.payeLe))}${f.moyen ? ` · ${echapper(f.moyen)}` : ''}</div>` : ''}
  </div>
</body></html>`;
}

/** Même facture en texte, pour les messageries qui n'affichent pas le HTML. */
function invoiceText(f) {
  const l = f.lignes.map(x => `- ${x.libelle}${x.detail ? ` (${x.detail})` : ''} : ${montant(x.montant, f.devise)}`).join('\n');
  return [
    `Facture ${f.numero}`,
    `Émise le ${jour(f.emiseLe)} · réservation ${f.reference}`,
    '',
    `Client : ${f.client.nom}`,
    `Séjour : ${f.sejour.logement}${f.sejour.ville ? `, ${f.sejour.ville}` : ''}`,
    `Du ${jour(f.sejour.arrivee)} au ${jour(f.sejour.depart)} · ${f.sejour.voyageurs} voyageur(s)`,
    '',
    l,
    `Total payé : ${montant(f.total, f.devise)}`,
    '',
    f.vendeur.nom,
  ].filter(x => x !== undefined).join('\n');
}

/* ---------------- Accès base ---------------- */

/** Identité légale du vendeur, saisie dans les réglages. */
async function vendeur() {
  const row = await db.one("SELECT value FROM settings WHERE key = 'facturation'").catch(() => null);
  return (row && row.value) || {};
}

/**
 * Émet la facture d'une réservation payée. Idempotent : rappelée (webhook
 * rejoué, reprise manuelle), elle renvoie la facture déjà émise sans en
 * créer une seconde.
 */
async function issueForBooking(booking) {
  if (!booking || booking.status !== 'confirmed') return null;
  const existante = await db.one('SELECT * FROM invoices WHERE booking_id = $1', [booking.id]);
  if (existante) return existante.snapshot;

  const user = await db.one('SELECT id, name, email FROM users WHERE id = $1', [booking.user_id]);
  const listing = cat.listing(booking.listing_id);
  const v = await vendeur();

  // La séquence est consommée par l'INSERT : c'est lui qui attribue le
  // numéro, et le snapshot est écrit juste après avec ce numéro-là.
  const row = await db.one(
    `INSERT INTO invoices (booking_id, amount, currency, snapshot)
     VALUES ($1, $2, $3, '{}'::jsonb)
     ON CONFLICT (booking_id) DO NOTHING
     RETURNING number, issued_at`,
    [booking.id, booking.amount, booking.currency || 'MAD']);
  if (!row) {
    // Course : une autre exécution vient de l'émettre.
    const dejaLa = await db.one('SELECT snapshot FROM invoices WHERE booking_id = $1', [booking.id]);
    return dejaLa ? dejaLa.snapshot : null;
  }

  const facture = buildInvoice({
    booking, user, listing, vendeur: v, numero: row.number, emiseLe: row.issued_at,
  });
  await db.query('UPDATE invoices SET snapshot = $2 WHERE booking_id = $1', [booking.id, JSON.stringify(facture)]);
  return facture;
}

/**
 * Facture d'une réservation, pour qui a le droit de la lire : le client,
 * l'administrateur, ou un collaborateur chargé des réservations.
 */
async function forBooking(actor, bookingId) {
  const b = await db.one('SELECT * FROM bookings WHERE id = $1', [bookingId]);
  if (!b) throw err(404, 'Réservation introuvable.');
  const autorise = actor && (
    String(b.user_id) === String(actor.id) ||
    actor.role === 'admin' ||
    (actor.role === 'collaborator' && Array.isArray(actor.scopes) && actor.scopes.includes('bookings'))
  );
  if (!autorise) throw err(403, 'Accès refusé.');
  if (b.status !== 'confirmed') throw err(409, 'La facture est établie une fois le paiement confirmé.');

  const row = await db.one('SELECT snapshot FROM invoices WHERE booking_id = $1', [bookingId]);
  if (row && row.snapshot && row.snapshot.numero) return row.snapshot;
  // Réservation payée avant la mise en place des factures : on l'émet maintenant.
  const f = await issueForBooking(b);
  if (!f) throw err(404, 'Facture indisponible.');
  return f;
}

module.exports = {
  // règles pures
  numeroFacture, lignes, buildInvoice, invoiceHtml, invoiceText, montant,
  // base
  issueForBooking, forBooking, vendeur,
};
