-- Une expérience se commande : il faut savoir QUAND elle a lieu, et pouvoir
-- joindre celui qui la propose.
--
-- Date et heure sont facultatives : beaucoup d'expériences se tiennent tous les
-- jours, et une date inventée serait pire qu'une date absente. Quand elles sont
-- renseignées, l'appli les affiche ; sinon elle ne montre rien plutôt qu'un
-- « à définir » qui n'apprend rien.
--
-- `phone` est le numéro que l'agence (ou l'administrateur) donne pour être
-- appelée. Il n'y a pas de numéro par défaut : le numéro de l'équipe ne doit
-- pas se retrouver sur une expérience d'agence à son insu.

ALTER TABLE activities ADD COLUMN IF NOT EXISTS starts_on date;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS starts_at text NOT NULL DEFAULT '';
ALTER TABLE activities ADD COLUMN IF NOT EXISTS phone     text NOT NULL DEFAULT '';

-- Deuxième voie pour commander : écrire dans l'appli. La conversation est
-- rattachée à l'expérience, entre le client et l'agence qui la propose —
-- exactement comme une conversation de séjour lie le client au propriétaire.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_kind_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_kind_check
  CHECK (kind IN ('booking', 'listing', 'support', 'activity'));
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS activity_id text REFERENCES activities(id) ON DELETE SET NULL;

-- Une seule conversation par couple (expérience, client) : on retrouve son fil
-- au lieu d'en ouvrir un nouveau à chaque question.
CREATE INDEX IF NOT EXISTS conversations_activity_idx ON conversations(activity_id) WHERE activity_id IS NOT NULL;

-- L'agence tient sa place dans l'échange, au même titre que le propriétaire.
ALTER TABLE conversation_members DROP CONSTRAINT IF EXISTS conversation_members_part_check;
ALTER TABLE conversation_members ADD CONSTRAINT conversation_members_part_check
  CHECK (part IN ('', 'client', 'owner', 'support', 'agency'));
