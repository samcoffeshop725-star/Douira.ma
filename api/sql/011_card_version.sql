-- Révocation d'une carte de membre.
--
-- Le jeton gravé sur une carte (ou affiché en QR) est un HMAC dérivé de
-- l'identifiant et du numéro de membre : deux valeurs qui ne changent jamais.
-- Une carte perdue ou un jeton divulgué étaient donc valables à vie, et la
-- seule parade était de changer CARD_SECRET — ce qui invalidait les cartes de
-- tout le monde.
--
-- En ajoutant un numéro de version au message signé, refaire la carte d'un
-- seul membre revient à incrémenter ce compteur : son ancien jeton cesse
-- aussitôt d'être reconnu, les autres ne bougent pas.

ALTER TABLE users ADD COLUMN IF NOT EXISTS card_version integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN users.card_version IS
  'Version du jeton de carte de membre. Incrémenter révoque la carte précédente.';
