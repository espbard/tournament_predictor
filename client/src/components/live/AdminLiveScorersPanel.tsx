import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { liveApi, liveKeys, type LivePlayerSearchHit } from '@/lib/liveApi';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import ImageUpload from '@/components/ImageUpload';
import { useT } from '@/lib/useT';
import type { LivePlayer } from '@tournament-predictor/shared';

// ── Admin: top-scorer shortlist ───────────────────────────────────────────────
//
// The shortlist is built one player at a time: type a name, pick the right person out of
// the competition's squads, and that player becomes a row. Nothing else is stored — the
// other ~880 players in the competition are never written down, because nobody is going to
// rank them and a page full of them is only in the way.
//
// Each row is then dressed: a picture, and a colour that becomes a glow around that
// player's row in the ranking every user sees. Goals and assists are editable whatever the
// source, since the provider is the source of truth where it answers and the admin is
// where it does not.
//
// A player the provider does not list at all can still be added by name, and picks up goals
// automatically if a later refresh recognises them.

/** Colours offered as one click, chosen to read on both the light and dark ranking rows. */
const GLOW_PRESETS = ['#f59e0b', '#22c55e', '#3b82f6', '#ec4899', '#a855f7', '#ef4444'];

const SEARCH_DEBOUNCE_MS = 300;

interface Props {
  tournamentId: string;
  /** The tournament's season, shown as the hint for which squads are being searched. */
  season?: string;
}

export default function AdminLiveScorersPanel({ tournamentId, season }: Props) {
  const { t } = useT();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [searchSeason, setSearchSeason] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);

  // Typing is not a query. Waiting for a pause keeps a burst of keystrokes to one request,
  // which matters on a provider that allows ten a minute.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search]);

  const { data: players = [], isLoading } = useQuery({
    queryKey: liveKeys.tournamentPlayers(tournamentId),
    queryFn: () => liveApi.tournamentPlayers(tournamentId),
  });

  const { data: results, isFetching: searching } = useQuery({
    queryKey: liveKeys.playerSearch(tournamentId, debounced, searchSeason),
    queryFn: () => liveApi.searchPlayers(tournamentId, debounced, searchSeason || undefined),
    // Two characters is the shortest search the server accepts, and a one-letter query
    // would match most of a competition anyway.
    enabled: debounced.length >= 2,
    staleTime: 60_000,
  });

  const { data: teams = [] } = useQuery({
    queryKey: liveKeys.tournamentTeams(tournamentId),
    queryFn: () => liveApi.tournamentTeams(tournamentId),
  });
  const teamNameById = useMemo(
    () => new Map(teams.map(team => [team.id, team.shortName ?? team.name])),
    [teams],
  );

  function refresh() {
    queryClient.invalidateQueries({ queryKey: liveKeys.tournamentPlayers(tournamentId) });
    // A player just added is "already added" in the next search, so the results are stale.
    queryClient.invalidateQueries({ queryKey: liveKeys.playerSearchAll(tournamentId) });
  }

  function reportError(err: unknown, fallback: string) {
    setMessage('');
    setError(err instanceof ApiError ? err.message : fallback);
  }

  const addMutation = useMutation({
    mutationFn: (hit: LivePlayerSearchHit) =>
      liveApi.createPlayer(tournamentId, {
        name: hit.name,
        providerPlayerId: hit.providerPlayerId,
        teamId: hit.teamId,
        position: hit.position,
      }),
    onSuccess: player => {
      setError('');
      setMessage(t('live.admin.scorers.added', { name: player.name }));
      refresh();
    },
    onError: err => reportError(err, t('live.admin.scorers.addFailed')),
  });

  const addByNameMutation = useMutation({
    mutationFn: (name: string) => liveApi.createPlayer(tournamentId, { name }),
    onSuccess: player => {
      setError('');
      setMessage(t('live.admin.scorers.added', { name: player.name }));
      setSearch('');
      refresh();
    },
    onError: err => reportError(err, t('live.admin.scorers.addFailed')),
  });

  const refreshGoalsMutation = useMutation({
    mutationFn: () => liveApi.refreshPlayerGoals(tournamentId),
    onSuccess: result => {
      setError('');
      refresh();
      if (!result.supported) {
        setMessage(t('live.admin.scorers.refreshUnsupported'));
        return;
      }
      if (result.seasonUnavailable) {
        setMessage(t('live.admin.scorers.refreshSeasonUnavailable'));
        return;
      }
      // "Nothing happened" has three quite different causes, and one sentence for all of
      // them reads like a failure when two of them are perfectly normal.
      if (result.shortlistSize === 0) {
        setMessage(t('live.admin.scorers.refreshNoPlayers'));
        return;
      }
      if (result.scorersFetched === 0) {
        setMessage(t('live.admin.scorers.refreshNoGoalsYet'));
        return;
      }
      const changed = result.updated + result.adopted;
      setMessage(
        changed === 0
          ? t('live.admin.scorers.refreshUnchanged', { players: result.shortlistSize })
          : t('live.admin.scorers.refreshed', {
              updated: changed,
              waiting: result.unmatchedNames.length,
            }),
      );
    },
    onError: err => reportError(err, t('live.admin.scorers.refreshFailed')),
  });

  const updateMutation = useMutation({
    mutationFn: (vars: {
      playerId: string;
      body: {
        goals?: number;
        assists?: number;
        isSelected?: boolean;
        imageUrl?: string | null;
        glowColor?: string | null;
      };
    }) => liveApi.updatePlayer(tournamentId, vars.playerId, vars.body),
    onSuccess: () => {
      setError('');
      refresh();
    },
    onError: err => reportError(err, t('live.admin.scorers.saveFailed')),
  });

  const purgeMutation = useMutation({
    mutationFn: () => liveApi.deleteUnselectedPlayers(tournamentId),
    onSuccess: result => {
      setError('');
      setShowPurgeConfirm(false);
      setMessage(t('live.admin.scorers.purged', { count: result.deleted }));
      refresh();
    },
    onError: err => {
      setShowPurgeConfirm(false);
      reportError(err, t('live.admin.scorers.purgeFailed'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (playerId: string) => liveApi.deletePlayer(tournamentId, playerId),
    onSuccess: () => {
      setError('');
      refresh();
    },
    onError: err => reportError(err, t('live.admin.scorers.deleteFailed')),
  });

  const selectedCount = players.filter(p => p.isSelected).length;
  // Everything left over from the old bulk-import model: in the table, in nobody's ranking.
  const candidateCount = players.length - selectedCount;
  const busy = updateMutation.isPending || deleteMutation.isPending;

  if (isLoading) {
    return (
      <div className="mb-6 rounded-lg border p-5">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-lg border p-5">
      <h2 className="mb-1 font-semibold">{t('live.admin.scorers.title')}</h2>
      <p className="mb-4 text-sm text-muted-foreground">{t('live.admin.scorers.explainer')}</p>

      {/* ── Search ───────────────────────────────────────────────────────────── */}
      <div className="mb-5 rounded-md border bg-muted/30 p-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">
              {t('live.admin.scorers.searchLabel')}
            </span>
            <div className="relative">
              <Search
                size={14}
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('live.admin.scorers.searchPlaceholder')}
                className="h-9 w-full min-w-[14rem] rounded-md border bg-background pl-7 pr-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">
              {t('live.admin.scorers.season')}
            </span>
            <input
              value={searchSeason}
              onChange={e => setSearchSeason(e.target.value)}
              placeholder={season ?? ''}
              className="h-9 w-24 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <button
            onClick={() => refreshGoalsMutation.mutate()}
            disabled={refreshGoalsMutation.isPending}
            className="h-9 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {refreshGoalsMutation.isPending
              ? t('live.admin.scorers.refreshing')
              : t('live.admin.scorers.refreshGoals')}
          </button>
        </div>

        {debounced.length >= 2 && (
          <div className="mt-3">
            {searching && !results ? (
              <p className="text-xs text-muted-foreground">{t('live.admin.scorers.searching')}</p>
            ) : results && !results.supported ? (
              <p className="text-xs text-muted-foreground">
                {t('live.admin.scorers.searchUnsupported')}
              </p>
            ) : results?.seasonUnavailable ? (
              <p className="text-xs text-muted-foreground">
                {t('live.admin.scorers.searchSeasonUnavailable')}
              </p>
            ) : results && results.hits.length === 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs text-muted-foreground">
                  {t('live.admin.scorers.noHits', { query: debounced })}
                </p>
                {/* Not every player is in a published squad — a late signing, a youth-team
                    call-up. Adding the typed name by hand is the way through that. */}
                <button
                  onClick={() => addByNameMutation.mutate(debounced)}
                  disabled={addByNameMutation.isPending}
                  className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                >
                  {t('live.admin.scorers.addByName', { name: debounced })}
                </button>
              </div>
            ) : (
              <ul className="grid gap-1">
                {results?.hits.map(hit => (
                  <li
                    key={hit.providerPlayerId}
                    className="flex items-center gap-3 rounded-md border bg-background px-3 py-1.5 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {hit.name}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {[hit.teamName, hit.position].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    {hit.alreadyAdded ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t('live.admin.scorers.alreadyAdded')}
                      </span>
                    ) : (
                      <button
                        onClick={() => addMutation.mutate(hit)}
                        disabled={addMutation.isPending}
                        className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                      >
                        {t('live.admin.scorers.add')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* ── The shortlist ────────────────────────────────────────────────────── */}
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <p className="text-xs text-muted-foreground">
          {t('live.admin.scorers.state', { selected: selectedCount, total: players.length })}
        </p>
        {/* Only offered while there is leftover haystack to clear. Once it is gone — and
            nothing adds to it any more — the control goes with it. */}
        {candidateCount > 0 && (
          <button
            onClick={() => setShowPurgeConfirm(true)}
            disabled={purgeMutation.isPending}
            className="rounded border border-destructive/30 px-2 py-1 text-xs text-destructive hover:bg-destructive/5 disabled:opacity-50"
          >
            {t('live.admin.scorers.purge', { count: candidateCount })}
          </button>
        )}
      </div>

      {showPurgeConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-lg border bg-background p-6 shadow-xl">
            <p className="mb-1 font-semibold">
              {t('live.admin.scorers.purgeConfirm.title', { count: candidateCount })}
            </p>
            <p className="mb-6 text-sm text-muted-foreground">
              {t('live.admin.scorers.purgeConfirm.body')}
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowPurgeConfirm(false)}
                disabled={purgeMutation.isPending}
                className="rounded-md border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => purgeMutation.mutate()}
                disabled={purgeMutation.isPending}
                className="rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
              >
                {purgeMutation.isPending
                  ? t('live.admin.scorers.purgeConfirm.removing')
                  : t('live.admin.scorers.purgeConfirm.remove')}
              </button>
            </div>
          </div>
        </div>
      )}

      {players.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('live.admin.scorers.empty')}</p>
      ) : (
        <ul className="grid gap-1">
          {players.map(player => (
            <PlayerRow
              key={player.id}
              player={player}
              teamName={teamNameById.get(player.teamId ?? '') ?? null}
              onToggle={isSelected =>
                updateMutation.mutate({ playerId: player.id, body: { isSelected } })
              }
              onNumbers={(goals, assists) =>
                updateMutation.mutate({ playerId: player.id, body: { goals, assists } })
              }
              onImage={imageUrl =>
                updateMutation.mutate({ playerId: player.id, body: { imageUrl } })
              }
              onGlow={glowColor =>
                updateMutation.mutate({ playerId: player.id, body: { glowColor } })
              }
              onDelete={() => deleteMutation.mutate(player.id)}
              busy={busy}
            />
          ))}
        </ul>
      )}

      {message && <p className="mt-3 text-sm text-green-600 dark:text-green-400">{message}</p>}
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
    </div>
  );
}

// ── One player ────────────────────────────────────────────────────────────────

interface RowProps {
  player: LivePlayer;
  /** The club, resolved by the panel — the row has only a team id. */
  teamName: string | null;
  onToggle: (isSelected: boolean) => void;
  onNumbers: (goals: number, assists: number) => void;
  onImage: (imageUrl: string) => void;
  onGlow: (glowColor: string | null) => void;
  onDelete: () => void;
  busy: boolean;
}

function PlayerRow({
  player,
  teamName,
  onToggle,
  onNumbers,
  onImage,
  onGlow,
  onDelete,
  busy,
}: RowProps) {
  const { t } = useT();
  const [goals, setGoals] = useState<string | null>(null);
  const [assists, setAssists] = useState<string | null>(null);

  /**
   * Save the numbers when the admin leaves the field.
   *
   * Anything unusable goes back to what is stored rather than being sent — a half-typed
   * field must not become somebody's goal count — and an unchanged pair is not sent at
   * all, since every save rebuilds the tournament's scores.
   */
  function commit() {
    const nextGoals = goals === null ? player.goals : Number(goals);
    const nextAssists = assists === null ? player.assists : Number(assists);
    const valid =
      Number.isInteger(nextGoals) &&
      nextGoals >= 0 &&
      Number.isInteger(nextAssists) &&
      nextAssists >= 0;

    if (!valid || (nextGoals === player.goals && nextAssists === player.assists)) {
      setGoals(null);
      setAssists(null);
      return;
    }
    onNumbers(nextGoals, nextAssists);
    setGoals(null);
    setAssists(null);
  }

  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"
      // The row previews its own glow, so the colour is chosen against the thing it
      // affects rather than against a swatch.
      style={
        player.glowColor
          ? { borderColor: `${player.glowColor}80`, boxShadow: `inset 0 0 24px -12px ${player.glowColor}` }
          : undefined
      }
    >
      {/* Outside any label, so a click on it never lands on the shortlist checkbox. */}
      <input
        type="checkbox"
        checked={player.isSelected}
        onChange={e => onToggle(e.target.checked)}
        disabled={busy}
        aria-label={t('live.admin.scorers.inShortlist', { name: player.name })}
        className="h-4 w-4 shrink-0"
      />

      <ImageUpload
        type="live-players"
        currentUrl={player.imageUrl}
        onUploaded={onImage}
        shape="circle"
        size="sm"
        label={
          player.imageUrl
            ? t('live.admin.scorers.changePicture')
            : t('live.admin.scorers.choosePicture')
        }
      />

      <span className="min-w-0 flex-1 truncate">
        {player.name}
        {(teamName || player.position) && (
          <span className="ml-2 text-xs text-muted-foreground">
            {[teamName, player.position].filter(Boolean).join(' · ')}
          </span>
        )}
        {/* Says where this row's numbers come from: a provider id means a refresh keeps
            them current, and its absence means they are whatever was typed here. */}
        {player.providerPlayerId === null && (
          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {t('live.admin.scorers.manual')}
          </span>
        )}
      </span>

      <GlowPicker
        value={player.glowColor}
        onChange={onGlow}
        disabled={busy}
        label={t('live.admin.scorers.glowFor', { name: player.name })}
        clearLabel={t('live.admin.scorers.clearGlow')}
      />

      <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        {t('live.admin.scorers.goalsShort')}
        <input
          type="number"
          min={0}
          value={goals ?? String(player.goals)}
          onChange={e => setGoals(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          disabled={busy}
          className="h-8 w-14 rounded-md border bg-background text-center text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
        />
      </label>

      <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        {t('live.admin.scorers.assistsShort')}
        <input
          type="number"
          min={0}
          value={assists ?? String(player.assists)}
          onChange={e => setAssists(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          disabled={busy}
          className="h-8 w-14 rounded-md border bg-background text-center text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
        />
      </label>

      <button
        onClick={onDelete}
        disabled={busy}
        className="shrink-0 rounded border border-destructive/30 px-2 py-1 text-xs text-destructive hover:bg-destructive/5 disabled:opacity-50"
      >
        {t('common.delete')}
      </button>
    </li>
  );
}

// ── The colour ────────────────────────────────────────────────────────────────

interface GlowPickerProps {
  value: string | null;
  onChange: (color: string | null) => void;
  disabled: boolean;
  label: string;
  clearLabel: string;
}

/**
 * Six presets and a full colour input.
 *
 * The presets are there because picking a colour out of a wheel for ten players is
 * tedious and lands on muddy ones; the input is there because it is the admin's league and
 * their club colours are not on my list.
 */
function GlowPicker({ value, onChange, disabled, label, clearLabel }: GlowPickerProps) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {GLOW_PRESETS.map(color => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          disabled={disabled}
          aria-label={color}
          className={`h-4 w-4 rounded-full border transition-transform hover:scale-110 disabled:opacity-50 ${
            value?.toLowerCase() === color ? 'ring-2 ring-offset-1 ring-foreground' : ''
          }`}
          style={{ backgroundColor: color }}
        />
      ))}
      <input
        type="color"
        value={value ?? '#888888'}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        aria-label={label}
        className="h-6 w-6 cursor-pointer rounded border bg-background disabled:opacity-50"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange(null)}
          disabled={disabled}
          className="rounded px-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {clearLabel}
        </button>
      )}
    </span>
  );
}
