import { migrate, query, closePool, syncPlayers } from '../poller/db.js';
import { loadFriends, requireEnv } from '../poller/config.js';

requireEnv('DATABASE_URL');

await migrate();
console.log('Schema applied.');

try {
  const friends = loadFriends();
  await syncPlayers(friends);
  console.log(`Synced ${friends.length} player(s):`);
  for (const f of friends) console.log(`  ${f.name}  account_id=${f.accountId}`);
} catch (err) {
  console.log(`Skipped player sync: ${err.message}`);
}

const { rows } = await query(
  `SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name`
);
console.log('Tables:', rows.map((r) => r.table_name).join(', '));

await closePool();
