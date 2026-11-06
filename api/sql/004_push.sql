-- Jetons de notification push (Expo). Un compte peut avoir plusieurs appareils.
-- Le jeton Expo (ExponentPushToken[...]) n'est pas un secret : il identifie un appareil,
-- pas une session. On le remplace s'il change de propriétaire (appareil revendu, etc.).
CREATE TABLE push_tokens (
  token       text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform    text NOT NULL DEFAULT '' CHECK (platform IN ('', 'ios', 'android', 'web')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_tokens_user_idx ON push_tokens(user_id);

-- RLS : table réservée au rôle de l'API (voir 002).
ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;
