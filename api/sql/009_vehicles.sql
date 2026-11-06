-- Voitures et motos proposées à la location, par ville.
-- Reprend le modèle déjà prévu côté site (nom, description, prix par jour, caution,
-- photo) en y ajoutant la ville et un statut de publication.

CREATE TABLE vehicles (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  -- Deux familles seulement, comme sur le site : voiture ou deux-roues.
  kind          text NOT NULL DEFAULT 'voiture' CHECK (kind IN ('voiture', 'moto')),
  city          text NOT NULL DEFAULT '',
  price_per_day integer NOT NULL DEFAULT 0,
  deposit       integer NOT NULL DEFAULT 0,
  seats         integer,
  gearbox       text NOT NULL DEFAULT '' CHECK (gearbox IN ('', 'manuelle', 'automatique')),
  specs         text NOT NULL DEFAULT '',
  photo         text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicles_public_idx ON vehicles(status, city, kind);

ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
