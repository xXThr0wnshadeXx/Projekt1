-- Private attestation/decision receipts. Never expose request, session binding, or ledger rows over HTTP.
CREATE TABLE fact_decisions (
  id text PRIMARY KEY,
  scope_id text NOT NULL, owner_user_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  request jsonb NOT NULL,
  subject_key text NOT NULL,
  relationship_id text,
  include_in_search boolean NOT NULL,
  before_claim jsonb, after_claim jsonb NOT NULL,
  source_policies jsonb NOT NULL,
  attestation_evidence_id text,
  base_graph_version bigint NOT NULL,
  graph_version bigint NOT NULL CHECK (graph_version = base_graph_version + 1),
  response jsonb NOT NULL,
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (scope_id, owner_user_id, idempotency_key),
  FOREIGN KEY (scope_id, owner_user_id) REFERENCES private_scopes(id, owner_user_id)
);
CREATE INDEX fact_decisions_projection ON fact_decisions(scope_id, owner_user_id, relationship_id, graph_version DESC);
