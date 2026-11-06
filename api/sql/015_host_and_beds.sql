-- Ce qui manquait à une fiche d'annonce complète.
--
-- 1) LES LITS. On connaissait le nombre de chambres, jamais ce qu'on y trouve.
--    « 2 chambres » ne dit pas si l'on dort à deux ou à cinq. `beds` porte le
--    total pour la ligne de capacité, `rooms` le détail pièce par pièce.
--
-- 2) L'HÔTE. Un propriétaire n'était qu'un identifiant : ni prénom public, ni
--    photo, ni langues. Impossible de présenter la personne qui reçoit.
--    `host_since` n'est pas ajouté : `created_at` dit déjà depuis quand.

ALTER TABLE listings ADD COLUMN IF NOT EXISTS beds  integer NOT NULL DEFAULT 0;
-- [{ "name": "Chambre 1", "beds": "1 lit king size" }, …]
ALTER TABLE listings ADD COLUMN IF NOT EXISTS rooms jsonb   NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN listings.beds IS 'Nombre total de lits, pour la ligne de capacité.';
COMMENT ON COLUMN listings.rooms IS 'Détail des couchages : [{ name, beds }].';

-- Profil public de l'hôte. Rien d'obligatoire : une fiche reste valable sans.
ALTER TABLE users ADD COLUMN IF NOT EXISTS host_bio       text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS host_languages text NOT NULL DEFAULT '';
-- Photo en data URL. Publique, donc NON chiffrée : la chiffrer donnerait une
-- fausse impression de confidentialité sur une image faite pour être vue.
ALTER TABLE users ADD COLUMN IF NOT EXISTS host_photo     text NOT NULL DEFAULT '';

COMMENT ON COLUMN users.host_bio IS 'Présentation publique de l''hôte.';
COMMENT ON COLUMN users.host_languages IS 'Langues parlées, séparées par des virgules.';
COMMENT ON COLUMN users.host_photo IS 'Photo publique de l''hôte (data URL).';
