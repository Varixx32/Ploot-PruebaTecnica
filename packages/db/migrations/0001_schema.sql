-- Core schema. All timestamps are timestamptz (stored as UTC instants); wall-clock/zone
-- conversion happens at the API edge, the IANA zone is kept for display and audit.

CREATE TYPE post_status AS ENUM ('draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled');
CREATE TYPE token_status AS ENUM ('valid', 'revoked');

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- An Embajador: one identity at the provider, owned by exactly one tenant.
CREATE TABLE ambassadors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  display_name     text NOT NULL,
  provider_user_id text NOT NULL UNIQUE,
  timezone         text NOT NULL DEFAULT 'Europe/Madrid',
  -- Head-of-line throttle: the worker won't take this Embajador's next post before this instant
  -- (provider Retry-After, pacing). -infinity = not throttled.
  throttled_until  timestamptz NOT NULL DEFAULT '-infinity',
  throttle_reason  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Target of composite FKs: children must belong to the same tenant as their Embajador.
  UNIQUE (tenant_id, id)
);

-- Token vault. Ciphertext only (AES-256-GCM, app-level envelope); key_version enables rotation.
-- One row per Embajador: the provider issues one grant per identity.
CREATE TABLE provider_tokens (
  ambassador_id     uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  access_token_enc  bytea NOT NULL,
  refresh_token_enc bytea NOT NULL,
  key_version       smallint NOT NULL,
  expires_at        timestamptz NOT NULL,
  status            token_status NOT NULL DEFAULT 'valid',
  revoked_at        timestamptz,
  refreshed_at      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, ambassador_id) REFERENCES ambassadors (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT revoked_has_timestamp CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);
-- Proactive refresh sweep: valid tokens about to expire.
CREATE INDEX provider_tokens_expiring_idx ON provider_tokens (expires_at) WHERE status = 'valid';
CREATE TRIGGER provider_tokens_updated_at BEFORE UPDATE ON provider_tokens
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE posts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  ambassador_id     uuid NOT NULL,
  content           text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 3000),
  status            post_status NOT NULL,
  -- Instant the user asked for. Immutable intent, used to measure publication lag.
  scheduled_at      timestamptz,
  -- IANA zone the user scheduled in (e.g. Europe/Madrid).
  timezone          text NOT NULL DEFAULT 'Europe/Madrid',
  -- When the worker may (re)try. Starts at scheduled_at, pushed forward by backoff.
  due_at            timestamptz,
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Publishing lease: if a worker dies mid-publish, the lease expires and the post is recoverable.
  lease_owner       text,
  lease_expires_at  timestamptz,
  external_id       text,
  published_at      timestamptz,
  last_error_code   text,
  last_error_detail text,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, ambassador_id) REFERENCES ambassadors (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT scheduled_has_times CHECK (
    status NOT IN ('scheduled', 'publishing') OR (scheduled_at IS NOT NULL AND due_at IS NOT NULL)),
  CONSTRAINT publishing_has_lease CHECK (
    status <> 'publishing' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CONSTRAINT published_has_external_id CHECK (
    status <> 'published' OR (external_id IS NOT NULL AND published_at IS NOT NULL)),
  CONSTRAINT failed_has_error CHECK (status <> 'failed' OR last_error_code IS NOT NULL)
);
CREATE TRIGGER posts_updated_at BEFORE UPDATE ON posts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A provider post id maps to exactly one of our posts.
CREATE UNIQUE INDEX posts_external_id_uq ON posts (external_id) WHERE external_id IS NOT NULL;
-- Worker hot path. Partial: only pending rows are indexed, not the published history.
CREATE INDEX posts_due_idx ON posts (due_at) WHERE status = 'scheduled';
-- Per-Embajador queue head (fair pick + "don't advance the head on 429").
CREATE INDEX posts_ambassador_due_idx ON posts (ambassador_id, due_at) WHERE status = 'scheduled';
-- Crash recovery: publishing rows whose lease expired.
CREATE INDEX posts_lease_idx ON posts (lease_expires_at) WHERE status = 'publishing';
-- API listing (keyset pagination, newest first), with and without status filter.
CREATE INDEX posts_tenant_created_idx ON posts (tenant_id, created_at DESC, id DESC);
CREATE INDEX posts_tenant_status_created_idx ON posts (tenant_id, status, created_at DESC, id DESC);

-- One row per call to the provider: answers "why is Embajador X late?" without reading code.
CREATE TABLE publish_attempts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id         uuid NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL,
  ambassador_id   uuid NOT NULL,
  attempt         integer NOT NULL,
  worker_id       text NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  outcome         text,
  http_status     integer,
  error_code      text,
  retry_after_sec integer,
  duration_ms     integer,
  FOREIGN KEY (tenant_id, ambassador_id) REFERENCES ambassadors (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX publish_attempts_ambassador_idx ON publish_attempts (ambassador_id, started_at DESC);
CREATE INDEX publish_attempts_post_idx ON publish_attempts (post_id, attempt);

-- Idempotency-Key store for POST /posts/:id/publish. Scoped per tenant.
CREATE TABLE idempotency_keys (
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  key                 text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 255),
  request_fingerprint text NOT NULL,
  post_id             uuid REFERENCES posts (id) ON DELETE CASCADE,
  response_status     integer,
  response_body       jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
-- TTL purge.
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
