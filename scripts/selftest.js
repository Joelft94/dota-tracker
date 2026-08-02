// Offline self-test: no database, no network, no API keys required.
//   npm test
//
// Worth running after `npm run heroes`, since a hero rename or id change upstream would
// silently break match messages.
import { toAccountId, heroName, heroImage, rankName } from '../poller/config.js';
import { fmtDuration, matchEmbed, stackEmbed, queueMessage, streakMessage } from '../poller/discord.js';
import { roastFor, groupByMatch } from '../poller/rules.js';
import { didWin, modeName, isAnnounceable } from '../poller/opendota.js';
import { classify, resolveState } from '../poller/steam.js';

let failures = 0;
let count = 0;

function eq(name, got, want) {
  count++;
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failures++;
  console.error(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
}

function group(name) {
  console.log(`\n${name}`);
}

group('SteamID conversion');
eq('steamID64 -> account_id', toAccountId('76561198047011640'), 86745912);
eq('handles whitespace', toAccountId(' 76561198047011640 '), 86745912);

group('Hero constants');
eq('known hero', heroName(1), 'Anti-Mage');
eq('hero 106', heroName(106), 'Ember Spirit');
eq('unknown hero degrades gracefully', heroName(99999), 'Hero #99999');
eq('image is absolute CDN url', heroImage(1).startsWith('https://cdn.cloudflare.steamstatic.com/'), true);
eq('unknown hero has no image', heroImage(99999), null);

group('Rank medals');
eq('immortal with leaderboard', rankName(80, 243), 'Immortal #243');
eq('immortal without leaderboard', rankName(80, null), 'Immortal');
eq('divine 3', rankName(73), 'Divine 3');
eq('herald 1', rankName(11), 'Herald 1');
eq('uncalibrated', rankName(null), 'Uncalibrated');

group('Win detection (player_slot < 128 is Radiant)');
eq('radiant player, radiant won', didWin({ player_slot: 4, radiant_win: true }), true);
eq('radiant player, radiant lost', didWin({ player_slot: 4, radiant_win: false }), false);
eq('dire player, radiant won', didWin({ player_slot: 132, radiant_win: true }), false);
eq('dire player, dire won', didWin({ player_slot: 132, radiant_win: false }), true);

group('Presence classification');
eq('playing another game', classify({ gameid: '730' }).state, 'offline');
eq('no summary (private profile)', classify(undefined).state, 'offline');
eq('in dota, no lobby field', classify({ gameid: '570' }).state, 'menu');
eq('in dota with lobbysteamid', classify({ gameid: '570', lobbysteamid: '1' }).state, 'match');
eq('in dota with gameserversteamid', classify({ gameid: '570', gameserversteamid: '1' }).state, 'match');

group('Dwell-time fallback (when Steam omits lobby fields)');
eq('fallback unused when fields available', resolveState('menu', 9, true), 'menu');
eq('one poll is not enough', resolveState('menu', 1, false), 'menu');
eq('two polls promotes to match', resolveState('menu', 2, false), 'match');
eq('offline is never promoted', resolveState('offline', 9, false), 'offline');

group('Lobby / mode filtering');
eq('unranked is announced', isAnnounceable({ lobby_type: 0 }), true);
eq('ranked is announced', isAnnounceable({ lobby_type: 7 }), true);
eq('tournament lobby is not', isAnnounceable({ lobby_type: 1 }), false);
eq('bot match is not', isAnnounceable({ lobby_type: 4 }), false);
eq('ranked mode label', modeName({ game_mode: 22, lobby_type: 7 }), 'Ranked All Pick');
eq('turbo label', modeName({ game_mode: 23, lobby_type: 0 }), 'Turbo');

group('Formatting');
eq('duration', fmtDuration(1780), '29:40');
eq('duration zero-pads seconds', fmtDuration(605), '10:05');
eq('queue message', queueMessage('Joel').content, '🎮 **Joel** just queued into a match');
eq('win streak message', /5-win streak/.test(streakMessage('Joel', 5, true).content), true);
eq('loss streak message', /lost \*\*4 in a row\*\*/.test(streakMessage('Joel', 4, false).content), true);

group('Roasts (at most one per match)');
const base = { hero_id: 1, kills: 5, deaths: 3, assists: 5, duration: 2000, won: true, leaver_status: 0 };
eq('ordinary game is not roasted', roastFor(base, 'Joel'), null);
eq('heavy feeding', /died \*\*15\*\* times/.test(roastFor({ ...base, deaths: 15 }, 'Joel')), true);
eq('abandon takes priority', /abandoned/.test(roastFor({ ...base, deaths: 20, leaver_status: 2 }, 'Joel')), true);
eq('zero kills in a loss', /0 kills/.test(roastFor({ ...base, kills: 0, assists: 1, won: false }, 'Joel')), true);
eq('fast loss', /Fastest gg/.test(roastFor({ ...base, won: false, duration: 800 }, 'Joel')), true);
eq('deathless win', /deathless/.test(roastFor({ ...base, deaths: 0, kills: 7 }, 'Joel')), true);

group('Stack grouping');
const entry = (matchId, accountId) => ({
  match: { match_id: matchId, hero_id: 1, kills: 1, deaths: 1, assists: 1, won: true,
           duration: 100, start_time: 1, gold_per_min: 400, last_hits: 90 },
  player: { account_id: accountId, display_name: `P${accountId}` },
});
const grouped = groupByMatch([entry(1, 10), entry(1, 11), entry(2, 12), entry(3, 13), entry(3, 14), entry(3, 15)]);
eq('one solo match', grouped.solo.length, 1);
eq('two stacks', grouped.stacks.length, 2);
eq('stack sizes', grouped.stacks.map((s) => s.length).sort(), [2, 3]);
eq('every entry accounted for',
  grouped.solo.length + grouped.stacks.reduce((a, s) => a + s.length, 0), 6);

group('Embeds');
const match = {
  match_id: 8921895413, hero_id: 106, won: true, kills: 7, deaths: 5, assists: 15,
  duration: 1780, game_mode: 22, lobby_type: 7, gold_per_min: 519, xp_per_min: 751,
  hero_damage: 21261, last_hits: 157, start_time: 1785472527,
};
const embed = matchEmbed(match, { display_name: 'Joel', avatar_url: null });
eq('title', embed.title, 'Ember Spirit — Victory');
eq('win is green', embed.color, 0x2ecc71);
eq('loss is red', matchEmbed({ ...match, won: false }, { display_name: 'x' }).color, 0xe74c3c);
eq('links to opendota', embed.url, 'https://www.opendota.com/matches/8921895413');
eq('kda ratio', embed.fields[1].value, '4.40');
eq('timestamp is match END, not start',
  embed.timestamp, new Date((match.start_time + match.duration) * 1000).toISOString());
eq('stack embed title', stackEmbed(match, [entry(1, 10), entry(1, 11)]).title, '2-stack — Victory');
eq('stack embed has one field per player', stackEmbed(match, [entry(1, 10), entry(1, 11)]).fields.length, 2);

console.log(
  failures === 0
    ? `\n✓ all ${count} assertions passed\n`
    : `\n✗ ${failures} of ${count} assertions failed\n`
);
process.exit(failures ? 1 : 0);
