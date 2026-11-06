-- Messages écrits par l'assistant.
--
-- Un message de l'assistant n'a pas d'expéditeur humain : son `sender_id` reste
-- NULL. Or un expéditeur NULL s'affichait « Compte supprimé », ce qui aurait
-- présenté le résumé transmis au collaborateur comme venant d'un fantôme.
-- Ce drapeau permet de l'afficher pour ce qu'il est.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS from_assistant boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN messages.from_assistant IS
  'Message écrit par l''assistant (résumé transmis à l''équipe), sans expéditeur humain.';
