import { useEffect, useRef, useState } from 'react';
import { liveFixtureMultiplier } from '@tournament-predictor/shared';
import { useT } from '@/lib/useT';
import LiveCountdown from '@/components/live/LiveCountdown';
import LiveMatchPredictions from '@/components/live/LiveMatchPredictions';
import type { LiveFixtureView } from '@/lib/liveApi';

// ── One fixture ───────────────────────────────────────────────────────────────
//
// Crests, names, kickoff, live minute, the actual score above the prediction, points once
// finished, and an AET / pens annotation showing how a tie actually ended alongside the
// normal-time score that did the scoring.
//
// The two scores share one box and one centre line, so what was tipped and what actually
// happened can be read off each other without hunting for either.
//
// Once the match is played it also carries the dropdown of what the whole league
// predicted — which needs the competition, so `competitionId` is what switches it on.
//
// A match an admin has given a multiplier is rendered gold — border, tint and a ×N badge —
// and says so in a line at the foot of the card, because a match worth several times the
// rest is worth noticing before the deadline rather than after it.

interface Props {
  fixture: LiveFixtureView;
  onSave: (fixtureId: string, homeScore: number, awayScore: number) => void;
  isSaving: boolean;
  savedAt: number | null;
  error: string | null;
  readOnly?: boolean;
  /**
   * Leave out the viewer's own prediction row entirely — for somebody looking at a public
   * competition they have not joined, who has no prediction to show.
   */
  hidePrediction?: boolean;
  /**
   * The competition this fixture is being predicted in. Set it to offer the league's
   * predictions under a played match; omit it where there is no league context.
   */
  competitionId?: string;
  /** Names in that dropdown link to a member's predictions unless this says otherwise. */
  linkToUsers?: boolean;
  /** A bonus-round match, whose league predictions come from the bonus-round route. */
  bonusRound?: boolean;
}

// The team name is always rendered next to the badge, so the crest itself is decorative.
function TeamBadge({ crestUrl }: { crestUrl: string | null }) {
  if (!crestUrl) {
    return <span className="h-6 w-6 shrink-0 rounded-full bg-muted" aria-hidden />;
  }
  return <img src={crestUrl} alt="" aria-hidden className="h-6 w-6 shrink-0 object-contain" />;
}

const LIVE_STATUSES = new Set(['in_play', 'paused']);

// The predicted and the actual score are read against each other, so they share one box —
// same size, same border, same centring — and differ only in weight: the actual score is
// the fact, the prediction is a guess.
const SCORE_BOX = 'h-9 w-12 rounded-md border text-center text-sm tabular-nums';
const SCORE_LABEL = 'text-[10px] font-medium uppercase tracking-wide text-muted-foreground';
// Equal outer thirds keep the middle pair on the card's centre line whatever sits beside
// it, so the actual score and the prediction below it stay aligned once a points badge
// or the save status appears.
const SCORE_ROW = 'grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2';

// How long the inputs have to sit still before a prediction is saved. Long enough that
// stepping a score up with the arrow keys, or typing "1" then "0", is one save and not
// several; short enough that it has gone before the user has moved on.
const AUTOSAVE_DELAY_MS = 700;

/** A score the server will take: a whole number of goals, 0–30, as the inputs allow. */
function validScore(value: string): boolean {
  if (!/^\d{1,2}$/.test(value)) return false;
  return Number(value) <= 30;
}

/**
 * Which wording explains a multiplied match.
 *
 * Doubling and tripling have their own words; anything else falls back to the number.
 * `applied` switches to the past tense, for a match whose points have been awarded.
 */
function multiplierExplainerKey(multiplier: number, applied: boolean): string {
  const base = applied ? 'live.multiplier.explainerApplied' : 'live.multiplier.explainer';
  if (multiplier === 2) return `${base}Double`;
  if (multiplier === 3) return `${base}Triple`;
  return base;
}

export default function LiveFixtureCard({
  fixture,
  onSave,
  isSaving,
  savedAt,
  error,
  readOnly = false,
  hidePrediction = false,
  competitionId,
  linkToUsers = true,
  bonusRound = false,
}: Props) {
  const { t } = useT();
  const [home, setHome] = useState(fixture.prediction ? String(fixture.prediction.homeScore) : '');
  const [away, setAway] = useState(fixture.prediction ? String(fixture.prediction.awayScore) : '');

  // The score most recently handed to `onSave`, or already stored — see Auto-save below.
  const lastSent = useRef<string | null>(
    fixture.prediction ? `${fixture.prediction.homeScore}-${fixture.prediction.awayScore}` : null,
  );

  // A prediction can arrive after first render — from a refetch, or another device.
  // Only adopt it when the user has not typed anything, so an edit in progress survives.
  useEffect(() => {
    if (!fixture.prediction) return;
    // A stored prediction showing up late is not an edit, so it is not saved back.
    if (lastSent.current === null) {
      lastSent.current = `${fixture.prediction.homeScore}-${fixture.prediction.awayScore}`;
    }
    setHome(prev => (prev === '' ? String(fixture.prediction!.homeScore) : prev));
    setAway(prev => (prev === '' ? String(fixture.prediction!.awayScore) : prev));
  }, [fixture.prediction]);

  const homeName = fixture.homeTeam?.shortName ?? fixture.homeTeam?.name ?? t('live.tbd');
  const awayName = fixture.awayTeam?.shortName ?? fixture.awayTeam?.name ?? t('live.tbd');

  const isLive = LIVE_STATUSES.has(fixture.status);
  const isFinished = fixture.status === 'finished';
  const isCalledOff = fixture.status === 'cancelled' || fixture.status === 'postponed';

  // A match the admin left out of its gameweek's selection is not part of the game, so it
  // is shown as a result only — exactly like a fixture below the starting stage.
  const inPredictionGame = fixture.isPredictable && fixture.isSelected;
  // Only meaningful on a match that is actually part of the game: a multiplier on a
  // fixture nobody predicts multiplies nothing.
  const multiplier = liveFixtureMultiplier(fixture.multiplier);
  const isMultiplied = inPredictionGame && multiplier > 1;
  const editable = !readOnly && !fixture.isLocked && inPredictionGame && fixture.homeTeamId !== null;

  // ── Auto-save ──
  //
  // There is no save button: a prediction is saved once both boxes hold a valid score and
  // the user has stopped changing it for a moment. `lastSent` is the score most recently
  // handed to `onSave` (or already stored), so neither a re-render nor the refetch that
  // follows a save sends the same score twice.
  //
  // A save still waiting out its delay, so it can be sent at once if the card unmounts —
  // switching gameweek straight after typing should not throw the prediction away.
  const pending = useRef<(() => void) | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!editable || !validScore(home) || !validScore(away)) return;
    const key = `${Number(home)}-${Number(away)}`;
    if (key === lastSent.current) return;
    const send = () => {
      pending.current = null;
      lastSent.current = key;
      onSaveRef.current(fixture.id, Number(home), Number(away));
    };
    pending.current = send;
    const timer = setTimeout(send, AUTOSAVE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      if (pending.current === send) pending.current = null;
    };
  }, [home, away, editable, fixture.id]);

  // Flush a save still waiting on its delay when the card goes away.
  useEffect(() => () => pending.current?.(), []);

  // A failed save leaves the score unsaved, so the same score typed again should be sent
  // again rather than mistaken for one already stored.
  useEffect(() => {
    if (error) {
      lastSent.current = fixture.prediction
        ? `${fixture.prediction.homeScore}-${fixture.prediction.awayScore}`
        : null;
    }
  }, [error, fixture.prediction]);

  const justSaved = savedAt !== null && !error;

  // How the tie actually ended, when that differs from the score that counted.
  const decidedBeyond90 =
    fixture.penaltiesHome !== null
      ? t('live.afterPenalties', { home: fixture.penaltiesHome, away: fixture.penaltiesAway ?? 0 })
      : fixture.extraTimeHome !== null
        ? t('live.afterExtraTime')
        : null;

  // A match that has started has a score worth showing; before kickoff there is none.
  const hasActualScore = isLive || isFinished;
  const actualHome = fixture.normalTimeHome ?? fixture.finalHome ?? 0;
  const actualAway = fixture.normalTimeAway ?? fixture.finalAway ?? 0;

  const kickoff = fixture.kickoffAt ? new Date(fixture.kickoffAt) : null;

  return (
    <div
      className={`rounded-lg border p-3 transition-colors ${
        isMultiplied
          ? // Gold outranks the live tint: a live match already says so with its pulsing
            // minute, while the multiplier has nothing else to announce it.
            'border-amber-400/70 bg-gradient-to-b from-amber-400/10 to-amber-400/[0.02] shadow-[0_0_0_1px_rgba(251,191,36,0.15)] dark:border-amber-300/50'
          : isLive
            ? 'border-green-500/60 bg-green-500/5'
            : ''
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs text-muted-foreground">
            {kickoff
              ? kickoff.toLocaleString(undefined, {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : t('live.kickoffTbd')}
          </span>
          {isMultiplied && (
            <span className="shrink-0 rounded-full border border-amber-400/70 bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-amber-700 dark:text-amber-300">
              {t('live.multiplier.badge', { multiplier })}
            </span>
          )}
        </span>

        {isLive ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
            {fixture.minute !== null ? `${fixture.minute}'` : t('live.inPlay')}
          </span>
        ) : isCalledOff ? (
          <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
            {t(`live.status.${fixture.status}`)}
          </span>
        ) : isFinished ? (
          // The slot a running match fills with its pulsing minute, and an upcoming one
          // with its countdown, goes blank the moment a match ends — which is exactly
          // when a played card starts looking like one that has not kicked off. A static
          // chip in the same place says it is over without competing with the live tint.
          <span className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('live.fullTime')}
          </span>
        ) : inPredictionGame ? (
          <LiveCountdown
            kickoffAt={fixture.kickoffAt}
            kickoffConfirmed={fixture.kickoffConfirmed}
            status={fixture.status}
          />
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <TeamBadge crestUrl={fixture.homeTeam?.crestUrl ?? null} />
          <span className="truncate text-sm font-medium">{homeName}</span>
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <span className="truncate text-right text-sm font-medium">{awayName}</span>
          <TeamBadge crestUrl={fixture.awayTeam?.crestUrl ?? null} />
        </div>
      </div>

      {/* Actual score */}
      {hasActualScore && (
        <div className={`mt-3 ${SCORE_ROW}`}>
          <div className="col-start-2 flex flex-col items-center gap-1">
            <span className={SCORE_LABEL}>{t('live.actualScoreLabel')}</span>
            <div className="flex items-center gap-2">
              <span className={`${SCORE_BOX} inline-flex items-center justify-center font-semibold`}>
                {actualHome}
              </span>
              <span className="text-muted-foreground">–</span>
              <span className={`${SCORE_BOX} inline-flex items-center justify-center font-semibold`}>
                {actualAway}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Sits under the score it qualifies: this is why the box above is not the score the
          match ended on. */}
      {decidedBeyond90 && (
        <p className="mt-1 text-center text-xs text-muted-foreground">{decidedBeyond90}</p>
      )}

      {/* Prediction row */}
      {hidePrediction ? null : !inPredictionGame ? (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          {fixture.isPredictable ? t('live.notSelected') : t('live.notPredictable')}
        </p>
      ) : (
        <div className={`mt-3 ${SCORE_ROW}`}>
          <div className="col-start-2 flex flex-col items-center gap-1">
            <span className={SCORE_LABEL}>{t('live.predictedScoreLabel')}</span>
            {/* The green ring is the confirmation that the prediction was saved. It is a
                ring rather than a border, and the padding is cancelled by the negative
                margin, so the boxes do not move off the actual score's line when it shows. */}
            <div
              className={`-m-1 flex items-center gap-2 rounded-lg p-1 ring-2 transition-shadow duration-500 ${
                justSaved ? 'ring-green-500/80' : 'ring-transparent'
              }`}
            >
              <input
                type="number"
                min={0}
                max={30}
                inputMode="numeric"
                value={home}
                disabled={!editable}
                onChange={e => setHome(e.target.value)}
                aria-label={t('live.predictedHomeScore', { team: homeName })}
                className={`${SCORE_BOX} focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60`}
              />
              <span className="text-muted-foreground">–</span>
              <input
                type="number"
                min={0}
                max={30}
                inputMode="numeric"
                value={away}
                disabled={!editable}
                onChange={e => setAway(e.target.value)}
                aria-label={t('live.predictedAwayScore', { team: awayName })}
                className={`${SCORE_BOX} focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60`}
              />
            </div>
          </div>

          {/* The save status and the points badge sit off the centre line, so the boxes
              stay lined up with the actual score above them however wide these get. */}
          <div className="col-start-3 flex min-h-9 min-w-0 items-center gap-2">
            {editable && (
              <span
                aria-live="polite"
                className={`text-xs transition-opacity duration-500 ${
                  isSaving || justSaved ? 'opacity-100' : 'opacity-0'
                } ${justSaved && !isSaving ? 'font-medium text-green-600 dark:text-green-400' : 'text-muted-foreground'}`}
              >
                {/* Kept as "saved" while hidden, so the word fades out rather than vanishing. */}
                {isSaving ? t('common.saving') : t('common.saved')}
              </span>
            )}

            {/* Points awarded, once the fixture has been scored */}
            {fixture.prediction?.points != null && (
              <span
                className={`rounded px-2 py-1 text-xs font-semibold tabular-nums ${
                  fixture.prediction.points > 0
                    ? 'bg-green-500/15 text-green-700 dark:text-green-400'
                    : 'bg-muted text-muted-foreground'
                }`}
                // The three tiers hold what the prediction earned at face value, so on a
                // highlighted match they no longer add up to the badge without saying what
                // the multiplier put on top.
                title={
                  fixture.prediction.multiplierBonusPoints > 0
                    ? t('live.pointsBreakdownWithHighlight', {
                        outcome: fixture.prediction.correctOutcomePoints,
                        gd: fixture.prediction.correctGoalDifferencePoints,
                        exact: fixture.prediction.exactScorePoints,
                        highlight: fixture.prediction.multiplierBonusPoints,
                      })
                    : t('live.pointsBreakdown', {
                        outcome: fixture.prediction.correctOutcomePoints,
                        gd: fixture.prediction.correctGoalDifferencePoints,
                        exact: fixture.prediction.exactScorePoints,
                      })
                }
              >
                {t('live.pointsShort', { points: fixture.prediction.points })}
              </span>
            )}
          </div>
        </div>
      )}

      {error && <p className="mt-1 text-center text-xs text-destructive">{error}</p>}

      {/* A finished fixture the provider gave us no normal-time score for cannot be
          scored — say so rather than letting it look like a zero. */}
      {isFinished && inPredictionGame && fixture.normalTimeHome === null && (
        <p className="mt-1 text-center text-xs text-amber-600 dark:text-amber-400">
          {t('live.notScorable')}
        </p>
      )}

      {/* Why the card is gold. Past tense once the points have actually been written,
          future while the match is still to be scored — and a word rather than a sum for
          the two multipliers a language has one for: "counts double" reads better than
          "multiplied by 2", in every language this app speaks. */}
      {isMultiplied && (
        <p className="mt-2 text-center text-xs font-medium text-amber-700 dark:text-amber-300">
          {t(multiplierExplainerKey(multiplier, hidePrediction ? isFinished : fixture.prediction?.points != null), { multiplier })}
        </p>
      )}

      {/* What the rest of the league predicted. Only under a played match that was part
          of the game: there is nothing to compare on a match nobody predicted. */}
      {competitionId && isFinished && inPredictionGame && (
        <LiveMatchPredictions
          competitionId={competitionId}
          fixtureId={fixture.id}
          linkToUsers={linkToUsers}
          multiplier={multiplier}
          bonusRound={bonusRound}
        />
      )}
    </div>
  );
}
