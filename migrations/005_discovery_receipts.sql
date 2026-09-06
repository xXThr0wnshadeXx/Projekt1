CREATE TABLE discovery_receipts (
 id text PRIMARY KEY,
 scope_id text NOT NULL,
 owner_user_id text NOT NULL,
 idempotency_key text NOT NULL,
 request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
 base_graph_version text NOT NULL,
 context_digest text NOT NULL,
 source_policies jsonb NOT NULL,
 phase text NOT NULL CHECK (phase IN ('RUNNING','COMPLETE','FAILED')),
 lease_expires_at timestamptz NOT NULL,
 result jsonb,
 failure_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,scope_id,idempotency_key),
 FOREIGN KEY(scope_id,owner_user_id) REFERENCES private_scopes(id,owner_user_id),
 CHECK ((phase='RUNNING' AND result IS NULL AND failure_code IS NULL) OR
        (phase='COMPLETE' AND result IS NOT NULL AND failure_code IS NULL) OR
        (phase='FAILED' AND result IS NULL AND failure_code IS NOT NULL))
);
