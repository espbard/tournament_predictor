import { describe, expect, it } from 'vitest';
import { verdictFrom } from './diagnostics';
import type { ProviderProbe, ProviderProbeKey } from './providers/types';

// Reading the probes is the part worth pinning: the requests themselves are the
// provider's business, but which conclusion a set of answers supports is ours, and
// getting it wrong sends an admin looking in the wrong place. Everything here is pure —
// see the plan's note that server/src/db/client.ts connects at import time.

function probe(key: ProviderProbeKey, over: Partial<ProviderProbe> = {}): ProviderProbe {
  return {
    key,
    url: `https://example.test/${key}`,
    status: 200,
    ok: true,
    count: 0,
    countForSeason: 0,
    detail: null,
    ...over,
  };
}

const failed = (key: ProviderProbeKey, status: number | null = 404): ProviderProbe =>
  probe(key, { status, ok: false, count: null, countForSeason: null });

const ALL_KEYS: ProviderProbeKey[] = [
  'competition',
  'matches_season',
  'matches_unfiltered',
  'teams',
  'standings',
];

const syncedAt = new Date('2026-08-29T10:00:00Z');

describe('verdictFrom', () => {
  it('reports fixtures as available when the season-filtered endpoint has them', () => {
    const probes = [
      probe('competition', { count: 40, countForSeason: 1 }),
      probe('matches_season', { count: 189, countForSeason: 189 }),
      probe('matches_unfiltered', { count: 189, countForSeason: 189 }),
      probe('teams', { count: 36, countForSeason: 36 }),
      probe('standings', { count: 36, countForSeason: 36 }),
    ];
    expect(verdictFrom(probes, 189, syncedAt)).toBe('fixtures_available');
  });

  // The trap this exists for: the data is there, nothing has pulled it, and the admin is
  // told the provider is at fault.
  it('blames the missing sync when the fixtures are there but nothing has synced', () => {
    const probes = [
      probe('matches_season', { count: 189, countForSeason: 189 }),
      probe('teams', { count: 36, countForSeason: 36 }),
    ];
    expect(verdictFrom(probes, 0, null)).toBe('never_fully_synced');
  });

  it('still says available when a full sync has run and the fixtures are stored', () => {
    const probes = [probe('matches_season', { count: 189, countForSeason: 189 })];
    expect(verdictFrom(probes, 0, syncedAt)).toBe('fixtures_available');
  });

  it('blames the season filter when only the unfiltered endpoint has the season', () => {
    const probes = [
      probe('competition', { count: 40, countForSeason: 1 }),
      probe('matches_season', { count: 0, countForSeason: 0 }),
      probe('matches_unfiltered', { count: 189, countForSeason: 189 }),
      probe('teams', { count: 36, countForSeason: 36 }),
    ];
    expect(verdictFrom(probes, 0, syncedAt)).toBe('season_filter_hides_fixtures');
  });

  // The unfiltered endpoint serves whatever the provider calls the current season, so
  // matches that are not this season's must not be read as this season's.
  it('ignores unfiltered matches that belong to another season', () => {
    const probes = [
      probe('matches_season', { count: 0, countForSeason: 0 }),
      probe('matches_unfiltered', { count: 380, countForSeason: 0 }),
      probe('teams', { count: 36, countForSeason: 36 }),
    ];
    expect(verdictFrom(probes, 0, syncedAt)).toBe('provider_has_no_fixtures');
  });

  it('blames the provider when the season exists with teams or a table but no matches', () => {
    const withTeams = [
      probe('matches_season', { count: 0, countForSeason: 0 }),
      probe('matches_unfiltered', { count: 0, countForSeason: 0 }),
      probe('teams', { count: 36, countForSeason: 36 }),
      probe('standings', { count: 0, countForSeason: 0 }),
    ];
    expect(verdictFrom(withTeams, 0, syncedAt)).toBe('provider_has_no_fixtures');

    const withTable = [
      probe('matches_season', { count: 0, countForSeason: 0 }),
      probe('teams', { count: 0, countForSeason: 0 }),
      probe('standings', { count: 36, countForSeason: 36 }),
    ];
    expect(verdictFrom(withTable, 0, syncedAt)).toBe('provider_has_no_fixtures');
  });

  it('reports an unpublished season when everything came back empty', () => {
    const probes = [
      probe('competition', { count: 40, countForSeason: 0 }),
      failed('matches_season'),
      probe('matches_unfiltered', { count: 0, countForSeason: 0 }),
      failed('teams'),
      failed('standings'),
    ];
    expect(verdictFrom(probes, 0, null)).toBe('season_not_published');
  });

  // A bad key 400s on every endpoint. Calling that "the provider has no fixtures" would
  // send an admin to wait for data that was never asked for successfully.
  it('reports the provider as unreachable when nothing answered', () => {
    const probes = ALL_KEYS.map(key => failed(key, 400));
    expect(verdictFrom(probes, 0, null)).toBe('provider_unreachable');
  });
});
