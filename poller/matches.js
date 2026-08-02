import { query } from './db.js';

const COLUMNS = [
  'match_id', 'account_id', 'hero_id', 'won', 'kills', 'deaths', 'assists', 'duration',
  'game_mode', 'lobby_type', 'gold_per_min', 'xp_per_min', 'hero_damage', 'tower_damage',
  'hero_healing', 'last_hits', 'party_size', 'leaver_status', 'player_slot', 'radiant_win',
  'start_time',
];

/**
 * Inserts matches for a player, ignoring ones already stored.
 * Returns only the rows that were genuinely new — that set drives what gets posted.
 */
export async function insertMatches(accountId, rows) {
  const inserted = [];
  for (const m of rows) {
    const record = { ...m, account_id: accountId };
    const placeholders = COLUMNS.map((_, i) => `$${i + 1}`).join(', ');
    const { rowCount } = await query(
      `INSERT INTO matches (${COLUMNS.join(', ')})
       VALUES (${placeholders})
       ON CONFLICT (match_id, account_id) DO NOTHING`,
      COLUMNS.map((c) => record[c])
    );
    if (rowCount > 0) inserted.push(record);
  }
  return inserted;
}

export async function maxMatchId(accountId) {
  const { rows } = await query(
    'SELECT COALESCE(MAX(match_id), 0) AS max FROM matches WHERE account_id = $1',
    [accountId]
  );
  return Number(rows[0].max);
}

export async function activePlayers() {
  const { rows } = await query(
    `SELECT account_id, steam_id64, display_name, avatar_url, rank_tier,
            leaderboard_rank, rank_checked_at, seeded
       FROM players WHERE active = TRUE ORDER BY display_name`
  );
  return rows;
}
