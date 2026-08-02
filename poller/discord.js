import { sleep } from './http.js';
import { DRY_RUN, heroName, heroImage, rankName } from './config.js';
import { modeName } from './opendota.js';

const GREEN = 0x2ecc71;
const RED = 0xe74c3c;
const BLURPLE = 0x5865f2;
const GOLD = 0xf1c40f;

const MAX_EMBEDS_PER_MESSAGE = 10; // Discord's hard limit

export function fmtDuration(seconds) {
  const m = Math.floor((seconds ?? 0) / 60);
  const s = (seconds ?? 0) % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function kdaRatio({ kills, deaths, assists }) {
  const d = deaths === 0 ? 1 : deaths;
  return ((kills + assists) / d).toFixed(2);
}

function odLink(matchId) {
  return `https://www.opendota.com/matches/${matchId}`;
}

/** Match end, not match start — what people actually want to see on the post. */
function endedAt(match) {
  return new Date((match.start_time + match.duration) * 1000).toISOString();
}

export function queueMessage(playerName) {
  return { content: `🎮 **${playerName}** just queued into a match` };
}

export function matchEmbed(match, player) {
  return {
    title: `${heroName(match.hero_id)} — ${match.won ? 'Victory' : 'Defeat'}`,
    url: odLink(match.match_id),
    color: match.won ? GREEN : RED,
    author: { name: player.display_name, icon_url: player.avatar_url || undefined },
    thumbnail: heroImage(match.hero_id) ? { url: heroImage(match.hero_id) } : undefined,
    fields: [
      { name: 'K/D/A', value: `${match.kills}/${match.deaths}/${match.assists}`, inline: true },
      { name: 'KDA', value: kdaRatio(match), inline: true },
      { name: 'Duration', value: fmtDuration(match.duration), inline: true },
      { name: 'GPM / XPM', value: `${match.gold_per_min ?? '—'} / ${match.xp_per_min ?? '—'}`, inline: true },
      { name: 'Last Hits', value: String(match.last_hits ?? '—'), inline: true },
      { name: 'Hero DMG', value: (match.hero_damage ?? 0).toLocaleString('en-US'), inline: true },
    ],
    footer: { text: modeName(match) },
    timestamp: endedAt(match),
  };
}

/** One embed for a match several tracked friends played together. */
export function stackEmbed(match, entries) {
  const won = entries[0].match.won;
  return {
    title: `${entries.length}-stack — ${won ? 'Victory' : 'Defeat'}`,
    url: odLink(match.match_id),
    color: won ? GREEN : RED,
    fields: entries.map(({ match: m, player }) => ({
      name: `${player.display_name} — ${heroName(m.hero_id)}`,
      value:
        `${m.kills}/${m.deaths}/${m.assists} · ${m.gold_per_min ?? '—'} GPM · ` +
        `${m.last_hits ?? '—'} LH`,
      inline: false,
    })),
    footer: { text: `${modeName(match)} · ${fmtDuration(match.duration)}` },
    timestamp: endedAt(match),
  };
}

export function streakMessage(playerName, count, won) {
  return won
    ? { content: `🔥 **${playerName}** is on a **${count}-win streak**` }
    : { content: `💀 **${playerName}** has lost **${count} in a row**. Maybe take a break?` };
}

export function rankEmbed(player, oldTier, newTier, newLeaderboard) {
  const up = (newTier ?? 0) > (oldTier ?? 0);
  return {
    title: up ? '📈 Rank up!' : '📉 Rank down',
    color: up ? GOLD : RED,
    author: { name: player.display_name, icon_url: player.avatar_url || undefined },
    description: `${rankName(oldTier)} → **${rankName(newTier, newLeaderboard)}**`,
    timestamp: new Date().toISOString(),
  };
}

export function recapEmbed(stats, since) {
  const fields = [];
  const add = (name, entry, fmt) => {
    if (entry) fields.push({ name, value: fmt(entry), inline: true });
  };

  add('🎮 Most games', stats.mostGames, (e) => `${e.name} — ${e.games}`);
  add('👑 Best win rate', stats.bestWinRate, (e) => `${e.name} — ${e.win_rate}% (${e.games})`);
  add('🪫 Worst win rate', stats.worstWinRate, (e) => `${e.name} — ${e.win_rate}% (${e.games})`);
  add('⚔️ Top fragger', stats.topFragger, (e) => `${e.name} — ${e.kills} kills`);
  add('💀 Most deaths', stats.mostDeaths, (e) => `${e.name} — ${e.deaths} deaths`);
  add('🦸 Hero of the week', stats.topHero, (e) => `${heroName(e.hero_id)} — ${e.games} games`);
  add('🌱 Touch grass award', stats.touchGrass, (e) => `${e.name} — ${e.hours}h played`);

  return {
    title: '📊 Weekly Dota Recap',
    color: BLURPLE,
    description:
      stats.totalMatches > 0
        ? `**${stats.totalMatches}** matches played since <t:${Math.floor(since / 1000)}:D>`
        : 'Nobody played a single game this week. Suspicious.',
    fields,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Sends one webhook payload. Honours Discord's 429 retry_after (which is in seconds and
 * can be fractional). Returns true on success.
 *
 * In --dry-run the payload is printed instead of sent, so the whole pipeline can be
 * exercised end-to-end without touching the real channel.
 */
export async function send(payload, { retries = 3 } = {}) {
  if (DRY_RUN) {
    console.log('\n─── DISCORD (dry-run) ───');
    console.log(JSON.stringify(payload, null, 2));
    return true;
  }

  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) throw new Error('DISCORD_WEBHOOK_URL is not set');

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.status === 204 || res.ok) return true;

    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const waitMs = Math.min((body.retry_after ?? 1) * 1000, 15000);
      await sleep(waitMs);
      continue;
    }
    if (res.status >= 500) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const text = await res.text().catch(() => '');
    throw new Error(`Discord webhook failed: ${res.status} ${text.slice(0, 300)}`);
  }
  throw new Error('Discord webhook failed after retries');
}

/** Sends embeds in chunks of 10, pacing slightly to stay clear of the webhook rate limit. */
export async function sendEmbeds(embeds) {
  for (let i = 0; i < embeds.length; i += MAX_EMBEDS_PER_MESSAGE) {
    await send({ embeds: embeds.slice(i, i + MAX_EMBEDS_PER_MESSAGE) });
    if (i + MAX_EMBEDS_PER_MESSAGE < embeds.length) await sleep(600);
  }
}
