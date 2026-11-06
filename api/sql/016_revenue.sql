-- Ce que Douira gagne réellement sur un séjour.
--
-- Jusqu'ici un seul levier était chiffré : la majoration sur le prix propriétaire
-- (`listings.owner_price` + `markupPct`, voir lib/catalog.js). Les trois autres
-- sources de revenu existaient dans le produit sans être mesurables :
--
--   * les services à prix fixe   — `services.price` est un prix de vente sans
--                                  prix d'achat en face : marge inconnue ;
--   * les véhicules              — `vehicles.price_per_day` idem ;
--   * les services « remise »    — une réduction offerte au client, sans
--                                  contrepartie facturée au partenaire.
--
-- Cette migration ajoute le prix d'achat à côté de chaque prix de vente, et la
-- commission partenaire à côté de chaque remise. Additive et sans valeur par
-- défaut inventée : une colonne laissée vide signifie « non renseigné », et
-- lib/revenue.js refuse alors d'annoncer une marge plutôt que d'en supposer une.

-- 1) Services : prix d'achat chez le prestataire, et commission sur les remises.
ALTER TABLE services ADD COLUMN IF NOT EXISTS net_price      integer;                   -- payé au prestataire, devise de la ville ; NULL = non renseigné
ALTER TABLE services ADD COLUMN IF NOT EXISTS commission_pct integer NOT NULL DEFAULT 0; -- service « remise » : % de l'addition facturé au partenaire
ALTER TABLE services DROP CONSTRAINT IF EXISTS services_net_price_check;
ALTER TABLE services ADD CONSTRAINT services_net_price_check CHECK (net_price IS NULL OR net_price >= 0);
ALTER TABLE services DROP CONSTRAINT IF EXISTS services_commission_pct_check;
ALTER TABLE services ADD CONSTRAINT services_commission_pct_check CHECK (commission_pct BETWEEN 0 AND 90);

-- 2) Véhicules : prix payé au loueur.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS net_price_per_day integer;
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_net_price_check;
ALTER TABLE vehicles ADD CONSTRAINT vehicles_net_price_check CHECK (net_price_per_day IS NULL OR net_price_per_day >= 0);

-- 3) Remises activées : le montant de l'addition et la commission appliquée.
--    Sans le montant, une remise activée n'est qu'un compteur ; avec lui, elle
--    devient une ligne facturable au partenaire. Les deux restent optionnels :
--    l'agence qui scanne ne connaît pas toujours l'addition au moment du scan.
ALTER TABLE activity_redemptions ADD COLUMN IF NOT EXISTS bill_amount    integer;                   -- addition réglée par le client ; NULL = non relevée
ALTER TABLE activity_redemptions ADD COLUMN IF NOT EXISTS commission_pct integer NOT NULL DEFAULT 0; -- % de l'addition dû par le partenaire
ALTER TABLE activity_redemptions DROP CONSTRAINT IF EXISTS activity_redemptions_bill_check;
ALTER TABLE activity_redemptions ADD CONSTRAINT activity_redemptions_bill_check CHECK (bill_amount IS NULL OR bill_amount >= 0);
ALTER TABLE activity_redemptions DROP CONSTRAINT IF EXISTS activity_redemptions_commission_check;
ALTER TABLE activity_redemptions ADD CONSTRAINT activity_redemptions_commission_check CHECK (commission_pct BETWEEN 0 AND 90);

-- Relevé mensuel par partenaire : « combien ce restaurant doit-il à Douira ce mois-ci ».
CREATE INDEX IF NOT EXISTS activity_redemptions_billing_idx ON activity_redemptions(activity_id, at);
