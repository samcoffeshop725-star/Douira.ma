-- Badge d'équipe : la carte d'identité de la société.
--
-- Administrateur, chef d'équipe et collaborateur en portent un : nom, numéro
-- de badge, et un code à présenter. Ce n'est PAS une carte de membre — elle
-- ouvre des droits commerciaux, le badge dit seulement qui travaille ici.
--
-- Le numéro 1 est réservé à l'administration. Les suivants se distribuent dans
-- l'ordre, sans jamais être réutilisés : un numéro rendu ne revient pas à
-- quelqu'un d'autre, sinon on ne saurait plus qui a présenté quoi.
--
-- Nullable : un badge n'est attribué qu'au premier affichage, et seulement aux
-- rôles qui y ont droit. Un client n'en a pas.

ALTER TABLE users ADD COLUMN IF NOT EXISTS badge_no integer;

-- Unicité réelle, pas seulement applicative : deux badges au même numéro
-- rendraient le contrôle inutile.
CREATE UNIQUE INDEX IF NOT EXISTS users_badge_no_idx ON users(badge_no) WHERE badge_no IS NOT NULL;

COMMENT ON COLUMN users.badge_no IS
  'Numéro de badge d''équipe. 1 est réservé à l''administration. Jamais réutilisé.';
