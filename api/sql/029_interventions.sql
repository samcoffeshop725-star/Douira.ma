-- Prestations : une intervention réellement effectuée chez un client.
--
-- CE QUI MANQUAIT. Le catalogue dit ce que Douira PROPOSE (table `services`),
-- le journal dit qu'un code a été LU (table `scans`). Entre les deux, rien ne
-- disait qu'un ménage a été fait, chez qui, pour quel prix, ni quand il a
-- commencé et fini. Le client ne pouvait donc pas retrouver ce qu'on lui avait
-- fait, et le prestataire ne pouvait rien prouver.
--
-- LE DÉROULÉ, ET POURQUOI IL EST EN DEUX TEMPS.
--
--   1. AVANT de commencer, le prestataire scanne la carte du client et saisit
--      le prix demandé. La prestation s'ouvre.
--   2. APRÈS avoir terminé, il rescanne la même carte. La prestation se ferme.
--
--   Le deuxième scan ne vaut que parce que le premier a eu lieu : le client a
--   vu le prix AVANT que le travail commence. C'est la raison d'être des deux
--   temps, et c'est pourquoi `amount` est fixé à l'ouverture et n'est jamais
--   réécrit à la fermeture. Un prix qu'on peut relever une fois le travail
--   fait n'est pas un prix annoncé, c'est une addition.
--
--   Les deux scans restent au journal (`scans`), et la prestation en garde les
--   identifiants : on peut toujours remonter à qui a scanné et quand.
--
-- CE QU'ON NE FAIT PAS ICI. On n'encaisse pas. `paid_at` dit seulement si le
-- règlement a été enregistré ; le paiement lui-même passe par les voies
-- existantes. Une prestation terminée et non réglée se lit « à payer ».

CREATE TABLE IF NOT EXISTS interventions (
  id           text PRIMARY KEY,

  -- Ce qui a été fait, et pour qui.
  service_id   text NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  client_id    uuid NOT NULL REFERENCES users(id)    ON DELETE RESTRICT,
  -- Celui qui a scanné et qui répond du travail. Il reste nommé même s'il
  -- quitte l'équipe : effacer le prestataire effacerait la responsabilité.
  provider_id  uuid NOT NULL REFERENCES users(id)    ON DELETE RESTRICT,

  status       text NOT NULL DEFAULT 'en_cours'
               CHECK (status IN ('en_cours', 'terminee', 'annulee')),

  -- Prix demandé, annoncé au client AVANT le travail, dans la devise de la
  -- ville. Entier : les devises servies (MAD, XOF) n'ont pas de centimes à
  -- l'usage, et le reste de la base compte déjà en unités entières.
  amount       integer NOT NULL CHECK (amount >= 0),
  currency     text    NOT NULL,
  -- Ce que le prestataire a saisi en toutes lettres : « 2 h de ménage, 3
  -- pièces ». Facultatif, jamais inventé.
  note         text    NOT NULL DEFAULT '',
  city         text    NOT NULL DEFAULT '',

  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  paid_at      timestamptz,

  -- Les deux scans qui encadrent la prestation. ON DELETE SET NULL : le
  -- journal ne s'efface pas, mais si un jour il était purgé, la prestation
  -- doit survivre à la perte de sa pièce justificative.
  start_scan   bigint REFERENCES scans(id) ON DELETE SET NULL,
  end_scan     bigint REFERENCES scans(id) ON DELETE SET NULL,

  -- Une prestation terminée a forcément une fin : sans cette contrainte, un
  -- enregistrement raté laisserait une prestation « terminée » hors du temps.
  CONSTRAINT interventions_fin_check
    CHECK ((status = 'terminee') = (ended_at IS NOT NULL))
);

-- UNE SEULE prestation ouverte à la fois pour un couple (service, client).
-- Sans cet index, un prestataire qui scanne deux fois — parce que l'appli a
-- ramé, parce qu'il a douté — ouvrait deux prestations et le client était
-- compté deux fois. L'index rend le second scan inoffensif : le serveur
-- retrouve la prestation en cours au lieu d'en créer une.
CREATE UNIQUE INDEX IF NOT EXISTS interventions_ouverte_idx
  ON interventions (service_id, client_id) WHERE status = 'en_cours';

-- Ce que le client lit sur sa page Réservations.
CREATE INDEX IF NOT EXISTS interventions_client_idx
  ON interventions (client_id, started_at DESC);
-- Ce que le prestataire retrouve de sa journée.
CREATE INDEX IF NOT EXISTS interventions_provider_idx
  ON interventions (provider_id, started_at DESC);

ALTER TABLE interventions ENABLE ROW LEVEL SECURITY;

-- Joindre celui qui fera le service, comme on joint déjà une agence pour une
-- expérience (voir 020). Pas de numéro par défaut : le numéro de l'équipe ne
-- doit pas se retrouver sur le service d'un prestataire à son insu.
ALTER TABLE services ADD COLUMN IF NOT EXISTS phone text NOT NULL DEFAULT '';

-- Deuxième voie pour joindre : écrire dans l'appli. La conversation est
-- rattachée au service, entre le client et celui qui en a la charge —
-- exactement comme une conversation d'expérience lie le client à l'agence.
-- ATTENTION en relisant ceci : on REMPLACE la contrainte, donc il faut
-- réécrire TOUS les types déjà admis, pas seulement le nouveau. 'vehicle' est
-- arrivé en 025 ; l'oublier ici aurait fait échouer la migration dès qu'une
-- conversation de location existe, et interdit d'écrire aux loueurs ensuite.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_kind_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_kind_check
  CHECK (kind IN ('booking', 'listing', 'support', 'activity', 'vehicle', 'service'));
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS service_id text REFERENCES services(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS conversations_service_idx
  ON conversations (service_id) WHERE service_id IS NOT NULL;

-- Le prestataire tient sa place dans l'échange, au même titre que l'agence.
ALTER TABLE conversation_members DROP CONSTRAINT IF EXISTS conversation_members_part_check;
ALTER TABLE conversation_members ADD CONSTRAINT conversation_members_part_check
  CHECK (part IN ('', 'client', 'owner', 'support', 'agency', 'provider'));
