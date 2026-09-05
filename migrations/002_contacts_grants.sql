-- Separate login and contacts authorization purposes. Only encrypted provider credentials persist.
CREATE TABLE contacts_transactions (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  browser_binding_hash text NOT NULL CHECK (browser_binding_hash ~ '^[a-f0-9]{64}$'),
  session_hash text NOT NULL REFERENCES app_sessions(token_hash) ON DELETE CASCADE,
  actor_user_id text NOT NULL REFERENCES app_users(id),
  scope_id text NOT NULL, source_id text NOT NULL, google_subject text NOT NULL,
  nonce text NOT NULL, code_verifier text NOT NULL,
  created_at bigint NOT NULL, expires_at bigint NOT NULL CHECK (expires_at > created_at),
  FOREIGN KEY (scope_id, actor_user_id) REFERENCES private_scopes(id, owner_user_id)
);
CREATE INDEX contacts_transactions_expiry ON contacts_transactions(expires_at);
CREATE TABLE contacts_grants (
  source_id text PRIMARY KEY, owner_user_id text NOT NULL, scope_id text NOT NULL,
  google_subject text NOT NULL, version text NOT NULL, revoked_at bigint, grant_data jsonb NOT NULL,
  UNIQUE (owner_user_id, scope_id, google_subject),
  FOREIGN KEY (source_id, scope_id, owner_user_id) REFERENCES private_sources(id, scope_id, owner_user_id),
  CHECK (grant_data->>'sourceId' = source_id),
  CHECK (grant_data->>'scopeId' = scope_id),
  CHECK (grant_data->>'ownerUserId' = owner_user_id),
  CHECK (grant_data->>'googleSubject' = google_subject),
  CHECK (grant_data->>'version' = version)
);
