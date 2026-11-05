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
  type LiveBonusSourceFixture,
  type LiveFixtureView,
} from '@/lib/liveApi';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useT } from '@/lib/useT';
import {
  LIVE_MAX_MULTIPLIER,
  suggestLiveBonusRoundAnchor,
  type LiveAnchorOption,
  type LiveBonusRoundAnchor,
  type LiveStageDef,
} from '@tournament-predictor/shared';

// ── Admin: a competition's bonus rounds ───────────────────────────────────────
//
// Create rounds of borrowed matches, place them between the competition's own rounds,
// pick their matches from a bonus-source tournament (the Nations League) across any
// matchdays, weight each match, and decide who sees the round. A new round is visible to
// test accounts only; switching it to everyone is what puts its points in the totals.
//
// See shared/src/live/bonusRounds.ts.

type Translate = ReturnType<typeof useT>['t'];

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
  const all = [{ afterStageKey: null, afterMatchday: null }, ...options];
  // An anchor whose gameweek has since gone stays selectable rather than silently moving.
  if (!all.some(o => anchorValue(o) === current)) all.push(value as LiveAnchorOption);
  return (
    <select
      id={id}
      value={current}
      onChange={e => onChange(parseAnchor(e.target.value))}
      className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
    >
      {all.map(option => (
        <option key={anchorValue(option)} value={anchorValue(option)}>
          {anchorLabel(option, stages, t)}
        </option>
      ))}
    </select>
  );
}

function VisibilitySelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: LiveBonusRoundVisibility;
  onChange: (value: LiveBonusRoundVisibility) => void;
}) {
  const { t } = useT();
  return (
    <select
      id={id}
      value={value}
      onChange={e => onChange(e.target.value as LiveBonusRoundVisibility)}
      className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
    >
      <option value="test">{t('live.bonusRounds.admin.visibilityTest')}</option>
      <option value="everyone">{t('live.bonusRounds.admin.visibilityEveryone')}</option>
    </select>
  );
}

const inputClass =
  'w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';

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
  const { data: sources = [] } = useQuery({
    queryKey: liveKeys.bonusSources,
    queryFn: () => liveApi.bonusSources(),
  });

  const stages = competition?.stages ?? [];
  const options = useMemo(() => anchorOptions(stages, fixtures), [stages, fixtures]);

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
    onError: err => setError(err instanceof ApiError ? err.message : String(err)),
  });

  if (isLoading) return <LoadingSpinner />;
  if (!competition) return <p className="p-8 text-center">{t('live.competitionNotFound')}</p>;

  // Matches already used by a round of this competition, so the picker can grey them out.
  const usedBy = new Map<string, string>();
  for (const round of rounds) for (const f of round.fixtures) usedBy.set(f.id, round.id);

  return (
    <main className="mx-auto max-w-2xl px-4 pb-12 pt-2.5 sm:pt-12 md:max-w-4xl">
      <Link to="/admin/live-competitions" className="text-sm text-muted-foreground hover:underline">
        {t('common.back')}
      </Link>
      <h1 className="mb-1 mt-2 text-2xl font-bold">
        {t('live.bonusRounds.admin.title')}: {competition.name}
      </h1>
      <p className="mb-6 text-sm text-muted-foreground">{t('live.bonusRounds.admin.intro')}</p>

      {sources.length === 0 && (
        <p className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          {t('live.bonusRounds.admin.noSources')}
        </p>
      )}

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
            <RoundEditor
              key={round.id}
              competitionId={id!}
              round={round}
              options={options}
              stages={stages}
              sources={sources}
              usedBy={usedBy}
            />
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
  sources,
  usedBy,
}: {
  competitionId: string;
  round: LiveBonusRoundView;
  options: LiveAnchorOption[];
  stages: LiveStageDef[];
  sources: Array<{ id: string; name: string }>;
  usedBy: Map<string, string>;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState(round.name);
  const [anchor, setAnchor] = useState<LiveBonusRoundAnchor>({
    afterStageKey: round.afterStageKey,
    afterMatchday: round.afterMatchday,
  });
  const [visibility, setVisibility] = useState<LiveBonusRoundVisibility>(round.visibility);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: liveKeys.bonusRounds(competitionId) });
    queryClient.invalidateQueries({ queryKey: liveKeys.leaderboard(competitionId) });
  };

  const dirty =
    name.trim() !== round.name ||
    anchorValue(anchor) !== anchorValue(round) ||
    visibility !== round.visibility;

  const saveMutation = useMutation({
    mutationFn: () => liveApi.updateBonusRound(round.id, { name: name.trim(), ...anchor, visibility }),
    onSuccess: () => {
      setError('');
      setSavedAt(Date.now());
      invalidate();
    },
    onError: err => setError(err instanceof ApiError ? err.message : String(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: () => liveApi.deleteBonusRound(round.id),
    onSuccess: invalidate,
    onError: err => setError(err instanceof ApiError ? err.message : String(err)),
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
          <PlacementSelect
            id={`anchor-${round.id}`}
            value={anchor}
            onChange={setAnchor}
            options={options}
            stages={stages}
          />
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
          <VisibilitySelect id={`vis-${round.id}`} value={visibility} onChange={setVisibility} />
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
          onClick={() => setPicking(p => !p)}
          className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
        >
          {picking
            ? t('live.bonusRounds.admin.hideMatches')
            : `${t('live.bonusRounds.admin.chooseMatches')} · ${t('live.bonusRounds.admin.matches', {
                count: round.fixtures.length,
              })}`}
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

      {picking && (
        <FixturePicker
          competitionId={competitionId}
          round={round}
          sources={sources}
          usedBy={usedBy}
        />
      )}
    </section>
  );
}

// ── Picking a round's matches ─────────────────────────────────────────────────

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function FixturePicker({
  competitionId,
  round,
  sources,
  usedBy,
}: {
  competitionId: string;
  round: LiveBonusRoundView;
  sources: Array<{ id: string; name: string }>;
  usedBy: Map<string, string>;
}) {
  const { t, language } = useT();
  const queryClient = useQueryClient();
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const [from, setFrom] = useState(() => isoDay(new Date()));
  const [to, setTo] = useState(() => isoDay(new Date(Date.now() + 45 * 24 * 60 * 60 * 1000)));
  const [search, setSearch] = useState('');
  // fixtureId → multiplier. Starts as the round's current matches.
  const [selected, setSelected] = useState<Map<string, number>>(
    () => new Map(round.fixtures.map(f => [f.id, f.multiplier])),
  );
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const { data: sourceFixtures = [], isLoading } = useQuery({
    queryKey: liveKeys.bonusSourceFixtures(sourceId),
    queryFn: () => liveApi.bonusSourceFixtures(sourceId),
    enabled: !!sourceId,
  });

  const needle = search.trim().toLowerCase();
  const shown = sourceFixtures.filter(f => {
    const day = (f.kickoffAt ?? '').slice(0, 10);
    // Selected matches always stay in view, whatever the filters say.
    if (selected.has(f.id)) return true;
    if (from && day < from) return false;
    if (to && day > to) return false;
    if (!needle) return true;
    return [f.homeTeam?.name, f.awayTeam?.name].some(n => n?.toLowerCase().includes(needle));
  });

  const byDay = new Map<string, LiveBonusSourceFixture[]>();
  for (const f of shown) {
    const day = (f.kickoffAt ?? '').slice(0, 10) || '?';
    const bucket = byDay.get(day) ?? [];
    bucket.push(f);
    byDay.set(day, bucket);
  }

  const original = new Map(round.fixtures.map(f => [f.id, f.multiplier]));
  const dirty =
    original.size !== selected.size || [...selected].some(([fid, m]) => original.get(fid) !== m);

  const saveMutation = useMutation({
    mutationFn: (force: boolean) =>
      liveApi.setBonusRoundFixtures(round.id, {
        fixtures: [...selected].map(([fixtureId, multiplier]) => ({ fixtureId, multiplier })),
        force,
      }),
    onSuccess: () => {
      setError('');
      setSavedAt(Date.now());
      queryClient.invalidateQueries({ queryKey: liveKeys.bonusRounds(competitionId) });
      queryClient.invalidateQueries({ queryKey: liveKeys.leaderboard(competitionId) });
    },
    onError: (err, force) => {
      const needsForce =
        err instanceof ApiError &&
        err.status === 409 &&
        (err.details as { needsForce?: boolean } | undefined)?.needsForce;
      if (needsForce && !force) {
        if (window.confirm(t('live.bonusRounds.admin.forceConfirm', { message: err.message }))) {
          saveMutation.mutate(true);
        }
        return;
      }
      setError(err instanceof ApiError ? err.message : String(err));
    },
  });

  const toggle = (fixtureId: string) =>
    setSelected(prev => {
      const next = new Map(prev);
      if (next.has(fixtureId)) next.delete(fixtureId);
      else next.set(fixtureId, 1);
      return next;
    });

  const timeFormat = new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' });
  const dayFormat = new Intl.DateTimeFormat(language, { weekday: 'short', day: 'numeric', month: 'short' });

  return (
    <div className="mt-5 border-t pt-5">
      <div className="mb-3 grid gap-3 sm:grid-cols-4">
        <div>
          <label htmlFor={`src-${round.id}`} className="mb-1 block text-xs font-medium">
            {t('live.bonusRounds.admin.source')}
          </label>
          <select
            id={`src-${round.id}`}
            value={sourceId}
            onChange={e => setSourceId(e.target.value)}
            className={inputClass}
          >
            {sources.map(s => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`from-${round.id}`} className="mb-1 block text-xs font-medium">
            {t('live.bonusRounds.admin.from')}
          </label>
          <input id={`from-${round.id}`} type="date" value={from} onChange={e => setFrom(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label htmlFor={`to-${round.id}`} className="mb-1 block text-xs font-medium">
            {t('live.bonusRounds.admin.to')}
          </label>
          <input id={`to-${round.id}`} type="date" value={to} onChange={e => setTo(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label htmlFor={`q-${round.id}`} className="mb-1 block text-xs font-medium">
            {t('live.bonusRounds.admin.search')}
          </label>
          <input id={`q-${round.id}`} type="search" value={search} onChange={e => setSearch(e.target.value)} className={inputClass} />
        </div>
      </div>

      <p className="mb-3 text-xs text-amber-700 dark:text-amber-400">{t('live.bonusRounds.admin.knockoutWarning')}</p>

      {isLoading ? (
        <LoadingSpinner />
      ) : byDay.size === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t('live.bonusRounds.admin.noFixtures')}
        </p>
      ) : (
        <div className="grid gap-4">
          {[...byDay.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([day, dayFixtures]) => (
              <div key={day}>
                <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                  {day === '?' ? '?' : dayFormat.format(new Date(`${day}T12:00:00Z`))}
                </h3>
                <ul className="divide-y rounded-md border">
                  {dayFixtures.map(f => {
                    const otherRound = usedBy.get(f.id);
                    const blocked = !!otherRound && otherRound !== round.id;
                    const isOn = selected.has(f.id);
                    return (
                      <li key={f.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                        <input
                          type="checkbox"
                          checked={isOn}
                          disabled={blocked}
                          onChange={() => toggle(f.id)}
                          aria-label={`${f.homeTeam?.name ?? '?'} – ${f.awayTeam?.name ?? '?'}`}
                        />
                        <span className="w-12 shrink-0 tabular-nums text-muted-foreground">
                          {f.kickoffAt ? timeFormat.format(new Date(f.kickoffAt)) : ''}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {f.homeTeam?.name ?? '?'} – {f.awayTeam?.name ?? '?'}
                          {f.status === 'finished' && f.normalTimeHome !== null && (
                            <span className="ml-2 tabular-nums text-muted-foreground">
                              {f.normalTimeHome}–{f.normalTimeAway}
                            </span>
                          )}
                        </span>
                        {blocked && (
                          <span className="text-xs text-muted-foreground">
                            {t('live.bonusRounds.admin.inOtherRound')}
                          </span>
                        )}
                        {isOn && (
                          <label className="flex items-center gap-1 text-xs">
                            {t('live.bonusRounds.admin.multiplier')}
                            <select
                              value={selected.get(f.id)}
                              onChange={e =>
                                setSelected(prev => new Map(prev).set(f.id, Number(e.target.value)))
                              }
                              className="rounded border bg-background px-1 py-0.5"
                            >
                              {Array.from({ length: LIVE_MAX_MULTIPLIER }, (_, i) => i + 1).map(n => (
                                <option key={n} value={n}>
                                  {n}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        {isOn && f.status === 'finished' && (
                          <ScoreOverride fixture={f} competitionId={competitionId} />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => saveMutation.mutate(false)}
          disabled={!dirty || saveMutation.isPending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saveMutation.isPending ? t('common.saving') : t('live.bonusRounds.admin.saveMatches')}
        </button>
        <span className="text-xs text-muted-foreground">
          {t('live.bonusRounds.admin.matches', { count: selected.size })}
        </span>
        {savedAt && !dirty && <span className="text-xs text-green-600">{t('live.bonusRounds.admin.saved')}</span>}
      </div>
    </div>
  );
}

// ── The 90-minute score, for a match the provider may have scored after extra time ──

function ScoreOverride({
  fixture,
  competitionId,
}: {
  fixture: LiveBonusSourceFixture;
  competitionId: string;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [home, setHome] = useState(fixture.scoreOverrideHome?.toString() ?? '');
  const [away, setAway] = useState(fixture.scoreOverrideAway?.toString() ?? '');

  const mutation = useMutation({
    mutationFn: (body: { homeScore: number | null; awayScore: number | null }) =>
      liveApi.setFixtureScoreOverride(fixture.id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: liveKeys.bonusSourceFixtures(fixture.liveTournamentId) });
      queryClient.invalidateQueries({ queryKey: liveKeys.bonusRounds(competitionId) });
      queryClient.invalidateQueries({ queryKey: liveKeys.leaderboard(competitionId) });
    },
  });

  const valid = /^\d+$/.test(home) && /^\d+$/.test(away);
  const hasOverride = fixture.scoreOverrideHome !== null;

  return (
    <span className="flex items-center gap-1 text-xs">
      {t('live.bonusRounds.admin.override')}
      <input
        value={home}
        onChange={e => setHome(e.target.value)}
        inputMode="numeric"
        className="w-8 rounded border bg-background px-1 py-0.5 text-center"
        aria-label={`${t('live.bonusRounds.admin.override')} ${fixture.homeTeam?.name ?? ''}`}
      />
      –
      <input
        value={away}
        onChange={e => setAway(e.target.value)}
        inputMode="numeric"
        className="w-8 rounded border bg-background px-1 py-0.5 text-center"
        aria-label={`${t('live.bonusRounds.admin.override')} ${fixture.awayTeam?.name ?? ''}`}
      />
      <button
        type="button"
        disabled={!valid || mutation.isPending}
        onClick={() => mutation.mutate({ homeScore: Number(home), awayScore: Number(away) })}
        className="rounded border px-1.5 py-0.5 hover:bg-muted disabled:opacity-50"
      >
        {t('live.bonusRounds.admin.overrideSave')}
      </button>
      {hasOverride && (
        <button
          type="button"
          disabled={mutation.isPending}
          onClick={() => {
            setHome('');
            setAway('');
            mutation.mutate({ homeScore: null, awayScore: null });
          }}
          className="rounded border px-1.5 py-0.5 hover:bg-muted disabled:opacity-50"
        >
          {t('live.bonusRounds.admin.overrideClear')}
        </button>
      )}
    </span>
  );
}
