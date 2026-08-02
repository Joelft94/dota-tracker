import Link from 'next/link';
import { leaderboard, recentResults, computeStreaks, recentMatches } from '../lib/db';
import {
  heroName, heroImage, fmtDuration, rankName, winRate, kda, timeAgo, modeName,
} from '../lib/format';

export const revalidate = 60;

export default async function Home() {
  let players = [];
  let streaks = new Map();
  let feed = [];
  let error = null;

  try {
    const [lb, results, matches] = await Promise.all([
      leaderboard(),
      recentResults(),
      recentMatches(30),
    ]);
    players = lb;
    streaks = computeStreaks(results);
    feed = matches;
  } catch (err) {
    error = err.message;
  }

  const totalGames = players.reduce((a, p) => a + p.games, 0);

  return (
    <>
      <header className="top">
        <h1>Dota <span>Tracker</span></h1>
        <p>Match history and leaderboards for the crew · updates every few minutes</p>
      </header>

      {error && (
        <div className="card">
          <div className="empty">
            Could not reach the database.<br />
            <span className="muted">{error}</span>
          </div>
        </div>
      )}

      {!error && totalGames === 0 && (
        <div className="card">
          <div className="empty">
            No matches recorded yet.<br />
            Run <code>npm run backfill</code> to load history, or wait for the poller to
            pick up the next game.
          </div>
        </div>
      )}

      {totalGames > 0 && (
        <>
          <div className="stats">
            <Stat label="Players" value={players.filter((p) => p.games > 0).length} />
            <Stat label="Matches tracked" value={totalGames.toLocaleString('en-GB')} />
            <Stat
              label="Group win rate"
              value={`${winRate(players.reduce((a, p) => a + p.wins, 0), totalGames)}%`}
            />
            <Stat
              label="Hours played"
              value={Math.round(
                players.reduce((a, p) => a + Number(p.seconds), 0) / 3600
              ).toLocaleString('en-GB')}
            />
          </div>

          <h2>Leaderboard</h2>
          <div className="card scroll">
            <table>
              <thead>
                <tr>
                  <th>Player</th>
                  <th className="num">Games</th>
                  <th className="num">W / L</th>
                  <th className="num">Win %</th>
                  <th className="num">Avg K/D/A</th>
                  <th className="num">KDA</th>
                  <th className="num">GPM</th>
                  <th className="num">LH</th>
                  <th>Streak</th>
                </tr>
              </thead>
              <tbody>
                {players.map((p) => {
                  const wr = winRate(p.wins, p.games);
                  const s = streaks.get(p.account_id);
                  return (
                    <tr key={p.account_id}>
                      <td>
                        <Link href={`/player/${p.account_id}`} className="player-cell">
                          {/* A background image degrades to the placeholder colour when the
                              URL is missing or dead, unlike <img> which shows a broken icon. */}
                          <span
                            className="avatar"
                            style={
                              p.avatar_url ? { backgroundImage: `url(${p.avatar_url})` } : undefined
                            }
                          />
                          <span>
                            {p.display_name}
                            {rankName(p.rank_tier, p.leaderboard_rank) && (
                              <span className="rank">
                                {rankName(p.rank_tier, p.leaderboard_rank)}
                              </span>
                            )}
                          </span>
                        </Link>
                      </td>
                      <td className="num">{p.games}</td>
                      {p.games === 0 ? (
                        // Nothing recorded yet — zeroes would read as "lost every game".
                        <td className="num muted" colSpan={6}>
                          no matches yet
                        </td>
                      ) : (
                        <>
                          <td className="num">
                            <span className="win">{p.wins}</span>
                            <span className="muted"> / </span>
                            <span className="loss">{p.games - p.wins}</span>
                          </td>
                          <td className="num">
                            {wr}%
                            <div className="bar"><i style={{ width: `${wr}%` }} /></div>
                          </td>
                          <td className="num muted">
                            {p.avg_kills} / {p.avg_deaths} / {p.avg_assists}
                          </td>
                          <td className="num">{kda(p)}</td>
                          <td className="num muted">{p.avg_gpm}</td>
                          <td className="num muted">{p.avg_lh}</td>
                        </>
                      )}
                      <td>
                        {s && s.count >= 2 ? (
                          <span className={`pill ${s.won ? 'w' : 'l'}`}>
                            {s.count}{s.won ? 'W' : 'L'}
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <h2>Recent matches</h2>
          <div className="card scroll">
            <table>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Hero</th>
                  <th>Result</th>
                  <th className="num">K/D/A</th>
                  <th className="num">GPM</th>
                  <th className="num">Length</th>
                  <th>Mode</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {feed.map((m) => (
                  <tr key={`${m.match_id}-${m.account_id}`}>
                    <td>
                      <Link href={`/player/${m.account_id}`}>{m.display_name}</Link>
                    </td>
                    <td>
                      <span className="hero-cell">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img className="hero-img" src={heroImage(m.hero_id) || undefined} alt="" />
                        {heroName(m.hero_id)}
                      </span>
                    </td>
                    <td>
                      <a
                        href={`https://www.opendota.com/matches/${m.match_id}`}
                        target="_blank"
                        rel="noreferrer"
                        className={m.won ? 'win' : 'loss'}
                      >
                        {m.won ? 'Win' : 'Loss'}
                      </a>
                    </td>
                    <td className="num">{m.kills}/{m.deaths}/{m.assists}</td>
                    <td className="num muted">{m.gold_per_min ?? '—'}</td>
                    <td className="num muted">{fmtDuration(m.duration)}</td>
                    <td className="muted">{modeName(m)}</td>
                    <td className="muted">{timeAgo(Number(m.start_time))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="foot">Data from OpenDota &amp; Steam · refreshed every 60s</p>
    </>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
