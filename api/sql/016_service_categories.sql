-- Catégories de services, administrables.
--
-- Elles étaient jusqu'ici une liste figée dans le code : ajouter « sauna » ou
-- « baby-sitting » demandait un déploiement. Elles vivent maintenant en base,
-- et se gèrent depuis l'appli par l'admin ou par un collaborateur à qui le
-- périmètre « services » a été confié.
--
-- `icon` est le nom d'une icône du jeu de l'appli, pas un emoji : les emoji
-- sont les dessins du système, identiques partout, et ne portent aucune
-- signature. Le jeu « IC2 » est celui du site.
--
-- `services.category` reste du texte libre côté colonne : une catégorie
-- supprimée ne doit pas faire disparaître les services qui la portaient.

CREATE TABLE service_categories (
  key        text PRIMARY KEY,
  label      text NOT NULL,
  icon       text NOT NULL DEFAULT '',
  -- Ordre d'affichage ; « Autre » reste volontairement en dernier.
  sort       integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Les sept catégories historiques, plus celles demandées. Les clés des
-- anciennes sont conservées telles quelles : les services déjà saisis gardent
-- leur catégorie.
INSERT INTO service_categories (key, label, icon, sort) VALUES
  ('menage',       'Ménage',          'broom',   10),
  ('massage',      'Massage',         'massage', 20),
  ('sauna',        'Sauna & hammam',  'hammam',  30),
  ('chef',         'Chef privé',      'chef',    40),
  ('babysitting',  'Baby-sitting',    'baby',    50),
  ('chauffeur',    'Chauffeur',       'car',     60),
  ('transfert',    'Transferts',      'plane',   70),
  ('conciergerie', 'Conciergerie',    'key',     80),
  ('entretien',    'Entretien',       'tools',   90),
  ('photo',        'Photographie',    'camera', 100),
  ('autre',        'Autre',           'tag',    999)
ON CONFLICT (key) DO NOTHING;

CREATE INDEX service_categories_sort_idx ON service_categories(sort, label);
