-- Connexion via Google et Apple (SSO).
--
-- L'e-mail reste la clé d'identité (users.email UNIQUE) : un même e-mail = un seul
-- compte, qu'on s'y connecte par mot de passe, par Google ou par Apple. Un compte
-- peut donc être lié à l'un, à l'autre, ou rester un compte e-mail classique.
--
-- Les comptes créés par SSO n'ont pas de mot de passe utilisable : le code y range
-- le haché d'un secret aléatoire que personne ne connaît, pour que la connexion par
-- mot de passe reste impossible sans casser la contrainte NOT NULL de pass_hash.

ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id     text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_id      text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider text NOT NULL DEFAULT 'password';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url    text NOT NULL DEFAULT '';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_auth_provider_check;
ALTER TABLE users ADD CONSTRAINT users_auth_provider_check CHECK (auth_provider IN ('password', 'google', 'apple'));

-- Un identifiant de fournisseur ne désigne qu'un seul compte (unicité quand présent).
CREATE UNIQUE INDEX IF NOT EXISTS users_google_id_idx ON users(google_id) WHERE google_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_apple_id_idx  ON users(apple_id)  WHERE apple_id  IS NOT NULL;
