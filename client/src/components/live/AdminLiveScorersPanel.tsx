import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { liveApi, liveKeys } from '@/lib/liveApi';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import ImageUpload from '@/components/ImageUpload';
import { useT } from '@/lib/useT';
import type { LivePlayer } from '@tournament-predictor/shared';

// ── Admin: top-scorer shortlist ───────────────────────────────────────────────
//
// The players users rank, and the goals the ranking is settled on. Two ways in:
//
//   * import the provider's scorer list, which is also how goals stay current;
//   * add a player by hand, for anyone the provider does not list — including, before a
//     season has started, everyone.
//
// Ticking a player puts them in the shortlist. Everything else in the list is a candidate
// and is neither ranked nor scored, which is why an import can be generous.
//
// Goals and assists are editable whatever the source: the provider is the source of truth
// where it answers, and the admin is the source of truth where it does not.

interface Props {
  tournamentId: string;
  /** The tournament's season, shown as the hint for what an import will ask for. */
  season?: string;
}

export default function AdminLiveScorersPanel({ tournamentId, season }: Props) {
  const { t } = useT();
  const queryClient = useQueryClient();

  const [importSeason, setImportSeason] = useState('');
  const [newName, setNewName] = useState('');
  const [newImageUrl, setNewImageUrl] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const { data: players = [], isLoading } = useQuery({
    queryKey: liveKeys.tournamentPlayers(tournamentId),
    queryFn: () => liveApi.tournamentPlayers(tournamentId),
  });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: liveKeys.tournamentPlayers(tournamentId) });
  }

  function reportError(err: unknown, fallback: string) {
    setMessage('');
    setError(err instanceof ApiError ? err.message : fallback);
  }

  const importMutation = useMutation({
    mutationFn: () =>
      liveApi.importScorers(tournamentId, importSeason ? { season: importSeason } : {}),
    onSuccess: result => {
      setError('');
      refresh();
      if (!result.supported) {
        setMessage(t('live.admin.scorers.importUnsupported'));
        return;
      }
      setMessage(
        t('live.admin.scorers.imported', {
          fetched: result.fetched,
          created: result.created,
          updated: result.updated + result.adopted,
        }) + (result.truncated ? ` ${t('live.admin.scorers.importTruncated')}` : ''),
      );
    },
    onError: err => reportError(err, t('live.admin.scorers.importFailed')),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      liveApi.createPlayer(tournamentId, {
        name: newName.trim(),
        imageUrl: newImageUrl,
        // A player added by hand is almost always one the admin wants ranked, so they go
        // straight into the shortlist rather than needing a second click.
        isSelected: true,
      }),
    onSuccess: () => {
      setError('');
      setMessage(t('live.admin.scorers.added', { name: newName.trim() }));
      setNewName('');
      setNewImageUrl(null);
      refresh();
    },
    onError: err => reportError(err, t('live.admin.scorers.addFailed')),
  });

  const updateMutation = useMutation({
    mutationFn: (vars: {
      playerId: string;
      body: { goals?: number; assists?: number; isSelected?: boolean; imageUrl?: string | null };
    }) => liveApi.updatePlayer(tournamentId, vars.playerId, vars.body),
    onSuccess: () => {
      setError('');
      refresh();
    },
    onError: err => reportError(err, t('live.admin.scorers.saveFailed')),
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

  if (isLoading) {
    return (
      <div className="mb-6 rounded-lg border p-5">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-lg border p-5">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">{t('live.admin.scorers.title')}</h2>
        <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
          {t('live.admin.scorers.testBadge')}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{t('live.admin.scorers.explainer')}</p>
      <p className="mb-4 text-sm text-muted-foreground">{t('live.admin.scorers.testOnly')}</p>

      {/* Import */}
      <div className="mb-5 rounded-md border bg-muted/30 p-3">
        <p className="mb-2 text-xs text-muted-foreground">
          {t('live.admin.scorers.importExplainer')}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">
              {t('live.admin.scorers.season')}
            </span>
            <input
              value={importSeason}
              onChange={e => setImportSeason(e.target.value)}
              placeholder={season ?? ''}
              className="h-9 w-28 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <button
            onClick={() => importMutation.mutate()}
            disabled={importMutation.isPending}
            className="h-9 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {importMutation.isPending
              ? t('live.admin.scorers.importing')
              : t('live.admin.scorers.import')}
          </button>
        </div>
      </div>

      {/* Add by hand */}
      <div className="mb-5 rounded-md border p-3">
        <p className="mb-2 text-xs text-muted-foreground">{t('live.admin.scorers.addExplainer')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <ImageUpload
            type="live-players"
            currentUrl={newImageUrl}
            onUploaded={setNewImageUrl}
            shape="circle"
            size="sm"
            label={t('live.admin.scorers.choosePicture')}
          />
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">
              {t('live.admin.scorers.playerName')}
            </span>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && newName.trim()) createMutation.mutate();
              }}
              className="h-9 w-56 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <button
            onClick={() => createMutation.mutate()}
            disabled={!newName.trim() || createMutation.isPending}
            className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {createMutation.isPending ? t('common.saving') : t('live.admin.scorers.add')}
          </button>
        </div>
      </div>

      <p className="mb-2 text-xs text-muted-foreground">
        {t('live.admin.scorers.state', { selected: selectedCount, total: players.length })}
      </p>

      {players.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('live.admin.scorers.empty')}</p>
      ) : (
        <ul className="grid gap-1">
          {players.map(player => (
            <PlayerRow
              key={player.id}
              player={player}
              onToggle={isSelected =>
                updateMutation.mutate({ playerId: player.id, body: { isSelected } })
              }
              onNumbers={(goals, assists) =>
                updateMutation.mutate({ playerId: player.id, body: { goals, assists } })
              }
              onImage={imageUrl =>
                updateMutation.mutate({ playerId: player.id, body: { imageUrl } })
              }
              onDelete={() => deleteMutation.mutate(player.id)}
              busy={updateMutation.isPending || deleteMutation.isPending}
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
  onToggle: (isSelected: boolean) => void;
  onNumbers: (goals: number, assists: number) => void;
  onImage: (imageUrl: string) => void;
  onDelete: () => void;
  busy: boolean;
}

function PlayerRow({ player, onToggle, onNumbers, onImage, onDelete, busy }: RowProps) {
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
    <li className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
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
        label={player.imageUrl ? t('live.admin.scorers.changePicture') : t('live.admin.scorers.choosePicture')}
      />

      <span className="min-w-0 flex-1 truncate">
        {player.name}
        {/* Says where this row's numbers come from: a provider id means a sync keeps them
            current, and its absence means they are whatever was typed here. */}
        {player.providerPlayerId === null && (
          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {t('live.admin.scorers.manual')}
          </span>
        )}
      </span>

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
