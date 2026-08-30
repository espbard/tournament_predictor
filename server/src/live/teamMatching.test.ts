import { describe, expect, it } from 'vitest';
import {
  buildTeamNameIndex,
  canonicalTeamName,
  matchTeamByName,
  normaliseTeamName,
  type MatchableTeam,
} from './teamMatching';

// Joining two providers by club name is the part of the split-provider setup that can go
// silently wrong, so both halves are pinned: the names that must match, and — more
// important — the ones that must NOT.

function team(id: string, name: string, shortName: string | null = null, tla: string | null = null): MatchableTeam {
  return { id, name, shortName, tla };
}

describe('normaliseTeamName', () => {
  it('strips club-type words, so a club is one club however it is written', () => {
    expect(normaliseTeamName('FC Barcelona')).toBe('barcelona');
    expect(normaliseTeamName('Barcelona FC')).toBe('barcelona');
    expect(normaliseTeamName('Barcelona')).toBe('barcelona');
  });

  it('folds accents and non-ASCII letters', () => {
    expect(normaliseTeamName('FC Bayern München')).toBe('bayernmunchen');
    expect(normaliseTeamName('Bayern Munchen')).toBe('bayernmunchen');
    expect(normaliseTeamName('Atlético Madrid')).toBe('atleticomadrid');
    expect(normaliseTeamName('Malmö FF')).toBe('malmoff');
  });

  it('drops punctuation and standalone digits', () => {
    expect(normaliseTeamName('1899 Hoffenheim')).toBe('hoffenheim');
    expect(normaliseTeamName('Paris Saint-Germain')).toBe('parissaintgermain');
    expect(normaliseTeamName('B. Dortmund')).toBe('bdortmund');
  });

  it('is empty for an absent name', () => {
    expect(normaliseTeamName(null)).toBe('');
    expect(normaliseTeamName('  ')).toBe('');
  });

  // A name that is nothing but club-type words must not reduce to nothing, or every such
  // name would match every other.
  it('never reduces an all-noise name to nothing', () => {
    expect(normaliseTeamName('FC de Club')).toBe('fcdeclub');
    expect(normaliseTeamName('FC de Club')).not.toBe('');
  });

  // The words that look like club-type noise but identify the club.
  it('keeps Atletico, Athletic and Sporting', () => {
    expect(normaliseTeamName('Club Atlético de Madrid')).toBe('atleticomadrid');
    expect(normaliseTeamName('Atletico Madrid')).toBe('atleticomadrid');
    expect(normaliseTeamName('Athletic Club')).toBe('athletic');
  });
});

describe('canonicalTeamName', () => {
  it('folds known aliases onto one token from either side', () => {
    expect(canonicalTeamName('FC Internazionale Milano')).toBe('inter');
    expect(canonicalTeamName('Inter Milan')).toBe('inter');
    expect(canonicalTeamName('Inter')).toBe('inter');

    expect(canonicalTeamName('RB Salzburg')).toBe('salzburg');
    expect(canonicalTeamName('Red Bull Salzburg')).toBe('salzburg');
  });

  it('leaves an unaliased name as its normalised form', () => {
    expect(canonicalTeamName('Real Madrid CF')).toBe('realmadrid');
  });

  it('does not let one Madrid club answer to the other', () => {
    expect(canonicalTeamName('Atlético Madrid')).not.toBe(canonicalTeamName('Real Madrid'));
  });

  it('folds the several ways Sporting CP is written', () => {
    expect(canonicalTeamName('Sporting Clube de Portugal')).toBe('sporting');
    expect(canonicalTeamName('Sporting CP')).toBe('sporting');
    expect(canonicalTeamName('Sporting Lisbon')).toBe('sporting');
  });
});

describe('buildTeamNameIndex / matchTeamByName', () => {
  const stored = [
    team('t-ars', 'Arsenal FC', 'Arsenal', 'ARS'),
    team('t-rma', 'Real Madrid CF', 'Real Madrid', 'RMA'),
    team('t-int', 'FC Internazionale Milano', 'Inter', 'INT'),
    team('t-bay', 'FC Bayern München', 'Bayern München', 'FCB'),
    team('t-psg', 'Paris Saint-Germain FC', 'PSG', 'PSG'),
  ];
  const index = buildTeamNameIndex(stored);

  it('matches a differently-written name to the stored team', () => {
    expect(matchTeamByName({ name: 'Arsenal' }, index)).toBe('t-ars');
    expect(matchTeamByName({ name: 'Real Madrid' }, index)).toBe('t-rma');
    expect(matchTeamByName({ name: 'Inter Milan' }, index)).toBe('t-int');
    expect(matchTeamByName({ name: 'Bayern Munich' }, index)).toBe('t-bay');
    expect(matchTeamByName({ name: 'Paris Saint-Germain' }, index)).toBe('t-psg');
  });

  it('falls back to the short name and then the three-letter code', () => {
    expect(matchTeamByName({ name: null, shortName: 'Arsenal' }, index)).toBe('t-ars');
    expect(matchTeamByName({ name: null, shortName: null, tla: 'RMA' }, index)).toBe('t-rma');
  });

  it('prefers the full name over an abbreviation', () => {
    // 'INT' as a code belongs to Inter; the full name here is Real Madrid's, and the full
    // name is what the fixture is actually about.
    expect(matchTeamByName({ name: 'Real Madrid', tla: 'INT' }, index)).toBe('t-rma');
  });

  // The property that matters most: no match beats a wrong match.
  it('returns null rather than guessing at an unknown club', () => {
    expect(matchTeamByName({ name: 'Slavia Praha' }, index)).toBeNull();
    expect(matchTeamByName({ name: '' }, index)).toBeNull();
    expect(matchTeamByName({ name: null }, index)).toBeNull();
  });

  it('drops a name two teams both answer to instead of picking one', () => {
    const ambiguous = buildTeamNameIndex([
      team('t-a', 'Manchester United FC', null, 'MUN'),
      team('t-b', 'Millwall FC', null, 'MUN'),
    ]);

    // The shared code resolves to neither; the distinctive full names still resolve.
    expect(matchTeamByName({ name: null, tla: 'MUN' }, ambiguous)).toBeNull();
    expect(matchTeamByName({ name: 'Manchester United' }, ambiguous)).toBe('t-a');
    expect(matchTeamByName({ name: 'Millwall' }, ambiguous)).toBe('t-b');
  });

  it('does not confuse clubs that merely share a city', () => {
    const city = buildTeamNameIndex([
      team('t-mc', 'Manchester City FC', 'Man City', 'MCI'),
      team('t-mu', 'Manchester United FC', 'Man United', 'MUN'),
    ]);
    expect(matchTeamByName({ name: 'Manchester City' }, city)).toBe('t-mc');
    expect(matchTeamByName({ name: 'Man Utd' }, city)).toBe('t-mu');
    expect(matchTeamByName({ name: 'Manchester' }, city)).toBeNull();
  });
});
