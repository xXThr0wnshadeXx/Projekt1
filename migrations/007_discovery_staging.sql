ALTER TABLE discovery_receipts ADD COLUMN workflow jsonb;
ALTER TABLE discovery_receipts ADD COLUMN run_id text;
CREATE TABLE discovery_source_steps (
 operation_id text PRIMARY KEY,
 scope_id text NOT NULL,owner_user_id text NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 source_id text NOT NULL,response jsonb NOT NULL,
 FOREIGN KEY(scope_id,owner_user_id) REFERENCES private_scopes(id,owner_user_id),
 FOREIGN KEY(source_id,scope_id,owner_user_id) REFERENCES private_sources(id,scope_id,owner_user_id)
);
