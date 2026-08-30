import { eq, sql } from 'drizzle-orm';
import type { LiveProviderId } from '@tournament-predictor/shared';
import { db } from '../db/client';
import { liveFixtures, liveTeams, liveTournaments } from '../db/liveSchema';
import { getProvider } from './providers';
import type { ProviderProbe, ProviderProbeKey } from './providers/types';

// ── Why does this tournament have no fixtures? ────────────────────────────────
//
// "0 fixtures" has several causes that are indistinguishable from inside the app: a
// season the provider has not created, a season it has created without a match calendar
// yet, a `season=` filter that returns nothing while the data is there, a competition or
// season we have wrong, and a full sync that has simply never run since the draw.
//
// So rather than guess, this asks each provider endpoint separately and reports the
// answers verbatim next to what the database holds. Read-only on both sides: nothing is
// written, and a failed probe is data, not an error.
//
// A tournament that reads fixtures from a second provider is asked twice — once of each,
// with each provider's own identifier for the competition. Asking only the main one, as
// this did before the split existed, answers a question nobody asked: it reports on the
// provider that is not serving the fixtures.

/** Which of the causes above the probes point at. Rendered client-side. */
export type FixtureDiagnosisVerdict =
  | 'fixtures_available'
  | 'season_filter_hides_fixtures'
  | 'provider_has_no_fixtures'
  | 'season_not_published'
  | 'provider_unreachable'
  | 'never_fully_synced';

export interface FixtureDiagnosis {
  provider: string;
  providerCompetitionId: string;
  /** The fixture provider and its identifier, when they differ from the above. */
  fixtureProvider: string | null;
  fixtureProviderCompetitionId: string | null;
  season: string;
  /** What the database holds right now, for comparison with the probes. */
  storedFixtures: number;
  storedTeams: number;
  lastStructureSyncAt: string | null;
  lastSyncError: string | null;
  probes: ProviderProbe[];
  verdict: FixtureDiagnosisVerdict;
}

function byKey(probes: ProviderProbe[]): Map<ProviderProbeKey, ProviderProbe> {
  return new Map(probes.map(p => [p.key, p]));
}

/**
 * Read the probes.
 *
 * Ordered most-actionable first: fixtures we could have but do not is worth knowing
 * before anything else, and an unreachable provider makes every other reading worthless.
 */
export function verdictFrom(
  probes: ProviderProbe[],
  storedFixtures: number,
  lastStructureSyncAt: Date | null,
  /** Which provider's match probes decide the verdict. Defaults to all of them. */
  fixtureProviderId?: LiveProviderId,
): FixtureDiagnosisVerdict {
  // Only the fixture provider's answers say anything about missing fixtures. The other
  // provider's match list is reported for context — is it worth switching back yet? —
  // and must not be read as evidence either way.
  const matchProbes = byKey(
    fixtureProviderId === undefined
      ? probes
      : probes.filter(probe => (probe.provider ?? fixtureProviderId) === fixtureProviderId),
  );
  const p = byKey(probes);
  // A bigger page, when the provider honours one, is simply more of the same request.
  const paged = matchProbes.get('matches_paged');
  const seasonFiltered = matchProbes.get('matches_season');
  const filtered =
    (paged?.countForSeason ?? -1) > (seasonFiltered?.countForSeason ?? -1) ? paged : seasonFiltered;
  const unfiltered = matchProbes.get('matches_unfiltered');
  const teams = p.get('teams');
  const standings = p.get('standings');

  // Nothing answered at all: a bad key, a blocked host, or the provider being down.
  if (probes.every(probe => !probe.ok)) return 'provider_unreachable';
  // ...or nothing from the provider that serves fixtures, while the other one answers.
  if (
    fixtureProviderId !== undefined &&
    matchProbes.size > 0 &&
    [...matchProbes.values()].every(probe => !probe.ok)
  ) {
    return 'provider_unreachable';
  }

  if ((filtered?.countForSeason ?? 0) > 0) {
    // The provider has them on the endpoint the sync engine uses. If they are not in the
    // database, the sync has not run — not that the data is missing.
    return storedFixtures === 0 && !lastStructureSyncAt ? 'never_fully_synced' : 'fixtures_available';
  }

  if ((unfiltered?.countForSeason ?? 0) > 0) return 'season_filter_hides_fixtures';

  if ((teams?.count ?? 0) > 0 || (standings?.count ?? 0) > 0) return 'provider_has_no_fixtures';

  return 'season_not_published';
}

export async function diagnoseTournamentFixtures(tournamentId: string): Promise<FixtureDiagnosis> {
  const [tournament] = await db
    .select()
    .from(liveTournaments)
    .where(eq(liveTournaments.id, tournamentId));
  if (!tournament) throw new Error(`Live tournament not found: ${tournamentId}`);

  const [fixtures] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(liveFixtures)
    .where(eq(liveFixtures.liveTournamentId, tournament.id));
  const [teams] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(liveTeams)
    .where(eq(liveTeams.liveTournamentId, tournament.id));

  const fixtureProviderId: LiveProviderId = tournament.fixtureProvider ?? tournament.provider;
  const fixtureCompetitionId =
    tournament.fixtureProviderCompetitionId ?? tournament.providerCompetitionId;

  /** Stamp each probe with the adapter that answered it, so the two are told apart. */
  const stamp = (provider: LiveProviderId, probes: ProviderProbe[]): ProviderProbe[] =>
    probes.map(probe => ({ ...probe, provider }));

  const probes = stamp(
    tournament.provider,
    await getProvider(tournament.provider).probe(
      tournament.providerCompetitionId,
      tournament.season,
    ),
  );

  if (fixtureProviderId !== tournament.provider) {
    probes.push(
      ...stamp(
        fixtureProviderId,
        await getProvider(fixtureProviderId).probe(fixtureCompetitionId, tournament.season),
      ),
    );
  }

  const storedFixtures = fixtures?.count ?? 0;

  return {
    provider: tournament.provider,
    providerCompetitionId: tournament.providerCompetitionId,
    fixtureProvider: tournament.fixtureProvider,
    fixtureProviderCompetitionId: tournament.fixtureProviderCompetitionId,
    season: tournament.season,
    storedFixtures,
    storedTeams: teams?.count ?? 0,
    lastStructureSyncAt: tournament.lastStructureSyncAt?.toISOString() ?? null,
    lastSyncError: tournament.lastSyncError,
    probes,
    verdict: verdictFrom(probes, storedFixtures, tournament.lastStructureSyncAt, fixtureProviderId),
  };
}
