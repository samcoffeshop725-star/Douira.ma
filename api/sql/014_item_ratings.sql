-- Notes des activités et des services, en cinq étoiles.
--
-- Les logements ont déjà les leurs (table `reviews`, après le séjour) : on ne
-- les double pas ici. Restaient les activités et les services, qu'on pouvait
-- consommer sans jamais pouvoir dire ce qu'on en avait pensé.
--
-- Une note se mérite : on ne note que ce qu'on a utilisé. Pour une activité,
-- la preuve existe déjà — `activity_redemptions` enregistre chaque offre
-- validée en agence. Pour un service, il n'existe aucune trace d'usage : on se
-- contente d'exiger un vrai client, c'est-à-dire quelqu'un qui a au moins une
-- réservation confirmée. C'est plus faible, et c'est dit ainsi dans le code.

CREATE TABLE IF NOT EXISTS item_ratings (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('activity', 'service')),
  item_id    text NOT NULL,
  author_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating     integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    text NOT NULL DEFAULT '',
  at         timestamptz NOT NULL DEFAULT now(),
  -- une note par personne et par élément
  UNIQUE (kind, item_id, author_id)
);

CREATE INDEX IF NOT EXISTS item_ratings_item_idx ON item_ratings(kind, item_id);

ALTER TABLE item_ratings ENABLE ROW LEVEL SECURITY;
