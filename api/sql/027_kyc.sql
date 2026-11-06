-- Vérification du visage : confirmer que la personne est bien le titulaire
-- de la pièce déposée.
--
-- La pièce seule prouve qu'un document existe, pas qu'il appartient à celui
-- qui le présente. Pour une location de véhicule, c'est exactement la question
-- qui compte : on ne remet pas les clés au porteur du permis d'un autre.
--
-- Principes de protection — les données biométriques sont une catégorie
-- particulière, et tout ici découle de là :
--
--   - le SELFIE est chiffré (clé DATA_KEY, comme les pièces et les adresses) ;
--   - il est EFFACÉ DÈS LA DÉCISION : une fois la comparaison faite, il n'a
--     plus d'usage, et ce qu'on ne garde pas ne peut pas fuir ;
--   - aucun gabarit facial, aucun score de similarité n'est conservé : on garde
--     la décision et son motif, pas la mesure ;
--   - `consent_at` porte le consentement explicite, horodaté — c'est la base
--     légale du traitement, elle doit pouvoir être prouvée ;
--   - `expires_at` est le filet : un dossier oublié sans décision voit son
--     selfie effacé par la routine d'entretien.
--
-- `provider` prépare la suite : aujourd'hui « humain » (l'équipe compare les
-- deux visages), demain le nom d'un prestataire qui rendra le même verdict.
-- Le reste du système n'aura pas à changer.

CREATE TABLE IF NOT EXISTS kyc_checks (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- La pièce à laquelle on compare le visage. ON DELETE SET NULL : effacer une
  -- pièce ne doit pas effacer la trace d'une vérification déjà rendue.
  doc_id       bigint REFERENCES client_documents(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'review'
               CHECK (status IN ('pending', 'review', 'passed', 'failed')),
  -- Motif lisible (« visage non concordant »), jamais un score.
  reason       text NOT NULL DEFAULT '',
  provider     text NOT NULL DEFAULT 'humain',
  provider_ref text NOT NULL DEFAULT '',
  -- Selfie chiffré, mis à NULL dès la décision ou à l'échéance.
  selfie_enc   text,
  mime         text NOT NULL DEFAULT '',
  consent_at   timestamptz NOT NULL DEFAULT now(),
  attempt      integer NOT NULL DEFAULT 1,
  reviewed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at   timestamptz,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kyc_checks_user_idx ON kyc_checks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS kyc_checks_status_idx ON kyc_checks (status);

ALTER TABLE kyc_checks ENABLE ROW LEVEL SECURITY;
