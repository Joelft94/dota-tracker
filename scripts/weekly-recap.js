// Weekly recap post. Run by .github/workflows/weekly.yml on Sundays.
//   node scripts/weekly-recap.js [--dry-run] [--days N]
import { DRY_RUN, requireEnv } from '../poller/config.js';
import { migrate, claimPost, releasePost, closePool } from '../poller/db.js';
import { weeklyStats } from '../poller/rules.js';
import * as discord from '../poller/discord.js';

requireEnv('DATABASE_URL');
if (!DRY_RUN) requireEnv('DISCORD_WEBHOOK_URL');

const daysArg = process.argv.indexOf('--days');
const days = daysArg > -1 ? Number(process.argv[daysArg + 1]) || 7 : 7;

await migrate();

const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
const sinceEpoch = Math.floor(sinceMs / 1000);
const stats = await weeklyStats(sinceEpoch);

// One recap per ISO week, so a re-run or a duplicated workflow can't double-post.
const now = new Date();
const week = isoWeek(now);
const key = `recap:${now.getUTCFullYear()}-W${week}`;

if (await claimPost({ key, kind: 'recap' })) {
  try {
    await discord.send({ embeds: [discord.recapEmbed(stats, sinceMs)] });
    console.log(`Posted recap for ${key} (${stats.totalMatches} matches).`);
  } catch (err) {
    await releasePost(key);
    throw err;
  }
} else {
  console.log(`Recap ${key} already posted; nothing to do.`);
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return String(Math.ceil(((t - yearStart) / 86400000 + 1) / 7)).padStart(2, '0');
}

await closePool();
