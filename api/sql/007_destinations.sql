-- Destinations ouvertes : un pays, une ville, sa devise et son cadrage de carte.
-- Jusqu'ici la liste était figée dans le code ; elle devient administrable, pour que
-- l'équipe puisse ouvrir un pays ou une ville sans livrer une nouvelle version.

CREATE TABLE destinations (
  id        text PRIMARY KEY,
  country   text NOT NULL,
  city      text NOT NULL,
  -- Devise facturée pour cette ville (doit être encaissable par un prestataire).
  currency  text NOT NULL DEFAULT 'EUR',
  lat       double precision,
  lng       double precision,
  -- Ouverte au public, ou préparée en coulisses.
  status    text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  sort      integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX destinations_city_idx ON destinations(lower(country), lower(city));
CREATE INDEX destinations_status_idx ON destinations(status, sort);

-- Les deux destinations actuelles, pour que rien ne change au déploiement.
INSERT INTO destinations (id, country, city, currency, lat, lng, status, sort) VALUES
  ('d1', 'Maroc',    'Marrakech', 'MAD', 31.6295,  -7.9811,  'published', 1),
  ('d2', 'Sénégal',  'Dakar',     'EUR', 14.7167, -17.4677,  'published', 2);

ALTER TABLE destinations ENABLE ROW LEVEL SECURITY;
