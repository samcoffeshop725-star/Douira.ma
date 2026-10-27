-- Douira · catalogue en base : biens (listings) et activités (activities), plus les rôles propriétaire,
-- collaborateur et agence. Jusqu'ici le catalogue vivait dans config.js ; cette migration permet de le
-- gérer en base depuis une administration. Additive : tant que les tables sont vides, le site continue de
-- lire config.js (repli côté serveur). La RLS est activée ici car la migration 002 a déjà été appliquée
-- avant la création de ces tables (sans effet sur un PostgreSQL ordinaire).

-- 1) Rôles supplémentaires + colonnes de compte (propriétaires, collaborateurs, agences)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('client', 'owner', 'collaborator', 'agency', 'admin'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS status      text NOT NULL DEFAULT 'actif';   -- invite | actif | suspendu
ALTER TABLE users ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';         -- présentation (agence)
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by  uuid REFERENCES users(id);

-- 2) Biens (logements). id texte « b1 », « b2 »… pour rester compatible avec bookings.listing_id et les liens #annonce-<id>.
CREATE TABLE listings (
  id              text PRIMARY KEY,
  slug            text,
  category        text NOT NULL DEFAULT 'appartement' CHECK (category IN ('appartement', 'villa')),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  owner_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  management_mode text NOT NULL DEFAULT 'delegue' CHECK (management_mode IN ('delegue', 'autonome')),
  title           text NOT NULL,
  title_en        text NOT NULL DEFAULT '',
  description     text NOT NULL DEFAULT '',
  description_en  text NOT NULL DEFAULT '',
  city            text NOT NULL DEFAULT 'Marrakech',
  area            text NOT NULL DEFAULT '',
  lat             double precision,                    -- position APPROXIMATIVE (centre du quartier), jamais l'adresse exacte
  lng             double precision,
  guests          integer NOT NULL DEFAULT 2 CHECK (guests >= 1),
  bedrooms        integer NOT NULL DEFAULT 0,
  bathrooms       integer NOT NULL DEFAULT 0,
  surface         integer,
  amenities       text NOT NULL DEFAULT '[]',          -- JSON (liste d'équipements)
  photos          text NOT NULL DEFAULT '[]',          -- JSON (chemins relatifs, ex. "photos/bien-1.jpg")
  owner_price     integer NOT NULL DEFAULT 0,          -- prix propriétaire / nuit (MAD) ; le public voit ce prix + majoration
  policy          text NOT NULL DEFAULT 'moderee' CHECK (policy IN ('flexible', 'moderee', 'stricte')),
  check_in        text NOT NULL DEFAULT '15:00',
  check_out       text NOT NULL DEFAULT '11:00',
  min_nights      integer NOT NULL DEFAULT 1 CHECK (min_nights >= 1),
  registration_no text NOT NULL DEFAULT '',            -- n° d'autorisation (loi 80-14)
  contact_phone   text NOT NULL DEFAULT '',            -- numéro de contact (propriétaire autonome) ; sinon numéro de l'équipe
  diamond         boolean NOT NULL DEFAULT false,
  discount_pct    integer NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 90),
  discount_label  text NOT NULL DEFAULT '',
  discount_from   date,
  discount_to     date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz
);
CREATE INDEX listings_status_idx ON listings(status);
CREATE INDEX listings_owner_idx ON listings(owner_id);

-- 3) Activités à proximité, proposées par une agence, avec réduction membre en %.
CREATE TABLE activities (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  category      text NOT NULL DEFAULT 'culture',       -- culture | souks | gastronomie | bienetre | excursions | sport | pratique
  status        text NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'archived')),
  agency_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  agency_name   text NOT NULL DEFAULT '',
  agency_desc   text NOT NULL DEFAULT '',
  lat           double precision,
  lng           double precision,
  price         integer,                               -- prix indicatif (MAD) ; NULL ou 0 = gratuit
  discount_pct  integer NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 90),
  note          text NOT NULL DEFAULT '',
  parcours      text NOT NULL DEFAULT '',
  photo         text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activities_status_idx ON activities(status);

-- 4) Promotions d'activité activées pour un client par une agence (scan de la carte de membre / recherche par nom)
CREATE TABLE activity_redemptions (
  id           bigserial PRIMARY KEY,
  activity_id  text REFERENCES activities(id) ON DELETE SET NULL,
  agency_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  client_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  pct          integer NOT NULL DEFAULT 0,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_redemptions_agency_idx ON activity_redemptions(agency_id);

-- 5) RLS : ces tables appartiennent au rôle de l'API ; aucun accès pour les rôles REST de Supabase (voir 002).
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_redemptions ENABLE ROW LEVEL SECURITY;
