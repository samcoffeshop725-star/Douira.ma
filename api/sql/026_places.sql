-- Où ça se passe, et ce que ça comprend.
--
-- Un service et un véhicule ont un lieu : on va chercher la voiture quelque
-- part, la praticienne vient depuis quelque part. Sans coordonnées, l'appli
-- ne peut ni les situer ni proposer « les plus proches de votre logement ».
--
-- Comme pour les logements, la position est APPROXIMATIVE : le centre du
-- quartier, pas l'adresse exacte. On ne publie pas l'adresse d'un partenaire
-- avant qu'une réservation existe.
--
-- `hours` et `includes` sont du texte libre en JSON : les horaires d'un
-- hammam ne s'écrivent pas comme ceux d'un chauffeur, et une grille rigide
-- obligerait l'équipe à mentir pour entrer dans les cases.

ALTER TABLE services ADD COLUMN IF NOT EXISTS lat      double precision;
ALTER TABLE services ADD COLUMN IF NOT EXISTS lng      double precision;
ALTER TABLE services ADD COLUMN IF NOT EXISTS area     text NOT NULL DEFAULT '';
-- Horaires : une ligne par créneau, « Lundi au samedi, 9 h – 19 h ».
ALTER TABLE services ADD COLUMN IF NOT EXISTS hours    text NOT NULL DEFAULT '[]';
-- Ce que la prestation comprend : une ligne par élément.
ALTER TABLE services ADD COLUMN IF NOT EXISTS includes text NOT NULL DEFAULT '[]';
-- Galerie. `photo` reste la vignette.
ALTER TABLE services ADD COLUMN IF NOT EXISTS photos   text NOT NULL DEFAULT '[]';

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS lat  double precision;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS lng  double precision;
-- Où l'on prend le véhicule : « Agence Guéliz », « Livraison à l'hôtel ».
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS pickup text NOT NULL DEFAULT '';

COMMENT ON COLUMN services.lat IS 'Position APPROXIMATIVE (centre du quartier), jamais l''adresse exacte.';
COMMENT ON COLUMN vehicles.lat IS 'Position APPROXIMATIVE du point de retrait.';
