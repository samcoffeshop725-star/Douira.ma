-- Douira · hébergement sur Supabase. Supabase publie le schéma public par son API REST (PostgREST) aux rôles
-- anon et authenticated : sans ce verrou, quiconque obtient la clé « anon » du projet pourrait lire ou modifier
-- users (hachés des mots de passe), sessions, bookings… L'API Douira se connecte en propriétaire des tables
-- (rôle postgres) : la RLS ne la concerne pas. Sans effet sur un PostgreSQL ordinaire (Render, tests locaux) :
-- les rôles absents sont ignorés et la RLS sans politique ne gêne pas le propriétaire.
DO $$
DECLARE t text; r text;
BEGIN
  -- RLS activée sans aucune politique : tout accès par un autre rôle que le propriétaire est refusé
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
  -- Retrait des droits accordés par défaut aux rôles de l'API REST, y compris sur les tables des migrations futures
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
    END IF;
  END LOOP;
END $$;
