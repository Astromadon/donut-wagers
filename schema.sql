-- Production relational schema (PostgreSQL-compatible).
CREATE TABLE users (
  id UUID PRIMARY KEY,
  discord_id TEXT NOT NULL UNIQUE,
  discord_username TEXT NOT NULL,
  discord_avatar TEXT,
  balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  locked_balance BIGINT NOT NULL DEFAULT 0 CHECK (locked_balance >= 0),
  wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
  minecraft_uuid UUID NULL UNIQUE,
  minecraft_username TEXT NULL,
  minecraft_verified BOOLEAN NOT NULL DEFAULT FALSE,
  minecraft_verified_at TIMESTAMPTZ NULL,
  player_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Runtime persistence used by the Node server. The JSON state is stored in a
-- transactional PostgreSQL row and locked during every escrow mutation.
CREATE TABLE IF NOT EXISTS donut_wagers_state (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE minecraft_accounts (user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, minecraft_uuid UUID NULL UNIQUE, minecraft_username TEXT NOT NULL, verified BOOLEAN NOT NULL DEFAULT FALSE, verified_at TIMESTAMPTZ, verification_method TEXT NOT NULL DEFAULT 'bot_private_message', created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX minecraft_accounts_username_ci_unique ON minecraft_accounts (LOWER(minecraft_username));
CREATE TABLE verification_codes (id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, minecraft_username TEXT NOT NULL, minecraft_username_normalized TEXT NOT NULL, code_hash TEXT NOT NULL, salt TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used BOOLEAN NOT NULL DEFAULT FALSE, verified BOOLEAN NOT NULL DEFAULT FALSE, verified_at TIMESTAMPTZ NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX verification_codes_pending_idx ON verification_codes(user_id, expires_at) WHERE used = FALSE;
CREATE TABLE wagers (id UUID PRIMARY KEY, match_code TEXT UNIQUE, player1_id UUID NOT NULL REFERENCES users(id), player2_id UUID REFERENCES users(id), amount BIGINT NOT NULL CHECK (amount > 0), status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE deposits (id UUID PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'wager', wager_id UUID REFERENCES wagers(id), user_id UUID NOT NULL REFERENCES users(id), minecraft_uuid UUID NULL, minecraft_username TEXT, amount BIGINT NOT NULL CHECK (amount > 0), recipient TEXT NOT NULL, transaction_id TEXT UNIQUE, status TEXT NOT NULL, expires_at TIMESTAMPTZ, detected_at TIMESTAMPTZ, verified_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX deposits_wager_status_idx ON deposits(wager_id, status);
CREATE INDEX deposits_wallet_pending_idx ON deposits(user_id, expires_at) WHERE kind = 'wallet' AND status = 'pending';
CREATE TABLE support_tickets (id UUID PRIMARY KEY, match_id UUID NOT NULL REFERENCES wagers(id) ON DELETE CASCADE, requester_id UUID NOT NULL REFERENCES users(id), discord_channel_id TEXT NOT NULL UNIQUE, channel_url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX support_tickets_one_open_per_match ON support_tickets(match_id) WHERE status = 'open';
CREATE TABLE bans (id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, reason TEXT NOT NULL, created_by UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMPTZ NULL, revoked_at TIMESTAMPTZ NULL, revoked_by UUID NULL REFERENCES users(id));
CREATE INDEX bans_active_user_idx ON bans(user_id, expires_at) WHERE revoked_at IS NULL;
CREATE TABLE bot_status (id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id), bot_username TEXT NOT NULL, last_heartbeat_at TIMESTAMPTZ NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE audit_logs (id UUID PRIMARY KEY, user_id UUID REFERENCES users(id), action TEXT NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
