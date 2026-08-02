import HEROES from './heroes.json';

export function heroName(id) {
  return HEROES[id]?.name ?? `Hero #${id}`;
}

export function heroImage(id) {
  const img = HEROES[id]?.img;
  return img ? `https://cdn.cloudflare.steamstatic.com${img}` : null;
}

export function fmtDuration(seconds) {
  const m = Math.floor((seconds ?? 0) / 60);
  const s = (seconds ?? 0) % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const MEDALS = ['Uncalibrated', 'Herald', 'Guardian', 'Crusader', 'Archon', 'Legend', 'Ancient', 'Divine', 'Immortal'];

export function rankName(rankTier, leaderboardRank) {
  if (!rankTier) return null;
  const medal = Math.floor(rankTier / 10);
  const star = rankTier % 10;
  const label = MEDALS[medal] ?? 'Unknown';
  if (medal === 8) return leaderboardRank ? `Immortal #${leaderboardRank}` : 'Immortal';
  return star ? `${label} ${star}` : label;
}

export function winRate(wins, games) {
  return games > 0 ? Math.round((wins / games) * 1000) / 10 : 0;
}

export function kda({ avg_kills, avg_deaths, avg_assists }) {
  const d = avg_deaths === 0 ? 1 : avg_deaths;
  return ((avg_kills + avg_assists) / d).toFixed(2);
}

export function timeAgo(epochSeconds) {
  const diff = Math.floor(Date.now() / 1000) - epochSeconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(epochSeconds * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export const MODES = {
  1: 'All Pick', 2: "Captain's Mode", 3: 'Random Draft', 4: 'Single Draft', 5: 'All Random',
  12: 'Least Played', 16: "Captain's Draft", 18: 'Ability Draft', 22: 'All Pick', 23: 'Turbo',
};

export function modeName(m) {
  const base = MODES[m.game_mode] ?? 'Unknown';
  return m.lobby_type === 7 ? `Ranked ${base}` : base;
}
