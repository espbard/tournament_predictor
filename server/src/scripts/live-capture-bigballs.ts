/**
 * Capture real bigballsdata payloads so the adapter's mapping can be pinned.
 *
 * server/src/live/providers/bigBalls.ts was written against bigballsdata's published
 * documentation, not against live responses — the host is unreachable from the cloud
 * environment it was written in. Every football-data mapping in this repo is pinned to a
 * captured payload under __fixtures__/, and this one should be too.
 *
 * Run it from a machine that can reach the API:
 *
 *   BIG_BALLS_API_KEY=xxxxx npx tsx src/scripts/live-capture-bigballs.ts
 *
 * or, with the key already in ../.env:
 *
 *   npm run live:capture -w server
 *
 * It writes two files into src/live/providers/__fixtures__/ and prints a short report of
 * what the payload does and does not carry. Paste the report back; commit the files.
 *
 * Nothing is written to the database, and the key is never printed.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BIG_BALLS_BASE_URL ?? 'https://api.bigballsdata.com';
const KEY = process.env.BIG_BALLS_API_KEY;
const LEAGUE = process.env.BIG_BALLS_LEAGUE ?? '';
const OUT_DIR = join(import.meta.dirname, '..', 'live', 'providers', '__fixtures__');

async function get(path: string): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${KEY!}`, Accept: 'application/json' },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

function save(name: string, note: string, body: unknown): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, name);
  writeFileSync(path, JSON.stringify({ _note: note, ...(body as object) }, null, 2) + '\n');
  return path;
}

/** The match array, wherever this API happens to put it. */
function matchesFrom(body: any): any[] {
  if (Array.isArray(body)) return body;
  for (const key of ['data', 'matches', 'results', 'items']) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  return [];
}

function heading(text: string) {
  console.log(`\n${'─'.repeat(72)}\n${text}\n${'─'.repeat(72)}`);
}

async function main() {
  if (!KEY) {
    console.error('BIG_BALLS_API_KEY is not set.\n');
    console.error('  BIG_BALLS_API_KEY=xxxxx npx tsx src/scripts/live-capture-bigballs.ts');
    process.exit(1);
  }

  // ── 1. The league list, which is where the Champions League key comes from ──
  heading('GET /v1/leagues?sport=football');
  const leagues = await get('/v1/leagues?sport=football');
  console.log(`  status: ${leagues.status}`);
  if (leagues.status !== 200) {
    console.log(`  body  : ${leagues.text.slice(0, 300)}`);
    console.log('\n  Cannot continue without the league list. Check the key and the base URL.');
    process.exit(1);
  }

  const list: any[] = Array.isArray(leagues.body)
    ? leagues.body
    : (leagues.body?.data ?? leagues.body?.leagues ?? []);
  console.log(`  leagues: ${list.length}`);
  console.log('  keys   :', list.map(l => l.key ?? l.id ?? l.slug).filter(Boolean).join(', '));
  console.log('  saved  :', save('bb-leagues.sample.json', `GET ${BASE}/v1/leagues?sport=football`, leagues.body));

  // Guess the Champions League key when one was not supplied.
  const guessed =
    LEAGUE ||
    list
      .map(l => String(l.key ?? l.id ?? l.slug ?? ''))
      .find(k => /ucl|champions/i.test(k)) ||
    list
      .filter(l => /champions/i.test(String(l.name ?? '')))
      .map(l => String(l.key ?? l.id ?? l.slug ?? ''))[0] ||
    '';

  if (!guessed) {
    console.log('\n  No Champions League key found in the list above.');
    console.log('  Re-run with BIG_BALLS_LEAGUE=<key> once you can see which one it is.');
    process.exit(1);
  }
  console.log(`\n  using league key: ${guessed}${LEAGUE ? '' : ' (guessed — override with BIG_BALLS_LEAGUE)'}`);

  // ── 2. The match list, which is the mapping that matters ────────────────────
  const matchesPath = `/v1/matches?sport=football&league=${encodeURIComponent(guessed)}`;
  heading(`GET ${matchesPath}`);
  const matches = await get(matchesPath);
  console.log(`  status: ${matches.status}`);
  if (matches.status !== 200) {
    console.log(`  body  : ${matches.text.slice(0, 300)}`);
    process.exit(1);
  }

  const all = matchesFrom(matches.body);
  console.log(`  envelope: ${Array.isArray(matches.body) ? 'bare array' : Object.keys(matches.body ?? {}).join(', ')}`);
  console.log(`  matches : ${all.length}`);
  console.log('  saved   :', save('bb-cl-matches.sample.json', `GET ${BASE}${matchesPath}`, matches.body));

  // ── 3. What the adapter needs, and whether it is there ──────────────────────
  heading('Field check — what the adapter depends on');
  const sample = all[0];
  if (!sample) {
    console.log('  No matches returned, so nothing to check.');
    return;
  }

  console.log('  fields on a match:', Object.keys(sample).join(', '));

  const has = (fn: (m: any) => unknown) => all.filter(m => fn(m) != null && fn(m) !== '').length;
  const report: Array<[string, number, string]> = [
    ['kickoff time', has(m => m.kickoff_utc ?? m.kickoff ?? m.start_time), 'fixtures need a date to lock predictions'],
    ['home team name', has(m => m.home?.name ?? m.home_team?.name), 'the only way to join to a stored team'],
    ['away team name', has(m => m.away?.name ?? m.away_team?.name), ''],
    ['stage / round', has(m => m.stage ?? m.round), 'absent → every fixture files under the tournament start stage'],
    ['matchday', has(m => m.matchday ?? m.week ?? m.round_number), 'absent → gameweek selection cannot group fixtures'],
    ['half-time score', has(m => m.half_time ?? m.score?.half_time ?? m.ht_score), 'nice to have'],
    ['extra time / pens', has(m => m.extra_time ?? m.penalties ?? m.score?.penalties), 'REQUIRED for knockout scoring'],
  ];

  for (const [label, count, why] of report) {
    const mark = count === 0 ? '✗' : count === all.length ? '✓' : '~';
    console.log(`  ${mark} ${label.padEnd(18)} ${count}/${all.length}${why ? `   ${why}` : ''}`);
  }

  console.log('\n  statuses seen :', [...new Set(all.map(m => m.status).filter(Boolean))].join(', '));
  console.log('  first match   :', JSON.stringify(sample, null, 2).split('\n').join('\n                  '));

  console.log(`\n${'─'.repeat(72)}`);
  console.log('Commit both files under src/live/providers/__fixtures__/ and paste this report back.');
  console.log('The adapter mapping and its tests should be corrected against them before the');
  console.log('Champions League fixtures are trusted in production.');
}

main().catch(err => {
  console.error('\ncapture failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
