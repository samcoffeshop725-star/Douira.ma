-- Modération du contenu écrit par les utilisateurs (messages, avis).
--
-- Deux objets. BLOQUER : une personne décide de ne plus rien recevoir d'une
-- autre — ni message, ni avis sous ses yeux. SIGNALER : elle porte un contenu
-- à l'attention de l'équipe, qui tranche. Les deux sont exigés d'une
-- application où des personnes s'écrivent (App Store, règle 1.2).

CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS user_blocks_blocked_idx ON user_blocks(blocked_id);

CREATE TABLE IF NOT EXISTS reports (
  id              bigserial PRIMARY KEY,
  reporter_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Ce qui est signalé : un message, un avis, une conversation ou une personne.
  kind            text NOT NULL CHECK (kind IN ('message', 'review', 'conversation', 'user')),
  target_id       text NOT NULL,
  -- La personne derrière le contenu, pour que l'équipe voie les récidives.
  target_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  reason          text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
  note            text NOT NULL DEFAULT '',
  at              timestamptz NOT NULL DEFAULT now(),
  reviewed_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports(status, at DESC);

-- RLS : tables réservées au rôle de l'API (voir 002).
ALTER TABLE user_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
