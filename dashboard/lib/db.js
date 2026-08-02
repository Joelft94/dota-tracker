import { neon } from '@neondatabase/serverless';

// Same Neon database the poller writes to; the dashboard only ever reads.
//
// Created lazily so `next build` doesn't crash when DATABASE_URL is absent — pages catch
// the error and render an empty state instead. Neon's driver speaks HTTP to Neon only, so
// a plain local Postgres falls back to `pg`, which makes `npm run dev` work offline.
let client;

async function getClient() {
  if (client) return client;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  if (/neon\.tech/i.test(url)) {
    client = neon(url);
  } else {
    const { default: pg } = await import('pg');
    pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
    pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
    const pool = new pg.Pool({
      connectionString: url,
      ssl: /sslmode=disable/i.test(url) ? false : undefined,
    });
    // Adapt pg's positional API to the tagged-template shape the queries below use.
    client = async (strings, ...values) => {
      const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ''), '');
      const { rows } = await pool.query(text, values);
      return rows;
    };
  }
  return client;
}

export const sql = async (strings, ...values) => (await getClient())(strings, ...values);

/** Per-player aggregates. `days` of 0 means all time. */
export async function leaderboard(days = 0) {
  const cutoff = days > 0 ? Math.floor(Date.now() / 1000) - days * 86400 : 0;
  return sql`
    SELECT p.account_id,
           p.display_name,
           p.avatar_url,
           p.rank_tier,
           p.leaderboard_rank,
           COUNT(m.*)::int                                        AS games,
           COALESCE(SUM(CASE WHEN m.won THEN 1 ELSE 0 END), 0)::int AS wins,
           COALESCE(ROUND(AVG(m.kills), 1), 0)::float             AS avg_kills,
           COALESCE(ROUND(AVG(m.deaths), 1), 0)::float            AS avg_deaths,
           COALESCE(ROUND(AVG(m.assists), 1), 0)::float           AS avg_assists,
           COALESCE(ROUND(AVG(m.gold_per_min)), 0)::int           AS avg_gpm,
           COALESCE(ROUND(AVG(m.last_hits)), 0)::int              AS avg_lh,
           COALESCE(SUM(m.duration), 0)::int                      AS seconds
      FROM players p
      LEFT JOIN matches m
        ON m.account_id = p.account_id AND m.start_time >= ${cutoff}
     WHERE p.active
     GROUP BY p.account_id, p.display_name, p.avatar_url, p.rank_tier, p.leaderboard_rank
     ORDER BY games DESC, wins DESC
  `;
}

/**
 * Last N results per player, newest first — used to compute current streaks in JS.
 * A window function keeps this to one round trip regardless of group size.
 */
export async function recentResults(limitPerPlayer = 20) {
  return sql`
    SELECT account_id, won FROM (
      SELECT account_id, won, start_time,
             ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY start_time DESC) AS rn
        FROM matches
    ) t
    WHERE rn <= ${limitPerPlayer}
    ORDER BY account_id, start_time DESC
  `;
}

export function computeStreaks(rows) {
  const byPlayer = new Map();
  for (const r of rows) {
    const list = byPlayer.get(r.account_id) ?? [];
    list.push(r.won);
    byPlayer.set(r.account_id, list);
  }
  const out = new Map();
  for (const [id, results] of byPlayer) {
    if (!results.length) continue;
    const won = results[0];
    let count = 0;
    for (const w of results) {
      if (w !== won) break;
      count++;
    }
    out.set(id, { count, won });
  }
  return out;
}

export async function recentMatches(limit = 30) {
  return sql`
    SELECT m.*, p.display_name, p.avatar_url
      FROM matches m
      JOIN players p USING (account_id)
     WHERE p.active
     ORDER BY m.start_time DESC
     LIMIT ${limit}
  `;
}

export async function playerById(accountId) {
  const rows = await sql`
    SELECT * FROM players WHERE account_id = ${accountId} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function playerMatches(accountId, limit = 50) {
  return sql`
    SELECT * FROM matches
     WHERE account_id = ${accountId}
     ORDER BY start_time DESC
     LIMIT ${limit}
  `;
}

export async function playerHeroes(accountId, limit = 12) {
  return sql`
    SELECT hero_id,
           COUNT(*)::int                                          AS games,
           SUM(CASE WHEN won THEN 1 ELSE 0 END)::int              AS wins,
           COALESCE(ROUND(AVG(kills), 1), 0)::float               AS avg_kills,
           COALESCE(ROUND(AVG(deaths), 1), 0)::float              AS avg_deaths,
           COALESCE(ROUND(AVG(assists), 1), 0)::float             AS avg_assists
      FROM matches
     WHERE account_id = ${accountId}
     GROUP BY hero_id
     ORDER BY games DESC
     LIMIT ${limit}
  `;
}

export async function rankHistory(accountId, limit = 60) {
  return sql`
    SELECT rank_tier, leaderboard_rank, recorded_at
      FROM rank_history
     WHERE account_id = ${accountId} AND rank_tier IS NOT NULL
     ORDER BY recorded_at DESC
     LIMIT ${limit}
  `;
}
