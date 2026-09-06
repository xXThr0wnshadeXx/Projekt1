CREATE TABLE public_claim_reviews (
  id text PRIMARY KEY, scope_id text NOT NULL, owner_user_id text NOT NULL,
  idempotency_key text NOT NULL, request_digest text NOT NULL, request jsonb NOT NULL, response jsonb NOT NULL,
  base_graph_version bigint NOT NULL, graph_version bigint NOT NULL CHECK(graph_version=base_graph_version+1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(scope_id,owner_user_id,idempotency_key),
  FOREIGN KEY(scope_id,owner_user_id) REFERENCES private_scopes(id,owner_user_id),
  CHECK(request_digest ~ '^[a-f0-9]{64}$')
);
CREATE TABLE public_claim_decisions (
  id text PRIMARY KEY, review_id text NOT NULL REFERENCES public_claim_reviews(id) DEFERRABLE INITIALLY DEFERRED,
  scope_id text NOT NULL, owner_user_id text NOT NULL, source_id text NOT NULL,
  proposal_id text NOT NULL, proposal_revision text NOT NULL, graph_version bigint NOT NULL,
  decision text NOT NULL CHECK(decision IN ('ACCEPT','REJECT')), basis text NOT NULL CHECK(basis='PUBLIC_CITATION_REVIEW'),
  include_in_search boolean NOT NULL, bindings jsonb,
  relationship_id text, relationship jsonb, policy_version text, policy_semantics jsonb, assessment jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(review_id,source_id,proposal_id),
  FOREIGN KEY(source_id,scope_id,owner_user_id) REFERENCES private_sources(id,scope_id,owner_user_id)
);
CREATE INDEX public_claim_latest ON public_claim_decisions(scope_id,owner_user_id,source_id,proposal_id,graph_version DESC);
