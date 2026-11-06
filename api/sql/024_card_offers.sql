-- Offres des cartes de membre : prix et avantages, par niveau.
--
-- Ce que chaque carte apporte est une décision commerciale, pas une donnée
-- technique. Elle se prend dans l'administration et se change sans
-- déploiement — une grille tarifaire figée dans le code vieillit mal.
--
-- Les quatre niveaux existent déjà (lib/cards.js) : cette table ne crée rien,
-- elle habille. Un niveau sans ligne ici reste un niveau valide, simplement
-- sans prix ni avantage annoncé — et l'appli le dit au lieu d'inventer.
--
-- `price` est en centimes de la devise, comme partout ailleurs. NULL veut dire
-- « pas encore fixé », ce qui n'est pas la même chose que gratuit : zéro est
-- une promesse, NULL est un silence.

CREATE TABLE card_offers (
  key         text PRIMARY KEY CHECK (key IN ('classique', 'bronze', 'gold', 'black')),
  price       integer CHECK (price IS NULL OR price >= 0),
  currency    text NOT NULL DEFAULT 'MAD',
  -- « par an », « par mois »… Vide quand le prix est unique.
  period      text NOT NULL DEFAULT '',
  -- Une phrase, celle qui résume la carte.
  tagline     text NOT NULL DEFAULT '',
  -- Avantages, en JSON : une liste de phrases courtes, dans l'ordre d'affichage.
  benefits    text NOT NULL DEFAULT '[]',
  -- Carte mise en avant sur la page (au plus une, l'application prend la première).
  featured    boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL
);

-- Les quatre lignes existent dès le départ, vides : l'administration remplit,
-- elle n'a pas à créer.
INSERT INTO card_offers (key) VALUES
  ('classique'), ('bronze'), ('gold'), ('black')
ON CONFLICT (key) DO NOTHING;
