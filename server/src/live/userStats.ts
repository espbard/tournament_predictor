import type { UserStatCardData } from '@tournament-predictor/shared';

// ── User statistics for live competitions ─────────────────────────────────────
//
// The same cards the manual competition type shows, built from live data. The manual
// version composes them inline in its route (server/src/routes/competitions.ts) from a
// pile of already-loaded query results; this one keeps the composing pure and takes the
// rows as arguments, so each card can be pinned by a unit test without a database.
//
// One card so far: who the league thinks will win.

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
 * The people's favourite — the team the most members put top of their table prediction.
 *
 * Null when nobody has predicted a table yet, or when every prediction leads with a team
 * that is no longer in the tournament: a card that cannot name a team is not a statistic.
 *
 * Ties are shown rather than broken. There is no fair way to pick between two teams the
 * league likes equally, and "they are level" is the more interesting fact anyway.
 */
export function peoplesFavouriteCard(
  predictions: LiveStatsTablePrediction[],
  teams: LiveStatsTeam[],
  lang: LiveStatsLang,
): UserStatCardData | null {
  const teamById = new Map(teams.map(team => [team.id, team]));

  const counts = new Map<string, number>();
  let total = 0;
  for (const prediction of predictions) {
    const first = prediction.orderedTeamIds[0];
    // A prediction whose leader has since been dropped from the tournament is left out of
    // the denominator too, so the "x of y" it prints always adds up.
    if (!first || !teamById.has(first)) continue;
    counts.set(first, (counts.get(first) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return null;

  const top = Math.max(...counts.values());
  // Sorted by name so a tie reads the same on every request.
  const winners = [...counts.entries()]
    .filter(([, count]) => count === top)
    .map(([teamId]) => teamById.get(teamId)!)
    .sort((a, b) => a.name.localeCompare(b.name));

  const names = joinNames(
    winners.map(team => team.name),
    lang,
  );
  const tied = winners.length > 1;

  const title =
    lang === 'no' ? 'Folkefavoritten' : lang === 'de' ? 'Der Publikumsliebling' : "The people's favourite";

  const statistic =
    lang === 'no'
      ? tied
        ? `**${names}** er tippet øverst på tabellen i **${top}** tabelltips hver, av **${total}**.`
        : `**${names}** er tippet øverst på tabellen i **${top}** av **${total}** tabelltips.`
      : lang === 'de'
        ? tied
          ? `**${names}** stehen in je **${top}** von **${total}** Tabellentipps ganz oben.`
          : `**${names}** steht in **${top}** von **${total}** Tabellentipps ganz oben.`
        : tied
          ? `**${names}** each top the table in **${top}** of **${total}** predictions.`
          : `**${names}** tops the table in **${top}** of **${total}** predictions.`;

  return {
    id: 'peoplesFavourite',
    title,
    statistic,
    subjects: winners.map(team => ({
      type: 'team' as const,
      id: team.id,
      name: team.name,
      imageUrl: team.crestUrl,
    })),
    // A crest is a logo on empty space, so a single winner goes in as the icon, which the
    // card letterboxes. The collage a tie falls back to crops to fill, which suits a
    // photograph and not a badge — but a tie is rare enough to live with.
    iconImageUrl: tied ? null : (winners[0].crestUrl ?? null),
    // None of UserStatCard's link targets exist for a live competition.
    linkType: null,
  };
}

/** Every card that has something to say, in the order they should be shown. */
export function buildLiveUserStats(
  predictions: LiveStatsTablePrediction[],
  teams: LiveStatsTeam[],
  lang: LiveStatsLang,
): UserStatCardData[] {
  return [peoplesFavouriteCard(predictions, teams, lang)].filter(
    (card): card is UserStatCardData => card !== null,
  );
}
