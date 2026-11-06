-- Parrainage, profil public opt-in, carte de voyages.
--
-- Trois fonctionnalités demandées ensemble :
--   1. chaque membre a un code d'invitation ; un filleul qui s'inscrit avec ce
--      code fait gagner au parrain un bon de réduction ;
--   2. le membre peut rendre son profil PUBLIC (éteint par défaut) ;
--   3. la carte de voyages et le score de pays se calculent à partir des séjours
--      réellement confirmés — rien n'est stocké en double ici.
--
-- Choix assumés (voir api/lib/referrals.js) :
--   - un même filleul ne crédite qu'UN parrain, une seule fois (UNIQUE referred_id) ;
--   - on ne peut pas se parrainer soi-même ni parrainer un compte déjà inscrit ;
--   - le bon vaut 5 %, applicable à une future location, et on ne peut en détenir
--     que 5 non utilisés à la fois (la « jauge ») : au-delà, le filleul est compté
--     mais aucun nouveau bon n'est émis tant que les précédents ne sont pas dépensés.

-- Code d'invitation (attribué à la première ouverture du tableau de bord) et
-- interrupteur de profil public.
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code  text UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS public_profile boolean NOT NULL DEFAULT false;

-- Un filleul, le parrain qui l'a amené, la date.
CREATE TABLE IF NOT EXISTS referrals (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referrer_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (referred_id)            -- un compte n'est parrainé qu'une fois, pour toujours
);
CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals(referrer_id);

-- Les bons gagnés. Un bon non utilisé a booking_id NULL ; il est « dépensé »
-- quand une réservation l'applique, et « rendu » (used_at/booking_id remis à NULL)
-- si cette réservation échoue, expire ou est annulée.
CREATE TABLE IF NOT EXISTS referral_rewards (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pct           integer NOT NULL DEFAULT 5 CHECK (pct > 0 AND pct <= 100),
  source_referral_id bigint REFERENCES referrals(id) ON DELETE SET NULL,
  booking_id    text REFERENCES bookings(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  used_at       timestamptz
);
CREATE INDEX IF NOT EXISTS referral_rewards_user_idx ON referral_rewards(user_id) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS referral_rewards_booking_idx ON referral_rewards(booking_id);

-- Supabase : l'API passe par le rôle propriétaire (service), jamais le client
-- anonyme. On active RLS sans politique permissive, comme les autres tables
-- sensibles (voir 028_rls_tables_manquantes.sql).
ALTER TABLE referrals        ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_rewards ENABLE ROW LEVEL SECURITY;
