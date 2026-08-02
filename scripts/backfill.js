// One-time history load so the dashboard and leaderboards aren't empty on day one.
// Writes to `matches` and NEVER posts to Discord.
//
//   node scripts/backfill.js [limit]     (default 100 matches per player)
import { loadFriends, requireEnv } from '../poller/config.js';
import { migrate, syncPlayers, query, closePool } from '../poller/db.js';
import { matchHistory, playerProfile } from '../poller/opendota.js';
import { insertMatches } from '../poller/matches.js';
import { sleep } from '../poller/http.js';

requireEnv('DATABASE_URL');

const limit = Number(process.argv.find((a) => /^\d+$/.test(a))) || 100;
const friends = loadFriends();

await migrate();
await syncPlayers(friends);

console.log(`Backfilling up to ${limit} matches for ${friends.length} player(s)...\n`);

for (const f of friends) {
  try {
    const rows = await matchHistory(f.accountId, limit);
    const inserted = await insertMatches(f.accountId, rows);

    // Seed the medal too, so the first rank-change post is a real change, not a first read.
    let rank = '';
    try {
      const profile = await playerProfile(f.accountId);
      await query(
        `UPDATE players
            SET rank_tier = $2, leaderboard_rank = $3, avatar_url = $4, rank_checked_at = now()
          WHERE account_id = $1`,
        [f.accountId, profile?.rank_tier ?? null, profile?.leaderboard_rank ?? null,
         profile?.profile?.avatarfull ?? null]
      );
      // Seed one history row so the dashboard's rank chart has a starting point
      // instead of waiting a day for the poller's first reading.
      if (profile?.rank_tier != null) {
        await query(
          `INSERT INTO rank_history (account_id, rank_tier, leaderboard_rank)
           VALUES ($1, $2, $3)`,
          [f.accountId, profile.rank_tier, profile.leaderboard_rank ?? null]
        );
      }
      rank = ` · rank_tier=${profile?.rank_tier ?? 'none'}`;
    } catch { /* rank is optional for backfill */ }

    await query('UPDATE players SET seeded = TRUE WHERE account_id = $1', [f.accountId]);

    if (rows.length === 0) {
      console.log(
        `  ${f.name}: 0 matches returned. Check that "Expose Public Match Data" is ` +
        `enabled in their Dota 2 settings.`
      );
    } else {
      console.log(`  ${f.name}: fetched ${rows.length}, inserted ${inserted.length} new${rank}`);
    }
  } catch (err) {
    console.log(`  ${f.name}: FAILED — ${err.message}`);
  }
  await sleep(1200); // stay well under OpenDota's 60 req/min
}

const { rows: totals } = await query(
  `SELECT p.display_name, COUNT(m.*)::int AS matches
     FROM players p LEFT JOIN matches m USING (account_id)
    WHERE p.active GROUP BY p.display_name ORDER BY matches DESC`
);
console.log('\nStored match counts:');
for (const t of totals) console.log(`  ${t.display_name}: ${t.matches}`);

await closePool();
