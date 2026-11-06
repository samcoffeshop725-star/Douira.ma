-- Photo d'un service.
--
-- Les services n'avaient qu'une icône : utile pour repérer une catégorie d'un
-- coup d'œil, insuffisant pour donner envie. Un hammam, un chef privé ou une
-- voiture avec chauffeur se choisissent d'abord sur une image.
--
-- La colonne accepte deux formes, comme la photo de profil d'un hôte :
--   - un chemin relatif servi par le site, « photos/svc-1.jpg » ;
--   - une image déposée depuis l'appli, « data:image/jpeg;base64,… ».
-- Vide tant que personne n'en a mis : l'appli retombe alors sur l'icône de la
-- catégorie plutôt que d'afficher un cadre gris.

ALTER TABLE services ADD COLUMN IF NOT EXISTS photo text NOT NULL DEFAULT '';
