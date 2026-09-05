-- Source-private immutable evidence and identity review; no public claim acceptance or SearchEdges.
CREATE TABLE public_fact_resources (
  source_id text NOT NULL, scope_id text NOT NULL, owner_user_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('DOCUMENT','ENDPOINT','PROPOSAL','EVIDENCE','CITATION')),
  id text NOT NULL, revision text NOT NULL, digest text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (source_id, kind, id, revision),
  FOREIGN KEY (source_id, scope_id, owner_user_id) REFERENCES private_sources(id, scope_id, owner_user_id),
  CHECK (digest ~ '^[a-f0-9]{64}$')
);
CREATE TABLE public_fact_heads (
  source_id text NOT NULL, scope_id text NOT NULL, owner_user_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('DOCUMENT','ENDPOINT','PROPOSAL','EVIDENCE','CITATION')),
  id text NOT NULL, revision text NOT NULL,
  PRIMARY KEY (source_id, kind, id),
  FOREIGN KEY (source_id, kind, id, revision) REFERENCES public_fact_resources(source_id, kind, id, revision),
  FOREIGN KEY (source_id, scope_id, owner_user_id) REFERENCES private_sources(id, scope_id, owner_user_id)
);
CREATE TABLE public_fact_batches (
  id text PRIMARY KEY, scope_id text NOT NULL, owner_user_id text NOT NULL, source_id text NOT NULL,
  batch_key text NOT NULL, idempotency_key text NOT NULL, request_digest text NOT NULL,
  source_policy text NOT NULL, envelope jsonb NOT NULL, endpoint_refs jsonb NOT NULL,
  response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (scope_id, owner_user_id, idempotency_key), UNIQUE (source_id, batch_key),
  FOREIGN KEY (source_id, scope_id, owner_user_id) REFERENCES private_sources(id, scope_id, owner_user_id),
  CHECK (request_digest ~ '^[a-f0-9]{64}$')
);
CREATE TABLE public_identity_decisions (
  id text PRIMARY KEY, scope_id text NOT NULL, owner_user_id text NOT NULL, source_id text NOT NULL,
  endpoint_id text NOT NULL, endpoint_revision text NOT NULL, source_policy text NOT NULL,
  idempotency_key text NOT NULL, request_digest text NOT NULL, request jsonb NOT NULL,
  previous_decision_id text REFERENCES public_identity_decisions(id),
  person_id text NOT NULL, identity_id text NOT NULL, response jsonb NOT NULL,
  base_graph_version bigint NOT NULL, graph_version bigint NOT NULL CHECK(graph_version=base_graph_version+1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(scope_id, owner_user_id, idempotency_key),
  FOREIGN KEY(source_id, scope_id, owner_user_id) REFERENCES private_sources(id, scope_id, owner_user_id),
  CHECK(request_digest ~ '^[a-f0-9]{64}$')
);
CREATE INDEX public_identity_latest ON public_identity_decisions(scope_id,owner_user_id,endpoint_id,graph_version DESC);
