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

/**
 * A contiguous run of table positions that means something in the competition — the
 * Champions League league phase splits into automatic qualification, a knockout play-off
 * and elimination.
 *
 * Used by table predictions: landing a team in the right band is worth a point even when
 * the exact position is wrong. Competitions without meaningful bands simply omit them,
 * and then only exact positions score.
 */
export interface LiveTableBand {
  /** Stable internal key. Persisted in scoring output — never rename in place. */
  key: string;
  labelKey: string;
  /** 1-based, inclusive. */
  from: number;
  /** 1-based, inclusive. Null means "down to the bottom of the table". */
  to: number | null;
}

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
  /**
   * Whether users predict the final order of this stage's table. Only ever set on a
   * `table` stage — there is no order to predict in a knockout.
   */
  tablePredictable?: boolean;
  /** Position bands, for the table-prediction bonus. Omit when the table has no bands. */
  bands?: LiveTableBand[];
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
      tablePredictable: true,
      // The 36-team league phase splits three ways: the top 8 go straight through, 9th
      // to 24th play a knockout play-off, and 25th down are out.
      bands: [
        { key: 'automatic', labelKey: 'live.bands.automatic', from: 1, to: 8 },
        { key: 'playoff', labelKey: 'live.bands.playoff', from: 9, to: 24 },
        { key: 'eliminated', labelKey: 'live.bands.eliminated', from: 25, to: null },
      ],
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
      tablePredictable: true,
      // No bands: a domestic league's European and relegation places carry no meaning
      // inside this app, so only exact positions score.
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

// ── Table predictions ─────────────────────────────────────────────────────────

/**
 * The stage whose final table users predict the order of, or null when the format has
 * none. Only stages at or above `startStageKey` count — a qualifying round's table is
 * not something this app ever asks about.
 */
export function tablePredictionStage(
  format: LiveFormatDef,
  startStageKey: string,
): LiveStageDef | null {
  return (
    predictableStages(format, startStageKey).find(s => s.kind === 'table' && s.tablePredictable) ??
    null
  );
}

/**
 * Which band a finishing position falls in, or null when the stage has no bands.
 * Positions outside every band also return null, which scores nothing rather than
 * silently counting as a match.
 */
export function bandForPosition(
  stage: LiveStageDef | null | undefined,
  position: number,
): string | null {
  if (!stage?.bands?.length || !Number.isFinite(position) || position < 1) return null;
  for (const band of stage.bands) {
    if (position >= band.from && (band.to === null || position <= band.to)) return band.key;
  }
  return null;
}

/** Convenience for the UI: the band definition rather than just its key. */
export function bandDefForPosition(
  stage: LiveStageDef | null | undefined,
  position: number,
): LiveTableBand | null {
  const key = bandForPosition(stage, position);
  return key ? (stage?.bands?.find(b => b.key === key) ?? null) : null;
}
