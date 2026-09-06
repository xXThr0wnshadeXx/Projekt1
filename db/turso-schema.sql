-- Portable schema for the optional Turso development database.
-- Production Sites deployments continue to apply drizzle/ migrations to D1.
CREATE TABLE IF NOT EXISTS people (
  owner TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
  search_name TEXT NOT NULL, headline TEXT NOT NULL, location TEXT NOT NULL,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY (owner, id)
);
CREATE INDEX IF NOT EXISTS people_name ON people(owner, search_name, id);
CREATE TABLE IF NOT EXISTS connections (
  owner TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY (owner, a, b)
);
CREATE INDEX IF NOT EXISTS connections_reverse ON connections(owner, b, a);
CREATE TABLE IF NOT EXISTS evidence (
  owner TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL, source TEXT NOT NULL,
  observed_at TEXT NOT NULL, PRIMARY KEY (owner, a, b, source)
);
CREATE TABLE IF NOT EXISTS api_rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
