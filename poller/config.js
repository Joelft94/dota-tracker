import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader so local runs don't need a dependency. Real env always wins,
// which keeps GitHub Actions secrets authoritative over any stray local file.
function loadDotEnv() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val && process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

// SteamID64 -> 32-bit Dota account_id
const STEAM64_BASE = 76561197960265728n;
export function toAccountId(steamId64) {
  return Number(BigInt(String(steamId64).trim()) - STEAM64_BASE);
}
export function toSteamId64(accountId) {
  return String(BigInt(accountId) + STEAM64_BASE);
}

export function loadFriends() {
  let raw;
  if (process.env.FRIENDS_JSON) {
    raw = process.env.FRIENDS_JSON;
  } else {
    const path = join(ROOT, 'friends.json');
    if (!existsSync(path)) {
      throw new Error(
        'No friends list found. Copy friends.example.json to friends.json, or set FRIENDS_JSON.'
      );
    }
    raw = readFileSync(path, 'utf8');
  }

  let list;
  try {
    list = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Friends list is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('Friends list must be a non-empty JSON array.');
  }

  return list.map((f, i) => {
    if (!f.steam_id64) throw new Error(`friends[${i}] is missing "steam_id64"`);
    const steamId64 = String(f.steam_id64).trim();
    if (!/^\d{17}$/.test(steamId64)) {
      throw new Error(
        `friends[${i}].steam_id64 "${steamId64}" is not a 17-digit SteamID64. ` +
          'Use the 64-bit ID from the profile URL, not the vanity name.'
      );
    }
    const accountId = toAccountId(steamId64);
    if (accountId <= 0) throw new Error(`friends[${i}].steam_id64 "${steamId64}" is out of range`);
    return { steamId64, accountId, name: f.name || `Player ${accountId}` };
  });
}

export function requireEnv(...keys) {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }
}

export const DRY_RUN = process.argv.includes('--dry-run');

const heroesPath = join(ROOT, 'poller', 'heroes.json');
export const HEROES = JSON.parse(readFileSync(heroesPath, 'utf8'));

export function heroName(heroId) {
  return HEROES[heroId]?.name ?? `Hero #${heroId}`;
}

export function heroImage(heroId) {
  const img = HEROES[heroId]?.img;
  return img ? `https://cdn.cloudflare.steamstatic.com${img}` : null;
}

// rank_tier is a two-digit code: tens = medal, ones = star.
const MEDALS = ['Uncalibrated', 'Herald', 'Guardian', 'Crusader', 'Archon', 'Legend', 'Ancient', 'Divine', 'Immortal'];
export function rankName(rankTier, leaderboardRank) {
  if (!rankTier) return 'Uncalibrated';
  const medal = Math.floor(rankTier / 10);
  const star = rankTier % 10;
  const label = MEDALS[medal] ?? 'Unknown';
  if (medal === 8) return leaderboardRank ? `Immortal #${leaderboardRank}` : 'Immortal';
  return star ? `${label} ${star}` : label;
}
