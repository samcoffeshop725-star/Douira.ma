-- Journal des scans.
--
-- Chaque fois qu'un code Douira est lu — carte de membre ou badge d'équipe —
-- on écrit QUI a scanné, QUI a été scanné, QUAND, et À QUEL TITRE. C'est ce
-- journal qui permet d'affirmer plus tard qu'un client s'est bien présenté,
-- qu'il a profité d'une offre, ou qu'une intervention a eu lieu.
--
-- Une ligne de journal ne se modifie pas et ne s'efface pas : un registre
-- qu'on peut retoucher ne prouve rien. Les corrections se font en ajoutant.
--
-- Le scanné peut disparaître (compte supprimé) sans emporter la trace : les
-- références passent à NULL, la date et le rôle restent.

CREATE TABLE scans (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),

  -- Qui a scanné, et avec quel rôle au moment du scan : un collaborateur
  -- peut changer de fonction, le journal garde ce qui était vrai ce jour-là.
  scanner_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  scanner_role text NOT NULL DEFAULT '',

  -- Qui a été scanné.
  subject_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Nature du code lu : carte de membre, ou badge d'équipe.
  kind         text NOT NULL CHECK (kind IN ('member', 'badge')),

  -- À quel titre. Au moins l'un des trois, ou aucun pour une simple
  -- vérification d'identité.
  activity_id  text REFERENCES activities(id) ON DELETE SET NULL,
  service_id   text REFERENCES services(id) ON DELETE SET NULL,
  booking_id   text REFERENCES bookings(id) ON DELETE SET NULL,

  -- Ce que le scan affirme : 'verification' (on a seulement regardé),
  -- 'offre' (le client a profité de l'offre), 'presence' (il s'est présenté),
  -- 'service' (l'intervention a eu lieu).
  motif        text NOT NULL DEFAULT 'verification'
               CHECK (motif IN ('verification', 'offre', 'presence', 'service')),
  note         text NOT NULL DEFAULT ''
);

CREATE INDEX scans_subject_idx ON scans(subject_id, at DESC);
CREATE INDEX scans_scanner_idx ON scans(scanner_id, at DESC);
CREATE INDEX scans_at_idx ON scans(at DESC);
