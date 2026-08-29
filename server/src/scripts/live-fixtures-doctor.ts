/**
 * Why does a live tournament have no fixtures?
 *
 * Answers exactly one question: is the provider missing the fixtures, or is the way we
 * ask for them wrong? The app cannot tell the two apart on its own — a season the
 * provider has not published, a season it has published without a match calendar, and a
 * `season=` filter that returns nothing all end up as the same "0 fixtures" in the admin
 * UI — so this asks every endpoint separately and prints a verdict.
 *
 * Usage, from the server workspace:
 *
 *   FOOTBALL_DATA_API_KEY=xxxxx npx tsx src/scripts/live-fixtures-doctor.ts
 *
 * or, with the key already in ../.env:
 *
 *   npm run live:doctor -w server
 *
 * Defaults to the Champions League 2026/27. Override with:
 *
 *   LIVE_DOCTOR_COMPETITION=PL LIVE_DOCTOR_SEASON=2026 LIVE_DOCTOR_FORMAT=domestic_league
 *
 * Read-only: nothing is written to the database, and the key is never printed.
 * Makes 5 requests, paced to stay inside the free tier's 10/minute limit.
 */

import { LIVE_FORMATS, type LiveFormatKey } from '@tournament-predictor/shared';

const BASE = 'https://api.football-data.org/v4';
const KEY = process.env.FOOTBALL_DATA_API_KEY;
const COMPETITION = process.env.LIVE_DOCTOR_COMPETITION ?? 'CL';
const SEASON = process.env.LIVE_DOCTOR_SEASON ?? '2026';
const FORMAT = (process.env.LIVE_DOCTOR_FORMAT ?? 'ucl_swiss') as LiveFormatKey;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Fetched {
  path: string;
  status: number;
  ok: boolean;
  body: any;
  /** The provider's own error message, on a non-2xx. */
  error: string | null;
}

let requestCount = 0;

async function get(path: string): Promise<Fetched> {
  // Free tier allows 10 requests/minute. 7s spacing keeps us well clear.
  if (requestCount > 0) await sleep(7000);
  requestCount++;

  const res = await fetch(`${BASE}${path}`, { headers: { 'X-Auth-Token': KEY! } });
  const text = await res.text().catch(() => '');
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  return {
    path,
    status: res.status,
    ok: res.ok,
    body,
    error: res.ok ? null : (body?.message ?? text.slice(0, 200) ?? res.statusText),
  };
}

function heading(text: string) {
  console.log(`\n${'─'.repeat(72)}\n${text}\n${'─'.repeat(72)}`);
}

function line(label: string, value: unknown) {
  console.log(`  ${label.padEnd(20)}: ${value}`);
}

/** Every provider stage string the format maps, so a stranded stage is visible. */
function mappedStages(): Set<string> {
  const out = new Set<string>();
  for (const stage of LIVE_FORMATS[FORMAT]?.stages ?? []) {
    for (const raw of stage.providerStages.football_data ?? []) out.add(raw.toUpperCase());
  }
  return out;
}

function describeMatches(matches: any[]): void {
  const stages = [...new Set(matches.map(m => m.stage).filter(Boolean))] as string[];
  const seasons = [...new Set(matches.map(m => String(m.season?.startDate ?? '').slice(0, 4)))]
    .filter(Boolean)
    .sort();
  const withTeams = matches.filter(m => m.homeTeam?.id != null && m.awayTeam?.id != null).length;
  const withDate = matches.filter(m => !!m.utcDate).length;
  const timed = matches.filter(m => m.status && m.status !== 'SCHEDULED').length;

  line('stages', stages.join(', ') || '(none)');
  line('seasons present', seasons.join(', ') || '(none)');
  line('both teams known', `${withTeams} of ${matches.length}`);
  line('kickoff date set', `${withDate} of ${matches.length}`);
  line('kickoff confirmed', `${timed} of ${matches.length} (status other than SCHEDULED)`);

  const mapping = mappedStages();
  const unmapped = stages.filter(s => !mapping.has(s.toUpperCase()));
  if (unmapped.length > 0) {
    line('!! UNMAPPED stages', `${unmapped.join(', ')} — these land with stage_key = null`);
  }

  const sample = matches[0];
  if (sample) {
    line(
      'sample',
      `${sample.homeTeam?.name ?? '?'} v ${sample.awayTeam?.name ?? '?'} — ` +
        `${sample.utcDate ?? 'no date'} — ${sample.status} — ${sample.stage} — md ${sample.matchday}`,
    );
  }
}

async function main() {
  if (!KEY) {
    console.error('FOOTBALL_DATA_API_KEY is not set.\n');
    console.error('Run one of:');
    console.error('  FOOTBALL_DATA_API_KEY=xxxxx npx tsx src/scripts/live-fixtures-doctor.ts');
    console.error('  npm run live:doctor -w server');
    process.exit(1);
  }
  if (!LIVE_FORMATS[FORMAT]) {
    console.error(`Unknown format "${FORMAT}". Expected one of: ${Object.keys(LIVE_FORMATS).join(', ')}`);
    process.exit(1);
  }

  console.log(`live fixtures doctor — competition ${COMPETITION}, season ${SEASON}, format ${FORMAT}`);

  // ── 1. Does the provider know about this season at all? ─────────────────────
  heading(`1. GET /competitions/${COMPETITION}`);
  const competition = await get(`/competitions/${COMPETITION}`);
  let seasonExists: boolean | null = null;

  if (!competition.ok) {
    line('!! failed', `${competition.status} ${competition.error}`);
  } else {
    const seasons: any[] = competition.body?.seasons ?? [];
    const years = seasons
      .map(s => String(s.startDate ?? '').slice(0, 4))
      .filter(Boolean);
    seasonExists = years.includes(SEASON);
    line('competition', competition.body?.name);
    line('current season', competition.body?.currentSeason?.startDate ?? '(none)');
    line('seasons listed', years.slice(0, 8).join(', ') + (years.length > 8 ? ` … (${years.length})` : ''));
    line(`season ${SEASON}`, seasonExists ? 'EXISTS at the provider' : 'NOT listed by the provider');
  }

  // ── 2. The request the sync engine actually makes ───────────────────────────
  heading(`2. GET /competitions/${COMPETITION}/matches?season=${SEASON}   ← what syncing uses`);
  const filtered = await get(`/competitions/${COMPETITION}/matches?season=${SEASON}`);
  const filteredMatches: any[] = filtered.body?.matches ?? [];

  if (!filtered.ok) {
    line('!! failed', `${filtered.status} ${filtered.error}`);
    if (filtered.status === 404) {
      line('meaning', 'the sync engine reads a 404 here as "season not published yet"');
    }
  } else {
    line('resultSet', JSON.stringify(filtered.body?.resultSet ?? {}));
    line('filters echoed', JSON.stringify(filtered.body?.filters ?? {}));
    line('matches', filteredMatches.length);
    if (filteredMatches.length > 0) describeMatches(filteredMatches);
  }

  // ── 3. The same endpoint with no season filter ──────────────────────────────
  heading(`3. GET /competitions/${COMPETITION}/matches   ← unfiltered, serves the current season`);
  const unfiltered = await get(`/competitions/${COMPETITION}/matches`);
  const unfilteredMatches: any[] = unfiltered.body?.matches ?? [];
  const unfilteredForSeason = unfilteredMatches.filter(
    m => String(m.season?.startDate ?? '').slice(0, 4) === SEASON,
  );

  if (!unfiltered.ok) {
    line('!! failed', `${unfiltered.status} ${unfiltered.error}`);
  } else {
    line('resultSet', JSON.stringify(unfiltered.body?.resultSet ?? {}));
    line('matches', unfilteredMatches.length);
    line(`of season ${SEASON}`, unfilteredForSeason.length);
    if (unfilteredForSeason.length > 0) describeMatches(unfilteredForSeason);
  }

  // ── 4 and 5. The two endpoints that are working, for contrast ───────────────
  heading(`4. GET /competitions/${COMPETITION}/teams?season=${SEASON}`);
  const teams = await get(`/competitions/${COMPETITION}/teams?season=${SEASON}`);
  const teamList: any[] = teams.body?.teams ?? [];
  if (!teams.ok) line('!! failed', `${teams.status} ${teams.error}`);
  else {
    line('teams', teamList.length);
    line('sample', teamList.slice(0, 6).map(t => t.tla ?? t.shortName ?? t.name).join(', ') || '(none)');
  }

  heading(`5. GET /competitions/${COMPETITION}/standings?season=${SEASON}`);
  const standings = await get(`/competitions/${COMPETITION}/standings?season=${SEASON}`);
  const tables: any[] = standings.body?.standings ?? [];
  if (!standings.ok) line('!! failed', `${standings.status} ${standings.error}`);
  else {
    line('tables', tables.length);
    for (const t of tables.slice(0, 3)) {
      line(` type=${t.type}`, `stage=${t.stage} group=${t.group ?? '(none)'} rows=${t.table?.length ?? 0}`);
    }
    const played = tables[0]?.table?.reduce((sum: number, r: any) => sum + (r.playedGames ?? 0), 0);
    if (played != null) line('games played', played);
  }

  // ── Verdict ─────────────────────────────────────────────────────────────────
  heading('VERDICT');

  if (!filtered.ok && filtered.status === 404 && !seasonExists) {
    console.log(`  The provider has not created the ${SEASON} season for ${COMPETITION} yet.`);
    console.log('  Nothing is wrong with the app. There is nothing to sync until it does.');
  } else if (filteredMatches.length > 0) {
    console.log(`  The provider HAS ${filteredMatches.length} fixtures and the sync request returns them.`);
    console.log('  So an empty fixtures tab is on our side. Check, in order:');
    console.log('   - unmapped stages above (fixtures land with stage_key = null and no stage tab);');
    console.log('   - live_tournaments.last_sync_error, and whether a full sync has actually run');
    console.log('     since the draw (the admin page shows lastStructureSyncAt);');
    console.log('   - that the tournament row really is season ' + SEASON + ' and competition ' + COMPETITION + '.');
  } else if (unfilteredForSeason.length > 0) {
    console.log(`  The provider has ${unfilteredForSeason.length} fixtures for season ${SEASON}, but only`);
    console.log('  WITHOUT the season= filter. That is the fetch, not the data.');
    console.log('  The adapter already falls back to the unfiltered endpoint when the filtered one');
    console.log('  comes back empty, so a full sync should now pick these up — if it does not, the');
    console.log('  fallback is not deployed yet.');
  } else if (teamList.length > 0 || tables.length > 0) {
    console.log(`  The provider has published the ${SEASON} season for ${COMPETITION} — teams and/or a`);
    console.log('  table exist — but it has NO fixtures for it, on either endpoint. The draw being');
    console.log('  public does not mean football-data has ingested the calendar: it typically');
    console.log('  appears once kickoff times are confirmed, a day or two after the draw.');
    console.log('  Nothing to fix in the app. Re-run this script tomorrow; the scheduler picks the');
    console.log('  fixtures up on its own (a cold tournament does a full structure sync every 6h).');
  } else {
    console.log('  Neither fixtures, teams nor a table came back for this season.');
    console.log('  Check the failures printed above: 400 means the API token is invalid, 403 means');
    console.log('  the plan does not cover this competition or season, and 404 means the season');
    console.log('  does not exist at the provider yet.');
  }

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`done — ${requestCount} requests`);
}

main().catch(err => {
  console.error('\ndoctor failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
