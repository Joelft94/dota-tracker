import Link from 'next/link';
import { notFound } from 'next/navigation';
import { playerById, playerMatches, playerHeroes, rankHistory } from '../../../lib/db';
import {
  heroName, heroImage, fmtDuration, rankName, winRate, kda, timeAgo, modeName,
} from '../../../lib/format';

export const revalidate = 60;

export default async function PlayerPage({ params }) {
  const { id } = await params;
  const accountId = Number(id);
  if (!Number.isFinite(accountId)) notFound();

  const player = await playerById(accountId);
  if (!player) notFound();

  const [matches, heroes, ranks] = await Promise.all([
    playerMatches(accountId, 50),
    playerHeroes(accountId, 12),
    rankHistory(accountId),
  ]);

  const wins = matches.filter((m) => m.won).length;
  const medal = rankName(player.rank_tier, player.leaderboard_rank);

  const totals = matches.reduce(
    (a, m) => ({
      kills: a.kills + m.kills,
      deaths: a.deaths + m.deaths,
      assists: a.assists + m.assists,
      seconds: a.seconds + m.duration,
    }),
    { kills: 0, deaths: 0, assists: 0, seconds: 0 }
  );
  const n = matches.length || 1;

  return (
    <>
      <Link href="/" className="back">← Leaderboard</Link>

      <header className="top">
        <h1>{player.display_name}</h1>
        <p>
          account_id {player.account_id}
          {medal ? ` · ${medal}` : ''} ·{' '}
          <a
            href={`https://www.opendota.com/players/${player.account_id}`}
            target="_blank"
            rel="noreferrer"
          >
            OpenDota profile
          </a>
        </p>
      </header>

      {matches.length === 0 ? (
        <div className="card">
          <div className="empty">
            No matches stored for this player yet.<br />
            Make sure <strong>Expose Public Match Data</strong> is enabled in their Dota 2
            settings, then run <code>npm run backfill</code>.
          </div>
        </div>
      ) : (
        <>
          <div className="stats">
            <Stat label={`Last ${matches.length} games`} value={`${wins}W ${matches.length - wins}L`} />
            <Stat label="Win rate" value={`${winRate(wins, matches.length)}%`} />
            <Stat
              label="Avg KDA"
              value={kda({
                avg_kills: totals.kills / n,
                avg_deaths: totals.deaths / n,
                avg_assists: totals.assists / n,
              })}
            />
            <Stat label="Hours" value={(totals.seconds / 3600).toFixed(1)} />
          </div>

          <h2>Hero pool</h2>
          <div className="card scroll">
            <table>
              <thead>
                <tr>
                  <th>Hero</th>
                  <th className="num">Games</th>
                  <th className="num">Win %</th>
                  <th className="num">Avg K/D/A</th>
                </tr>
              </thead>
              <tbody>
                {heroes.map((h) => (
                  <tr key={h.hero_id}>
                    <td>
                      <span className="hero-cell">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img className="hero-img" src={heroImage(h.hero_id) || undefined} alt="" />
                        {heroName(h.hero_id)}
                      </span>
                    </td>
                    <td className="num">{h.games}</td>
                    <td className="num">{winRate(h.wins, h.games)}%</td>
                    <td className="num muted">
                      {h.avg_kills} / {h.avg_deaths} / {h.avg_assists}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {ranks.length > 1 && (
            <>
              <h2>Rank history</h2>
              <div className="card scroll">
                <table>
                  <thead>
                    <tr><th>Date</th><th>Medal</th></tr>
                  </thead>
                  <tbody>
                    {dedupeRanks(ranks).map((r, i) => (
                      <tr key={i}>
                        <td className="muted">
                          {new Date(r.recorded_at).toLocaleDateString('en-GB', {
                            day: 'numeric', month: 'short', year: 'numeric',
                          })}
                        </td>
                        <td>{rankName(r.rank_tier, r.leaderboard_rank)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <h2>Match history</h2>
          <div className="card scroll">
            <table>
              <thead>
                <tr>
                  <th>Hero</th>
                  <th>Result</th>
                  <th className="num">K/D/A</th>
                  <th className="num">GPM / XPM</th>
                  <th className="num">LH</th>
                  <th className="num">Length</th>
                  <th>Mode</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((m) => (
                  <tr key={m.match_id}>
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
                    <td className="num muted">
                      {m.gold_per_min ?? '—'} / {m.xp_per_min ?? '—'}
                    </td>
                    <td className="num muted">{m.last_hits ?? '—'}</td>
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

      <p className="foot">Data from OpenDota &amp; Steam</p>
    </>
  );
}

/** The poller records a rank row daily; only the changes are interesting. */
function dedupeRanks(rows) {
  const out = [];
  let last = null;
  for (const r of rows) {
    if (r.rank_tier !== last) out.push(r);
    last = r.rank_tier;
  }
  return out;
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
