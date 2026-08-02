import { fetchJson } from './http.js';

const DOTA_APPID = '570';
const BATCH = 100; // Steam's documented max SteamIDs per GetPlayerSummaries call

// Overridable so the presence pipeline can be exercised against a stub. Leave unset in
// production and it points at Steam.
const API_BASE = process.env.STEAM_API_BASE || 'https://api.steampowered.com';

/**
 * Fetches presence for every friend. Steam allows 100 IDs per request, so a whole
 * friend group costs a single call — this is what keeps us far inside the API quota
 * and lets us poll every 5 minutes without touching OpenDota.
 *
 * Returns Map<steamId64, summary>. SteamIDs absent from the response (private profiles)
 * simply won't be keys.
 */
export async function getPlayerSummaries(steamIds) {
  const key = process.env.STEAM_API_KEY;
  const out = new Map();

  for (let i = 0; i < steamIds.length; i += BATCH) {
    const chunk = steamIds.slice(i, i + BATCH);
    const url =
      `${API_BASE}/ISteamUser/GetPlayerSummaries/v2/` +
      `?key=${encodeURIComponent(key)}&steamids=${chunk.join(',')}`;
    const data = await fetchJson(url);
    for (const p of data?.response?.players ?? []) {
      out.set(String(p.steamid), p);
    }
  }
  return out;
}

/**
 * Classifies a Steam summary into 'offline' | 'menu' | 'match'.
 *
 * `lobbysteamid` / `gameserversteamid` are returned by Steam in practice but are NOT in
 * Valve's published GetPlayerSummaries spec, so we never rely on them alone — see
 * resolveState() for the dwell-time fallback that covers the case where they never show up.
 */
export function classify(summary) {
  if (!summary || String(summary.gameid) !== DOTA_APPID) {
    return { state: 'offline', sawLobbyField: false };
  }
  const sawLobbyField = Boolean(summary.lobbysteamid || summary.gameserversteamid);
  return { state: sawLobbyField ? 'match' : 'menu', sawLobbyField };
}

/**
 * Applies the fallback. If Steam has never once given us a lobby field for anyone, the
 * undocumented fields aren't available on this account/region — so instead treat "in the
 * Dota client for >= DWELL_POLLS consecutive polls" as being in a match. At a 5-minute
 * cadence that's ~10 minutes of continuous presence, which filters out shop/replay browsing.
 */
export const DWELL_POLLS = 2;

export function resolveState(rawState, consecutiveInGame, lobbyFieldsAvailable) {
  if (rawState !== 'menu') return rawState;
  if (lobbyFieldsAvailable) return 'menu';
  return consecutiveInGame >= DWELL_POLLS ? 'match' : 'menu';
}

/** True when the profile is too locked down for us to see game activity. */
export function isProfilePrivate(summary) {
  return !summary || summary.communityvisibilitystate !== 3;
}
