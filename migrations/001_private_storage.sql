-- Run once through migrate.ts; no provider credentials or imported raw payloads are stored.
CREATE TABLE app_users (
  id text PRIMARY KEY, google_subject text NOT NULL UNIQUE, display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE private_scopes (
  id text PRIMARY KEY, owner_user_id text NOT NULL UNIQUE REFERENCES app_users(id),
  root_person_id text NOT NULL, graph_version bigint NOT NULL CHECK (graph_version >= 0),
  snapshot jsonb NOT NULL,
  UNIQUE (id, owner_user_id),
  CHECK (snapshot->>'scopeId' = id),
  CHECK (snapshot->>'rootPersonId' = root_person_id),
  CHECK (snapshot->>'graphVersion' = graph_version::text)
);
CREATE TABLE private_sources (
  id text PRIMARY KEY, scope_id text NOT NULL, owner_user_id text NOT NULL,
  policy_version text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  summary jsonb NOT NULL, owner_identity jsonb,
  UNIQUE (id, scope_id, owner_user_id),
  FOREIGN KEY (scope_id, owner_user_id) REFERENCES private_scopes(id, owner_user_id),
  CHECK (summary->>'id' = id)
);
CREATE TABLE import_jobs (
  id text PRIMARY KEY, scope_id text NOT NULL, owner_user_id text NOT NULL, source_id text NOT NULL,
  batch_id text NOT NULL, payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  envelope jsonb NOT NULL, status text NOT NULL CHECK (status IN ('PENDING_REVIEW','OBSERVATIONS_APPROVED')),
  review_key text, review_digest text, events jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_id, source_id, batch_id),
  FOREIGN KEY (source_id, scope_id, owner_user_id) REFERENCES private_sources(id, scope_id, owner_user_id)
);
CREATE INDEX import_jobs_owner_scope ON import_jobs(owner_user_id, scope_id);
CREATE TABLE oauth_transactions (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  browser_binding_hash text NOT NULL CHECK (browser_binding_hash ~ '^[a-f0-9]{64}$'),
  nonce text NOT NULL, code_verifier text NOT NULL,
  created_at bigint NOT NULL, expires_at bigint NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX oauth_transactions_expiry ON oauth_transactions(expires_at);
CREATE TABLE app_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id text NOT NULL REFERENCES app_users(id), created_at bigint NOT NULL,
  expires_at bigint NOT NULL CHECK (expires_at > created_at), revoked_at bigint
);
CREATE INDEX app_sessions_expiry ON app_sessions(expires_at);
CREATE INDEX app_sessions_user ON app_sessions(user_id);
