import type { UserStatCardData } from '@tournament-predictor/shared';

// ── User statistics for live competitions ─────────────────────────────────────
//
// The same cards the manual competition type shows, built from live data. The manual
// version composes them inline in its route (server/src/routes/competitions.ts) from a
// pile of already-loaded query results; this one keeps the composing pure and takes the
// rows as arguments, so each card can be pinned by a unit test without a database.
//
// Two cards so far, a matched pair: who the league thinks will win, and who it thinks
// will come last.

export type LiveStatsLang = 'en' | 'no' | 'de';

export interface LiveStatsTeam {
  id: string;
  name: string;
  crestUrl: string | null;
}

export interface LiveStatsTablePrediction {
  userId: string;
  orderedTeamIds: string[];
}

/** "A", "A and B", "A, B and C" — and the same in the other two locales. */
function joinNames(names: string[], lang: LiveStatsLang): string {
  if (names.length <= 1) return names[0] ?? '';
  const and = lang === 'no' ? 'og' : lang === 'de' ? 'und' : 'and';
  return `${names.slice(0, -1).join(', ')} ${and} ${names[names.length - 1]}`;
}

/**
 * Which team the most members put at one end of their table prediction, and how many of
 * them did. Null when nobody has predicted a table yet, or when every prediction puts a
 * team there that is no longer in the tournament: a card that cannot name a team is not a
 * statistic.
 *
 * Ties are shown rather than broken. There is no fair way to pick between two teams the
 * league feels the same way about, and "they are level" is the more interesting fact.
 */
function countEnd(
  predictions: LiveStatsTablePrediction[],
  teamById: Map<string, LiveStatsTeam>,
  end: 'top' | 'bottom',
): { winners: LiveStatsTeam[]; count: number; total: number } | null {
  const counts = new Map<string, number>();
  let total = 0;
  for (const prediction of predictions) {
    const ids = prediction.orderedTeamIds;
    const teamId = end === 'top' ? ids[0] : ids[ids.length - 1];
    // A prediction whose team at this end has since been dropped from the tournament is
    // left out of the denominator too, so the "x of y" it prints always adds up. The two
    // cards can therefore land on different totals, which is right: each counts what it
    // can still name.
    if (!teamId || !teamById.has(teamId)) continue;
    counts.set(teamId, (counts.get(teamId) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return null;

  const count = Math.max(...counts.values());
  return {
    // Sorted by name so a tie reads the same on every request.
    winners: [...counts.entries()]
      .filter(([, n]) => n === count)
      .map(([teamId]) => teamById.get(teamId)!)
      .sort((a, b) => a.name.localeCompare(b.name)),
    count,
    total,
  };
}

function card(
  id: string,
  title: string,
  statistic: string,
  winners: LiveStatsTeam[],
): UserStatCardData {
  return {
    id,
    title,
    statistic,
    subjects: winners.map(team => ({
      type: 'team' as const,
      id: team.id,
      name: team.name,
      imageUrl: team.crestUrl,
    })),
    // None of UserStatCard's link targets exist for a live competition, and the live card
    // renders the crests from `subjects` itself.
    linkType: null,
  };
}

/** The team the most members expect to finish top. */
export function peoplesFavouriteCard(
  predictions: LiveStatsTablePrediction[],
  teams: LiveStatsTeam[],
  lang: LiveStatsLang,
): UserStatCardData | null {
  const teamById = new Map(teams.map(team => [team.id, team]));
  const result = countEnd(predictions, teamById, 'top');
  if (!result) return null;

  const { winners, count, total } = result;
  const names = joinNames(winners.map(team => team.name), lang);
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

  return card('peoplesFavourite', title, statistic, winners);
}

/** The mirror: the team the most members expect to finish bottom. */
export function woodenSpoonCard(
  predictions: LiveStatsTablePrediction[],
  teams: LiveStatsTeam[],
  lang: LiveStatsLang,
): UserStatCardData | null {
  const teamById = new Map(teams.map(team => [team.id, team]));
  const result = countEnd(predictions, teamById, 'bottom');
  if (!result) return null;

  const { winners, count, total } = result;
  const names = joinNames(winners.map(team => team.name), lang);
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

  return card('woodenSpoon', title, statistic, winners);
}

/** Every card that has something to say, in the order they should be shown. */
export function buildLiveUserStats(
  predictions: LiveStatsTablePrediction[],
  teams: LiveStatsTeam[],
  lang: LiveStatsLang,
): UserStatCardData[] {
  return [
    peoplesFavouriteCard(predictions, teams, lang),
    woodenSpoonCard(predictions, teams, lang),
  ].filter(
    (card): card is UserStatCardData => card !== null,
  );
}
