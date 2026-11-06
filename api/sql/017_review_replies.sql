-- Réponse du propriétaire à un avis.
--
-- Un avis est public et définitif : personne ne peut le modifier ni l'effacer,
-- pas même l'hôte. Mais l'hôte doit pouvoir répondre — c'est ce qui distingue
-- une critique restée sans voix d'un échange que le prochain voyageur peut
-- juger lui-même.
--
-- La réponse est rattachée à l'avis, datée, et porte son auteur : on saura
-- toujours qui a répondu, même si le bien change de main.

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reply      text NOT NULL DEFAULT '';
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reply_at   timestamptz;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reply_by   uuid REFERENCES users(id) ON DELETE SET NULL;
