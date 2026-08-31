import { useT } from '@/lib/useT';
import LiveFixtureCard from '@/components/live/LiveFixtureCard';
import LiveTieCard from '@/components/live/LiveTieCard';
import type { LiveFixtureView } from '@/lib/liveApi';

// ── Fixture list ──────────────────────────────────────────────────────────────
//
// The stage's matches, grouped the way the stage is played: a table stage lists one
// matchday, a two-legged knockout stage groups both legs of a tie together.
//
// Shared by the competition page and the read-only view of another member's predictions,
// which differ only in whether the cards can be edited.

interface Props {
  fixtures: LiveFixtureView[];
  stageKind: 'table' | 'knockout';
  legs: 1 | 2;
  matchday: number | null;
  /** Why there is nothing here, when the caller knows better than "no matches yet". */
  emptyMessage?: string;
  onSave: (fixtureId: string, homeScore: number, awayScore: number) => void;
  savingFixtureId: string | null;
  savedFixtures: Record<string, number>;
  errors: Record<string, string>;
  readOnly?: boolean;
  /** Set to offer the league's predictions under each played match. */
  competitionId?: string;
  linkToUsers?: boolean;
}

export default function LiveFixtureList({
  fixtures,
  stageKind,
  legs,
  matchday,
  emptyMessage,
  onSave,
  savingFixtureId,
  savedFixtures,
  errors,
  readOnly = false,
  competitionId,
  linkToUsers = true,
}: Props) {
  const { t } = useT();

  // A two-legged knockout stage groups its legs into ties.
  if (stageKind === 'knockout' && legs === 2) {
    const ties = new Map<string, LiveFixtureView[]>();
    const loose: LiveFixtureView[] = [];

    for (const fixture of fixtures) {
      if (!fixture.tieKey) {
        // Undrawn, so it has no identifiable tie yet.
        loose.push(fixture);
        continue;
      }
      const bucket = ties.get(fixture.tieKey);
      if (bucket) bucket.push(fixture);
      else ties.set(fixture.tieKey, [fixture]);
    }

    return (
      <div className="grid gap-3">
        {[...ties.values()]
          .sort((a, b) => (a[0].kickoffAt ?? '').localeCompare(b[0].kickoffAt ?? ''))
          .map(tieLegs => (
            <LiveTieCard
              key={tieLegs[0].tieKey}
              legs={tieLegs}
              onSave={onSave}
              savingFixtureId={savingFixtureId}
              savedFixtures={savedFixtures}
              errors={errors}
              readOnly={readOnly}
              competitionId={competitionId}
              linkToUsers={linkToUsers}
            />
          ))}
        {loose.map(fixture => (
          <LiveFixtureCard
            key={fixture.id}
            fixture={fixture}
            onSave={onSave}
            isSaving={savingFixtureId === fixture.id}
            savedAt={savedFixtures[fixture.id] ?? null}
            error={errors[fixture.id] ?? null}
            readOnly={readOnly}
            competitionId={competitionId}
            linkToUsers={linkToUsers}
          />
        ))}
      </div>
    );
  }

  const shown =
    stageKind === 'table' && matchday !== null
      ? fixtures.filter(f => f.matchday === matchday)
      : fixtures;

  if (shown.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        {emptyMessage ?? t('live.noFixtures')}
      </p>
    );
  }

  return (
    <div className="grid gap-2">
      {shown.map(fixture => (
        <LiveFixtureCard
          key={fixture.id}
          fixture={fixture}
          onSave={onSave}
          isSaving={savingFixtureId === fixture.id}
          savedAt={savedFixtures[fixture.id] ?? null}
          error={errors[fixture.id] ?? null}
          readOnly={readOnly}
          competitionId={competitionId}
          linkToUsers={linkToUsers}
        />
      ))}
    </div>
  );
}
