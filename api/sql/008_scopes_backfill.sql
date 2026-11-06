-- Généralisation des périmètres aux routes existantes.
--
-- Jusqu'ici, un collaborateur pouvait gérer les LOGEMENTS du seul fait de son rôle.
-- Les routes vont désormais exiger le périmètre correspondant : sans cette reprise,
-- les collaborateurs déjà en place perdraient l'accès au premier déploiement.
--
-- On leur attribue donc exactement ce qu'ils avaient : « listings ». Rien de plus —
-- les autres périmètres restent à confier explicitement par l'administrateur.
INSERT INTO collaborator_scopes (user_id, scope, granted_by)
SELECT u.id, 'listings', NULL
  FROM users u
 WHERE u.role = 'collaborator' AND u.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- Les collaborateurs déjà affectés au service client gardent ce périmètre.
INSERT INTO collaborator_scopes (user_id, scope, granted_by)
SELECT s.user_id, 'support', s.assigned_by
  FROM support_agents s
  JOIN users u ON u.id = s.user_id
 WHERE u.role = 'collaborator' AND u.deleted_at IS NULL
ON CONFLICT DO NOTHING;
