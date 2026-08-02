import { fetchJson } from './http.js';

const BASE = 'https://api.opendota.com/api';

// The free tier is ~50k calls/month. We only ever call this when a player LEAVES a game
// (plus a once-daily rank refresh), which keeps usage to dozens of calls/day regardless
// of how many friends are tracked.
function withKey(path) {
  const key = process.env.OPENDOTA_API_KEY;
  if (!key) return `${BASE}${path}`;
  return `${BASE}${path}${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}`;
}

/** Last ~20 matches, including the extended stats we store. */
export async function recentMatches(accountId) {
  const rows = await fetchJson(withKey(`/players/${accountId}/recentMatches`));
  return Array.isArray(rows) ? rows.map(normalize) : [];
}

// `project` REPLACES the default field set rather than adding to it, so every column we
// persist has to be named here explicitly.
const PROJECTION = [
  'hero_id',
  'start_time',
  'kills',
  'deaths',
  'assists',
  'party_size',
  'leaver_status',
  'gold_per_min',
  'xp_per_min',
  'hero_damage',
  'tower_damage',
  'hero_healing',
  'last_hits',
]
  .map((f) => `project=${f}`)
  .join('&');

/** Deeper history for the one-time backfill. */
export async function matchHistory(accountId, limit = 100) {
  const rows = await fetchJson(withKey(`/players/${accountId}/matches?limit=${limit}&${PROJECTION}`));
  return Array.isArray(rows) ? rows.map(normalize) : [];
}

export async function playerProfile(accountId) {
  return fetchJson(withKey(`/players/${accountId}`));
}

/** player_slot < 128 means Radiant; a win is "my side won". */
export function didWin(row) {
  const isRadiant = row.player_slot < 128;
  return isRadiant === Boolean(row.radiant_win);
}

function normalize(row) {
  return {
    match_id: Number(row.match_id),
    account_id: null, // filled in by the caller
    hero_id: row.hero_id ?? 0,
    won: didWin(row),
    kills: row.kills ?? 0,
    deaths: row.deaths ?? 0,
    assists: row.assists ?? 0,
    duration: row.duration ?? 0,
    game_mode: row.game_mode ?? null,
    lobby_type: row.lobby_type ?? null,
    gold_per_min: row.gold_per_min ?? null,
    xp_per_min: row.xp_per_min ?? null,
    hero_damage: row.hero_damage ?? null,
    tower_damage: row.tower_damage ?? null,
    hero_healing: row.hero_healing ?? null,
    last_hits: row.last_hits ?? null,
    party_size: row.party_size ?? null,
    leaver_status: row.leaver_status ?? null,
    player_slot: row.player_slot ?? null,
    radiant_win: row.radiant_win ?? null,
    start_time: Number(row.start_time ?? 0),
  };
}

// Lobby types worth announcing. 0 = unranked matchmaking, 7 = ranked. Everything else
// (bot games, custom games, tutorials, event modes) is noise for a friend-group feed.
const ANNOUNCEABLE_LOBBIES = new Set([0, 7]);

export function isAnnounceable(match) {
  return match.lobby_type === null || ANNOUNCEABLE_LOBBIES.has(match.lobby_type);
}

export const GAME_MODES = {
  1: 'All Pick',
  2: "Captain's Mode",
  3: 'Random Draft',
  4: 'Single Draft',
  5: 'All Random',
  12: 'Least Played',
  16: "Captain's Draft",
  18: 'Ability Draft',
  22: 'All Pick',
  23: 'Turbo',
};

export function modeName(match) {
  const base = GAME_MODES[match.game_mode] ?? 'Unknown';
  return match.lobby_type === 7 ? `Ranked ${base}` : base;
}
