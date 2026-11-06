-- Niveau de la carte de membre.
--
-- Quatre niveaux, du plus courant au plus rare : classique, bronze, gold,
-- black. Le niveau décide de ce à quoi le membre a droit — à commencer par la
-- disponibilité du service client, plus large au gold, plus encore au black.
--
-- Tout le monde naît « classique » : une carte sans niveau n'existe pas, et
-- personne ne doit se retrouver sans carte parce que l'équipe n'a pas encore
-- tranché son cas.
--
-- Le niveau est posé par l'administration, pas gagné automatiquement : c'est
-- une décision commerciale, pas un calcul.

ALTER TABLE users ADD COLUMN IF NOT EXISTS card_tier text NOT NULL DEFAULT 'classique';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_card_tier_check;
ALTER TABLE users ADD CONSTRAINT users_card_tier_check
  CHECK (card_tier IN ('classique', 'bronze', 'gold', 'black'));

COMMENT ON COLUMN users.card_tier IS
  'Niveau de la carte : classique | bronze | gold | black. Posé par l''administration.';
