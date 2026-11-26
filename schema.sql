-- Reference only. postgres-store.js creates these tables on the first start.
CREATE TABLE donut_wagers_meta (id SMALLINT PRIMARY KEY CHECK (id = 1), version BIGINT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);

-- One row per record. data IS NULL marks a deleted record.
CREATE TABLE donut_wagers_records (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  seq BIGSERIAL NOT NULL,
  version BIGINT NOT NULL,
  data JSON,
  PRIMARY KEY (collection, id),
  CONSTRAINT donut_wagers_locked_not_negative CHECK (collection <> 'users' OR data IS NULL OR COALESCE((data->>'locked_balance')::numeric, 0) >= 0)
);
CREATE INDEX donut_wagers_records_version ON donut_wagers_records (version);
CREATE UNIQUE INDEX donut_wagers_one_discord ON donut_wagers_records ((data->>'discord_id')) WHERE collection = 'users' AND data IS NOT NULL;
CREATE UNIQUE INDEX donut_wagers_one_match_code ON donut_wagers_records ((data->>'match_code')) WHERE collection = 'matches' AND data IS NOT NULL;
CREATE UNIQUE INDEX donut_wagers_one_minecraft ON donut_wagers_records (lower(data->>'minecraft_username')) WHERE collection = 'minecraft_accounts' AND data IS NOT NULL;
CREATE UNIQUE INDEX donut_wagers_one_account_id ON donut_wagers_records ((data->>'minecraft_uuid')) WHERE collection = 'minecraft_accounts' AND data IS NOT NULL;
CREATE UNIQUE INDEX donut_wagers_one_transaction ON donut_wagers_records ((data->>'transaction_id')) WHERE collection = 'deposits' AND data IS NOT NULL;

CREATE TABLE donut_wagers_audit (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, details JSON, created_at TIMESTAMPTZ NOT NULL);
CREATE INDEX donut_wagers_audit_time ON donut_wagers_audit (created_at);
CREATE INDEX donut_wagers_audit_user ON donut_wagers_audit (user_id, created_at);
