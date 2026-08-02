import pg from 'pg';
import { requireEnv, DRY_RUN } from './config.js';

// Dota match_ids and SteamIDs exceed 2^31 but stay well inside Number.MAX_SAFE_INTEGER,
// so parse int8 as a JS number rather than the string pg returns by default.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// numeric -> number (used by AVG/ROUND in leaderboard queries)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

let pool;

/**
 * Neon serves a publicly-trusted cert, so ordinary verification works and is the default.
 * Local development against a plain Postgres (`sslmode=disable`) turns TLS off, and
 * PGSSL_NO_VERIFY=1 is the escape hatch for a TLS-intercepting proxy.
 */
function sslOption(connectionString = '') {
  if (/sslmode=disable/i.test(connectionString)) return false;
  if (/^postgres(ql)?:\/\/[^/]*@?(localhost|127\.0\.0\.1)/i.test(connectionString)) return false;
  if (process.env.PGSSL_NO_VERIFY === '1') return { rejectUnauthorized: false };
  return true;
}

export function getPool() {
  if (pool) return pool;
  requireEnv('DATABASE_URL');
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslOption(process.env.DATABASE_URL),
    max: 4,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 10000,
  });
  return pool;
}

export function query(text, params) {
  return getPool().query(text, params);
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

// Arbitrary but fixed key. Prevents two overlapping Actions runs from double-posting;
// the `posts.dedupe_key` unique index is the real backstop, this just avoids wasted work.
const LOCK_KEY = 570570570;

/**
 * Runs `fn` while holding a session-level advisory lock. Returns null (without running
 * `fn`) if another run already holds it. The lock is released when the client is freed.
 */
export async function withLock(fn) {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
    if (!rows[0].locked) return null;
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  account_id       BIGINT PRIMARY KEY,
  steam_id64       TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  avatar_url       TEXT,
  rank_tier        INTEGER,
  leaderboard_rank INTEGER,
  rank_checked_at  TIMESTAMPTZ,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Added after initial release; ALTER keeps existing databases upgradable in place.
-- A player is "seeded" once their history is loaded silently. Without this, adding a
-- friend mid-flight would dump their last 20 matches into the channel at once.
ALTER TABLE players ADD COLUMN IF NOT EXISTS seeded BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS matches (
  match_id      BIGINT  NOT NULL,
  account_id    BIGINT  NOT NULL REFERENCES players(account_id) ON DELETE CASCADE,
  hero_id       INTEGER NOT NULL,
  won           BOOLEAN NOT NULL,
  kills         INTEGER NOT NULL DEFAULT 0,
  deaths        INTEGER NOT NULL DEFAULT 0,
  assists       INTEGER NOT NULL DEFAULT 0,
  duration      INTEGER NOT NULL DEFAULT 0,
  game_mode     INTEGER,
  lobby_type    INTEGER,
  gold_per_min  INTEGER,
  xp_per_min    INTEGER,
  hero_damage   INTEGER,
  tower_damage  INTEGER,
  hero_healing  INTEGER,
  last_hits     INTEGER,
  party_size    INTEGER,
  leaver_status INTEGER,
  player_slot   INTEGER,
  radiant_win   BOOLEAN,
  start_time    BIGINT  NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, account_id)
);

CREATE INDEX IF NOT EXISTS matches_account_start_idx ON matches (account_id, start_time DESC);
CREATE INDEX IF NOT EXISTS matches_start_idx         ON matches (start_time DESC);
CREATE INDEX IF NOT EXISTS matches_match_idx         ON matches (match_id);

CREATE TABLE IF NOT EXISTS presence (
  account_id          BIGINT PRIMARY KEY REFERENCES players(account_id) ON DELETE CASCADE,
  state               TEXT NOT NULL DEFAULT 'offline',
  since               TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen           TIMESTAMPTZ NOT NULL DEFAULT now(),
  consecutive_in_game INTEGER NOT NULL DEFAULT 0,
  raw                 JSONB
);

-- Retry queue. OpenDota lags several minutes behind match end, so a single check at
-- logout would silently miss matches; we keep re-checking until a newer match appears.
CREATE TABLE IF NOT EXISTS pending_results (
  account_id        BIGINT PRIMARY KEY REFERENCES players(account_id) ON DELETE CASCADE,
  left_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  baseline_match_id BIGINT NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_attempt_at   TIMESTAMPTZ
);

-- Idempotency guard: every Discord post claims a unique key first. Makes double-posting
-- impossible even if a run is retried, duplicated, or overlaps another.
CREATE TABLE IF NOT EXISTS posts (
  id          BIGSERIAL PRIMARY KEY,
  dedupe_key  TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,
  account_id  BIGINT,
  match_id    BIGINT,
  posted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rank_history (
  id               BIGSERIAL PRIMARY KEY,
  account_id       BIGINT NOT NULL REFERENCES players(account_id) ON DELETE CASCADE,
  rank_tier        INTEGER,
  leaderboard_rank INTEGER,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rank_history_account_idx ON rank_history (account_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function migrate() {
  await query(SCHEMA);
}

/**
 * Claims a dedupe key. Returns true if this process won the claim (and should post),
 * false if it was already claimed. Call BEFORE sending to Discord.
 */
export async function claimPost({ key, kind, accountId = null, matchId = null }) {
  // A dry run must not record claims, or the following real run would think everything
  // was already posted and stay silent.
  if (DRY_RUN) return true;

  const { rowCount } = await query(
    `INSERT INTO posts (dedupe_key, kind, account_id, match_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [key, kind, accountId, matchId]
  );
  return rowCount > 0;
}

/** Releases a claim so a later run can retry — used when the Discord POST fails. */
export async function releasePost(key) {
  await query('DELETE FROM posts WHERE dedupe_key = $1', [key]);
}

export async function getMeta(key) {
  const { rows } = await query('SELECT value FROM meta WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

export async function setMeta(key, value) {
  await query(
    `INSERT INTO meta (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, String(value)]
  );
}

/** Upserts the configured friends into `players`, deactivating anyone removed from config. */
export async function syncPlayers(friends) {
  for (const f of friends) {
    await query(
      `INSERT INTO players (account_id, steam_id64, display_name, active)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (account_id) DO UPDATE
         SET steam_id64 = EXCLUDED.steam_id64,
             display_name = EXCLUDED.display_name,
             active = TRUE`,
      [f.accountId, f.steamId64, f.name]
    );
    await query(
      `INSERT INTO presence (account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING`,
      [f.accountId]
    );
  }
  const ids = friends.map((f) => f.accountId);
  await query('UPDATE players SET active = FALSE WHERE NOT (account_id = ANY($1::bigint[]))', [ids]);
}
