/**
 * Phase 2 go/no-go check for the live tournament type.
 *
 * Answers the four questions in docs/LIVE_TOURNAMENTS_PLAN.md §13 against the real
 * football-data.org API, and prints a report that can be pasted back into a chat or
 * an issue. It only reads — nothing is written to the database.
 *
 * Usage, from the server workspace:
 *
 *   FOOTBALL_DATA_API_KEY=xxxxx npx tsx src/scripts/live-provider-smoke.ts
 *
 * or, with the key already in ../.env:
 *
 *   npx tsx --env-file=../.env src/scripts/live-provider-smoke.ts
 *
 * Makes 6 requests, paced to stay inside the free tier's 10/minute limit.
 * The key is read from the environment and never printed.
 */

import { LIVE_FORMATS } from '@tournament-predictor/shared';

const BASE = 'https://api.football-data.org/v4';
const KEY = process.env.FOOTBALL_DATA_API_KEY;
const SEASON = process.env.LIVE_SMOKE_SEASON ?? '2026';
/** A completed season, used to find a finished extra-time match. */
const PAST_SEASON = process.env.LIVE_SMOKE_PAST_SEASON ?? '2024';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let requestCount = 0;

async function get(path: string): Promise<any> {
  // Free tier allows 10 requests/minute. 7s spacing keeps us well clear.
  if (requestCount > 0) await sleep(7000);
  requestCount++;
  const res = await fetch(`${BASE}${path}`, { headers: { 'X-Auth-Token': KEY! } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} on ${path} ${body.slice(0, 200)}`);
  }
  return res.json();
}

function heading(n: number, text: string) {
  console.log(`\n${'─'.repeat(72)}\nQ${n}. ${text}\n${'─'.repeat(72)}`);
}

/** Every provider stage string the ucl_swiss / domestic_league formats currently know. */
function mappedStages(formatKey: 'ucl_swiss' | 'domestic_league'): Map<string, string> {
  const out = new Map<string, string>();
  for (const stage of LIVE_FORMATS[formatKey].stages) {
    for (const raw of stage.providerStages.football_data ?? []) out.set(raw.toUpperCase(), stage.key);
  }
  return out;
}

function compareStages(formatKey: 'ucl_swiss' | 'domestic_league', actual: string[]) {
  const mapping = mappedStages(formatKey);
  const unmapped = actual.filter(s => !mapping.has(s.toUpperCase()));
  const unused = [...mapping.keys()].filter(m => !actual.some(a => a.toUpperCase() === m));

  console.log('  provider reports :', actual.join(', ') || '(none)');
  console.log('  we map           :', [...mapping.keys()].join(', '));
  if (unmapped.length) console.log('  !! UNMAPPED      :', unmapped.join(', '), '<- fixtures here would land with stage_key = null');
  if (unused.length) console.log('  !! WE MAP UNUSED :', unused.join(', '), '<- string may be wrong');
  if (!unmapped.length && !unused.length) console.log('  => exact match');
}

async function q1() {
  heading(1, 'Do the Champions League availableStages match the ucl_swiss mapping?');
  const comp = await get(`/competitions/CL`);
  console.log('  competition      :', comp.name, '| current season starts', comp.currentSeason?.startDate);
  compareStages('ucl_swiss', comp.seasons?.[0]?.stages ?? comp.availableStages ?? []);
  console.log('\n  Critical: PLAY_OFF_ROUND (August qualifier) and PLAYOFFS (February knockout)');
  console.log('  must be two DIFFERENT strings. If the provider uses one string for both,');
  console.log('  the startStageKey filter cannot separate them and the mapping needs rework.');
}

async function q2() {
  heading(2, `Does /teams?season=${SEASON} list the automatic qualifiers before the draw?`);
  const teams = await get(`/competitions/CL/teams?season=${SEASON}`);
  const list = teams.teams ?? [];
  console.log(`  teams returned   : ${list.length} (expecting 36 once the draw is done; 29 would mean`);
  console.log('                     automatic qualifiers are listed, 0 means we must wait for the draw)');
  console.log('  sample           :', list.slice(0, 8).map((t: any) => t.tla ?? t.shortName ?? t.name).join(', ') || '(empty)');
  console.log('  crest url sample :', list[0]?.crest ?? '(none)');
}

async function q3() {
  heading(3, 'Is score.regularTime exposed on a finished extra-time match?');
  console.log(`  (checking season ${PAST_SEASON} knockout matches)`);
  const matches = await get(`/competitions/CL/matches?season=${PAST_SEASON}`);
  const all = matches.matches ?? [];
  const finished = all.filter((m: any) => m.status === 'FINISHED');
  const durations = new Set(finished.map((m: any) => m.score?.duration).filter(Boolean));
  console.log('  finished matches :', finished.length, '| score.duration values seen:', [...durations].join(', ') || '(none)');

  const et = finished.find((m: any) => m.score?.duration && m.score.duration !== 'REGULAR');
  if (!et) {
    console.log('  !! no extra-time match found in this season — try LIVE_SMOKE_PAST_SEASON=<year>');
    return;
  }
  console.log(`  example          : ${et.homeTeam?.name} v ${et.awayTeam?.name} (${et.stage})`);
  console.log('  score object     :', JSON.stringify(et.score, null, 2).split('\n').join('\n                     '));
  const regular = et.score.regularTime;
  if (regular && regular.home != null) {
    console.log(`  => regularTime present: ${regular.home}-${regular.away}. The 90-minute rule is implementable.`);
  } else {
    console.log('  => !! regularTime MISSING. We cannot score extra-time knockout fixtures on');
    console.log('        normal time with this provider. This is a go/no-go blocker.');
  }
}

async function q4() {
  heading(4, `Does the Premier League ${SEASON} season return all 380 fixtures with matchdays?`);
  const matches = await get(`/competitions/PL/matches?season=${SEASON}`);
  const all = matches.matches ?? [];
  const matchdays = new Set(all.map((m: any) => m.matchday).filter((d: any) => d != null));
  const stages = [...new Set(all.map((m: any) => m.stage).filter(Boolean))] as string[];
  console.log(`  fixtures returned: ${all.length} (expecting 380)`);
  console.log(`  matchdays        : ${matchdays.size} distinct (expecting 38)`);
  compareStages('domestic_league', stages);
  const sample = all[0];
  if (sample) {
    console.log('  sample fixture   :', sample.homeTeam?.name, 'v', sample.awayTeam?.name);
    console.log('  utcDate / status :', sample.utcDate, '/', sample.status);
  }
}

async function q5Standings() {
  heading(5, 'Bonus: what does the standings endpoint return for a Swiss league phase?');
  const standings = await get(`/competitions/CL/standings?season=${PAST_SEASON}`);
  const tables = standings.standings ?? [];
  console.log('  tables returned  :', tables.length);
  for (const t of tables.slice(0, 3)) {
    console.log(`   - type=${t.type} stage=${t.stage} group=${t.group ?? '(none)'} rows=${t.table?.length ?? 0}`);
  }
  const row = tables[0]?.table?.[0];
  if (row) {
    console.log('  first row fields :', Object.keys(row).join(', '));
  }
}

async function main() {
  if (!KEY) {
    console.error('FOOTBALL_DATA_API_KEY is not set.\n');
    console.error('Run one of:');
    console.error('  FOOTBALL_DATA_API_KEY=xxxxx npx tsx src/scripts/live-provider-smoke.ts');
    console.error('  npx tsx --env-file=../.env src/scripts/live-provider-smoke.ts');
    process.exit(1);
  }

  console.log('football-data.org smoke check');
  console.log(`season under test: ${SEASON}   past season for extra-time check: ${PAST_SEASON}`);

  const steps: Array<[string, () => Promise<void>]> = [
    ['Q1 stages', q1],
    ['Q2 teams', q2],
    ['Q3 regularTime', q3],
    ['Q4 premier league', q4],
    ['Q5 standings', q5Standings],
  ];

  let failures = 0;
  for (const [label, fn] of steps) {
    try {
      await fn();
    } catch (err) {
      failures++;
      console.log(`\n  !! ${label} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`done — ${requestCount} requests, ${failures} step(s) failed`);
  console.log('Paste the whole output back; it decides whether football-data is sufficient.');
  process.exit(failures > 0 ? 1 : 0);
}

main();
