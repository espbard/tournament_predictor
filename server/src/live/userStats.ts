import type { LiveScorerNationalities, UserStatCardData } from '@tournament-predictor/shared';

// ── User statistics for live competitions ─────────────────────────────────────
//
// The same cards the manual competition type shows, built from live data. The manual
// version composes them inline in its route (server/src/routes/competitions.ts) from a
// pile of already-loaded query results; this one keeps the composing pure and takes the
// rows as arguments, so each card can be pinned by a unit test without a database.
//
// Two matched pairs, one per ranking the game asks for: who the league thinks will finish
// top and bottom of the league table, and who it thinks will finish top and bottom of the
// top-scorer list. All four are the same count — which entrant sits at one end of the most
// rankings — so they share countEnd and differ only in their wording.
//
// Then one card about the members themselves rather than what they predicted: who keeps
// landing on the right margin and the wrong scoreline.
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

export interface LiveStatsTablePrediction {
  userId: string;
  orderedTeamIds: string[];
}

export interface LiveStatsScorerPrediction {
  userId: string;
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

const indexTeams = (teams: LiveStatsTeam[]): Map<string, Entrant> =>
  new Map(teams.map(t => [t.id, { id: t.id, name: t.name, imageUrl: t.crestUrl }]));

const indexPlayers = (players: LiveStatsPlayer[]): Map<string, Entrant> =>
  new Map(players.map(p => [p.id, { id: p.id, name: p.name, imageUrl: p.imageUrl }]));

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
        ? `**${names}** er tippet øverst på tabellen i **${count}** tabelltips hver, av **${total}**.`
        : `**${names}** er tippet øverst på tabellen i **${count}** av **${total}** tabelltips.`
      : lang === 'de'
        ? tied
          ? `**${names}** stehen in je **${count}** von **${total}** Tabellentipps ganz oben.`
          : `**${names}** steht in **${count}** von **${total}** Tabellentipps ganz oben.`
        : tied
          ? `**${names}** each top the table in **${count}** of **${total}** predictions.`
          : `**${names}** tops the table in **${count}** of **${total}** predictions.`;

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

  const title = lang === 'no' ? 'Bunnfavoritten' : lang === 'de' ? 'Das Schlusslicht' : 'The wooden spoon';

  const statistic =
    lang === 'no'
      ? tied
        ? `**${names}** er tippet sist i **${count}** tabelltips hver, av **${total}**.`
        : `**${names}** er tippet sist i **${count}** av **${total}** tabelltips.`
      : lang === 'de'
        ? tied
          ? `**${names}** stehen in je **${count}** von **${total}** Tabellentipps ganz unten.`
          : `**${names}** steht in **${count}** von **${total}** Tabellentipps ganz unten.`
        : tied
          ? `**${names}** each finish bottom in **${count}** of **${total}** predictions.`
          : `**${names}** finishes bottom in **${count}** of **${total}** predictions.`;

  return card('woodenSpoon', title, statistic, winners, 'team');
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

  const title = lang === 'no' ? 'Måltørken' : lang === 'de' ? 'Die Torflaute' : 'The goal drought';

  const statistic =
    lang === 'no'
      ? tied
        ? `**${names}** er tippet sist på toppscorerlisten i **${count}** lister hver, av **${total}**.`
        : `**${names}** er tippet sist på toppscorerlisten i **${count}** av **${total}** lister.`
      : lang === 'de'
        ? tied
          ? `**${names}** stehen in je **${count}** von **${total}** Torjägerlisten ganz unten.`
          : `**${names}** steht in **${count}** von **${total}** Torjägerlisten ganz unten.`
        : tied
          ? `**${names}** each finish last on the scorer list in **${count}** of **${total}** rankings.`
          : `**${names}** finishes last on the scorer list in **${count}** of **${total}** rankings.`;

  return card('goalDrought', title, statistic, winners, 'player');
}


// ── Almost ────────────────────────────────────────────────────────────────────

/**
 * One scored prediction, paired with the result it was scored against.
 *
 * The predicted and actual scores travel rather than the stored tier columns, because
 * those hold *points*, and a competition is free to configure a tier at zero — which
 * would turn "got the goal difference right" into "got the goal difference right in a
 * competition that pays for it". The two comparisons below are the same ones
 * calculateLivePoints makes; see server/src/live/scoring.ts.
 */
export interface LiveStatsScoredPrediction {
  userId: string;
  username: string;
  imageUrl: string | null;
  iconColor: string | null;
  predictedHome: number;
  predictedAway: number;
  /** End of normal time — the score the tiers are judged against. */
  actualHome: number;
  actualAway: number;
}

interface AlmostTally {
  userId: string;
  username: string;
  imageUrl: string | null;
  iconColor: string | null;
  goalDifferences: number;
  exactScores: number;
}

/**
 * The member who reads the match right and the scoreline wrong: most predictions with
 * the goal difference correct, and — among those level on that — the fewest that landed
 * on the exact scoreline.
 *
 * Two keys in that order, rather than the widest gap between the two counts, because
 * that is the statistic the card claims to show. It does mean a prolific predictor who
 * also hits a few scorelines outranks a quieter one who hits none; the second key is
 * what separates them once they are level, and the sentence prints both numbers so the
 * card can be read either way.
 *
 * Exact scorelines are counted inside the goal-difference total, not against it, because
 * that is how the tiers stack: an exact scoreline necessarily has the right margin too.
 *
 * Null until somebody has had a goal difference right — a card that names nobody, or
 * names somebody with nothing to their name, is not a statistic.
 */
export function almostCard(
  predictions: LiveStatsScoredPrediction[],
  lang: LiveStatsLang,
): UserStatCardData | null {
  const tallies = new Map<string, AlmostTally>();
  for (const p of predictions) {
    if (p.actualHome - p.actualAway !== p.predictedHome - p.predictedAway) continue;
    const tally: AlmostTally = tallies.get(p.userId) ?? {
      userId: p.userId,
      username: p.username,
      imageUrl: p.imageUrl,
      iconColor: p.iconColor,
      goalDifferences: 0,
      exactScores: 0,
    };
    tally.goalDifferences += 1;
    if (p.predictedHome === p.actualHome && p.predictedAway === p.actualAway) {
      tally.exactScores += 1;
    }
    tallies.set(p.userId, tally);
  }
  if (tallies.size === 0) return null;

  const rows = [...tallies.values()];
  const goalDifferences = Math.max(...rows.map(r => r.goalDifferences));
  const contenders = rows.filter(r => r.goalDifferences === goalDifferences);
  const exactScores = Math.min(...contenders.map(r => r.exactScores));
  // Level on both counts is a genuine tie, and shown as one — same rule as countEnd.
  const winners = contenders
    .filter(r => r.exactScores === exactScores)
    .sort((a, b) => a.username.localeCompare(b.username));

  const names = joinNames(winners.map(w => w.username), lang);
  const tied = winners.length > 1;
  const none = exactScores === 0;

  const title = lang === 'no' ? 'Nesten' : lang === 'de' ? 'Fast' : 'Almost';

  const statistic =
    lang === 'no'
      ? `**${names}** har rett målforskjell i **${goalDifferences}** ${
          goalDifferences === 1 ? 'kamp' : 'kamper'
        }${tied ? ' hver' : ''}, ` +
        (none
          ? 'uten et eneste eksakt resultat.'
          : `men bare **${exactScores}** eksakt${exactScores === 1 ? '' : 'e'} resultat${
              exactScores === 1 ? '' : 'er'
            }${tied ? ' hver' : ''}.`)
      : lang === 'de'
        ? `**${names}** ${tied ? 'haben in je' : 'hat in'} **${goalDifferences}** ${
            goalDifferences === 1 ? 'Spiel' : 'Spielen'
          } die Tordifferenz getroffen, ` +
          (none
            ? 'aber kein einziges exaktes Ergebnis.'
            : `aber nur ${tied ? 'je ' : ''}**${exactScores}** exakte${
                exactScores === 1 ? 's Ergebnis' : ' Ergebnisse'
              }.`)
        : `**${names}** ${tied ? 'each have' : 'has'} the goal difference right in **${goalDifferences}** ${
            goalDifferences === 1 ? 'match' : 'matches'
          }, ` +
          (none
            ? 'without a single exact scoreline.'
            : `with only **${exactScores}** exact scoreline${exactScores === 1 ? '' : 's'}${
                tied ? ' each' : ''
              }.`);

  return {
    id: 'almost',
    title,
    statistic,
    // Built here rather than through `card()`: a member is the one subject that can have
    // no picture at all, and the live card falls back to their initial on `iconColor`.
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


// ── Goals by nationality ──────────────────────────────────────────────────────

/** The country counted, and the flag shown for it. One line to change to count another. */
const NATIONALITY = 'Norway';
const NATIONALITY_FLAG = '/stat-flag-no.webp';

/**
 * How many goals players of one country have scored in the tournament.
 *
 * Not a prediction card: this is what happened. It reads the snapshot
 * refreshLivePlayerGoals folds out of the provider's scorer feed, so it is as fresh as the
 * last structure sync and costs nothing to show.
 *
 * Null when there is no snapshot yet or the country has not scored — a card that would
 * read "0 goals" is not a statistic, it is a tournament that has not started.
 *
 * When the feed came back truncated the totals are floors rather than totals, so the
 * sentence says "at least" instead of printing a number that reads as exact.
 */
export function nationalityGoalsCard(
  snapshot: LiveScorerNationalities | null,
  lang: LiveStatsLang,
): UserStatCardData | null {
  if (!snapshot) return null;

  // The provider spells its own country names and could reasonably change the casing, so
  // the key is matched case-insensitively rather than looked up directly.
  const entry = Object.entries(snapshot.byNationality).find(
    ([name]) => name.toLowerCase() === NATIONALITY.toLowerCase(),
  )?.[1];
  if (!entry || entry.goals === 0) return null;

  const { goals, players } = entry;
  const floor = snapshot.truncated;

  const title =
    lang === 'no' ? 'Norske mål' : lang === 'de' ? 'Norwegische Tore' : 'Norwegian goals';

  const statistic =
    lang === 'no'
      ? (floor
          ? `Nordmenn har scoret **minst ${goals}** mål i turneringen`
          : `**${goals}** mål i turneringen er scoret av nordmenn`) +
        (players === 1 ? ', av **1** spiller.' : `, fordelt på **${players}** spillere.`)
      : lang === 'de'
        ? (floor
            ? `Norweger haben in diesem Wettbewerb **mindestens ${goals}** Tore erzielt`
            : `**${goals}** Tore in diesem Wettbewerb gehen auf das Konto von Norwegern`) +
          (players === 1 ? ' — **1** Spieler.' : ` — **${players}** verschiedene Spieler.`)
        : (floor
            ? `Norwegians have scored **at least ${goals}** goals in this tournament`
            : `**${goals}** goals in this tournament have been scored by Norwegians`) +
          (players === 1 ? ' — **1** player.' : ` — **${players}** different players.`);

  // A flag is a picture of the subject, not a photograph of one, so it is shown whole on
  // the light ground — the same treatment a crest gets. See UserStatSubject: `type` says
  // how to picture the subject, not what kind of thing it is.
  return card('norwegianGoals', title, statistic, [
    { id: NATIONALITY, name: NATIONALITY, imageUrl: NATIONALITY_FLAG },
  ], 'team');
}

/** Every card that has something to say, in the order they should be shown. */
export function buildLiveUserStats(
  input: {
    tablePredictions: LiveStatsTablePrediction[];
    teams: LiveStatsTeam[];
    scorerPredictions: LiveStatsScorerPrediction[];
    players: LiveStatsPlayer[];
    scoredPredictions: LiveStatsScoredPrediction[];
    scorerNationalities: LiveScorerNationalities | null;
  },
  lang: LiveStatsLang,
): UserStatCardData[] {
  const {
    tablePredictions,
    teams,
    scorerPredictions,
    players,
    scoredPredictions,
    scorerNationalities,
  } = input;
  return [
    peoplesFavouriteCard(tablePredictions, teams, lang),
    woodenSpoonCard(tablePredictions, teams, lang),
    goldenBootCard(scorerPredictions, players, lang),
    goalDroughtCard(scorerPredictions, players, lang),
    almostCard(scoredPredictions, lang),
    nationalityGoalsCard(scorerNationalities, lang),
  ].filter((c): c is UserStatCardData => c !== null);
}
