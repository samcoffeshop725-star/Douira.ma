-- Fiche d'un véhicule : photos, description, équipements, et qui le loue.
--
-- Jusqu'ici un véhicule tenait en une ligne de caractéristiques et une photo.
-- On ne loue pas une voiture sur une ligne : il faut voir l'intérieur, savoir
-- ce qu'elle a, et pouvoir joindre quelqu'un.
--
-- Même modèle que les expériences, volontairement : une agence rattachée, un
-- numéro à appeler, et une conversation dans l'appli. Deux mécaniques
-- différentes pour la même chose vieilliraient mal.

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
-- Galerie, en JSON. `photo` reste la vignette : les listes existantes ne
-- doivent pas se vider le jour du déploiement.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS photos      text NOT NULL DEFAULT '[]';
-- Ce qu'il y a dans la voiture : climatisation, GPS, sièges enfant…
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS equipments  text NOT NULL DEFAULT '[]';

-- Qui loue. Vide tant que l'agence n'est pas rattachée : on n'invente pas de
-- loueur, et l'appli n'affiche alors aucun bouton de contact.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS agency_id   uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS agency_name text NOT NULL DEFAULT '';
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS phone       text NOT NULL DEFAULT '';

-- Deuxième voie pour réserver : écrire dans l'appli, comme pour une
-- expérience. La conversation est rattachée au véhicule.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_kind_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_kind_check
  CHECK (kind IN ('booking', 'listing', 'support', 'activity', 'vehicle'));
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS vehicle_id text REFERENCES vehicles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS conversations_vehicle_idx ON conversations(vehicle_id) WHERE vehicle_id IS NOT NULL;
