import type {
  LeaderboardProgressionMatch,
  LeaderboardProgressionResponse,
  LiveScorerNationalities,
  LiveScoringConfig,
  UserStatCardData,
} from '@tournament-predictor/shared';
import { LIVE_SEASON_MILESTONE_IDS } from './progression';

// ── User statistics for live competitions ─────────────────────────────────────
//
// The same cards the manual competition type shows, built from live data. Seven of them —
// the leader, the form pair, the two table movers and the result pair — are that type's
// cards outright, sentence and all, because the league already reads those words; the
// rest are this type's own. The manual
// version composes them inline in its route (server/src/routes/competitions.ts) from a
// pile of already-loaded query results; this one keeps the composing pure and takes the
// rows as arguments, so each card can be pinned by a unit test without a database.
//
// Two matched pairs, one per ranking the game asks for: who the league thinks will finish
// top and bottom of the league table, and who it thinks will finish top and bottom of the
// top-scorer list. All four are the same count — which entrant sits at one end of the most
// rankings — so they share countEnd and differ only in their wording. Beside the table pair,
// the two ends of the bands: the team the league has going straight through, and the one
// it has written off bar a believer — who is named.
//
// Then a pair about the members themselves rather than what they predicted: who calls the
// scoreline outright most often, and who keeps landing on the right margin and the wrong
// scoreline. And a pair about one prediction rather than a season of them: the one nobody
// else saw coming, and the one that missed by the most goals.
//
// Plus one card that is not about predictions at all: how many goals Norwegians have
// actually scored. It reads the snapshot the scorer sync leaves on the tournament, so it
// costs no provider request of its own.

export type LiveStatsLang = 'en' | 'no' | 'de';

export interface LiveStatsTeam {
  id: string;
  name: string;
  crestUrl: string | null;
}

export interface LiveStatsPlayer {
  id: string;
  name: string;
  imageUrl: string | null;
}

export interface LiveStatsTablePrediction extends CardMember {
  orderedTeamIds: string[];
}

export interface LiveStatsScorerPrediction {
  userId: string;
  /** Carried for the Haaland card, which names the members behind a ranking. */
  username: string;
  imageUrl: string | null;
  iconColor: string | null;
  orderedPlayerIds: string[];
}

/** A team or a player, once the difference between them stops mattering. */
interface Entrant {
  id: string;
  name: string;
  imageUrl: string | null;
}

/** "A", "A and B", "A, B and C" — and the same in the other two locales. */
function joinNames(names: string[], lang: LiveStatsLang): string {
  if (names.length <= 1) return names[0] ?? '';
  const and = lang === 'no' ? 'og' : lang === 'de' ? 'und' : 'and';
  return `${names.slice(0, -1).join(', ')} ${and} ${names[names.length - 1]}`;
}

interface EndCount {
  winners: Entrant[];
  count: number;
  total: number;
}

/**
 * Which entrant the most members put at one end of their ranking, and how many of them
 * did. Null when nobody has ranked anything yet, or when every ranking puts something
 * there that no longer exists: a card that cannot name a subject is not a statistic.
 *
 * Ties are shown rather than broken. There is no fair way to pick between two the league
 * feels the same way about, and "they are level" is the more interesting fact.
 */
function countEnd(
  orders: string[][],
  byId: Map<string, Entrant>,
  end: 'top' | 'bottom',
): EndCount | null {
  const counts = new Map<string, number>();
  let total = 0;
  for (const ids of orders) {
    const entrantId = end === 'top' ? ids[0] : ids[ids.length - 1];
    // A ranking whose entrant at this end has since left the tournament is left out of the
    // denominator too, so the "x of y" it prints always adds up. The top and bottom cards
    // can therefore land on different totals, which is right: each counts what it can
    // still name.
    if (!entrantId || !byId.has(entrantId)) continue;
    counts.set(entrantId, (counts.get(entrantId) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return null;

  const count = Math.max(...counts.values());
  return {
    // Sorted by name so a tie reads the same on every request.
    winners: [...counts.entries()]
      .filter(([, n]) => n === count)
      .map(([entrantId]) => byId.get(entrantId)!)
      .sort((a, b) => a.name.localeCompare(b.name)),
    count,
    total,
  };
}

function card(
  id: string,
  title: string,
  statistic: string,
  winners: Entrant[],
  type: 'team' | 'player',
): UserStatCardData {
  return {
    id,
    title,
    statistic,
    subjects: winners.map(entrant => ({
      type,
      id: entrant.id,
      name: entrant.name,
      imageUrl: entrant.imageUrl,
    })),
    // None of UserStatCard's link targets exist for a live competition, and the live card
    // renders the pictures from `subjects` itself.
    linkType: null,
  };
}

/** What any row needs to become a card subject: a member, however they were counted. */
interface CardMember {
  userId: string;
  username: string;
  imageUrl: string | null;
  iconColor: string | null;
}

/**
 * A member is the one subject that can have no picture at all, so these carry the colour
 * the live card draws their initial on. Built here rather than through `card()`, which
 * has only ever had a picture to pass on.
 */
/** Sorted by name so a tie reads the same on every request — same rule as countEnd. */
const byUsername = (a: CardMember, b: CardMember) => a.username.localeCompare(b.username);

/**
 * One entry per member, name-sorted. The prediction pair below ranks predictions rather
 * than members, so the same member can hold two of the rows that tie; they are one
 * subject and one name in the sentence either way.
 */
function dedupeByUser<T extends CardMember>(rows: T[]): T[] {
  const byUser = new Map<string, T>();
  for (const row of rows) if (!byUser.has(row.userId)) byUser.set(row.userId, row);
  return [...byUser.values()].sort(byUsername);
}

function memberCard(
  id: string,
  title: string,
  statistic: string,
  winners: CardMember[],
): UserStatCardData {
  return {
    id,
    title,
    statistic,
    subjects: winners.map(w => ({
      type: 'user' as const,
      id: w.userId,
      name: w.username,
      imageUrl: w.imageUrl,
      iconColor: w.iconColor,
    })),
    linkType: null,
  };
}

const indexTeams = (teams: LiveStatsTeam[]): Map<string, Entrant> =>
  new Map(teams.map(t => [t.id, { id: t.id, name: t.name, imageUrl: t.crestUrl }]));

const indexPlayers = (players: LiveStatsPlayer[]): Map<string, Entrant> =>
  new Map(players.map(p => [p.id, { id: p.id, name: p.name, imageUrl: p.imageUrl }]));

// ── The leader ────────────────────────────────────────────────────────────────

/**
 * Names, bolded and joined the way the manual competition type's formatUserList does —
 * with the comma before the "and" that joinNames above leaves out.
 *
 * The duplication is the point: this card prints the manual type's sentence word for
 * word, so it has to punctuate it the same way too. See formatUserList in
 * server/src/routes/competitions.ts.
 */
function formatUserList(names: string[], lang: LiveStatsLang): string {
  const bolded = names.map(n => `**${n}**`);
  const and = lang === 'no' ? 'og' : lang === 'de' ? 'und' : 'and';
  if (bolded.length === 1) return bolded[0];
  if (bolded.length === 2) return `${bolded[0]} ${and} ${bolded[1]}`;
  return `${bolded.slice(0, -1).join(', ')}, ${and} ${bolded[bolded.length - 1]}`;
}

const SEASON_MILESTONES = new Set<string>(LIVE_SEASON_MILESTONE_IDS);

/**
 * The played fixtures off the points progression, oldest first.
 *
 * The season-long lumps are dropped: they move the totals, but they are settled once at
 * the end rather than played, and every card below counts matches.
 */
function playedFixtures(progression: LeaderboardProgressionResponse): LeaderboardProgressionMatch[] {
  return progression.matches.filter(m => !SEASON_MILESTONES.has(m.matchId));
}

/** Everyone level on the most points at one milestone. Empty while nobody has any. */
function leadersAt(milestone: LeaderboardProgressionMatch): Set<string> {
  const totals = Object.entries(milestone.cumulativePoints);
  const most = Math.max(0, ...totals.map(([, points]) => points));
  // A leaderboard of nothing but zeroes has no leader. The manual type would name the
  // whole league here; a card that says everybody is winning is not a statistic.
  if (most === 0) return new Set();
  return new Set(totals.filter(([, points]) => points === most).map(([userId]) => userId));
}

/**
 * Who is top of the leaderboard, and how many matches they have been top for.
 *
 * The manual competition type's card, wording and all — the league already reads that
 * sentence, and this tournament type having a different one for the same fact would be
 * two cards, not one. What differs is underneath: the run is walked over the points
 * progression, so "leading" here means exactly what the leaderboard and the chart mean
 * by it, including the multiplier bonuses and the deselected-fixture rules.
 *
 * Only fixture milestones count. The table, the top-scorer ranking and the bonus
 * questions are settled in one lump at the end of a season and are no part of a run of
 * matches — see LIVE_SEASON_MILESTONE_IDS.
 *
 * Where several members are level at the top, the one who has been there longest wins
 * the card, and a tie on that is shown in full: both are the manual card's rules.
 */
export function theLeaderCard(
  progression: LeaderboardProgressionResponse | null,
  lang: LiveStatsLang,
): UserStatCardData | null {
  if (!progression) return null;

  const games = playedFixtures(progression);
  if (games.length === 0) return null;

  const leading = games.map(leadersAt);
  const current = leading[leading.length - 1];
  if (current.size === 0) return null;

  const streakFor = (userId: string): number => {
    let streak = 0;
    for (let i = leading.length - 1; i >= 0; i--) {
      if (!leading[i].has(userId)) break;
      streak += 1;
    }
    return streak;
  };

  const byUser = new Map(progression.users.map(u => [u.userId, u]));
  const streaks = [...current]
    .filter(userId => byUser.has(userId))
    .map(userId => ({ userId, streak: streakFor(userId) }));
  if (streaks.length === 0) return null;

  const longest = Math.max(...streaks.map(s => s.streak));
  const kings: CardMember[] = streaks
    .filter(s => s.streak === longest)
    .map(s => {
      const user = byUser.get(s.userId)!;
      return {
        userId: user.userId,
        username: user.username,
        imageUrl: user.imageUrl ?? null,
        iconColor: user.iconColor ?? null,
      };
    })
    .sort(byUsername);

  const names = formatUserList(kings.map(k => k.username), lang);
  const gameCount = longest;

  const title = lang === 'no' ? 'Kongen på haugen' : lang === 'de' ? 'Der Platzhirsch' : 'The Leader';

  const statistic =
    lang === 'no'
      ? `${names} har regjert på toppen i ${gameCount} kamp${gameCount === 1 ? '' : 'er'}!`
      : lang === 'de'
        ? `${names} thront seit ${gameCount} Spiel${gameCount === 1 ? '' : 'en'} an der Spitze wie eine sehr wackelige Krone!`
        : `${names} ${kings.length === 1 ? 'has' : 'have'} reigned supreme for the last ${gameCount} game${gameCount === 1 ? '' : 's'}!`;

  return memberCard('theLeader', title, statistic, kings);
}


// ── Form and movement ─────────────────────────────────────────────────────────
//
// Four more of the manual competition type's cards, wording and all, for the same reason
// the leader card is here: the league reads these sentences already. What they are made
// of is this type's own — the run of played fixtures comes off the points progression, so
// "the last 5 matches" and "the last 10 games" mean the same fixtures the chart plots.

/** One member's points on one fixture, keyed fixture then member. */
function pointsByFixture(
  predictions: LiveStatsScoredPrediction[],
): Map<string, Map<string, number>> {
  const byFixture = new Map<string, Map<string, number>>();
  for (const p of predictions) {
    let forFixture = byFixture.get(p.fixtureId);
    if (!forFixture) {
      forFixture = new Map();
      byFixture.set(p.fixtureId, forFixture);
    }
    forFixture.set(p.userId, p.points);
  }
  return byFixture;
}

/** Members as card subjects, by id, so a card can name whoever a walk turns up. */
function membersById(progression: LeaderboardProgressionResponse): Map<string, CardMember> {
  return new Map(
    progression.users.map(u => [
      u.userId,
      {
        userId: u.userId,
        username: u.username,
        imageUrl: u.imageUrl ?? null,
        iconColor: u.iconColor ?? null,
      },
    ]),
  );
}

/** How many matches "recent form" is measured over, and over how many the table moves. */
const FORM_WINDOW = 5;
const MOVEMENT_WINDOW = 10;

/**
 * Who has taken the most points from the last five matches.
 *
 * Only members who predicted at least one of them are in the running — the manual card's
 * behaviour, since a member with nothing in the window never enters its tally either.
 *
 * Null before anything has been played, and null when the best of them took nothing:
 * "gained 0 points" naming half the league is the zero the rest of this deck refuses.
 */
export function bestFormCard(
  predictions: LiveStatsScoredPrediction[],
  progression: LeaderboardProgressionResponse | null,
  lang: LiveStatsLang,
): UserStatCardData | null {
  if (!progression) return null;
  const played = playedFixtures(progression);
  if (played.length === 0) return null;

  const window = played.slice(-FORM_WINDOW).map(m => m.matchId);
  const byFixture = pointsByFixture(predictions);
  const members = membersById(progression);

  const recent = new Map<string, number>();
  for (const fixtureId of window) {
    for (const [userId, points] of byFixture.get(fixtureId) ?? []) {
      if (!members.has(userId)) continue;
      recent.set(userId, (recent.get(userId) ?? 0) + points);
    }
  }
  if (recent.size === 0) return null;

  const most = Math.max(...recent.values());
  if (most === 0) return null;

  const inForm = [...recent.entries()]
    .filter(([, points]) => points === most)
    .map(([userId]) => members.get(userId)!)
    .sort(byUsername);

  const names = formatUserList(inForm.map(m => m.username), lang);
  const title = lang === 'no' ? 'I fyr og flamme 🔥' : lang === 'de' ? 'Formrakete 🔥' : 'Best form';

  const statistic =
    lang === 'no'
      ? `${names} har sanket ${most} poeng de siste 5 kampene!`
      : lang === 'de'
        ? `${names} hat in den letzten 5 Spielen ${most} Punkte eingesammelt! Heiß wie eine Bratwurst auf dem Grill.`
        : `${names} ${inForm.length === 1 ? 'has' : 'have'} gained ${most} points in the last 5 matches!`;

  return memberCard('bestForm', title, statistic, inForm);
}

/**
 * The mirror: the longest run of played matches ending now with no points at all.
 *
 * Only members who predicted every played fixture are eligible, as in the manual card —
 * otherwise the longest drought would always belong to whoever stopped playing, which is
 * a different and much sadder statistic. A drought of one is a bad afternoon rather than
 * a run, so the card starts at two.
 */
export function worstFormCard(
  predictions: LiveStatsScoredPrediction[],
  progression: LeaderboardProgressionResponse | null,
  lang: LiveStatsLang,
): UserStatCardData | null {
  if (!progression) return null;
  const played = playedFixtures(progression);
  if (played.length === 0) return null;

  const byFixture = pointsByFixture(predictions);
  const members = membersById(progression);

  const droughts = new Map<string, number>();
  for (const [userId, member] of members) {
    if (!played.every(m => byFixture.get(m.matchId)?.has(userId))) continue;
    let drought = 0;
    for (let i = played.length - 1; i >= 0; i--) {
      if ((byFixture.get(played[i].matchId)?.get(userId) ?? 0) > 0) break;
      drought += 1;
    }
    droughts.set(member.userId, drought);
  }
  if (droughts.size === 0) return null;

  const longest = Math.max(...droughts.values());
  if (longest <= 1) return null;

  const outOfForm = [...droughts.entries()]
    .filter(([, drought]) => drought === longest)
    .map(([userId]) => members.get(userId)!)
    .sort(byUsername);

  const names = formatUserList(outOfForm.map(m => m.username), lang);
  const title = lang === 'no' ? 'Send Hjelp' : lang === 'de' ? 'Hilfe senden' : 'Worst form';

  const statistic =
    lang === 'no'
      ? `${names} har gått ${longest} kamper på rad uten å sanke et eneste poeng!`
      : lang === 'de'
        ? `${names} hat ${longest} Spiele in Folge keinen einzigen Punkt geholt! Bitte ruft professionelle Hilfe!`
        : `${names} ${outOfForm.length === 1 ? 'has' : 'have'} gone ${longest} matches without gaining a single point!`;

  return memberCard('worstForm', title, statistic, outOfForm);
}

/**
 * Standings at one milestone: joint totals share a place, and the next one down is left
 * empty — 1, 2, 2, 4. The manual card's ranking, so a shared second is not a climb.
 */
function rankAt(milestone: LeaderboardProgressionMatch): Map<string, number> {
  const sorted = Object.entries(milestone.cumulativePoints).sort((a, b) => b[1] - a[1]);
  const ranks = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) {
    const [userId, points] = sorted[i];
    const tiedWithPrevious = i > 0 && points === sorted[i - 1][1];
    ranks.set(userId, tiedWithPrevious ? ranks.get(sorted[i - 1][0])! : i + 1);
  }
  return ranks;
}

/** How many places each member has moved over the last ten played fixtures. */
function movementOverWindow(
  progression: LeaderboardProgressionResponse | null,
): Array<{ member: CardMember; climbed: number }> {
  if (!progression) return [];
  const played = playedFixtures(progression);
  // Eleven milestones, because the move is measured from the one before the ten.
  if (played.length < MOVEMENT_WINDOW + 1) return [];

  const before = rankAt(played[played.length - MOVEMENT_WINDOW - 1]);
  const now = rankAt(played[played.length - 1]);
  const members = membersById(progression);

  const moves: Array<{ member: CardMember; climbed: number }> = [];
  for (const [userId, rank] of now) {
    const previous = before.get(userId);
    const member = members.get(userId);
    if (previous === undefined || !member) continue;
    moves.push({ member, climbed: previous - rank });
  }
  return moves;
}

/** How many places the biggest mover has moved, and who moved that far. */
function movers(
  moves: Array<{ member: CardMember; climbed: number }>,
  direction: 'up' | 'down',
): { places: number; members: CardMember[] } | null {
  if (moves.length === 0) return null;
  const moved = (m: { climbed: number }) => (direction === 'up' ? m.climbed : -m.climbed);
  const places = Math.max(...moves.map(moved));
  // One place is the table breathing; the manual card starts at two, and so does this.
  if (places < 2) return null;
  return {
    places,
    members: moves.filter(m => moved(m) === places).map(m => m.member).sort(byUsername),
  };
}

/** Who has climbed the most places over the last ten matches. */
export function theClimberCard(
  progression: LeaderboardProgressionResponse | null,
  lang: LiveStatsLang,
): UserStatCardData | null {
  const climbed = movers(movementOverWindow(progression), 'up');
  if (!climbed) return null;

  const { places, members } = climbed;
  const names = formatUserList(members.map(m => m.username), lang);
  const title = lang === 'no' ? 'Det klatres!' : lang === 'de' ? 'Der Aufsteiger' : 'The Climber';

  const statistic =
    lang === 'no'
      ? `${names} har klatret ${places} ${places === 1 ? 'plass' : 'plasser'} på tabellen de siste 10 kampene!`
      : lang === 'de'
        ? `${names} ist in den letzten 10 Spielen um ${places} ${places === 1 ? 'Platz' : 'Plätze'} aufgestiegen!`
        : `${names} ${members.length === 1 ? 'has' : 'have'} climbed ${places} ${places === 1 ? 'spot' : 'spots'} on the leaderboard over the last 10 games!`;

  return memberCard('theClimber', title, statistic, members);
}

/** The mirror: who has dropped the most places over the same ten. */
export function theFallerCard(
  progression: LeaderboardProgressionResponse | null,
  lang: LiveStatsLang,
): UserStatCardData | null {
  const fell = movers(movementOverWindow(progression), 'down');
  if (!fell) return null;

  const { places, members } = fell;
  const names = formatUserList(members.map(m => m.username), lang);
  const title = lang === 'no' ? 'Rett åt skogen' : lang === 'de' ? 'Tabellenabsteiger' : "I'm falling!";

  const statistic =
    lang === 'no'
      ? `${names} har falt ${places} ${places === 1 ? 'plass' : 'plasser'} på tabellen de siste 10 kampene!`
      : lang === 'de'
        ? `${names} ist in den letzten 10 Spielen um ${places} ${places === 1 ? 'Platz' : 'Plätze'} abgefallen!`
        : `${names} ${members.length === 1 ? 'has' : 'have'} dropped ${places} ${places === 1 ? 'spot' : 'spots'} on the leaderboard over the last 10 games!`;

  return memberCard('theFaller', title, statistic, members);
}


// ── The league table pair ─────────────────────────────────────────────────────

/** The team the most members expect to finish top. */
export function peoplesFavouriteCard(
  predictions: LiveStatsTablePrediction[],
  teams: LiveStatsTeam[],
  lang: LiveStatsLang,
): UserStatCardData | null {
  const result = countEnd(predictions.map(p => p.orderedTeamIds), indexTeams(teams), 'top');
  if (!result) return null;

  const { winners, count, total } = result;
  const names = joinNames(winners.map(w => w.name), lang);
  const tied = winners.length > 1;

  const title =
    lang === 'no' ? 'Folkefavoritten' : lang === 'de' ? 'Der Publikumsliebling' : "The people's favourite";

  const statistic =
    lang === 'no'
      ? tied
        ? `**${names}** er folkets favoritter! **${count}** av **${total}** har tippet hver av dem øverst på tabelltipset.`
        : `**${names}** er folkets favoritt! **${count}** av **${total}** har tippet dem øverst på tabelltipset.`
      : lang === 'de'
        ? tied
          ? `**${names}** sind die Publikumslieblinge! **${count}** von **${total}** haben sie jeweils ganz oben im Tabellentipp.`
          : `**${names}** ist der Publikumsliebling! **${count}** von **${total}** haben sie ganz oben im Tabellentipp.`
        : tied
          ? `**${names}** are the people's favourites! **${count}** of **${total}** have each of them top of their table prediction.`
          : `**${names}** are the people's favourite! **${count}** of **${total}** have them top of their table prediction.`;

  return card('peoplesFavourite', title, statistic, winners, 'team');
}

/** The mirror: the team the most members expect to finish bottom. */
export function woodenSpoonCard(
  predictions: LiveStatsTablePrediction[],
  teams: LiveStatsTeam[],
  lang: LiveStatsLang,
): UserStatCardData | null {
  const result = countEnd(predictions.map(p => p.orderedTeamIds), indexTeams(teams), 'bottom');
  if (!result) return null;

  const { winners, count, total } = result;
  const names = joinNames(winners.map(w => w.name), lang);
  const tied = winners.length > 1;

  const title = lang === 'no' ? 'Bunnslammet' : lang === 'de' ? 'Der Bodensatz' : 'The bottom of the barrel';

  const statistic =
    lang === 'no'
      ? tied
        ? `Ingen har trua på **${names}**! **${count}** av **${total}** har tippet at hver av dem ender helt sist på tabellen.`
        : `Ingen har trua på **${names}**! **${count}** av **${total}** har tippet at de ender helt sist på tabellen.`
      : lang === 'de'
        ? tied
          ? `Niemand glaubt an **${names}**! **${count}** von **${total}** tippen jede von ihnen auf den letzten Tabellenplatz.`
          : `Niemand glaubt an **${names}**! **${count}** von **${total}** tippen sie auf den letzten Tabellenplatz.`
        : tied
          ? `Nobody believes in **${names}**! **${count}** of **${total}** have each of them finishing dead last.`
          : `Nobody believes in **${names}**! **${count}** of **${total}** have them finishing dead last.`;

  return card('woodenSpoon', title, statistic, winners, 'team');
}

/**
 * The team the league has going straight through to the knockout — everyone's pick where
 * the league agrees, and the closest thing to it where it does not.
 *
 * One count, worded two ways: the most members placing a team inside the band that
 * qualifies directly, and a sentence that says "every one of them" when that count is the
 * whole league. There is no separate unanimous card, because a league of twelve agreeing
 * eleven times over is the same statistic as one agreeing twelve.
 *
 * Ties are shown, as everywhere else — with a top eight to fill, several teams being
 * nailed on is the normal case rather than an edge one.
 *
 * Null where the format has no band that qualifies directly, and null while nobody has
 * been placed in it.
 */
export function deadCertCard(
  predictions: LiveStatsTablePrediction[],
  teams: LiveStatsTeam[],
  directPlaces: number | null,
  lang: LiveStatsLang,
): UserStatCardData | null {
  if (!directPlaces || directPlaces < 1) return null;

  const byId = indexTeams(teams);
  const through = new Map<string, number>();
  const ranked = new Map<string, number>();
  for (const prediction of predictions) {
    prediction.orderedTeamIds.forEach((teamId, index) => {
      // A team that has left the tournament is left out of both halves of the count, the
      // same way countEnd drops one: the sentence has to be able to name its subject.
      if (!byId.has(teamId)) return;
      ranked.set(teamId, (ranked.get(teamId) ?? 0) + 1);
      if (index + 1 <= directPlaces) through.set(teamId, (through.get(teamId) ?? 0) + 1);
    });
  }
  if (through.size === 0) return null;

  const most = Math.max(...through.values());
  const winners = [...through.entries()]
    .filter(([, count]) => count === most)
    .map(([teamId]) => byId.get(teamId)!)
    .sort((a, b) => a.name.localeCompare(b.name));
  // Each tied team was ranked by the same members in practice; where an old ranking missed
  // one of them, the first winner's denominator is the honest one to print.
  const total = ranked.get(winners[0].id)!;
  const everyone = most === total;

  const names = joinNames(winners.map(w => w.name), lang);
  const title =
    lang === 'no' ? 'Så godt som klar' : lang === 'de' ? 'So gut wie durch' : 'A dead cert';

  const statistic =
    lang === 'no'
      ? everyone
        ? `Alle **${total}** har tippet **${names}** blant de **${directPlaces}** som går rett videre.`
        : `**${most}** av **${total}** har tippet **${names}** blant de **${directPlaces}** som går rett videre — flere enn noe annet lag.`
      : lang === 'de'
        ? everyone
          ? `Alle **${total}** haben **${names}** unter den **${directPlaces}**, die direkt weiterkommen.`
          : `**${most}** von **${total}** haben **${names}** unter den **${directPlaces}**, die direkt weiterkommen — mehr als jede andere Mannschaft.`
        : everyone
          ? `Every one of **${total}** has **${names}** in the **${directPlaces}** that go straight through.`
          : `**${most}** of **${total}** have **${names}** in the **${directPlaces}** that go straight through — more than any other team.`;

  return card('deadCert', title, statistic, winners, 'team');
}

/**
 * The team the league has written off, and whoever still has them going through.
 *
 * Most members put them in the band that goes straight out — no play-off, no second
 * chance — and at least one member does not. That last condition is the card: a team
 * everybody writes off is a fact about the draw, and a team nobody writes off has no
 * story in it either. It is the split that makes it worth printing, and the believers
 * are the half of it worth naming.
 *
 * Teams level on both counts are all shown, and each gets its own sentence naming who
 * still backs it: one sentence could not say who backed which. There is no cap on how
 * many — a league that has written off four teams bar one believer each is a card worth
 * printing in full, and the tile shows the first four crests either way.
 *
 * Null where the format has no bands to drop out of — a domestic league's table means
 * plenty, but not this — and null while nobody is written off, or everybody is.
 */
export function lastBelieverCard(
  predictions: LiveStatsTablePrediction[],
  teams: LiveStatsTeam[],
  eliminationFrom: number | null,
  lang: LiveStatsLang,
): UserStatCardData | null {
  if (!eliminationFrom || eliminationFrom < 1) return null;

  const byId = indexTeams(teams);
  interface Verdict {
    team: Entrant;
    writtenOff: number;
    believers: CardMember[];
    ranked: number;
  }
  const verdicts = new Map<string, Verdict>();
  for (const prediction of predictions) {
    prediction.orderedTeamIds.forEach((teamId, index) => {
      // A team that has left the tournament is left out of every count, the same way
      // countEnd drops one: the sentence has to be able to name its subject.
      const team = byId.get(teamId);
      if (!team) return;
      const verdict = verdicts.get(teamId) ?? { team, writtenOff: 0, believers: [], ranked: 0 };
      verdict.ranked += 1;
      if (index + 1 >= eliminationFrom) verdict.writtenOff += 1;
      else verdict.believers.push(prediction);
      verdicts.set(teamId, verdict);
    });
  }

  const candidates = [...verdicts.values()].filter(v => v.writtenOff > 0 && v.believers.length > 0);
  if (candidates.length === 0) return null;

  const mostWrittenOff = Math.max(...candidates.map(v => v.writtenOff));
  const level = candidates.filter(v => v.writtenOff === mostWrittenOff);
  const fewestBelievers = Math.min(...level.map(v => v.believers.length));
  const tied = level
    .filter(v => v.believers.length === fewestBelievers)
    .sort((a, b) => a.team.name.localeCompare(b.team.name));

  // Every team level on both counts is shown, whoever believes in them. Two teams with
  // different believers are two stories, so they get a sentence each rather than one
  // sentence that could not say who backed which.
  const winners = tied;
  const { writtenOff, ranked } = winners[0];
  const names = joinNames(winners.map(w => w.team.name), lang);
  const single = winners.length === 1;

  /** "Alice is the only one with Viking going through", once per team. */
  const believedBy = (verdict: Verdict): string => {
    const believers = dedupeByUser(verdict.believers);
    const who = joinNames(believers.map(b => b.username), lang);
    const alone = believers.length === 1;
    // With one team on the card its name has just been printed, so the sentence says
    // "them"; with several it has to say which of them it means.
    const team = single
      ? lang === 'no'
        ? 'dem'
        : lang === 'de'
          ? 'sie'
          : 'them'
      : `**${verdict.team.name}**`;

    return lang === 'no'
      ? alone
        ? `**${who}** er den eneste som har tippet ${team} videre.`
        : `Bare **${who}** har tippet ${team} videre.`
      : lang === 'de'
        ? alone
          ? `**${who}** ist die einzige Person, die ${team} weiterkommen sieht.`
          : `Nur **${who}** sehen ${team} weiterkommen.`
        : alone
          ? `**${who}** is the only one with ${team} going through.`
          : `Only **${who}** have ${team} going through.`;
  };

  const title =
    lang === 'no' ? 'Den siste troende' : lang === 'de' ? 'Der letzte Gläubige' : 'The last believer';

  const opening =
    lang === 'no'
      ? `**${writtenOff}** av **${ranked}** har tippet at **${names}** ryker rett ut.`
      : lang === 'de'
        ? `**${writtenOff}** von **${ranked}** tippen **${names}** auf den direkten Abgang.`
        : `**${writtenOff}** of **${ranked}** have **${names}** dropping straight out.`;

  const statistic = [opening, ...winners.map(believedBy)].join(' ');

  return card('lastBeliever', title, statistic, winners.map(w => w.team), 'team');
}


// ── The top-scorer pair ───────────────────────────────────────────────────────

/** The player the most members expect to score the most. */
export function goldenBootCard(
  predictions: LiveStatsScorerPrediction[],
  players: LiveStatsPlayer[],
  lang: LiveStatsLang,
): UserStatCardData | null {
  const result = countEnd(predictions.map(p => p.orderedPlayerIds), indexPlayers(players), 'top');
  if (!result) return null;

  const { winners, count, total } = result;
  const names = joinNames(winners.map(w => w.name), lang);
  const tied = winners.length > 1;

  const title = lang === 'no' ? 'Gullstøvelen' : lang === 'de' ? 'Der Goldene Schuh' : 'The golden boot';

  const statistic =
    lang === 'no'
      ? tied
        ? `**${names}** er tippet øverst på toppscorerlisten i **${count}** lister hver, av **${total}**.`
        : `**${names}** er tippet øverst på toppscorerlisten i **${count}** av **${total}** lister.`
      : lang === 'de'
        ? tied
          ? `**${names}** stehen in je **${count}** von **${total}** Torjägerlisten ganz oben.`
          : `**${names}** steht in **${count}** von **${total}** Torjägerlisten ganz oben.`
        : tied
          ? `**${names}** each top the scorer list in **${count}** of **${total}** rankings.`
          : `**${names}** tops the scorer list in **${count}** of **${total}** rankings.`;

  return card('goldenBoot', title, statistic, winners, 'player');
}

/** The mirror: the player the most members expect to score the fewest. */
export function goalDroughtCard(
  predictions: LiveStatsScorerPrediction[],
  players: LiveStatsPlayer[],
  lang: LiveStatsLang,
): UserStatCardData | null {
  const result = countEnd(predictions.map(p => p.orderedPlayerIds), indexPlayers(players), 'bottom');
  if (!result) return null;

  const { winners, count, total } = result;
  const names = joinNames(winners.map(w => w.name), lang);
  const tied = winners.length > 1;

  const title = lang === 'no' ? 'Null tillit' : lang === 'de' ? 'Kein Vertrauen' : 'No confidence';

  const statistic =
    lang === 'no'
      ? tied
        ? `Forventningene er lave for **${names}**. **${count}** av **${total}** har tippet at hver av dem scorer færrest mål på toppscorerlista.`
        : `Forventningene er lave for **${names}**. **${count}** av **${total}** har tippet at han scorer færrest mål på toppscorerlista.`
      : lang === 'de'
        ? tied
          ? `Die Erwartungen an **${names}** sind gering. **${count}** von **${total}** tippen jeden von ihnen auf die wenigsten Tore der Torjägerliste.`
          : `Die Erwartungen an **${names}** sind gering. **${count}** von **${total}** tippen ihn auf die wenigsten Tore der Torjägerliste.`
        : tied
          ? `Expectations are low for **${names}**. **${count}** of **${total}** have each of them scoring the fewest goals on the top-scorer list.`
          : `Expectations are low for **${names}**. **${count}** of **${total}** have him scoring the fewest goals on the top-scorer list.`;

  return card('goalDrought', title, statistic, winners, 'player');
}


// ── In Haaland we trust ───────────────────────────────────────────────────────

/**
 * Who the card is about, matched on surname alone.
 *
 * The provider spells him "Erling Haaland" and has spelled him "Erling Braut Haaland";
 * a Norwegian league will only ever have one of him, so the surname is the safe half to
 * look for. One line to change to follow somebody else around.
 */
const TRUSTED_SURNAME = 'haaland';

function findTrusted(players: LiveStatsPlayer[]): LiveStatsPlayer | null {
  return (
    players
      .filter(p => p.name.toLowerCase().includes(TRUSTED_SURNAME))
      // Sorted so two spellings of the same man cannot make the card flicker between them.
      .sort((a, b) => a.name.localeCompare(b.name))[0] ?? null
  );
}

/** 1st, 2nd, 3rd, 4th … 11th, 21st. English is the only one of the three that needs this. */
function ordinal(n: number): string {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/**
 * How much of the league is backing Haaland for the golden boot, and who is not.
 *
 * The denominator is the rankings that place him at all: one saved before he joined the
 * shortlist has no opinion about him to count, in either half of the sentence.
 *
 * The second sentence goes when the lowest anybody has him is first place — with the
 * whole league behind him there is nobody with "least faith", only the same fact said
 * twice.
 *
 * Null where he is not in the tournament, or where nobody has ranked him: the card is a
 * running joke about one player, not a slot that has to be filled.
 */
export function inHaalandWeTrustCard(
  predictions: LiveStatsScorerPrediction[],
  players: LiveStatsPlayer[],
  lang: LiveStatsLang,
): UserStatCardData | null {
  const haaland = findTrusted(players);
  if (!haaland) return null;

  const ranked = predictions
    .map(p => ({ prediction: p, place: p.orderedPlayerIds.indexOf(haaland.id) + 1 }))
    .filter(r => r.place > 0);
  if (ranked.length === 0) return null;

  const total = ranked.length;
  const believers = ranked.filter(r => r.place === 1).length;
  const lowest = Math.max(...ranked.map(r => r.place));
  const doubters = dedupeByUser(
    ranked.filter(r => r.place === lowest).map(r => r.prediction),
  );
  const names = joinNames(doubters.map(d => d.username), lang);
  const one = doubters.length === 1;

  const doubt =
    lowest === 1
      ? ''
      : lang === 'no'
        ? ` ${one ? 'Brukeren' : 'Brukerne'} som har minst tro på Brauten er **${names}**, som tippet at Haaland ender på **${lowest}. plass** på toppscorerlisten.`
        : lang === 'de'
          ? ` Am wenigsten ${one ? 'glaubt' : 'glauben'} **${names}** an ihn — auf **Platz ${lowest}** der Torjägerliste.`
          : ` The ${one ? 'one' : 'ones'} with the least faith in him: **${names}**, who put him **${ordinal(lowest)}** on the top-scorer list.`;

  const statistic =
    (lang === 'no'
      ? `**${believers}** av **${total}** har tippet at Haaland blir toppscorer!`
      : lang === 'de'
        ? `**${believers}** von **${total}** tippen Haaland als Torschützenkönig!`
        : `**${believers}** of **${total}** have Haaland finishing as top scorer!`) + doubt;

  // The same title everywhere, because it is a slogan rather than a sentence.
  return card('inHaalandWeTrust', 'In Haaland we trust', statistic, [
    { id: haaland.id, name: haaland.name, imageUrl: haaland.imageUrl },
  ], 'player');
}

// ── The member pair ───────────────────────────────────────────────────────────
//
// The only two cards about the members themselves rather than about what the league
// thinks of the teams: who calls the scoreline outright most often, and who keeps
// landing on the right margin and the wrong scoreline. Both are read off the same tally,
// so a member counted by one is counted the same way by the other.

/**
 * One scored prediction, paired with the result it was scored against.
 *
 * The predicted and actual scores travel rather than the stored tier columns, because
 * those hold *points*, and a competition is free to configure a tier at zero — which
 * would turn "got the goal difference right" into "got the goal difference right in a
 * competition that pays for it". The comparisons below are the same ones
 * calculateLivePoints makes; see server/src/live/scoring.ts.
 */
export interface LiveStatsScoredPrediction {
  userId: string;
  username: string;
  imageUrl: string | null;
  iconColor: string | null;
  /** Which fixture it was made on — the prediction pair below groups by it. */
  fixtureId: string;
  /** Null only where the provider has not named the teams yet; see liveFixtures. */
  homeTeamId: string | null;
  awayTeamId: string | null;
  predictedHome: number;
  predictedAway: number;
  /** End of normal time — the score the tiers are judged against. */
  actualHome: number;
  actualAway: number;
  /** What it was awarded, multiplier bonus included: the leaderboard's own number. */
  points: number;
}

/** The three tiers, asked of one prediction. Nested, exactly as calculateLivePoints has them. */
const rightOutcome = (p: LiveStatsScoredPrediction): boolean =>
  Math.sign(p.actualHome - p.actualAway) === Math.sign(p.predictedHome - p.predictedAway);

const rightGoalDifference = (p: LiveStatsScoredPrediction): boolean =>
  p.actualHome - p.actualAway === p.predictedHome - p.predictedAway;

const rightScore = (p: LiveStatsScoredPrediction): boolean =>
  p.predictedHome === p.actualHome && p.predictedAway === p.actualAway;

/** How far the predicted margin was from the real one: 0-4 on a 3-0 is seven goals out. */
const goalDifferenceGap = (p: LiveStatsScoredPrediction): number =>
  Math.abs(p.predictedHome - p.predictedAway - (p.actualHome - p.actualAway));

/** What one member's scored predictions add up to. */
interface MemberTally extends CardMember {
  /** Every scored prediction they have made, right or wrong. */
  predictions: number;
  goalDifferences: number;
  /**
   * Counted inside `goalDifferences` rather than against it, because that is how the
   * tiers stack: an exact scoreline necessarily has the right margin too.
   */
  exactScores: number;
}

function tallyMembers(predictions: LiveStatsScoredPrediction[]): MemberTally[] {
  const tallies = new Map<string, MemberTally>();
  for (const p of predictions) {
    const tally: MemberTally = tallies.get(p.userId) ?? {
      userId: p.userId,
      username: p.username,
      imageUrl: p.imageUrl,
      iconColor: p.iconColor,
      predictions: 0,
      goalDifferences: 0,
      exactScores: 0,
    };
    tally.predictions += 1;
    if (rightGoalDifference(p)) {
      tally.goalDifferences += 1;
      if (rightScore(p)) tally.exactScores += 1;
    }
    tallies.set(p.userId, tally);
  }
  return [...tallies.values()];
}

/**
 * The member who has called the most scorelines outright — and, at the other end, the
 * one who has called the fewest.
 *
 * Ties are shown rather than broken at both ends, as everywhere else in the deck: two
 * members level on the only number the card counts are level.
 *
 * The second sentence is dropped when everybody is level, which includes a league of
 * one: naming the same member as both the best and the worst of them is not a contrast,
 * it is the same fact twice.
 *
 * Null until somebody has called one: a card announcing nobody's zero is not a statistic.
 */
export function spotOnCard(
  predictions: LiveStatsScoredPrediction[],
  lang: LiveStatsLang,
): UserStatCardData | null {
  const everyone = tallyMembers(predictions);
  const rows = everyone.filter(r => r.exactScores > 0);
  if (rows.length === 0) return null;

  const exactScores = Math.max(...rows.map(r => r.exactScores));
  const winners = rows.filter(r => r.exactScores === exactScores).sort(byUsername);

  // Counted over everyone who has predicted, not only those who have called one: nobody
  // has fewer perfect scorelines than the member who has never managed any.
  const fewest = Math.min(...everyone.map(r => r.exactScores));
  const trailers =
    fewest === exactScores ? [] : everyone.filter(r => r.exactScores === fewest).sort(byUsername);

  const names = joinNames(winners.map(w => w.username), lang);
  const trailerNames = joinNames(trailers.map(t => t.username), lang);
  const tied = winners.length > 1;

  const title =
    lang === 'no'
      ? 'Sitter med fasiten i hånden'
      : lang === 'de'
        ? 'Mit dem Lösungsblatt in der Hand'
        : 'Holding the answer key';

  // One exact scoreline is a real card — somebody has to be first — so every sentence
  // below has to read in the singular as well as the plural.
  const one = exactScores === 1;
  const scorelines = one ? 'perfect scoreline' : 'perfect scorelines';
  const resultater = one ? 'perfekt resultat' : 'perfekte resultater';
  const ergebnisse = one ? 'perfektes Ergebnis' : 'perfekte Ergebnisse';

  const fewestOne = fewest === 1;
  const fewestScorelines = fewestOne ? 'perfect scoreline' : 'perfect scorelines';
  const fulltreffere = fewestOne ? 'fulltreffer' : 'fulltreffere';
  const fewestErgebnisse = fewestOne ? 'perfekten Ergebnis' : 'perfekten Ergebnissen';

  const statistic =
    lang === 'no'
      ? `**${names}** har tippet hele **${exactScores}** ${resultater}${tied ? ' hver' : ''}!` +
        (trailers.length > 0
          ? ` **${trailerNames}** har færrest med **${fewest}** ${fulltreffere}.`
          : '')
      : lang === 'de'
        ? `**${names}** ${tied ? 'haben je' : 'hat'} ganze **${exactScores}** ${ergebnisse} getippt!` +
          (trailers.length > 0
            ? ` **${trailerNames}** ${trailers.length > 1 ? 'haben' : 'hat'} mit **${fewest}** ${fewestErgebnisse} die wenigsten.`
            : '')
        : `**${names}** ${tied ? 'have each' : 'has'} predicted a full **${exactScores}** ${scorelines}!` +
          (trailers.length > 0
            ? ` **${trailerNames}** ${trailers.length > 1 ? 'have' : 'has'} the fewest with **${fewest}** ${fewestScorelines}.`
            : '');

  return memberCard('spotOn', title, statistic, winners);
}

/**
 * The mirror: the member who reads the match right and the scoreline wrong. Most
 * predictions with the goal difference correct, and — among those level on that — the
 * fewest that landed on the exact scoreline.
 *
 * Two keys in that order, rather than the widest gap between the two counts, because
 * that is the statistic the card claims to show. It does mean a prolific predictor who
 * also hits a few scorelines outranks a quieter one who hits none; the second key is
 * what separates them once they are level, and the sentence prints both numbers so the
 * card can be read either way.
 *
 * Null until somebody has had a goal difference right — a card that names nobody, or
 * names somebody with nothing to their name, is not a statistic.
 */
export function almostCard(
  predictions: LiveStatsScoredPrediction[],
  lang: LiveStatsLang,
): UserStatCardData | null {
  const rows = tallyMembers(predictions).filter(r => r.goalDifferences > 0);
  if (rows.length === 0) return null;

  const goalDifferences = Math.max(...rows.map(r => r.goalDifferences));
  const contenders = rows.filter(r => r.goalDifferences === goalDifferences);
  const exactScores = Math.min(...contenders.map(r => r.exactScores));
  // Level on both counts is a genuine tie, and shown as one.
  const winners = contenders.filter(r => r.exactScores === exactScores).sort(byUsername);

  const names = joinNames(winners.map(w => w.username), lang);
  const tied = winners.length > 1;
  const none = exactScores === 0;

  const title = lang === 'no' ? 'Nesten' : lang === 'de' ? 'Fast' : 'Almost';

  const one = exactScores === 1;
  const kamper = goalDifferences === 1 ? 'kamp' : 'kamper';
  const spiele = goalDifferences === 1 ? 'Spiel' : 'Spielen';
  const matches = goalDifferences === 1 ? 'match' : 'matches';
  const resultater = one ? 'eksakt resultat' : 'eksakte resultater';
  const ergebnisse = one ? 'exaktes Ergebnis' : 'exakte Ergebnisse';
  const scorelines = one ? 'exact scoreline' : 'exact scorelines';

  const statistic =
    lang === 'no'
      ? `**${names}** har rett målforskjell i **${goalDifferences}** ${kamper}${
          tied ? ' hver' : ''
        }, ` +
        (none
          ? 'uten et eneste eksakt resultat.'
          : `men bare **${exactScores}** ${resultater}${tied ? ' hver' : ''}.`)
      : lang === 'de'
        ? `**${names}** ${tied ? 'haben in je' : 'hat in'} **${goalDifferences}** ${spiele} die Tordifferenz getroffen, ` +
          (none
            ? 'aber kein einziges exaktes Ergebnis.'
            : `aber nur ${tied ? 'je ' : ''}**${exactScores}** ${ergebnisse}.`)
        : `**${names}** ${tied ? 'each have' : 'has'} the goal difference right in **${goalDifferences}** ${matches}, ` +
          (none
            ? 'without a single exact scoreline.'
            : `with only **${exactScores}** ${scorelines}${tied ? ' each' : ''}.`);

  return memberCard('almost', title, statistic, winners);
}


// ── The prediction pair ───────────────────────────────────────────────────────
//
// The two cards about a single prediction rather than a member's season: the one nobody
// else saw coming, and the one that missed by the most goals. Both name the member who
// made it, because that is whose story it is; the fixture is in the sentence.

/** "Arsenal 3-1 Bayern" for the best card, "Arsenal vs Bayern" for the worst. */
function teamNames(
  p: LiveStatsScoredPrediction,
  byId: Map<string, Entrant>,
): { home: string; away: string } | null {
  const home = p.homeTeamId ? byId.get(p.homeTeamId) : null;
  const away = p.awayTeamId ? byId.get(p.awayTeamId) : null;
  // A fixture whose teams are not both known is still eligible — it was played and
  // scored like any other — but the sentence names the scoreline alone rather than
  // printing a placeholder where a club should be.
  return home && away ? { home: home.name, away: away.name } : null;
}

interface BestPrediction {
  winner: LiveStatsScoredPrediction;
  /** Members other than the winner who had the margin right, and who had the winner right. */
  othersWithGoalDifference: number;
  othersWithOutcome: number;
}

/**
 * The prediction only one member saw: the fixture where exactly one of them called the
 * scoreline, and fewest of the others managed even the goal difference. Where several
 * fixtures are level on that, the one where fewest of the others so much as picked the
 * winner — which is the question the second tier asks, one rung further down.
 *
 * "Others" excludes the member who called it, on both counts. They necessarily have the
 * goal difference and the outcome too, and counting themselves would mean no fixture
 * could ever reach the zero the card is looking for.
 *
 * A fixture two members both called exactly is not a candidate at all: the card is about
 * a prediction nobody else made, and the moment two people made it, it is neither
 * theirs alone nor a tie between them.
 *
 * Null when no fixture has exactly one exact scoreline on it.
 */
export function bestPredictionCard(
  predictions: LiveStatsScoredPrediction[],
  teams: LiveStatsTeam[],
  lang: LiveStatsLang,
): UserStatCardData | null {
  const byFixture = new Map<string, LiveStatsScoredPrediction[]>();
  for (const p of predictions) {
    const madeOnFixture = byFixture.get(p.fixtureId);
    if (madeOnFixture) madeOnFixture.push(p);
    else byFixture.set(p.fixtureId, [p]);
  }

  const candidates: BestPrediction[] = [];
  for (const madeOnFixture of byFixture.values()) {
    const exact = madeOnFixture.filter(rightScore);
    if (exact.length !== 1) continue;
    const winner = exact[0];
    const others = madeOnFixture.filter(p => p !== winner);
    candidates.push({
      winner,
      othersWithGoalDifference: others.filter(rightGoalDifference).length,
      othersWithOutcome: others.filter(rightOutcome).length,
    });
  }
  if (candidates.length === 0) return null;

  // Fewest others on the goal difference first; where that is level, fewest others on
  // the outcome. Negative when the first argument is the better story.
  const rank = (a: BestPrediction, b: BestPrediction): number =>
    a.othersWithGoalDifference !== b.othersWithGoalDifference
      ? a.othersWithGoalDifference - b.othersWithGoalDifference
      : a.othersWithOutcome - b.othersWithOutcome;
  const best = candidates.reduce((a, b) => (rank(b, a) < 0 ? b : a));
  const tie = candidates.filter(
    c =>
      c.othersWithGoalDifference === best.othersWithGoalDifference &&
      c.othersWithOutcome === best.othersWithOutcome,
  );

  const winners = dedupeByUser(tie.map(c => c.winner));
  const names = joinNames(winners.map(w => w.username), lang);
  const { othersWithGoalDifference: gd, othersWithOutcome: outcome } = best;

  const title =
    lang === 'no'
      ? 'Hvordan visste du det?'
      : lang === 'de'
        ? 'Woher wusstest du das?'
        : 'How did you know?';

  // Two fixtures level on both counts are two different stories, so a tie names no
  // fixture: only what every one of them has in common. And a tie can be one member
  // twice over, which "each" would not describe — hence three openings, not two.
  const alone = tie.length === 1;
  const named = alone ? teamNames(best.winner, indexTeams(teams)) : null;
  const score = `${best.winner.predictedHome}-${best.winner.predictedAway}`;
  // The fixture, scoreline and all — or the scoreline alone where the teams have no names
  // yet. It is what they predicted and what happened, those being the same thing here.
  const what = named ? `**${named.home} ${score} ${named.away}**` : `**${score}**`;

  // Three things can be said about how alone they were, and only one of them is true at a
  // time: somebody else had the margin, or nobody did but somebody had the winner, or
  // nobody managed even that.
  const appendix =
    lang === 'no'
      ? gd > 0
        ? ` Bare **${gd}** ${gd === 1 ? 'annen' : 'andre'} tippet i det hele tatt riktig målforskjell!`
        : outcome > 0
          ? ` Bare **${outcome}** ${outcome === 1 ? 'annen' : 'andre'} tippet i det hele tatt riktig utfall!`
          : ' Ingen andre tippet engang riktig utfall av kampen!'
      : lang === 'de'
        ? gd > 0
          ? ` Nur **${gd}** ${gd === 1 ? 'andere Person hatte' : 'andere hatten'} überhaupt die Tordifferenz!`
          : outcome > 0
            ? ` Nur **${outcome}** ${outcome === 1 ? 'andere Person lag' : 'andere lagen'} überhaupt beim Ausgang richtig!`
            : ' Niemand sonst lag auch nur beim Ausgang der Partie richtig!'
        : gd > 0
          ? ` Only **${gd}** ${gd === 1 ? 'other' : 'others'} even had the goal difference!`
          : outcome > 0
            ? ` Only **${outcome}** ${outcome === 1 ? 'other' : 'others'} even had the right outcome!`
            : ' Nobody else even got the outcome of the match right!';

  const statistic =
    lang === 'no'
      ? (alone
          ? `**${names}** var den eneste som tippet perfekt resultat for ${what}!`
          : winners.length === 1
            ? `**${names}** tippet perfekt resultat i **${tie.length}** kamper som ingen andre traff!`
            : `**${names}** tippet hver et perfekt resultat som ingen andre traff!`) + appendix
      : lang === 'de'
        ? (alone
            ? `**${names}** hat als einzige Person das perfekte Ergebnis für ${what} getippt!`
            : winners.length === 1
              ? `**${names}** hat in **${tie.length}** Spielen das perfekte Ergebnis getippt, das sonst niemand hatte!`
              : `**${names}** haben jeweils ein perfektes Ergebnis getippt, das sonst niemand hatte!`) +
          appendix
        : (alone
            ? `**${names}** was the only one to predict the perfect score for ${what}!`
            : winners.length === 1
              ? `**${names}** predicted the perfect score in **${tie.length}** matches nobody else got!`
              : `**${names}** each predicted a perfect score nobody else got!`) + appendix;

  return memberCard('bestPrediction', title, statistic, winners);
}

/**
 * The mirror: the prediction furthest from the goal difference that actually happened.
 * 0-4 on a match that finished 3-0 is seven goals out, and seven is the number the card
 * ranks on — not how many goals the scoreline missed by, which would make a wild 6-5 on
 * a 1-0 look worse than a backwards 0-4.
 *
 * Null when nobody was out at all, which is a league that has predicted every margin
 * correctly rather than a card worth showing.
 */
export function worstPredictionCard(
  predictions: LiveStatsScoredPrediction[],
  teams: LiveStatsTeam[],
  lang: LiveStatsLang,
): UserStatCardData | null {
  if (predictions.length === 0) return null;

  const gap = Math.max(...predictions.map(goalDifferenceGap));
  if (gap === 0) return null;

  const tie = predictions.filter(p => goalDifferenceGap(p) === gap);
  const winners = dedupeByUser(tie);
  const names = joinNames(winners.map(w => w.username), lang);

  const title =
    lang === 'no' ? 'Det var nesten da!' : lang === 'de' ? 'Knapp daneben!' : 'Close enough!';

  // One prediction is the story; a tie can only say that they are level, and a tie held by
  // one member alone says how many of theirs it took. The number of goals is what the card
  // ranks on rather than what it prints: "nobody has missed by more" is the claim, and it
  // is the one a tie has to soften, since the others in it missed by exactly as much.
  const alone = tie.length === 1;
  const worst = tie[0];
  const named = alone ? teamNames(worst, indexTeams(teams)) : null;
  const predicted = `${worst.predictedHome}-${worst.predictedAway}`;
  const actual = `${worst.actualHome}-${worst.actualAway}`;

  const statistic =
    lang === 'no'
      ? alone
        ? `**${names}** tippet **${predicted}** ${
            named ? `på **${named.home} mot ${named.away}**, som` : 'på en kamp som'
          } endte **${actual}**. Ingen andre har bommet så stort på en kamp!`
        : winners.length === 1
          ? `**${names}** har **${tie.length}** tips som bommer like stort. Ingen andre har bommet så stort på en kamp!`
          : `**${names}** har bommet like stort hver sin gang. Ingen andre har bommet mer på en kamp!`
      : lang === 'de'
        ? alone
          ? `**${names}** hat **${predicted}** ${
              named ? `bei **${named.home} gegen ${named.away}**` : 'bei einem Spiel'
            } getippt, das **${actual}** endete. Niemand sonst hat bei einem Spiel so danebengelegen!`
          : winners.length === 1
            ? `**${names}** hat **${tie.length}** Tipps, die genauso weit danebenliegen. Niemand sonst hat bei einem Spiel so danebengelegen!`
            : `**${names}** haben jeweils genauso weit danebengelegen. Niemand sonst hat bei einem Spiel weiter danebengelegen!`
        : alone
          ? `**${names}** predicted **${predicted}** ${
              named ? `in **${named.home} vs ${named.away}**, which` : 'in a match that'
            } finished **${actual}**. Nobody else has missed a match by that much!`
          : winners.length === 1
            ? `**${names}** has **${tie.length}** predictions that missed by just as much. Nobody else has missed a match by that much!`
            : `**${names}** have each missed a match by just as much. Nobody else has missed one by more!`;

  return memberCard('worstPrediction', title, statistic, winners);
}


// ── The result pair ───────────────────────────────────────────────────────────
//
// The manual type's two cards about a fixture rather than a member: the one the league
// called between them, and the one nobody saw coming. Their subjects are the two crests,
// so these are the only borrowed cards that do not picture a person.

/** "Arsenal to beat Bayern", "a draw" — the manual type's describeOutcome, word for word. */
function describeOutcome(
  home: string,
  away: string,
  homeScore: number,
  awayScore: number,
  lang: LiveStatsLang,
): string {
  if (lang === 'no') {
    if (homeScore > awayScore) return `at ${home} slo ${away}`;
    if (awayScore > homeScore) return `at ${away} slo ${home}`;
    return `uavgjort mellom ${home} og ${away}`;
  }
  if (lang === 'de') {
    if (homeScore > awayScore) return `dass ${home} gegen ${away} gewinnt`;
    if (awayScore > homeScore) return `dass ${away} gegen ${home} gewinnt`;
    return `ein Unentschieden zwischen ${home} und ${away}`;
  }
  if (homeScore > awayScore) return `${home} to beat ${away}`;
  if (awayScore > homeScore) return `${away} to beat ${home}`;
  return `${home} to draw against ${away}`;
}

/** One played fixture with everything predicted on it, in the order they were played. */
interface FixtureRound {
  fixtureId: string;
  home: string;
  away: string;
  homeTeamId: string;
  awayTeamId: string;
  actualHome: number;
  actualAway: number;
  predictions: LiveStatsScoredPrediction[];
}

/**
 * Every fixture that has been played and named, oldest first, with its predictions.
 *
 * A fixture whose teams the provider has not named cannot be described by either card —
 * both sentences are about who beat whom — so it is left out rather than printed with a
 * hole in it. Kickoff order comes from the progression, which is also the manual cards'
 * tie-break: where two fixtures are level, the earlier one is the story.
 */
function fixtureRounds(
  predictions: LiveStatsScoredPrediction[],
  teams: LiveStatsTeam[],
  progression: LeaderboardProgressionResponse | null,
): FixtureRound[] {
  if (!progression) return [];
  const byId = indexTeams(teams);
  const byFixture = new Map<string, LiveStatsScoredPrediction[]>();
  for (const p of predictions) {
    const madeOnFixture = byFixture.get(p.fixtureId);
    if (madeOnFixture) madeOnFixture.push(p);
    else byFixture.set(p.fixtureId, [p]);
  }

  const rounds: FixtureRound[] = [];
  for (const milestone of playedFixtures(progression)) {
    const madeOnFixture = byFixture.get(milestone.matchId);
    if (!madeOnFixture || madeOnFixture.length === 0) continue;
    const [first] = madeOnFixture;
    const names = teamNames(first, byId);
    if (!names || !first.homeTeamId || !first.awayTeamId) continue;
    rounds.push({
      fixtureId: milestone.matchId,
      home: names.home,
      away: names.away,
      homeTeamId: first.homeTeamId,
      awayTeamId: first.awayTeamId,
      actualHome: first.actualHome,
      actualAway: first.actualAway,
      predictions: madeOnFixture,
    });
  }
  return rounds;
}

/** The two crests, in kickoff order, as the card's subjects. */
function crests(round: FixtureRound, teams: LiveStatsTeam[]): UserStatCardData['subjects'] {
  const byId = indexTeams(teams);
  return [round.homeTeamId, round.awayTeamId]
    .map(id => byId.get(id))
    .filter((team): team is Entrant => !!team)
    .map(team => ({ type: 'team' as const, id: team.id, name: team.name, imageUrl: team.imageUrl }));
}

/**
 * The result nobody had: the fixture where not one member picked the winner, and where
 * somebody's prediction was furthest from the margin. The names on it are the biggest
 * group who made the same worst prediction — being wrong together is the funnier fact.
 *
 * Null while every played fixture has at least one member on the right outcome, which is
 * most of a season: this card is meant to be rare.
 */
export function mostUnexpectedResultCard(
  predictions: LiveStatsScoredPrediction[],
  teams: LiveStatsTeam[],
  progression: LeaderboardProgressionResponse | null,
  lang: LiveStatsLang,
): UserStatCardData | null {
  let shock: { round: FixtureRound; deviation: number } | null = null;
  for (const round of fixtureRounds(predictions, teams, progression)) {
    if (round.predictions.some(rightOutcome)) continue;
    const deviation = Math.max(...round.predictions.map(goalDifferenceGap));
    // Strictly greater, so the earliest of several level fixtures keeps the card.
    if (!shock || deviation > shock.deviation) shock = { round, deviation };
  }
  if (!shock) return null;

  const { round, deviation } = shock;
  const furthest = round.predictions.filter(p => goalDifferenceGap(p) === deviation);

  // Grouped by what they said, and the biggest group wins: one scoreline has to be named,
  // and the one the most of them agreed on is the one worth naming.
  const byScoreline = new Map<string, LiveStatsScoredPrediction[]>();
  for (const p of furthest) {
    const key = `${p.predictedHome}-${p.predictedAway}`;
    const group = byScoreline.get(key);
    if (group) group.push(p);
    else byScoreline.set(key, [p]);
  }
  const worst = [...byScoreline.values()].reduce((a, b) => (b.length > a.length ? b : a));
  const wrong = dedupeByUser(worst);

  const actual = describeOutcome(round.home, round.away, round.actualHome, round.actualAway, lang);
  const predicted = describeOutcome(
    round.home,
    round.away,
    worst[0].predictedHome,
    worst[0].predictedAway,
    lang,
  );
  const names = formatUserList(wrong.map(w => w.username), lang);
  const { predictedHome, predictedAway } = worst[0];

  const title =
    lang === 'no' ? 'Sjokkresultat' : lang === 'de' ? 'Schockresultat' : 'Most unexpected result';

  const statistic =
    lang === 'no'
      ? `Ingen tippet ${actual}! ${names} tippet til og med ${predicted} (${predictedHome}-${predictedAway})!`
      : lang === 'de'
        ? `Niemand hat ${actual} vorhergesagt! ${names} hat sogar ${predicted} (${predictedHome}-${predictedAway}) getippt!`
        : `No one predicted ${actual}! ${names} even predicted ${predicted} (${predictedHome} - ${predictedAway})!`;

  return {
    id: 'mostUnexpectedResult',
    title,
    statistic,
    subjects: crests(round, teams),
    linkType: null,
  };
}

/**
 * The result the league saw coming: the fixture whose predictions earned the most tier
 * points — outcomes, margins and scorelines at what this competition pays for them.
 *
 * The tiers rather than the points actually awarded, because a fixture the admin marked
 * as worth triple would otherwise win every time on the multiplier alone, which says
 * nothing about how obvious it was. The average in the sentence is the real points,
 * multiplier and all: that is what people took home.
 */
export function mostExpectedResultCard(
  predictions: LiveStatsScoredPrediction[],
  teams: LiveStatsTeam[],
  progression: LeaderboardProgressionResponse | null,
  config: LiveScoringConfig,
  lang: LiveStatsLang,
): UserStatCardData | null {
  let obvious: { round: FixtureRound; tierPoints: number } | null = null;
  for (const round of fixtureRounds(predictions, teams, progression)) {
    const outcomes = round.predictions.filter(rightOutcome).length;
    if (outcomes === 0) continue;
    const tierPoints =
      outcomes * config.correct_outcome +
      round.predictions.filter(rightGoalDifference).length * config.correct_goal_difference +
      round.predictions.filter(rightScore).length * config.exact_score;
    if (!obvious || tierPoints > obvious.tierPoints) obvious = { round, tierPoints };
  }
  if (!obvious) return null;

  const { round } = obvious;
  const outcomes = round.predictions.filter(rightOutcome).length;
  const exact = round.predictions.filter(rightScore).length;
  const average = (
    round.predictions.reduce((sum, p) => sum + p.points, 0) / round.predictions.length
  ).toFixed(2);

  // Whoever managed to come away with nothing from the most obvious result of the season
  // is the joke the manual card tells, and one point is the next-best punchline.
  const withNothing = dedupeByUser(round.predictions.filter(p => p.points === 0));
  const withOne = dedupeByUser(round.predictions.filter(p => p.points === 1));
  const appendix =
    withNothing.length > 0
      ? lang === 'no'
        ? ` Likevel sanket ${formatUserList(withNothing.map(u => u.username), lang)} 0 poeng.`
        : lang === 'de'
          ? ` Und trotzdem hat ${formatUserList(withNothing.map(u => u.username), lang)} 0 Punkte geholt. Wie?`
          : ` Still ${formatUserList(withNothing.map(u => u.username), lang)} earned 0 points.`
      : withOne.length >= 1 && withOne.length <= 4
        ? lang === 'no'
          ? ` Likevel sanket ${formatUserList(withOne.map(u => u.username), lang)} bare 1 poeng.`
          : lang === 'de'
            ? ` Und trotzdem hat ${formatUserList(withOne.map(u => u.username), lang)} nur 1 Punkt geholt. Traurig.`
            : ` Still ${formatUserList(withOne.map(u => u.username), lang)} earned only 1 point.`
        : '';

  const title =
    lang === 'no' ? 'Forventet resultat' : lang === 'de' ? 'Na klar!' : 'The most expected result';

  const statistic =
    (lang === 'no'
      ? `${round.home} mot ${round.away} (${round.actualHome}-${round.actualAway}) var det mest forutsigbare resultatet! Totalt tippet ${outcomes} ${outcomes === 1 ? 'spiller' : 'spillere'} riktig resultat, og ${exact} av dem tippet eksakt resultat! Hver spiller sanket i snitt ${average} poeng.`
      : lang === 'de'
        ? `${round.home} gegen ${round.away} (${round.actualHome}-${round.actualAway}) — so offensichtlich, dass sogar ein Blindgänger es hätte tippen können! ${outcomes} Leute lagen richtig, ${exact} davon sogar mit exaktem Ergebnis. Im Schnitt ${average} Punkte pro Person.`
        : `${round.home} vs ${round.away} (${round.actualHome} - ${round.actualAway}) was the most predictable outcome! A total of ${outcomes} ${outcomes === 1 ? 'user' : 'users'} predicted the correct result, and ${exact} of those predicted the exact score! Each user scored on average ${average} points.`) +
    appendix;

  return {
    id: 'mostPredictableResult',
    title,
    statistic,
    subjects: crests(round, teams),
    linkType: null,
  };
}


// ── Goals by nationality ──────────────────────────────────────────────────────

/** The country counted, and the flag shown for it. One line to change to count another. */
const NATIONALITY = 'Norway';
const NATIONALITY_FLAG = '/stat-flag-no.webp';

/**
 * The bonus question this card reads, matched on two words rather than on its exact text.
 *
 * It is typed in by an admin — "Hvor mange mål blir scoret av norske spillere?" today,
 * possibly with a different wording next season — so an exact match would leave the card
 * silently half-empty. A number question that mentions Norwegians and goals is the one.
 */
const NORWEGIAN_GOALS_QUESTION = ['norsk', 'mål'];

/** One member's answer to a number bonus question, with the member attached. */
export interface LiveStatsBonusAnswer extends CardMember {
  /** The question as the admin typed it — this card picks its own out by the words in it. */
  question: string;
  answer: string;
}

interface Guess extends CardMember {
  goals: number;
}

function norwegianGoalGuesses(answers: LiveStatsBonusAnswer[]): Guess[] {
  const guesses: Guess[] = [];
  for (const answer of answers) {
    const question = answer.question.toLowerCase();
    if (!NORWEGIAN_GOALS_QUESTION.every(word => question.includes(word))) continue;
    const goals = Number(answer.answer);
    // An answer that is not a number belongs to a question this card has misread, or to
    // one whose type an admin has since changed. Either way it cannot be averaged.
    if (!Number.isFinite(goals)) continue;
    guesses.push({
      userId: answer.userId,
      username: answer.username,
      imageUrl: answer.imageUrl,
      iconColor: answer.iconColor,
      goals,
    });
  }
  return guesses;
}

/**
 * What the league expects of the Norwegians, and what the Norwegians have managed.
 *
 * Two halves, and either can stand alone. The first is the bonus question — who backs
 * them hardest, who backs them least, and what the league guesses on average. The second
 * is what has actually been scored, read off the snapshot refreshLivePlayerGoals folds
 * out of the provider's scorer feed, so it is as fresh as the last sync and costs no
 * request of its own.
 *
 * Null only when neither half has anything: no answers to that question, and no goals.
 * A tournament where they have not scored yet still has a league arguing about it.
 *
 * When the feed came back truncated the total is a floor rather than a total, so the
 * sentence says "at least" instead of printing a number that reads as exact.
 */
export function nationalityGoalsCard(
  snapshot: LiveScorerNationalities | null,
  bonusAnswers: LiveStatsBonusAnswer[],
  lang: LiveStatsLang,
): UserStatCardData | null {
  // The provider spells its own country names and could reasonably change the casing, so
  // the key is matched case-insensitively rather than looked up directly.
  const entry = snapshot
    ? Object.entries(snapshot.byNationality).find(
        ([name]) => name.toLowerCase() === NATIONALITY.toLowerCase(),
      )?.[1]
    : undefined;
  const scored = entry && entry.goals > 0 ? entry : null;

  const guesses = norwegianGoalGuesses(bonusAnswers);
  if (guesses.length === 0 && !scored) return null;

  const title = lang === 'no' ? 'Heia Norge!' : lang === 'de' ? 'Los, Norwegen!' : 'Go Norway!';

  let statistic = '';

  if (guesses.length > 0) {
    const most = Math.max(...guesses.map(g => g.goals));
    const least = Math.min(...guesses.map(g => g.goals));
    const average = (guesses.reduce((sum, g) => sum + g.goals, 0) / guesses.length).toFixed(1);
    const believers = dedupeByUser(guesses.filter(g => g.goals === most));
    const doubters = dedupeByUser(guesses.filter(g => g.goals === least));
    const believerNames = joinNames(believers.map(b => b.username), lang);
    const doubterNames = joinNames(doubters.map(d => d.username), lang);
    // With one answer, or a league that all guessed the same, the two ends are the same
    // people saying the same number: there is no "meanwhile" to draw.
    const split = most !== least;

    statistic =
      lang === 'no'
        ? `**${believerNames}** har mest trua på de norske spillerne! De har tippet at de scorer totalt **${most}** mål i turneringen!` +
          (split
            ? ` Det er flest av samtlige! **${doubterNames}**, imidlertid, har tippet at det kun blir **${least}** norske mål i turneringen.`
            : '') +
          ` I gjennomsnitt er det tippet at norske spillere scorer til sammen **${average}** mål.`
        : lang === 'de'
          ? `**${believerNames}** glaubt am meisten an die norwegischen Spieler! Getippt sind insgesamt **${most}** Tore in diesem Wettbewerb!` +
            (split
              ? ` Mehr als alle anderen! **${doubterNames}** hingegen tippt nur **${least}** norwegische Tore.`
              : '') +
            ` Im Schnitt werden **${average}** norwegische Tore getippt.`
          : `**${believerNames}** ${believers.length === 1 ? 'has' : 'have'} the most faith in the Norwegian players! They have them scoring **${most}** goals in total this tournament!` +
            (split
              ? ` More than anybody else! **${doubterNames}**, meanwhile, ${doubters.length === 1 ? 'has' : 'have'} them managing only **${least}** Norwegian goals.`
              : '') +
            ` The average guess is **${average}** goals between them.`;
  }

  if (scored) {
    const { goals, players } = scored;
    const floor = snapshot!.truncated;
    // A blank line, so the two halves read as the two paragraphs they are. See
    // LiveUserStatCard, which keeps the break rather than collapsing it.
    const gap = statistic === '' ? '' : '\n\n';

    statistic +=
      lang === 'no'
        ? gap +
          `Så langt har norske spillere scoret **${floor ? `minst ${goals}` : goals}** mål seg imellom!` +
          (players === 1
            ? ' Alt sammen av **1** norsk målscorer.'
            : ` Fordelt på **${players}** forskjellige norske målscorere.`)
        : lang === 'de'
          ? gap +
            `Bisher haben Norweger **${floor ? `mindestens ${goals}` : goals}** Tore untereinander erzielt!` +
            (players === 1
              ? ' Alle von **1** norwegischen Torschützen.'
              : ` Verteilt auf **${players}** verschiedene norwegische Torschützen.`)
          : gap +
            `So far Norwegians have scored **${floor ? `at least ${goals}` : goals}** goals between them!` +
            (players === 1
              ? ' All of them by **1** Norwegian scorer.'
              : ` Spread across **${players}** different Norwegian scorers.`);
  }

  // The flag is the tile rather than a picture on it: a rectangle of solid colour fills a
  // card better than anything cropping could do to it, and there is no crest or face here
  // that a full bleed would cut in half. `backgroundImageUrl` is how the payload says so,
  // and it leaves `subjects` empty — the background is the whole picture.
  return {
    id: 'norwegianGoals',
    title,
    statistic,
    subjects: [],
    linkType: null,
    backgroundImageUrl: NATIONALITY_FLAG,
  };
}

/** Every card that has something to say, in the order they should be shown. */
export function buildLiveUserStats(
  input: {
    tablePredictions: LiveStatsTablePrediction[];
    teams: LiveStatsTeam[];
    /**
     * How many places qualify directly for the knockout — the top band of the table
     * stage. Null where the format has no bands.
     */
    directPlaces: number | null;
    /**
     * The position from which a team is out of the tournament outright — the bottom band
     * of the table stage. Null where the format has no bands.
     */
    eliminationFrom: number | null;
    scorerPredictions: LiveStatsScorerPrediction[];
    players: LiveStatsPlayer[];
    scoredPredictions: LiveStatsScoredPrediction[];
    progression: LeaderboardProgressionResponse | null;
    /** What this competition pays per tier — the expected-result card ranks on it. */
    scoringConfig: LiveScoringConfig;
    scorerNationalities: LiveScorerNationalities | null;
    /** Answers to the number bonus questions — the nationality card reads one of them. */
    bonusAnswers: LiveStatsBonusAnswer[];
  },
  lang: LiveStatsLang,
): UserStatCardData[] {
  const {
    tablePredictions,
    teams,
    directPlaces,
    eliminationFrom,
    scorerPredictions,
    players,
    scoredPredictions,
    progression,
    scoringConfig,
    scorerNationalities,
    bonusAnswers,
  } = input;
  return [
    theLeaderCard(progression, lang),
    bestFormCard(scoredPredictions, progression, lang),
    worstFormCard(scoredPredictions, progression, lang),
    theClimberCard(progression, lang),
    theFallerCard(progression, lang),
    peoplesFavouriteCard(tablePredictions, teams, lang),
    woodenSpoonCard(tablePredictions, teams, lang),
    deadCertCard(tablePredictions, teams, directPlaces, lang),
    lastBelieverCard(tablePredictions, teams, eliminationFrom, lang),
    goldenBootCard(scorerPredictions, players, lang),
    goalDroughtCard(scorerPredictions, players, lang),
    inHaalandWeTrustCard(scorerPredictions, players, lang),
    spotOnCard(scoredPredictions, lang),
    almostCard(scoredPredictions, lang),
    bestPredictionCard(scoredPredictions, teams, lang),
    worstPredictionCard(scoredPredictions, teams, lang),
    mostExpectedResultCard(scoredPredictions, teams, progression, scoringConfig, lang),
    mostUnexpectedResultCard(scoredPredictions, teams, progression, lang),
    nationalityGoalsCard(scorerNationalities, bonusAnswers, lang),
  ].filter((c): c is UserStatCardData => c !== null);
}
