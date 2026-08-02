# Dota Tracker

Tracks a small group of friends' Dota 2 activity, posts to a **Discord webhook**, and serves a
**web dashboard** with leaderboards.

- 🎮 Posts when someone enters a match
- 🏆 Posts a rich embed when a match ends — hero, W/L, KDA, GPM/XPM, last hits, duration
- 👥 Collapses games several friends played together into a single "stack" post
- 🔥 Win/loss streak callouts and automatic roasts for spectacular performances
- 📊 Weekly recap: most games, best/worst win rate, top fragger, "touch grass" award
- 📈 Rank-up / rank-down alerts and medal history
- 🌐 Next.js dashboard on Vercel reading the same database

No Discord bot token needed — just a webhook URL. Runs as a scheduled GitHub Action, so there's
no server to keep alive.

---

## How it works

```
GitHub Actions (cron */5)          Neon Postgres          Vercel (Next.js)
  poller/index.js  ──write──────>  players / matches  <──read──  dashboard
        │                          presence / posts
        └──> Discord webhook       rank_history
```

Each run does one batched Steam call for **all** friends at once, and only touches OpenDota when
someone actually finishes a game.

**Why it's built this way** — the two constraints that shaped the design:

- **OpenDota's free tier is ~50k calls/month.** Polling every friend every 5 minutes would be
  `288 runs/day × N friends` and breaks the quota at around 6 friends. Steam's
  `GetPlayerSummaries` accepts **100 SteamIDs per call** with a 100k/day limit, so presence
  costs one call per run no matter how many friends you track. OpenDota is only called when a
  player leaves a game — dozens of calls a day, not thousands.
- **OpenDota lags 5–15 minutes behind a match ending.** Checking once at logout silently drops
  matches, so departures go into a `pending_results` retry queue that re-checks each run for up
  to ~50 minutes.

Every Discord post claims a unique key in a `posts` table before sending, so **double-posting is
impossible** even if a run is retried, duplicated, or overlaps another.

---

## Setup

### 1. Steam Web API key

Go to **https://steamcommunity.com/dev/apikey**, sign in, enter any domain name (e.g. `localhost`),
and copy the key. This is your `STEAM_API_KEY`.

### 2. Find each friend's SteamID64

Open their Steam profile. If the URL looks like
`steamcommunity.com/profiles/76561198046011640`, the 17-digit number **is** the SteamID64.

If it's a custom URL (`steamcommunity.com/id/someone`), paste it into
**https://steamid.io** and copy the value labelled `steamID64`.

You don't need the 32-bit `account_id` — the tracker derives it
(`account_id = steamID64 − 76561197960265728`).

### 3. Two Dota/Steam settings each friend MUST enable

This is where setup usually goes wrong:

| Setting | Where | Why |
| --- | --- | --- |
| **Expose Public Match Data** | Dota 2 → Settings → Options → Advanced Options | Without it OpenDota can't see their matches at all, so **no results are ever posted**. |
| **Profile + Game details = Public** | Steam profile → Edit Profile → Privacy Settings | Without it the "entered a match" alert never fires. |

If `npm run backfill` reports `0 matches returned` for someone, it's almost always the first one.

### 4. Discord webhook

In your Discord server: **Channel Settings → Integrations → Webhooks → New Webhook**, pick the
channel, then **Copy Webhook URL**. That's your `DISCORD_WEBHOOK_URL`.

### 5. Neon database

Create a free project at **https://neon.tech**, then copy the **pooled** connection string (the
host ends in `-pooler`). That's your `DATABASE_URL`.

### 6. Local setup

```bash
npm install
cp .env.example .env              # fill in the three values
cp friends.example.json friends.json
```

`friends.json` — one entry per person:

```json
[
  { "steam_id64": "76561198046011640", "name": "Joel" },
  { "steam_id64": "76561198000000000", "name": "Someone Else" }
]
```

Then create the schema and load history so the dashboard isn't empty on day one:

```bash
npm run migrate     # creates tables, syncs the friends list
npm run backfill    # pulls up to 100 past matches per player — posts nothing
```

Check it works **without** spamming your channel:

```bash
npm run poll:dry    # prints the Discord payloads instead of sending them
```

When that looks right, run it for real:

```bash
npm run poll
```

### 7. GitHub Actions

Push to a repo, then add these under **Settings → Secrets and variables → Actions**:

| Secret | Required | Notes |
| --- | --- | --- |
| `STEAM_API_KEY` | yes | From step 1 |
| `DISCORD_WEBHOOK_URL` | yes | From step 4 |
| `DATABASE_URL` | yes | Neon pooled string |
| `FRIENDS_JSON` | yes | The whole `friends.json` contents, pasted inline — keeps your group's SteamIDs out of a public repo |
| `OPENDOTA_API_KEY` | no | Only if you outgrow the free tier |

Then trigger **Actions → Poll Dota activity → Run workflow** once to confirm it works before
relying on the cron.

> **Keep the repo public.** Public repos get unlimited Actions minutes; private repos get 2,000/month
> and a 5-minute cron needs roughly 8,600. Secrets stay encrypted either way, and `friends.json` is
> gitignored.

> GitHub disables scheduled workflows after **60 days without repo activity**. If the poller goes
> quiet after a long break, re-enable it in the Actions tab.

### 8. Dashboard on Vercel

1. **Add New Project** → import this repo
2. Set **Root Directory** to `dashboard`
3. Add environment variable `DATABASE_URL` (same Neon string)
4. Deploy

Locally: `cd dashboard && npm install && DATABASE_URL=... npm run dev`

---

## Workflows

| File | Schedule | Does |
| --- | --- | --- |
| `poll.yml` | every 5 min | The main poller |
| `weekly.yml` | Sundays 20:00 UTC | Weekly recap post |
| `heroes.yml` | Mondays 06:00 UTC | Refreshes hero constants, commits only on change |

Cron in GitHub Actions is **always UTC** and best-effort — real spacing is often 5–15 minutes under
load. For a 20:00 local post in UTC−3 (Argentina/Brazil), use `0 23 * * 0`.

## Commands

| Command | Does |
| --- | --- |
| `npm test` | Offline self-test — no database, network or keys needed |
| `npm run migrate` | Create/upgrade schema, sync friends list |
| `npm run backfill` | Load past matches (no Discord posts) |
| `npm run poll` | One polling pass |
| `npm run poll:dry` | Same, but prints payloads instead of posting |
| `npm run recap` | Post the weekly recap now |
| `npm run recap:dry` | Preview the recap |
| `npm run heroes` | Refresh hero constants |

## Tuning

| Env var | Default | Purpose |
| --- | --- | --- |
| `MAX_MATCH_AGE_HOURS` | `6` | Matches that ended longer ago than this are recorded but not announced. Raise it if your cron runs rarely. |
| `OPENDOTA_API_KEY` | — | Lifts OpenDota rate limits |
| `PGSSL_NO_VERIFY` | — | Set to `1` only behind a TLS-intercepting proxy |

Editable in code: roast thresholds and streak length live in `poller/rules.js`; which lobby types
get announced is `ANNOUNCEABLE_LOBBIES` in `poller/opendota.js` (public and ranked only by default,
so bot games and tournament lobbies stay out of the feed).

## Notes and limitations

- **"Entered a match" is a best-effort signal.** Steam returns `lobbysteamid` / `gameserversteamid`
  alongside `gameid`, which cleanly separates "sitting in the menu" from "in a game" — but those
  fields aren't in Valve's published API spec. If Steam ever stops sending them, the poller falls
  back to treating two consecutive polls in the Dota client (~10 minutes) as being in a match. Both
  paths are tested; you don't need to do anything.
- There's no free way to detect *queueing* specifically, so the alert fires once a match is
  underway rather than the moment someone hits Find Match.
- Turbo, All Pick and ranked games all post. Bot matches, custom games and tournament lobbies are
  recorded for stats but not announced.
- Match results appear a few minutes after a game ends — that's OpenDota's ingestion lag, not a bug.

## Project layout

```
poller/
  index.js      run orchestration: presence → pending queue → posts
  steam.js      batched GetPlayerSummaries + presence classification
  opendota.js   recentMatches / match history / profile
  db.js         pool, schema, advisory lock, post dedupe
  discord.js    embed builders + webhook sending
  rules.js      streaks, roasts, stack grouping, recap aggregation
  matches.js    match persistence
  heroes.json   vendored hero constants
scripts/        migrate · backfill · weekly-recap · update-heroes
dashboard/      Next.js app (Vercel root directory)
```
