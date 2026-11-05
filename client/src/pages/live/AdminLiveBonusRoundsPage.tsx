import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  liveApi,
  liveKeys,
  type LiveBonusRoundView,
  type LiveBonusRoundVisibility,
  type LiveFixtureView,
} from '@/lib/liveApi';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useT } from '@/lib/useT';
import {
  LIVE_MAX_MULTIPLIER,
  suggestLiveBonusRoundAnchor,
  type LiveAnchorOption,
  type LiveBonusRoundAnchor,
  type LiveBonusRoundFixtureView,
  type LiveStageDef,
} from '@tournament-predictor/shared';

// ── Admin: a competition's bonus rounds ───────────────────────────────────────
//
// Create rounds of extra matches, place them between the competition's own rounds, set
// their matches up by hand — two team names, a kickoff, an optional competition label and
// a multiplier — and enter each result after 90 minutes once played, which is what scores
// it. The same way the manual tournament type works; no data provider is involved.
//
// A new round is visible to test accounts only; switching it to everyone is what puts its
// points in the totals. See shared/src/live/bonusRounds.ts.

type Translate = ReturnType<typeof useT>['t'];

const inputClass =
  'w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';
const smallInputClass =
  'rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring';

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

/** A placement as a <select> value. */
function anchorValue(anchor: LiveBonusRoundAnchor): string {
  return `${anchor.afterStageKey ?? ''}|${anchor.afterMatchday ?? ''}`;
}

function parseAnchor(value: string): LiveBonusRoundAnchor {
  const [stage, matchday] = value.split('|');
  return {
    afterStageKey: stage || null,
    afterMatchday: stage && matchday ? Number(matchday) : null,
  };
}

/**
 * Every place a round can go, in display order: each table stage's gameweeks, then the
 * stage itself. A gameweek option carries its first kickoff and a stage option its last,
 * which is what suggestLiveBonusRoundAnchor compares a round's first match against.
 */
function anchorOptions(stages: LiveStageDef[], fixtures: LiveFixtureView[]): LiveAnchorOption[] {
  const options: LiveAnchorOption[] = [];
  for (const stage of stages) {
    const inStage = fixtures.filter(f => f.stageKey === stage.key);
    if (inStage.length === 0) continue;
    const kickoffs = inStage.map(f => f.kickoffAt).filter((k): k is string => !!k).sort();
    if (stage.kind === 'table') {
      const matchdays = [...new Set(inStage.map(f => f.matchday).filter((m): m is number => m != null))].sort(
        (a, b) => a - b,
      );
      for (const matchday of matchdays) {
        const first = inStage
          .filter(f => f.matchday === matchday)
          .map(f => f.kickoffAt)
          .filter((k): k is string => !!k)
          .sort()[0];
        options.push({ afterStageKey: stage.key, afterMatchday: matchday, firstKickoffAt: first ?? null });
      }
    }
    options.push({
      afterStageKey: stage.key,
      afterMatchday: null,
      firstKickoffAt: kickoffs[kickoffs.length - 1] ?? null,
    });
  }
  return options;
}

function anchorLabel(anchor: LiveBonusRoundAnchor, stages: LiveStageDef[], t: Translate): string {
  if (anchor.afterStageKey === null) return t('live.bonusRounds.admin.beforeAll');
  const stage = stages.find(s => s.key === anchor.afterStageKey);
  const stageName = stage ? t(stage.labelKey) : anchor.afterStageKey;
  return anchor.afterMatchday === null
    ? t('live.bonusRounds.admin.afterStage', { stage: stageName })
    : t('live.bonusRounds.admin.afterGameweek', { stage: stageName, matchday: anchor.afterMatchday });
}

/** ISO → the value a datetime-local input wants, in the browser's own time zone. */
function toLocalInput(isoString: string | null): string {
  if (!isoString) return '';
  const d = new Date(isoString);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value (local time) → ISO, or null when it is not a full date and time. */
function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function PlacementSelect({
  id,
  value,
  onChange,
  options,
  stages,
}: {
  id: string;
  value: LiveBonusRoundAnchor;
  onChange: (anchor: LiveBonusRoundAnchor) => void;
  options: LiveAnchorOption[];
  stages: LiveStageDef[];
}) {
  const { t } = useT();
  const current = anchorValue(value);
  const all: LiveBonusRoundAnchor[] = [{ afterStageKey: null, afterMatchday: null }, ...options];
  // An anchor whose gameweek has since gone stays selectable rather than silently moving.
  if (!all.some(o => anchorValue(o) === current)) all.push(value);
  return (
    <select id={id} value={current} onChange={e => onChange(parseAnchor(e.target.value))} className={inputClass}>
      {all.map(option => (
        <option key={anchorValue(option)} value={anchorValue(option)}>
          {anchorLabel(option, stages, t)}
        </option>
      ))}
    </select>
  );
}

function MultiplierSelect({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <select value={value} onChange={e => onChange(Number(e.target.value))} className={smallInputClass}>
      {Array.from({ length: LIVE_MAX_MULTIPLIER }, (_, i) => i + 1).map(n => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  );
}

export default function AdminLiveBonusRoundsPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useT();
  const queryClient = useQueryClient();

  const { data: competition, isLoading } = useQuery({
    queryKey: liveKeys.competition(id!),
    queryFn: () => liveApi.competition(id!),
    enabled: !!id,
  });
  const { data: fixtures = [] } = useQuery({
    queryKey: liveKeys.fixtures(id!),
    queryFn: () => liveApi.fixtures(id!),
    enabled: !!id,
  });
  const { data: rounds = [] } = useQuery({
    queryKey: liveKeys.bonusRounds(id!),
    queryFn: () => liveApi.bonusRounds(id!),
    enabled: !!id,
  });

  const stages = useMemo(() => competition?.stages ?? [], [competition?.stages]);
  const options = useMemo(() => anchorOptions(stages, fixtures), [stages, fixtures]);

  // Names already used in this competition's rounds, offered as suggestions, so "Norway"
  // is not typed three different ways.
  const teamNames = useMemo(
    () =>
      [...new Set(rounds.flatMap(r => r.fixtures.flatMap(f => [f.homeTeam?.name, f.awayTeam?.name])))]
        .filter((n): n is string => !!n)
        .sort(),
    [rounds],
  );
  const labels = useMemo(
    () =>
      [...new Set(rounds.flatMap(r => r.fixtures.map(f => f.label)))].filter((l): l is string => !!l).sort(),
    [rounds],
  );

  const [name, setName] = useState('');
  const [anchor, setAnchor] = useState<LiveBonusRoundAnchor>({ afterStageKey: null, afterMatchday: null });
  const [error, setError] = useState('');

  const createMutation = useMutation({
    mutationFn: () => liveApi.createBonusRound(id!, { name: name.trim(), ...anchor }),
    onSuccess: () => {
      setName('');
      setError('');
      queryClient.invalidateQueries({ queryKey: liveKeys.bonusRounds(id!) });
    },
    onError: err => setError(errorText(err)),
  });

  if (isLoading) return <LoadingSpinner />;
  if (!competition) return <p className="p-8 text-center">{t('live.competitionNotFound')}</p>;

  return (
    <main className="mx-auto max-w-2xl px-4 pb-12 pt-2.5 sm:pt-12 md:max-w-4xl">
      <Link to="/admin/live-competitions" className="text-sm text-muted-foreground hover:underline">
        {t('common.back')}
      </Link>
      <h1 className="mb-1 mt-2 text-2xl font-bold">
        {t('live.bonusRounds.admin.title')}: {competition.name}
      </h1>
      <p className="mb-6 text-sm text-muted-foreground">{t('live.bonusRounds.admin.intro')}</p>

      <datalist id="bonus-team-names">
        {teamNames.map(n => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <datalist id="bonus-labels">
        {labels.map(l => (
          <option key={l} value={l} />
        ))}
      </datalist>

      <form
        onSubmit={e => {
          e.preventDefault();
          if (name.trim()) createMutation.mutate();
        }}
        className="mb-8 grid gap-3 rounded-lg border p-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <div>
          <label htmlFor="br-name" className="mb-1 block text-xs font-medium">
            {t('live.bonusRounds.admin.name')}
          </label>
          <input
            id="br-name"
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('live.bonusRounds.admin.namePlaceholder')}
            maxLength={80}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="br-anchor" className="mb-1 block text-xs font-medium">
            {t('live.bonusRounds.admin.placeAfter')}
          </label>
          <PlacementSelect id="br-anchor" value={anchor} onChange={setAnchor} options={options} stages={stages} />
        </div>
        <button
          type="submit"
          disabled={!name.trim() || createMutation.isPending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('live.bonusRounds.admin.create')}
        </button>
        {error && <p className="text-sm text-destructive sm:col-span-3">{error}</p>}
      </form>

      {rounds.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t('live.bonusRounds.admin.noRounds')}
        </p>
      ) : (
        <div className="grid gap-4">
          {rounds.map(round => (
            <RoundEditor key={round.id} competitionId={id!} round={round} options={options} stages={stages} />
          ))}
        </div>
      )}
    </main>
  );
}

// ── One round ─────────────────────────────────────────────────────────────────

function RoundEditor({
  competitionId,
  round,
  options,
  stages,
}: {
  competitionId: string;
  round: LiveBonusRoundView;
  options: LiveAnchorOption[];
  stages: LiveStageDef[];
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState(round.name);
  const [anchor, setAnchor] = useState<LiveBonusRoundAnchor>({
    afterStageKey: round.afterStageKey,
    afterMatchday: round.afterMatchday,
  });
  const [visibility, setVisibility] = useState<LiveBonusRoundVisibility>(round.visibility);
  const [showMatches, setShowMatches] = useState(true);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: liveKeys.bonusRounds(competitionId) });
    queryClient.invalidateQueries({ queryKey: liveKeys.leaderboard(competitionId) });
  };

  const dirty =
    name.trim() !== round.name || anchorValue(anchor) !== anchorValue(round) || visibility !== round.visibility;

  const saveMutation = useMutation({
    mutationFn: () => liveApi.updateBonusRound(round.id, { name: name.trim(), ...anchor, visibility }),
    onSuccess: () => {
      setError('');
      setSavedAt(Date.now());
      invalidate();
    },
    onError: err => setError(errorText(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: () => liveApi.deleteBonusRound(round.id),
    onSuccess: invalidate,
    onError: err => setError(errorText(err)),
  });

  const suggested = suggestLiveBonusRoundAnchor(options, round.firstKickoffAt);

  return (
    <section className="rounded-lg border p-5">
      <div className="mb-4 flex items-center gap-2">
        <Star className="h-4 w-4 fill-current text-amber-500" aria-hidden />
        <h2 className="flex-1 font-semibold">{round.name}</h2>
        {round.visibility === 'test' && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {t('live.bonusRounds.testOnly')}
          </span>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={`name-${round.id}`} className="mb-1 block text-xs font-medium">
            {t('live.bonusRounds.admin.name')}
          </label>
          <input
            id={`name-${round.id}`}
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={80}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={`anchor-${round.id}`} className="mb-1 block text-xs font-medium">
            {t('live.bonusRounds.admin.placeAfter')}
          </label>
          <PlacementSelect id={`anchor-${round.id}`} value={anchor} onChange={setAnchor} options={options} stages={stages} />
          {round.firstKickoffAt && anchorValue(suggested) !== anchorValue(anchor) && (
            <button
              type="button"
              onClick={() => setAnchor(suggested)}
              className="mt-1 text-xs text-muted-foreground underline"
            >
              {t('live.bonusRounds.admin.suggestPlacement')}: {anchorLabel(suggested, stages, t)}
            </button>
          )}
        </div>
        <div>
          <label htmlFor={`vis-${round.id}`} className="mb-1 block text-xs font-medium">
            {t('live.bonusRounds.admin.visibility')}
          </label>
          <select
            id={`vis-${round.id}`}
            value={visibility}
            onChange={e => setVisibility(e.target.value as LiveBonusRoundVisibility)}
            className={inputClass}
          >
            <option value="test">{t('live.bonusRounds.admin.visibilityTest')}</option>
            <option value="everyone">{t('live.bonusRounds.admin.visibilityEveryone')}</option>
          </select>
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => saveMutation.mutate()}
          disabled={!dirty || !name.trim() || saveMutation.isPending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saveMutation.isPending ? t('common.saving') : t('live.bonusRounds.admin.save')}
        </button>
        <button
          type="button"
          onClick={() => setShowMatches(v => !v)}
          className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
        >
          {showMatches
            ? t('live.bonusRounds.admin.hideMatches')
            : t('live.bonusRounds.admin.matches', { count: round.fixtures.length })}
        </button>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(t('live.bonusRounds.admin.deleteConfirm'))) deleteMutation.mutate();
          }}
          disabled={deleteMutation.isPending}
          className="ml-auto rounded-md border px-4 py-2 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
        >
          {t('live.bonusRounds.admin.delete')}
        </button>
        {savedAt && !dirty && <span className="text-xs text-green-600">{t('live.bonusRounds.admin.saved')}</span>}
      </div>

      {showMatches && (
        <div className="mt-5 border-t pt-5">
          <h3 className="mb-2 text-sm font-semibold">
            {t('live.bonusRounds.admin.matches', { count: round.fixtures.length })}
          </h3>
          {round.fixtures.length === 0 ? (
            <p className="mb-4 text-sm text-muted-foreground">{t('live.bonusRounds.admin.noMatches')}</p>
          ) : (
            <div className="mb-4 grid gap-3">
              {round.fixtures.map(fixture => (
                <MatchEditor key={fixture.id} competitionId={competitionId} fixture={fixture} />
              ))}
            </div>
          )}
          <AddMatchForm competitionId={competitionId} roundId={round.id} />
        </div>
      )}
    </section>
  );
}

// ── Matches ───────────────────────────────────────────────────────────────────

interface MatchDraft {
  homeTeamName: string;
  awayTeamName: string;
  label: string;
  kickoff: string;
  multiplier: number;
}

function MatchFields({
  idPrefix,
  draft,
  onChange,
}: {
  idPrefix: string;
  draft: MatchDraft;
  onChange: (next: MatchDraft) => void;
}) {
  const { t } = useT();
  const field = (key: keyof MatchDraft, label: string, input: React.ReactNode) => (
    <div>
      <label htmlFor={`${idPrefix}-${key}`} className="mb-1 block text-xs font-medium">
        {label}
      </label>
      {input}
    </div>
  );
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto_auto]">
      {field(
        'homeTeamName',
        t('live.bonusRounds.admin.homeTeam'),
        <input
          id={`${idPrefix}-homeTeamName`}
          list="bonus-team-names"
          value={draft.homeTeamName}
          onChange={e => onChange({ ...draft, homeTeamName: e.target.value })}
          maxLength={60}
          className={`${smallInputClass} w-full`}
        />,
      )}
      {field(
        'awayTeamName',
        t('live.bonusRounds.admin.awayTeam'),
        <input
          id={`${idPrefix}-awayTeamName`}
          list="bonus-team-names"
          value={draft.awayTeamName}
          onChange={e => onChange({ ...draft, awayTeamName: e.target.value })}
          maxLength={60}
          className={`${smallInputClass} w-full`}
        />,
      )}
      {field(
        'label',
        t('live.bonusRounds.admin.label'),
        <input
          id={`${idPrefix}-label`}
          list="bonus-labels"
          value={draft.label}
          onChange={e => onChange({ ...draft, label: e.target.value })}
          placeholder={t('live.bonusRounds.admin.labelPlaceholder')}
          maxLength={60}
          className={`${smallInputClass} w-full`}
        />,
      )}
      {field(
        'kickoff',
        t('live.bonusRounds.admin.kickoff'),
        <input
          id={`${idPrefix}-kickoff`}
          type="datetime-local"
          value={draft.kickoff}
          onChange={e => onChange({ ...draft, kickoff: e.target.value })}
          className={smallInputClass}
        />,
      )}
      {field(
        'multiplier',
        t('live.bonusRounds.admin.multiplier'),
        <MultiplierSelect value={draft.multiplier} onChange={n => onChange({ ...draft, multiplier: n })} />,
      )}
    </div>
  );
}

function draftIsValid(draft: MatchDraft): boolean {
  return !!draft.homeTeamName.trim() && !!draft.awayTeamName.trim() && fromLocalInput(draft.kickoff) !== null;
}

function AddMatchForm({ competitionId, roundId }: { competitionId: string; roundId: string }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const empty: MatchDraft = { homeTeamName: '', awayTeamName: '', label: '', kickoff: '', multiplier: 1 };
  const [draft, setDraft] = useState<MatchDraft>(empty);
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      liveApi.createBonusFixture(roundId, {
        homeTeamName: draft.homeTeamName.trim(),
        awayTeamName: draft.awayTeamName.trim(),
        label: draft.label.trim() || null,
        kickoffAt: fromLocalInput(draft.kickoff)!,
        multiplier: draft.multiplier,
      }),
    onSuccess: () => {
      setError('');
      // Keep the label and the kickoff: the next match is usually from the same window.
      setDraft({ ...empty, label: draft.label, kickoff: draft.kickoff });
      queryClient.invalidateQueries({ queryKey: liveKeys.bonusRounds(competitionId) });
    },
    onError: err => setError(errorText(err)),
  });

  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        if (draftIsValid(draft)) mutation.mutate();
      }}
      className="rounded-md border border-dashed p-3"
    >
      <MatchFields idPrefix={`new-${roundId}`} draft={draft} onChange={setDraft} />
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      <button
        type="submit"
        disabled={!draftIsValid(draft) || mutation.isPending}
        className="mt-3 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {t('live.bonusRounds.admin.addMatch')}
      </button>
    </form>
  );
}

function MatchEditor({ competitionId, fixture }: { competitionId: string; fixture: LiveBonusRoundFixtureView }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const original: MatchDraft = {
    homeTeamName: fixture.homeTeam?.name ?? '',
    awayTeamName: fixture.awayTeam?.name ?? '',
    label: fixture.label ?? '',
    kickoff: toLocalInput(fixture.kickoffAt),
    multiplier: fixture.multiplier,
  };
  const [draft, setDraft] = useState<MatchDraft>(original);
  const [home, setHome] = useState(fixture.normalTimeHome?.toString() ?? '');
  const [away, setAway] = useState(fixture.normalTimeAway?.toString() ?? '');
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const invalidate = () => {
    setError('');
    setSavedAt(Date.now());
    queryClient.invalidateQueries({ queryKey: liveKeys.bonusRounds(competitionId) });
    queryClient.invalidateQueries({ queryKey: liveKeys.leaderboard(competitionId) });
  };

  const update = useMutation({
    mutationFn: (body: Parameters<typeof liveApi.updateBonusFixture>[1]) =>
      liveApi.updateBonusFixture(fixture.id, body),
    onSuccess: invalidate,
    onError: err => setError(errorText(err)),
  });

  const remove = useMutation({
    mutationFn: () => liveApi.deleteBonusFixture(fixture.id),
    onSuccess: invalidate,
    onError: err => setError(errorText(err)),
  });

  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
  const hasResult = fixture.normalTimeHome !== null && fixture.normalTimeAway !== null;
  const resultValid = /^\d{1,2}$/.test(home) && /^\d{1,2}$/.test(away);
  const resultChanged = home !== (fixture.normalTimeHome?.toString() ?? '') || away !== (fixture.normalTimeAway?.toString() ?? '');

  return (
    <div className="rounded-md border p-3">
      <MatchFields idPrefix={fixture.id} draft={draft} onChange={setDraft} />

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <button
          type="button"
          disabled={!dirty || !draftIsValid(draft) || update.isPending}
          onClick={() =>
            update.mutate({
              homeTeamName: draft.homeTeamName.trim(),
              awayTeamName: draft.awayTeamName.trim(),
              label: draft.label.trim() || null,
              kickoffAt: fromLocalInput(draft.kickoff)!,
              multiplier: draft.multiplier,
            })
          }
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        >
          {t('live.bonusRounds.admin.saveMatch')}
        </button>

        <div className="ml-auto flex items-end gap-1.5">
          <div>
            <span className="mb-1 block text-xs font-medium">{t('live.bonusRounds.admin.result')}</span>
            <span className="flex items-center gap-1">
              <input
                value={home}
                onChange={e => setHome(e.target.value)}
                inputMode="numeric"
                aria-label={`${t('live.bonusRounds.admin.result')}: ${draft.homeTeamName}`}
                className={`${smallInputClass} w-12 text-center`}
              />
              –
              <input
                value={away}
                onChange={e => setAway(e.target.value)}
                inputMode="numeric"
                aria-label={`${t('live.bonusRounds.admin.result')}: ${draft.awayTeamName}`}
                className={`${smallInputClass} w-12 text-center`}
              />
            </span>
          </div>
          <button
            type="button"
            disabled={!resultValid || !resultChanged || update.isPending}
            onClick={() => update.mutate({ homeScore: Number(home), awayScore: Number(away) })}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {t('live.bonusRounds.admin.resultSave')}
          </button>
          {hasResult && (
            <button
              type="button"
              disabled={update.isPending}
              onClick={() => {
                setHome('');
                setAway('');
                update.mutate({ homeScore: null, awayScore: null });
              }}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            >
              {t('live.bonusRounds.admin.resultClear')}
            </button>
          )}
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(t('live.bonusRounds.admin.deleteMatchConfirm'))) remove.mutate();
            }}
            className="rounded-md border px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            {t('live.bonusRounds.admin.deleteMatch')}
          </button>
        </div>
      </div>

      {!hasResult && <p className="mt-2 text-xs text-muted-foreground">{t('live.bonusRounds.admin.resultHint')}</p>}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      {savedAt && !dirty && !error && <p className="mt-2 text-xs text-green-600">{t('live.bonusRounds.admin.saved')}</p>}
    </div>
  );
}
