-- Runtime roles and Row Level Security.
--
-- ploot_app    : Next.js API. Tenant-scoped by RLS; the tenant comes from the verified JWT and is
--                set per transaction with set_config('app.tenant_id', ..., true) (SET LOCAL), which
--                is safe behind PgBouncer in transaction mode. No access to the token vault.
-- ploot_worker : long-lived publisher. Cross-tenant by design, least privilege per table.
--
-- Both are NOLOGIN group roles; login users are created by the deploy/bootstrap step with
-- passwords from the environment (never in migrations). The owner (migrator) is not used at
-- runtime, so RLS is not FORCEd on it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ploot_app') THEN
    CREATE ROLE ploot_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ploot_worker') THEN
    CREATE ROLE ploot_worker NOLOGIN;
  END IF;
END $$;

-- Missing or empty setting => NULL => no row matches: fails closed.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ploot_app, ploot_worker;
GRANT EXECUTE ON FUNCTION app_current_tenant() TO ploot_app, ploot_worker;

-- ---- ploot_app grants (cancel is an UPDATE to 'cancelled': no hard DELETE on posts) ----
GRANT SELECT ON tenants, ambassadors, publish_attempts TO ploot_app;
GRANT SELECT, INSERT, UPDATE ON posts, idempotency_keys TO ploot_app;

-- ---- ploot_worker grants ----
GRANT SELECT ON tenants, ambassadors TO ploot_worker;
GRANT UPDATE (throttled_until, throttle_reason) ON ambassadors TO ploot_worker;
GRANT SELECT, UPDATE ON posts, provider_tokens TO ploot_worker;
GRANT SELECT, INSERT, UPDATE ON publish_attempts TO ploot_worker;

-- ---- RLS ----
ALTER TABLE tenants          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ambassadors      ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_tokens  ENABLE ROW LEVEL SECURITY;
ALTER TABLE publish_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_tenant ON tenants TO ploot_app
  USING (id = app_current_tenant());
CREATE POLICY app_tenant ON ambassadors TO ploot_app
  USING (tenant_id = app_current_tenant());
CREATE POLICY app_tenant ON posts TO ploot_app
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY app_tenant ON publish_attempts TO ploot_app
  USING (tenant_id = app_current_tenant());
CREATE POLICY app_tenant ON idempotency_keys TO ploot_app
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
-- provider_tokens: no policy for ploot_app (and no grant) => no access at all.

CREATE POLICY worker_all ON tenants          TO ploot_worker USING (true);
CREATE POLICY worker_all ON ambassadors      TO ploot_worker USING (true) WITH CHECK (true);
CREATE POLICY worker_all ON posts            TO ploot_worker USING (true) WITH CHECK (true);
CREATE POLICY worker_all ON provider_tokens  TO ploot_worker USING (true) WITH CHECK (true);
CREATE POLICY worker_all ON publish_attempts TO ploot_worker USING (true) WITH CHECK (true);
