-- A dedicated, unprivileged role for the application to connect as.
--
-- WHY THIS MIGRATION EXISTS: the RLS policies in 0001 were verified present
-- and FORCEd, and they still protected nothing, because the connecting role
-- was a superuser. Superusers bypass RLS unconditionally -- FORCE only
-- extends the policies to the table OWNER, it does nothing about BYPASSRLS or
-- superuser.
--
-- That is the whole failure mode, and it is quiet: `pg_policies` lists the
-- policies, `relrowsecurity` and `relforcerowsecurity` are both true, the
-- migration is reviewed and approved, and every customer can still read every
-- other customer's KYC record. Nothing warns you. The only thing that catches
-- it is a test that connects the way the application connects and asserts it
-- sees one row.
--
-- The default Postgres Docker image makes POSTGRES_USER a superuser, so this
-- is the default state of any quick local setup.
--
-- In production the API connects as this role with a password from Secrets
-- Manager. Migrations continue to run as the owner, which is correct: DDL
-- needs privileges the request path must never have.

--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kilowattx_app') THEN
    -- No password is set here. A credential in a migration is a credential in
    -- git. Local development sets one with ALTER ROLE; production injects it
    -- from Secrets Manager.
    CREATE ROLE kilowattx_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  ELSE
    -- Idempotent, and also repairs a role that was created too permissively.
    ALTER ROLE kilowattx_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO kilowattx_app;

--> statement-breakpoint

-- Data access only. No DDL, no TRUNCATE -- note that TRUNCATE would bypass
-- the append-only row triggers entirely, so the request path must not have it.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kilowattx_app;

--> statement-breakpoint

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kilowattx_app;

--> statement-breakpoint

-- So tables added by a later migration are reachable without a follow-up grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kilowattx_app;

--> statement-breakpoint

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO kilowattx_app;

--> statement-breakpoint

-- A guard against the same mistake returning. If someone grants BYPASSRLS or
-- superuser to the app role, this function says so, and a test calls it.
CREATE OR REPLACE FUNCTION assert_app_role_cannot_bypass_rls() RETURNS void AS $$
DECLARE
  r record;
BEGIN
  SELECT rolsuper, rolbypassrls INTO r FROM pg_roles WHERE rolname = 'kilowattx_app';

  IF r IS NULL THEN
    RAISE EXCEPTION 'kilowattx_app role does not exist';
  END IF;

  IF r.rolsuper OR r.rolbypassrls THEN
    RAISE EXCEPTION
      'kilowattx_app can bypass RLS (superuser=%, bypassrls=%). Every row level security policy is inert for it.',
      r.rolsuper, r.rolbypassrls
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$ LANGUAGE plpgsql;
