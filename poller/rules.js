import { query } from './db.js';
import { heroName } from './config.js';
import { fmtDuration } from './discord.js';

export const STREAK_THRESHOLD = 3;

/**
 * Current win or loss streak for a player, computed from stored history.
 * Returns { count, won } or null when the most recent results are mixed below threshold.
 */
export async function currentStreak(accountId, lookback = 25) {
  const { rows } = await query(
    `SELECT won FROM matches
      WHERE account_id = $1
      ORDER BY start_time DESC
      LIMIT $2`,
    [accountId, lookback]
  );
  if (rows.length === 0) return null;

  const won = rows[0].won;
  let count = 0;
  for (const r of rows) {
    if (r.won !== won) break;
    count++;
  }
  return { count, won };
}

/**
 * Roasts for a single match. Deliberately only fires on genuinely notable lines so the
 * channel doesn't turn into noise — each match yields at most one roast.
 */
export function roastFor(match, playerName) {
  const hero = heroName(match.hero_id);

  if (match.leaver_status && match.leaver_status >= 2) {
    return `🚪 **${playerName}** abandoned on ${hero}. Bold strategy.`;
  }
  if (match.deaths >= 15) {
    return `⚰️ **${playerName}** died **${match.deaths}** times on ${hero}. That's not a KDA, that's a phone number.`;
  }
  if (match.kills === 0 && match.assists <= 2 && !match.won) {
    return `🫥 **${playerName}** finished ${hero} with **0 kills**. Were you AFK?`;
  }
  if (match.deaths >= 12) {
    return `💀 **${playerName}** went ${match.kills}/${match.deaths}/${match.assists} on ${hero}. Rough one.`;
  }
  if (!match.won && match.duration > 0 && match.duration < 900) {
    return `⏱️ **${playerName}** lost in **${fmtDuration(match.duration)}** on ${hero}. Fastest gg in the west.`;
  }
  if (match.won && match.deaths === 0 && match.kills >= 5) {
    return `😇 **${playerName}** went **deathless** (${match.kills}/0/${match.assists}) on ${hero}. Show-off.`;
  }
  return null;
}

/**
 * Groups newly-recorded matches by match_id. Any match_id with 2+ tracked players becomes
 * a single stack embed instead of N separate posts. Costs nothing extra — the match_id is
 * already shared across their rows.
 */
export function groupByMatch(entries) {
  const byMatch = new Map();
  for (const e of entries) {
    const list = byMatch.get(e.match.match_id) ?? [];
    list.push(e);
    byMatch.set(e.match.match_id, list);
  }
  const solo = [];
  const stacks = [];
  for (const list of byMatch.values()) {
    if (list.length > 1) stacks.push(list);
    else solo.push(list[0]);
  }
  return { solo, stacks };
}

/** Aggregates the weekly recap. `sinceEpoch` is a unix seconds boundary. */
export async function weeklyStats(sinceEpoch, minGames = 3) {
  const perPlayer = await query(
    `SELECT p.account_id,
            p.display_name           AS name,
            COUNT(*)::int            AS games,
            SUM(CASE WHEN m.won THEN 1 ELSE 0 END)::int AS wins,
            SUM(m.kills)::int        AS kills,
            SUM(m.deaths)::int       AS deaths,
            SUM(m.assists)::int      AS assists,
            SUM(m.duration)::bigint  AS seconds,
            ROUND(100.0 * SUM(CASE WHEN m.won THEN 1 ELSE 0 END) / COUNT(*), 1) AS win_rate
       FROM matches m
       JOIN players p USING (account_id)
      WHERE m.start_time >= $1
      GROUP BY p.account_id, p.display_name`,
    [sinceEpoch]
  );

  const heroes = await query(
    `SELECT hero_id, COUNT(*)::int AS games
       FROM matches
      WHERE start_time >= $1
      GROUP BY hero_id
      ORDER BY games DESC, hero_id ASC
      LIMIT 1`,
    [sinceEpoch]
  );

  const rows = perPlayer.rows;
  const totalMatches = rows.reduce((a, r) => a + r.games, 0);
  const ranked = rows.filter((r) => r.games >= minGames);
  // Fall back to everyone when nobody cleared the minimum, so a quiet week still posts.
  const pool = ranked.length > 0 ? ranked : rows;

  const best = (list, cmp) => (list.length ? [...list].sort(cmp)[0] : null);

  return {
    totalMatches,
    mostGames: best(rows, (a, b) => b.games - a.games),
    bestWinRate: best(pool, (a, b) => b.win_rate - a.win_rate || b.games - a.games),
    worstWinRate: best(pool, (a, b) => a.win_rate - b.win_rate || b.games - a.games),
    topFragger: best(rows, (a, b) => b.kills - a.kills),
    mostDeaths: best(rows, (a, b) => b.deaths - a.deaths),
    topHero: heroes.rows[0] ?? null,
    touchGrass: (() => {
      const e = best(rows, (a, b) => Number(b.seconds) - Number(a.seconds));
      return e ? { ...e, hours: (Number(e.seconds) / 3600).toFixed(1) } : null;
    })(),
  };
}
