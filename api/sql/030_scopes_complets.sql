-- Périmètres délégables : la contrainte de 006 n'admettait que six valeurs,
-- alors que lib/team.js en déclare huit depuis les destinations (007) et les
-- véhicules (009). Déléguer « vehicles » ou « destinations » à un collaborateur
-- échouait en base (500) : ces deux écrans restaient de fait réservés à l'admin.
ALTER TABLE collaborator_scopes DROP CONSTRAINT IF EXISTS collaborator_scopes_scope_check;
ALTER TABLE collaborator_scopes ADD CONSTRAINT collaborator_scopes_scope_check
  CHECK (scope IN ('listings', 'activities', 'services', 'support', 'bookings', 'team', 'destinations', 'vehicles'));
