-- Douira · schéma initial. Aucune donnée de carte bancaire n'est stockée (déléguée au prestataire de paiement).
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  name          text NOT NULL,
  phone         text NOT NULL DEFAULT '',
  role          text NOT NULL DEFAULT 'client' CHECK (role IN ('client', 'admin')),
  pass_hash     text NOT NULL,                       -- scrypt (N=2^15, r=8, p=1), sel 16 octets ; jamais le mot de passe
  member_no     integer UNIQUE NOT NULL DEFAULT (100000 + floor(random() * 900000)::int),
  consent_at    timestamptz,                         -- acceptation des conditions et de la politique de confidentialité
  must_change_password boolean NOT NULL DEFAULT false, -- mot de passe initial : changement obligatoire à la première connexion
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz                          -- compte supprimé (RGPD) : données anonymisées, ligne conservée pour les factures
);

CREATE TABLE sessions (
  id          text PRIMARY KEY,                      -- SHA-256 du jeton envoyé dans le cookie (le jeton en clair n'est jamais stocké)
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  last_seen   timestamptz NOT NULL DEFAULT now(),
  ip          text NOT NULL DEFAULT '',
  ua          text NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_exp_idx ON sessions(expires_at);

CREATE TABLE password_resets (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

-- Limitation de débit partagée entre les instances (connexion, inscription, paiement…)
CREATE TABLE rate_limits (
  key          text PRIMARY KEY,
  hits         integer NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bookings (
  id             text PRIMARY KEY,                   -- référence DR-xxxxxx montrée au client
  user_id        uuid NOT NULL REFERENCES users(id),
  listing_id     text NOT NULL,                      -- identifiant du bien dans config.js (b1, b2…)
  start_date     date NOT NULL,
  end_date       date NOT NULL,
  guests         integer NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending_payment', 'confirmed', 'cancelled', 'failed', 'expired')),
  quote          jsonb NOT NULL,                     -- devis calculé par le serveur (prix affichés au client uniquement)
  amount         integer NOT NULL,                   -- total en centimes de la devise
  currency       text NOT NULL DEFAULT 'MAD',
  hold_until     timestamptz,                        -- dates bloquées jusqu'à cette heure en attendant le paiement
  psp            text NOT NULL DEFAULT '',           -- stripe | cmi | simulate
  psp_ref        text NOT NULL DEFAULT '',           -- identifiant de session ou de transaction chez le prestataire
  pay_url        text NOT NULL DEFAULT '',           -- page de paiement à rouvrir tant que le blocage des dates court
  paid_at        timestamptz,
  cancelled_at   timestamptz,
  refund_amount  integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date > start_date)
);
CREATE INDEX bookings_user_idx ON bookings(user_id);
CREATE INDEX bookings_listing_dates_idx ON bookings(listing_id, start_date, end_date) WHERE status IN ('pending_payment', 'confirmed');

-- Événements reçus du prestataire de paiement : garantit l'idempotence (un webhook rejoué ne confirme pas deux fois)
CREATE TABLE payment_events (
  id          text PRIMARY KEY,
  booking_id  text REFERENCES bookings(id),
  type        text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Adresse exacte et code d'accès : chiffrés (AES-256-GCM, clé DATA_KEY hors base), communiqués au seul client de la réservation confirmée
CREATE TABLE listing_access (
  listing_id   text PRIMARY KEY,
  address_enc  text NOT NULL,
  code_enc     text NOT NULL DEFAULT '',
  notes_enc    text NOT NULL DEFAULT '',
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE checkins (
  id          bigserial PRIMARY KEY,
  booking_id  text REFERENCES bookings(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  by_user_id  uuid REFERENCES users(id),
  at          timestamptz NOT NULL DEFAULT now()
);

-- Journal d'audit sans données sensibles (qui a fait quoi, sur quoi, quand)
CREATE TABLE audit (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  actor     uuid,
  action    text NOT NULL,
  target    text NOT NULL DEFAULT '',
  ip        text NOT NULL DEFAULT ''
);

-- Réglages modifiables depuis l'administration (envoi d'e-mails…). Les secrets y sont chiffrés (AES-256-GCM).
CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
