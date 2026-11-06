-- Pièces justificatives des clients (loi 09-08).
--
-- Obligations couvertes :
--   - séjour  : déclaration des voyageurs (CIN pour les résidents, passeport sinon) ;
--   - véhicule : permis de conduire exigé du loueur.
--
-- Principes de protection :
--   - le NUMÉRO et le FICHIER sont chiffrés (même mécanisme que les adresses et codes
--     d'accès, clé DATA_KEY) : une copie de la base ne révèle aucune pièce ;
--   - `expires_at` porte la durée de conservation ; la routine d'entretien efface le
--     fichier dès l'échéance, en gardant la seule trace de vérification ;
--   - aucun document n'est renvoyé à un autre client : lecture réservée à son
--     propriétaire et à l'équipe habilitée.

CREATE TABLE client_documents (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('cin', 'passeport', 'permis')),
  number_enc  text NOT NULL DEFAULT '',
  -- Image de la pièce, chiffrée. Mise à NULL par la purge, sans perdre la vérification.
  file_enc    text,
  mime        text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  note        text NOT NULL DEFAULT '',
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  -- Échéance d'effacement du fichier.
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Une pièce de chaque type par personne : un nouvel envoi remplace le précédent.
CREATE UNIQUE INDEX client_documents_user_kind_idx ON client_documents(user_id, kind);
CREATE INDEX client_documents_status_idx ON client_documents(status);

ALTER TABLE client_documents ENABLE ROW LEVEL SECURITY;
