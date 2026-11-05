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
  type LiveBonusTeamOption,
  type LiveFixtureView,
} from '@/lib/liveApi';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import ImageUpload from '@/components/ImageUpload';
import TeamSelectInput from '@/components/TeamSelectInput';
import { useT } from '@/lib/useT';
import {
  LIVE_MAX_MULTIPLIER,
  suggestLiveBonusRoundAnchor,
  type LiveAnchorOption,
  type LiveBonusRoundAnchor,
  type LiveBonusRoundFixtureView,
  type LiveStageDef,
  type Team,
} from '@tournament-predictor/shared';

// ── Admin: a competition's bonus rounds ───────────────────────────────────────
//
// Create rounds of extra matches, place them between the competition's own rounds, set
// their matches up by hand — two teams, a kickoff, an optional competition label and a
// multiplier — and enter each result after 90 minutes once played, which is what scores
// it. The same way the manual tournament type works; no data provider is involved.
//
// Teams are picked from a searchable list of every team the database holds: registered
// bonus teams, plus the manual and live tournaments' teams (registered on first use). A
// team that is not there yet is created from the add-match card, with a name and a logo.
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
  /** Picker ids: a bonus team, or `manual:` / `live:` for another tournament's team. */
  homeTeamId: string;
  awayTeamId: string;
  label: string;
  kickoff: string;
  multiplier: number;
}

/** Every team the picker offers. One query, shared by every match row on the page. */
function useBonusTeams() {
  return useQuery({ queryKey: liveKeys.bonusTeams, queryFn: () => liveApi.bonusTeams() }).data ?? [];
}

/** The picker's options in the shape TeamSelectInput takes. Its value is a team name. */
function asTeams(options: LiveBonusTeamOption[]): Team[] {
  return options.map(o => ({ id: o.id, tournamentId: '', name: o.name, groupId: null, imageUrl: o.imageUrl }));
}

function TeamPicker({
  options,
  value,
  onChange,
}: {
  options: LiveBonusTeamOption[];
  value: string;
  onChange: (id: string) => void;
}) {
  const teams = useMemo(() => asTeams(options), [options]);
  const name = options.find(o => o.id === value)?.name ?? '';
  return (
    <TeamSelectInput
      teams={teams}
      value={name}
      onChange={picked => onChange(options.find(o => o.name === picked)?.id ?? '')}
    />
  );
}

function MatchFields({
  idPrefix,
  draft,
  onChange,
  options,
}: {
  idPrefix: string;
  draft: MatchDraft;
  onChange: (next: MatchDraft) => void;
  options: LiveBonusTeamOption[];
}) {
  const { t } = useT();
  return (
    <div className="grid gap-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <span className="mb-1 block text-xs font-medium">{t('live.bonusRounds.admin.homeTeam')}</span>
          <TeamPicker options={options} value={draft.homeTeamId} onChange={id => onChange({ ...draft, homeTeamId: id })} />
        </div>
        <div>
          <span className="mb-1 block text-xs font-medium">{t('live.bonusRounds.admin.awayTeam')}</span>
          <TeamPicker options={options} value={draft.awayTeamId} onChange={id => onChange({ ...draft, awayTeamId: id })} />
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <div>
          <label htmlFor={`${idPrefix}-label`} className="mb-1 block text-xs font-medium">
            {t('live.bonusRounds.admin.label')}
          </label>
          <input
            id={`${idPrefix}-label`}
            list="bonus-labels"
            value={draft.label}
            onChange={e => onChange({ ...draft, label: e.target.value })}
            placeholder={t('live.bonusRounds.admin.labelPlaceholder')}
            maxLength={60}
            className={`${smallInputClass} w-full`}
          />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-kickoff`} className="mb-1 block text-xs font-medium">
            {t('live.bonusRounds.admin.kickoff')}
          </label>
          <input
            id={`${idPrefix}-kickoff`}
            type="datetime-local"
            value={draft.kickoff}
            onChange={e => onChange({ ...draft, kickoff: e.target.value })}
            className={smallInputClass}
          />
        </div>
        <div>
          <span className="mb-1 block text-xs font-medium">{t('live.bonusRounds.admin.multiplier')}</span>
          <MultiplierSelect value={draft.multiplier} onChange={n => onChange({ ...draft, multiplier: n })} />
        </div>
      </div>
    </div>
  );
}

function draftIsValid(draft: MatchDraft): boolean {
  return (
    !!draft.homeTeamId &&
    !!draft.awayTeamId &&
    draft.homeTeamId !== draft.awayTeamId &&
    fromLocalInput(draft.kickoff) !== null
  );
}

/** Register a team that is not in the list yet: a name and a logo. */
function NewTeamForm({ onCreated, onCancel }: { onCreated: (teamId: string) => void; onCancel: () => void }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: () => liveApi.createBonusTeam({ name: name.trim(), imageUrl }),
    onSuccess: async team => {
      await queryClient.invalidateQueries({ queryKey: liveKeys.bonusTeams });
      onCreated(team.id);
    },
    onError: err => setError(errorText(err)),
  });

  return (
    <div className="mb-3 rounded-md border bg-muted/30 p-3">
      <h4 className="mb-2 text-sm font-semibold">{t('live.bonusRounds.admin.newTeamTitle')}</h4>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <span className="mb-1 block text-xs font-medium">{t('live.bonusRounds.admin.teamLogo')}</span>
          <ImageUpload
            type="teams"
            currentUrl={imageUrl}
            onUploaded={setImageUrl}
            shape="circle"
            size="sm"
            label={t('live.bonusRounds.admin.chooseLogo')}
          />
        </div>
        <div className="min-w-[12rem] flex-1">
          <label htmlFor="new-bonus-team-name" className="mb-1 block text-xs font-medium">
            {t('live.bonusRounds.admin.teamName')}
          </label>
          <input
            id="new-bonus-team-name"
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={60}
            className={`${smallInputClass} w-full`}
          />
        </div>
        <button
          type="button"
          disabled={!name.trim() || mutation.isPending}
          onClick={() => mutation.mutate()}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('live.bonusRounds.admin.createTeam')}
        </button>
        <button type="button" onClick={onCancel} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
          {t('common.cancel')}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}

function AddMatchForm({ competitionId, roundId }: { competitionId: string; roundId: string }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const options = useBonusTeams();
  const empty: MatchDraft = { homeTeamId: '', awayTeamId: '', label: '', kickoff: '', multiplier: 1 };
  const [draft, setDraft] = useState<MatchDraft>(empty);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      liveApi.createBonusFixture(roundId, {
        homeTeamId: draft.homeTeamId,
        awayTeamId: draft.awayTeamId,
        label: draft.label.trim() || null,
        kickoffAt: fromLocalInput(draft.kickoff)!,
        multiplier: draft.multiplier,
      }),
    onSuccess: () => {
      setError('');
      // Keep the label and the kickoff: the next match is usually from the same window.
      setDraft({ ...empty, label: draft.label, kickoff: draft.kickoff });
      queryClient.invalidateQueries({ queryKey: liveKeys.bonusRounds(competitionId) });
      // A tournament team picked here is a bonus team now.
      queryClient.invalidateQueries({ queryKey: liveKeys.bonusTeams });
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
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{t('live.bonusRounds.admin.addMatch')}</h4>
        {!creatingTeam && (
          <button
            type="button"
            onClick={() => setCreatingTeam(true)}
            className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
          >
            + {t('live.bonusRounds.admin.newTeam')}
          </button>
        )}
      </div>

      {creatingTeam && (
        <NewTeamForm
          onCancel={() => setCreatingTeam(false)}
          // Straight into whichever side is still empty.
          onCreated={teamId => {
            setCreatingTeam(false);
            setDraft(d =>
              !d.homeTeamId ? { ...d, homeTeamId: teamId } : !d.awayTeamId ? { ...d, awayTeamId: teamId } : d,
            );
          }}
        />
      )}

      <MatchFields idPrefix={`new-${roundId}`} draft={draft} onChange={setDraft} options={options} />
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
  const options = useBonusTeams();
  const original: MatchDraft = {
    homeTeamId: fixture.homeTeamId ?? '',
    awayTeamId: fixture.awayTeamId ?? '',
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
    queryClient.invalidateQueries({ queryKey: liveKeys.bonusTeams });
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
  const resultChanged =
    home !== (fixture.normalTimeHome?.toString() ?? '') || away !== (fixture.normalTimeAway?.toString() ?? '');

  return (
    <div className="rounded-md border p-3">
      <MatchFields idPrefix={fixture.id} draft={draft} onChange={setDraft} options={options} />

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <button
          type="button"
          disabled={!dirty || !draftIsValid(draft) || update.isPending}
          onClick={() =>
            update.mutate({
              homeTeamId: draft.homeTeamId,
              awayTeamId: draft.awayTeamId,
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
                aria-label={`${t('live.bonusRounds.admin.result')}: ${fixture.homeTeam?.name ?? ''}`}
                className={`${smallInputClass} w-12 text-center`}
              />
              –
              <input
                value={away}
                onChange={e => setAway(e.target.value)}
                inputMode="numeric"
                aria-label={`${t('live.bonusRounds.admin.result')}: ${fixture.awayTeam?.name ?? ''}`}
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
