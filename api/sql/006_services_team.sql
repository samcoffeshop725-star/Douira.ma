-- Services proposés par la plateforme, et répartition des tâches dans l'équipe.
--
-- Un service s'adresse soit aux CLIENTS (ménage, chef à domicile, transfert…), soit aux
-- PROPRIÉTAIRES (conciergerie, photos, entretien…), soit aux deux quand l'admin ou un
-- collaborateur habilité le décide explicitement (`audience = 'both'`).

CREATE TABLE services (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  category     text NOT NULL DEFAULT 'autre',
  -- À qui le service est proposé. 'both' = choix explicite de l'équipe.
  audience     text NOT NULL DEFAULT 'client' CHECK (audience IN ('client', 'owner', 'both')),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  city         text NOT NULL DEFAULT '',
  price        integer,                      -- prix indicatif, dans la devise de la ville
  unit         text NOT NULL DEFAULT '',     -- « par séjour », « par heure »…
  description  text NOT NULL DEFAULT '',
  -- Collaborateur en charge de ce service (répartition des tâches).
  assignee_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX services_audience_idx ON services(audience, status);
CREATE INDEX services_assignee_idx ON services(assignee_id);

-- Périmètres confiés à un collaborateur : l'admin (ou un chef d'équipe) répartit les
-- tâches comme il l'entend, et peut tout confier à une seule personne.
CREATE TABLE collaborator_scopes (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope      text NOT NULL CHECK (scope IN ('listings', 'activities', 'services', 'support', 'bookings', 'team')),
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope)
);
CREATE INDEX collaborator_scopes_user_idx ON collaborator_scopes(user_id);

-- Chef d'équipe : peut à son tour répartir les périmètres qu'il détient, et désigner
-- un autre chef d'équipe. Désigné par l'admin ou par un chef d'équipe.
ALTER TABLE users ADD COLUMN team_lead boolean NOT NULL DEFAULT false;

-- RLS : ces tables appartiennent au rôle de l'API (voir 002).
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaborator_scopes ENABLE ROW LEVEL SECURITY;
