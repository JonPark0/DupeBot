-- DupeBot schema. The bot applies this file on every start; every statement is idempotent.
-- Only fingerprints are stored: hashes, Discord IDs and timestamps, plus the embed title and
-- description of links (for semantic matching). No message text, no image files.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id            TEXT PRIMARY KEY,
  emoji               TEXT,
  semantic_emoji      TEXT,
  mode                TEXT CHECK (mode IN ('forward', 'reply', 'react')),
  hamming_threshold   INTEGER,
  same_author_minutes INTEGER,
  semantic_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  include_channels    TEXT[] NOT NULL DEFAULT '{}',
  exclude_channels    TEXT[] NOT NULL DEFAULT '{}',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fingerprints (
  id          BIGSERIAL PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  author_id   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('url', 'image')),
  key         TEXT NOT NULL,          -- sha256 hex of the normalized URL or of the image bytes
  dhash       BIGINT,                 -- 64-bit image difference hash (stored signed)
  title       TEXT,                   -- link embed title
  description TEXT,                   -- link embed description
  posted_at   TIMESTAMPTZ NOT NULL,
  UNIQUE (message_id, kind, key)
);
CREATE INDEX IF NOT EXISTS fingerprints_lookup ON fingerprints (guild_id, kind, key, posted_at);
CREATE INDEX IF NOT EXISTS fingerprints_recent ON fingerprints (guild_id, kind, posted_at);
CREATE INDEX IF NOT EXISTS fingerprints_message ON fingerprints (message_id);

-- Hashes an admin marked "중복 아님" (not a duplicate): never flagged again in that guild.
CREATE TABLE IF NOT EXISTS allowlist (
  guild_id TEXT NOT NULL,
  key      TEXT NOT NULL,
  dhash    BIGINT,
  added_by TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, key)
);

-- What the bot did about a message, so "중복 아님" can undo it.
CREATE TABLE IF NOT EXISTS responses (
  message_id     TEXT NOT NULL,
  channel_id     TEXT NOT NULL,
  bot_message_id TEXT,
  kind           TEXT NOT NULL CHECK (kind IN ('exact', 'semantic')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS responses_message ON responses (message_id);

-- Claude API usage per UTC day, for the daily budget and /status.
CREATE TABLE IF NOT EXISTS llm_usage (
  day           DATE PRIMARY KEY,
  calls         INTEGER NOT NULL DEFAULT 0,
  input_tokens  BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  usd           NUMERIC(12, 6) NOT NULL DEFAULT 0
);
