-- Note d'un ÉCHANGE, en cinq étoiles.
--
-- Les avis de séjour (table `reviews`) notent un logement et son hôte après la
-- fin du séjour. Ils ne disaient rien de la qualité des échanges : un client
-- qui attend trois jours une réponse du service, un collaborateur qui traite
-- bien ses propriétaires — rien ne le distinguait.
--
-- Une note porte donc sur une conversation, et désigne la PART notée plutôt
-- qu'une personne : dans un échange avec le service client, plusieurs agents
-- peuvent répondre, et c'est le service qu'on note. `target_id` reste rempli
-- quand un interlocuteur unique est identifiable, pour pouvoir agréger par
-- collaborateur.

CREATE TABLE IF NOT EXISTS conversation_ratings (
  id              bigserial PRIMARY KEY,
  conversation_id bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- part notée : 'support' (service client), 'owner' (propriétaire), 'client'
  target_part     text NOT NULL CHECK (target_part IN ('client', 'owner', 'support')),
  -- interlocuteur, quand il est unique et identifiable ; sinon NULL
  target_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  rating          integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment         text NOT NULL DEFAULT '',
  at              timestamptz NOT NULL DEFAULT now(),
  -- une note par personne et par conversation
  UNIQUE (conversation_id, author_id)
);

CREATE INDEX IF NOT EXISTS conversation_ratings_target_idx ON conversation_ratings(target_id);
CREATE INDEX IF NOT EXISTS conversation_ratings_part_idx ON conversation_ratings(target_part);

ALTER TABLE conversation_ratings ENABLE ROW LEVEL SECURITY;
