import { DRY_RUN, loadFriends, requireEnv } from './config.js';
import {
  migrate, query, withLock, syncPlayers, claimPost, releasePost, closePool,
} from './db.js';
import { insertMatches, maxMatchId, activePlayers } from './matches.js';
import { getPlayerSummaries, classify, resolveState, isProfilePrivate } from './steam.js';
import { recentMatches, playerProfile, isAnnounceable } from './opendota.js';
import { currentStreak, roastFor, groupByMatch, STREAK_THRESHOLD } from './rules.js';
import * as discord from './discord.js';

// Stop re-checking a player ~50 minutes after they left a game. OpenDota normally lags
// 5-15 min; beyond this the match almost certainly isn't coming (private match data,
// or they quit the client without finishing a game).
const MAX_PENDING_ATTEMPTS = 10;

// Never announce a match that ended more than this long ago. Guards against a paused
// cron, a backlog, or a newly-added friend dumping days-old games into the channel.
// Such matches are still RECORDED (they count for the dashboard and leaderboards) —
// they're just not announced. Widen with MAX_MATCH_AGE_HOURS if your cron runs rarely.
const MAX_MATCH_AGE_SECONDS = (Number(process.env.MAX_MATCH_AGE_HOURS) || 6) * 60 * 60;

const RANK_REFRESH_MS = 24 * 60 * 60 * 1000;

const log = (...args) => console.log(new Date().toISOString(), ...args);

async function main() {
  requireEnv('STEAM_API_KEY', 'DATABASE_URL');
  if (!DRY_RUN) requireEnv('DISCORD_WEBHOOK_URL');

  const friends = loadFriends();
  await migrate();
  await syncPlayers(friends);

  const ran = await withLock(() => runOnce(friends));
  if (ran === null) log('Another run holds the lock; exiting cleanly.');
}

async function runOnce(friends) {
  const players = await activePlayers();
  const byAccount = new Map(players.map((p) => [p.account_id, p]));
  const embeds = [];

  await seedNewPlayers(players);
  await updatePresence(friends, byAccount);
  const newMatches = await drainPendingResults(byAccount);
  await announceMatches(newMatches, byAccount, embeds);
  await announceStreaks(newMatches, byAccount);
  await refreshRanks(players, embeds);

  if (embeds.length) await discord.sendEmbeds(embeds);
  log(`Done. ${newMatches.length} new match rows, ${embeds.length} embeds.`);
}

/**
 * Loads history for players we've never seen before, WITHOUT posting. This is what makes
 * adding a friend to the config safe mid-flight.
 */
async function seedNewPlayers(players) {
  for (const p of players) {
    if (p.seeded) continue;
    log(`Seeding history for ${p.display_name} (no posts)...`);
    try {
      const rows = await recentMatches(p.account_id);
      await insertMatches(p.account_id, rows);
      await query('UPDATE players SET seeded = TRUE WHERE account_id = $1', [p.account_id]);
      p.seeded = true;
      log(`  seeded ${rows.length} matches`);
    } catch (err) {
      log(`  ! seeding failed for ${p.display_name}: ${err.message}`);
    }
  }
}

async function updatePresence(friends, byAccount) {
  const summaries = await getPlayerSummaries(friends.map((f) => f.steamId64));

  // The lobby fields are undocumented, so we record whether Steam has EVER given us one.
  // Until it has, presence falls back to dwell time. See steam.js resolveState().
  const { rows: metaRows } = await query(
    `SELECT value FROM meta WHERE key = 'lobby_fields_seen'`
  );
  let lobbyFieldsAvailable = metaRows[0]?.value === '1';

  for (const f of friends) {
    const player = byAccount.get(f.accountId);
    if (!player) continue;

    const summary = summaries.get(f.steamId64);
    const { state: rawState, sawLobbyField } = classify(summary);

    if (sawLobbyField && !lobbyFieldsAvailable) {
      await query(
        `INSERT INTO meta (key, value) VALUES ('lobby_fields_seen', '1')
         ON CONFLICT (key) DO UPDATE SET value = '1', updated_at = now()`
      );
      lobbyFieldsAvailable = true;
      log('Steam lobby fields detected — using precise in-match detection.');
    }

    if (isProfilePrivate(summary) && !summary?.gameid) {
      log(`  note: ${f.name}'s Steam profile is not public; presence unavailable.`);
    }

    const { rows: prevRows } = await query(
      'SELECT state, consecutive_in_game FROM presence WHERE account_id = $1',
      [f.accountId]
    );
    const prev = prevRows[0] ?? { state: 'offline', consecutive_in_game: 0 };

    const inDota = rawState !== 'offline';
    const consecutive = inDota ? prev.consecutive_in_game + 1 : 0;
    const state = resolveState(rawState, consecutive, lobbyFieldsAvailable);

    if (state !== prev.state) {
      await query(
        `UPDATE presence
            SET state = $2, since = now(), last_seen = now(),
                consecutive_in_game = $3, raw = $4
          WHERE account_id = $1`,
        [f.accountId, state, consecutive, summary ? JSON.stringify(summary) : null]
      );
    } else {
      await query(
        `UPDATE presence SET last_seen = now(), consecutive_in_game = $2, raw = $3
          WHERE account_id = $1`,
        [f.accountId, consecutive, summary ? JSON.stringify(summary) : null]
      );
    }

    // Entered a match
    if (state === 'match' && prev.state !== 'match') {
      const key = `queue:${f.accountId}:${Math.floor(Date.now() / 60000)}`;
      if (await claimPost({ key, kind: 'queue', accountId: f.accountId })) {
        try {
          await discord.send(discord.queueMessage(player.display_name));
          log(`  ${f.name} entered a match`);
        } catch (err) {
          await releasePost(key);
          log(`  ! failed to post queue message for ${f.name}: ${err.message}`);
        }
      }
    }

    // Left a match -> queue up a result check
    if (state !== 'match' && prev.state === 'match') {
      const baseline = await maxMatchId(f.accountId);
      await query(
        `INSERT INTO pending_results (account_id, left_at, baseline_match_id, attempts)
         VALUES ($1, now(), $2, 0)
         ON CONFLICT (account_id) DO UPDATE
           SET left_at = now(), baseline_match_id = EXCLUDED.baseline_match_id, attempts = 0`,
        [f.accountId, baseline]
      );
      log(`  ${f.name} left a match; awaiting OpenDota (baseline ${baseline})`);
    }
  }
}

/**
 * The retry queue. OpenDota only sees a match some minutes after it ends, so we keep
 * re-checking each departed player until a newer match_id appears or we give up.
 * This is the only place that calls OpenDota during normal operation.
 */
async function drainPendingResults(byAccount) {
  const { rows: pending } = await query('SELECT * FROM pending_results ORDER BY left_at');
  const newMatches = [];

  for (const row of pending) {
    const player = byAccount.get(row.account_id);
    if (!player) {
      await query('DELETE FROM pending_results WHERE account_id = $1', [row.account_id]);
      continue;
    }

    let fetched;
    try {
      fetched = await recentMatches(row.account_id);
    } catch (err) {
      log(`  ! OpenDota failed for ${player.display_name}: ${err.message}`);
      await query(
        `UPDATE pending_results SET attempts = attempts + 1, last_attempt_at = now()
          WHERE account_id = $1`,
        [row.account_id]
      );
      continue;
    }

    const fresh = fetched.filter((m) => m.match_id > row.baseline_match_id);
    if (fresh.length > 0) {
      const inserted = await insertMatches(row.account_id, fresh);
      newMatches.push(...inserted.map((m) => ({ match: m, player })));
      await query('DELETE FROM pending_results WHERE account_id = $1', [row.account_id]);
      log(`  recorded ${inserted.length} match(es) for ${player.display_name}`);
    } else if (row.attempts + 1 >= MAX_PENDING_ATTEMPTS) {
      await query('DELETE FROM pending_results WHERE account_id = $1', [row.account_id]);
      log(`  gave up waiting on a result for ${player.display_name}`);
    } else {
      await query(
        `UPDATE pending_results SET attempts = attempts + 1, last_attempt_at = now()
          WHERE account_id = $1`,
        [row.account_id]
      );
    }
  }
  return newMatches;
}

async function announceMatches(newMatches, byAccount, embeds) {
  const nowSec = Math.floor(Date.now() / 1000);
  const announceable = newMatches.filter(({ match }) => {
    if (!isAnnounceable(match)) return false;
    return nowSec - (match.start_time + match.duration) <= MAX_MATCH_AGE_SECONDS;
  });

  const { solo, stacks } = groupByMatch(announceable);

  for (const group of stacks) {
    const matchId = group[0].match.match_id;
    const key = `stack:${matchId}`;
    if (!(await claimPost({ key, kind: 'stack', matchId }))) continue;
    embeds.push(discord.stackEmbed(group[0].match, group));
    // A stack post covers everyone in it, so claim their solo keys too.
    for (const { match, player } of group) {
      await claimPost({
        key: `result:${player.account_id}:${match.match_id}`,
        kind: 'result',
        accountId: player.account_id,
        matchId: match.match_id,
      });
    }
  }

  for (const { match, player } of solo) {
    const key = `result:${player.account_id}:${match.match_id}`;
    if (!(await claimPost({ key, kind: 'result', accountId: player.account_id, matchId: match.match_id }))) {
      continue;
    }
    embeds.push(discord.matchEmbed(match, player));
  }

  // Roasts ride along as plain text after the embeds.
  for (const { match, player } of announceable) {
    const roast = roastFor(match, player.display_name);
    if (!roast) continue;
    const key = `roast:${player.account_id}:${match.match_id}`;
    if (!(await claimPost({ key, kind: 'roast', accountId: player.account_id, matchId: match.match_id }))) {
      continue;
    }
    try {
      await discord.send({ content: roast });
    } catch (err) {
      await releasePost(key);
      log(`  ! roast post failed: ${err.message}`);
    }
  }
}

async function announceStreaks(newMatches, byAccount) {
  const touched = new Set(newMatches.map(({ player }) => player.account_id));
  for (const accountId of touched) {
    const player = byAccount.get(accountId);
    const streak = await currentStreak(accountId);
    if (!streak || streak.count < STREAK_THRESHOLD) continue;

    const key = `streak:${accountId}:${streak.won ? 'w' : 'l'}:${streak.count}`;
    if (!(await claimPost({ key, kind: 'streak', accountId }))) continue;
    try {
      await discord.send(discord.streakMessage(player.display_name, streak.count, streak.won));
    } catch (err) {
      await releasePost(key);
      log(`  ! streak post failed: ${err.message}`);
    }
  }
}

/** Once per day per player: refresh medal, post on change, and keep a history row. */
async function refreshRanks(players, embeds) {
  const now = Date.now();
  for (const p of players) {
    const checked = p.rank_checked_at ? new Date(p.rank_checked_at).getTime() : 0;
    if (now - checked < RANK_REFRESH_MS) continue;

    let profile;
    try {
      profile = await playerProfile(p.account_id);
    } catch (err) {
      log(`  ! rank fetch failed for ${p.display_name}: ${err.message}`);
      continue;
    }

    const newTier = profile?.rank_tier ?? null;
    const newBoard = profile?.leaderboard_rank ?? null;
    const avatar = profile?.profile?.avatarfull ?? p.avatar_url;

    await query(
      `UPDATE players
          SET rank_tier = $2, leaderboard_rank = $3, avatar_url = $4, rank_checked_at = now()
        WHERE account_id = $1`,
      [p.account_id, newTier, newBoard, avatar]
    );
    await query(
      'INSERT INTO rank_history (account_id, rank_tier, leaderboard_rank) VALUES ($1, $2, $3)',
      [p.account_id, newTier, newBoard]
    );

    // Only announce a genuine change, and never the very first reading (nothing to compare).
    if (p.rank_tier != null && newTier != null && newTier !== p.rank_tier) {
      const key = `rank:${p.account_id}:${p.rank_tier}:${newTier}:${new Date().toISOString().slice(0, 10)}`;
      if (await claimPost({ key, kind: 'rank', accountId: p.account_id })) {
        embeds.push(discord.rankEmbed(p, p.rank_tier, newTier, newBoard));
      }
    }
  }
}

main()
  .catch((err) => {
    console.error('FATAL:', err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
