-- Messagerie, avis de séjour et service client.
--
-- Une conversation est toujours rattachée à un contexte : une réservation
-- (client ↔ propriétaire), un logement (demande avant réservation) ou le service
-- client. L'accès est porté par conversation_members : on ne lit une conversation
-- que si l'on en est membre (l'admin n'y accède pas d'office : la correspondance
-- entre un client et un propriétaire reste privée).

CREATE TABLE conversations (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('booking', 'listing', 'support')),
  booking_id  text REFERENCES bookings(id) ON DELETE SET NULL,
  listing_id  text REFERENCES listings(id) ON DELETE SET NULL,
  subject     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_at     timestamptz NOT NULL DEFAULT now()
);
-- Une seule conversation par réservation, et une par couple (logement, client).
CREATE UNIQUE INDEX conversations_booking_idx ON conversations(booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX conversations_last_idx ON conversations(last_at DESC);

CREATE TABLE conversation_members (
  conversation_id bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- rôle tenu DANS la conversation : client, owner (propriétaire) ou support
  part            text NOT NULL DEFAULT '' CHECK (part IN ('', 'client', 'owner', 'support')),
  last_read_at    timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user_idx ON conversation_members(user_id);

CREATE TABLE messages (
  id              bigserial PRIMARY KEY,
  conversation_id bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  body            text NOT NULL,
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages(conversation_id, at);

-- Avis de séjour : possible seulement après la fin du séjour, un seul par
-- participant et par réservation (contrainte d'unicité, pas seulement applicative).
CREATE TABLE reviews (
  id         bigserial PRIMARY KEY,
  booking_id text NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  listing_id text REFERENCES listings(id) ON DELETE SET NULL,
  rating     integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    text NOT NULL DEFAULT '',
  at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, author_id)
);
CREATE INDEX reviews_listing_idx ON reviews(listing_id);

-- Collaborateurs affectés au service client (désignés par l'administrateur).
CREATE TABLE support_agents (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  at          timestamptz NOT NULL DEFAULT now()
);

-- RLS : ces tables appartiennent au rôle de l'API (voir 002).
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_agents ENABLE ROW LEVEL SECURITY;
