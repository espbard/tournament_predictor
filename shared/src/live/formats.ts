import type { LiveProviderId } from './types';

// ── Competition formats ───────────────────────────────────────────────────────
//
// Different real competitions have different shapes: a Swiss league phase feeding
// two-legged knockouts, a plain domestic round-robin, and so on. Rather than
// hardcoding a stage enum the way the manual tournament type does, a live tournament
// names a format and the format supplies its stages.
//
// Adding a new competition shape is one entry in LIVE_FORMATS.

export type LiveFormatKey = 'ucl_swiss' | 'domestic_league';

export type LiveStageKind = 'table' | 'knockout';

export interface LiveStageDef {
  /** Stable internal key. Persisted on live_fixtures.stage_key — never rename in place. */
  key: string;
  /** i18n key, resolved client-side through useT(). */
  labelKey: string;
  kind: LiveStageKind;
  /** Two-legged ties are grouped in the UI, but each leg is predicted and scored separately. */
  legs: 1 | 2;
  /** Chronological ordinal. Used to decide what falls below a tournament's startStageKey. */
  order: number;
  /** Raw provider stage strings that map onto this stage, per provider. */
  providerStages: Partial<Record<LiveProviderId, string[]>>;
}

export interface LiveFormatDef {
  key: LiveFormatKey;
  /** Whether standings are one table or one per group. */
  tableScope: 'single' | 'per_group';
  stages: LiveStageDef[];
}

// ── UEFA Champions League (Swiss league phase, since 2024/25) ──────────────────
//
// The summer qualifying rounds are included so their fixtures can be mapped and used
// to derive which teams have qualified. They sit below the usual startStageKey of
// 'league_phase' and so are never predictable.
//
// Note the two similarly-named rounds: PLAY_OFF_ROUND is the August qualifier,
// PLAYOFFS is the February knockout play-off between league-phase places 9–24.
// Mapping them to the same stage would make summer qualifiers predictable.

const UCL_SWISS: LiveFormatDef = {
  key: 'ucl_swiss',
  tableScope: 'single',
  stages: [
    {
      key: 'qualifying_round_1',
      labelKey: 'live.stages.qualifying_round_1',
      kind: 'knockout',
      legs: 2,
      order: 1,
      providerStages: { football_data: ['1ST_QUALIFYING_ROUND'] },
    },
    {
      key: 'qualifying_round_2',
      labelKey: 'live.stages.qualifying_round_2',
      kind: 'knockout',
      legs: 2,
      order: 2,
      providerStages: { football_data: ['2ND_QUALIFYING_ROUND'] },
    },
    {
      key: 'qualifying_round_3',
      labelKey: 'live.stages.qualifying_round_3',
      kind: 'knockout',
      legs: 2,
      order: 3,
      providerStages: { football_data: ['3RD_QUALIFYING_ROUND'] },
    },
    {
      key: 'qualifying_playoff',
      labelKey: 'live.stages.qualifying_playoff',
      kind: 'knockout',
      legs: 2,
      order: 4,
      providerStages: { football_data: ['PLAY_OFF_ROUND'] },
    },
    {
      key: 'league_phase',
      labelKey: 'live.stages.league_phase',
      kind: 'table',
      legs: 1,
      order: 10,
      providerStages: { football_data: ['LEAGUE_STAGE'] },
    },
    {
      key: 'knockout_playoff',
      labelKey: 'live.stages.knockout_playoff',
      kind: 'knockout',
      legs: 2,
      order: 20,
      providerStages: { football_data: ['PLAYOFFS'] },
    },
    {
      key: 'round_of_16',
      labelKey: 'live.stages.round_of_16',
      kind: 'knockout',
      legs: 2,
      order: 30,
      providerStages: { football_data: ['LAST_16'] },
    },
    {
      key: 'quarter_final',
      labelKey: 'live.stages.quarter_final',
      kind: 'knockout',
      legs: 2,
      order: 40,
      providerStages: { football_data: ['QUARTER_FINALS'] },
    },
    {
      key: 'semi_final',
      labelKey: 'live.stages.semi_final',
      kind: 'knockout',
      legs: 2,
      order: 50,
      providerStages: { football_data: ['SEMI_FINALS'] },
    },
    {
      key: 'final',
      labelKey: 'live.stages.final',
      kind: 'knockout',
      legs: 1,
      order: 60,
      providerStages: { football_data: ['FINAL'] },
    },
  ],
};

// ── Domestic round-robin league (Premier League and similar) ───────────────────

const DOMESTIC_LEAGUE: LiveFormatDef = {
  key: 'domestic_league',
  tableScope: 'single',
  stages: [
    {
      key: 'regular_season',
      labelKey: 'live.stages.regular_season',
      kind: 'table',
      legs: 1,
      order: 10,
      providerStages: { football_data: ['REGULAR_SEASON'] },
    },
  ],
};

export const LIVE_FORMATS: Record<LiveFormatKey, LiveFormatDef> = {
  ucl_swiss: UCL_SWISS,
  domestic_league: DOMESTIC_LEAGUE,
};

export const LIVE_FORMAT_KEYS = Object.keys(LIVE_FORMATS) as LiveFormatKey[];

// ── Helpers ───────────────────────────────────────────────────────────────────

export function isLiveFormatKey(value: string): value is LiveFormatKey {
  return Object.prototype.hasOwnProperty.call(LIVE_FORMATS, value);
}

export function getLiveFormat(key: string): LiveFormatDef {
  if (!isLiveFormatKey(key)) throw new Error(`Unknown live format: ${key}`);
  return LIVE_FORMATS[key];
}

export function getLiveStage(format: LiveFormatDef, stageKey: string | null): LiveStageDef | null {
  if (!stageKey) return null;
  return format.stages.find(s => s.key === stageKey) ?? null;
}

/**
 * Map a raw provider stage string onto an internal stage key.
 * Returns null when the provider sends something the format does not know about —
 * the caller stores the fixture anyway and surfaces a warning, so a provider rename
 * is visible rather than silently dropping fixtures.
 */
export function resolveStageKey(
  format: LiveFormatDef,
  provider: LiveProviderId,
  providerStage: string | null,
): string | null {
  if (!providerStage) return null;
  const needle = providerStage.trim().toUpperCase();
  for (const stage of format.stages) {
    if (stage.providerStages[provider]?.some(s => s.toUpperCase() === needle)) return stage.key;
  }
  return null;
}

/**
 * Whether a fixture in `stageKey` is at or after the tournament's starting stage,
 * i.e. part of what users actually predict. Unmapped stages are never predictable.
 */
export function isStageAtOrAfter(
  format: LiveFormatDef,
  stageKey: string | null,
  startStageKey: string,
): boolean {
  const stage = getLiveStage(format, stageKey);
  const start = getLiveStage(format, startStageKey);
  if (!stage || !start) return false;
  return stage.order >= start.order;
}

/** The stages users predict on, in chronological order. */
export function predictableStages(format: LiveFormatDef, startStageKey: string): LiveStageDef[] {
  const start = getLiveStage(format, startStageKey);
  if (!start) return [];
  return format.stages.filter(s => s.order >= start.order).sort((a, b) => a.order - b.order);
}
