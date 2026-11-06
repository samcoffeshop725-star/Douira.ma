-- Factures.
--
-- Une facture est émise quand le paiement est confirmé, et une seule fois par
-- réservation (contrainte d'unicité, pas seulement applicative).
--
-- Elle est FIGÉE à l'émission : `snapshot` garde la facture telle qu'elle a été
-- envoyée au client — son nom, le titre du logement, le détail du prix. Si le
-- logement est renommé ou le compte modifié ensuite, la facture ne bouge pas.
-- Une facture qui changerait après coup ne vaudrait rien.
--
-- Le numéro vient d'une séquence : il est croissant et ne se réutilise jamais.
-- (Un rollback de transaction peut y laisser un trou ; c'est le comportement
-- normal d'une séquence PostgreSQL, et le numéro reste unique et ordonné.)

CREATE TABLE invoices (
  number      bigserial PRIMARY KEY,
  booking_id  text NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE RESTRICT,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  -- Recopiés hors du snapshot pour pouvoir trier et totaliser sans l'ouvrir.
  amount      integer NOT NULL,
  currency    text NOT NULL DEFAULT 'MAD',
  snapshot    jsonb NOT NULL
);

CREATE INDEX invoices_issued_idx ON invoices(issued_at DESC);
