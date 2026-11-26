/**
 * Match rules in one place. The match page's Game Rules panel shows these, and score reports are checked
 * against the same first-to settings, so the text players read and the checks the server makes agree.
 */
const DUEL_SERVER = { name: 'MCPVP Club', address: 'mcpvp.club' };

const GENERAL = [
  { title: 'Verified accounts only', text: 'Play on the Minecraft account verified on your DonutWagers profile. Another account, or someone else on yours, forfeits the match.' },
  { title: 'Match settings are fixed', text: 'Gamemode, region, first-to target and round lead are set when the match is created and cannot be changed afterwards.' },
  { title: 'Ready up in time', text: 'Both players have 15 minutes to ready up after someone joins. If either does not, the match is cancelled and both entries are returned.' },
  { title: 'Report honestly', text: 'After the duel, both players report the winner and the final score. Matching reports settle the match straight away. A false report can lead to an overturned result, a balance correction or a ban.' },
  { title: 'Reports have a deadline', text: 'If only one player reports within 24 hours, the match goes to staff review instead of settling on one report.' },
  { title: 'Disputes', text: 'Different reports put the match under staff review. Use Contact staff in the match room and add your recording to the Discord ticket. Staff decisions are logged.' },
  { title: 'Disconnects', text: 'A disconnect during a round loses that round unless both players agree in chat to replay it. Leaving and not returning within 5 minutes forfeits the match.' },
  { title: 'Cancelling', text: 'Before anyone joins, the creator can cancel. After that, both players must agree to cancel, and both entries are returned.' },
  { title: 'Keep evidence', text: 'Record your duels. Without a recording, staff decide disputes from the reports, the chat and the match history.' },
];

const PROHIBITED = 'Hacked clients, macros, auto-clickers, reach or velocity changes, x-ray, and any mod that gives an advantage are not allowed. Exploits forfeit the match.';
const ALLOWED = 'Performance mods, minimaps without entity radar, shaders, zoom and texture packs that do not reveal hidden information are allowed.';

const MODES = {
  crystal: {
    title: 'Crystal PvP',
    kit: 'The duel server’s own Crystal PvP kit, unchanged.',
    rules: [
      { title: 'Kit', text: 'Use only the server’s Crystal PvP kit for every round. Bringing extra items or a custom kit loses the round.' },
      { title: 'Rounds', text: 'A round ends when a player dies or leaves the arena. The first player to reach the target wins; with “win by 2” the winner must also lead by two.' },
      { title: 'Allowed', text: ALLOWED },
      { title: 'Not allowed', text: `${PROHIBITED} Crystal auto-placers and anchor macros count as cheating.` },
      { title: 'Round lead', text: 'If the match has a round lead, the joining player starts with that many rounds already won.' },
    ],
  },
  sword: {
    title: 'Sword',
    kit: 'The duel server’s own Sword kit, unchanged.',
    rules: [
      { title: 'Kit', text: 'Use only the server’s Sword kit for every round. No items from outside the kit.' },
      { title: 'Rounds', text: 'A round ends when a player dies or leaves the arena. The first player to reach the target wins; with “win by 2” the winner must also lead by two.' },
      { title: 'Allowed', text: ALLOWED },
      { title: 'Not allowed', text: `${PROHIBITED} Hitbox changes and click-assist mods count as cheating.` },
      { title: 'Round lead', text: 'If the match has a round lead, the joining player starts with that many rounds already won.' },
    ],
  },
};

/** "First to 3+2, lead 1" → { firstTo: 3, winByTwo: true, lead: 1 }. */
function parseRules(rules) {
  const parsed = String(rules || '').match(/^First to (\d+)(\+2)?, lead (\d)$/);
  return parsed ? { firstTo: Number(parsed[1]), winByTwo: Boolean(parsed[2]), lead: Number(parsed[3]) } : null;
}

/**
 * A reported final score, as rounds won by the winner and the loser, or why it cannot be right under the
 * match's first-to setting. A score is optional; undefined means none was given.
 */
function checkScore(rules, winnerRounds, loserRounds) {
  if (winnerRounds === undefined && loserRounds === undefined) return { score: null };
  const winner = Number(winnerRounds);
  const loser = Number(loserRounds);
  if (!Number.isInteger(winner) || !Number.isInteger(loser) || winner < 0 || loser < 0 || winner > 99 || loser > 99) return { error: 'Enter the score as whole numbers of rounds.' };
  if (winner <= loser) return { error: 'The winner must have won more rounds.' };
  const terms = parseRules(rules);
  if (terms) {
    if (winner < terms.firstTo) return { error: `The winner needs at least ${terms.firstTo} rounds.` };
    if (terms.winByTwo ? (winner > terms.firstTo ? winner - loser !== 2 : winner - loser < 2) : (winner !== terms.firstTo)) return { error: terms.winByTwo ? `First to ${terms.firstTo}, win by 2: that score is not possible.` : `First to ${terms.firstTo}: the winner has exactly ${terms.firstTo} rounds.` };
  }
  return { score: { winner, loser } };
}

/** What the match page's Game Rules panel shows for one match. */
function rulesFor(mode, rules) {
  const config = MODES[mode] || MODES.sword;
  const terms = parseRules(rules);
  return {
    mode: config.title,
    kit: config.kit,
    server: DUEL_SERVER,
    terms: terms ? { first_to: terms.firstTo, win_by_two: terms.winByTwo, lead: terms.lead } : null,
    mode_rules: config.rules,
    general_rules: GENERAL,
  };
}

module.exports = { rulesFor, checkScore, parseRules, DUEL_SERVER };
