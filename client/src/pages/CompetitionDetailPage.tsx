import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import ImageUpload from '@/components/ImageUpload';
import type { Competition, Tournament, Prediction, MatchStage } from '@tournament-predictor/shared';

interface LeaderboardEntry {
  userId: string;
  username: string;
  imageUrl?: string | null;
  totalPoints: number;
  rank: number;
}

interface MatchWithTeams {
  id: string;
  tournamentId: string;
  homeTeamId: string | null;
  awayTeamId: string | null;
  homeTeamName: string | null;
  awayTeamName: string | null;
  homeTeamImageUrl: string | null;
  awayTeamImageUrl: string | null;
  stage: MatchStage;
  scheduledAt: string | null;
  status: 'scheduled' | 'completed';
  homeScore: number | null;
  awayScore: number | null;
  groupName: string | null;
}

const STAGE_LABELS: Record<MatchStage, string> = {
  group: 'Group Stage',
  round_of_16: 'Round of 16',
  quarter_final: 'Quarter-finals',
  semi_final: 'Semi-finals',
  final: 'Final',
};

export default function CompetitionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuthStore();
  const queryClient = useQueryClient();

  const [editName, setEditName] = useState('');
  const [editImageUrl, setEditImageUrl] = useState<string | null>(null);
  const [editDeadline, setEditDeadline] = useState('');
  const [showEdit, setShowEdit] = useState(false);
  const [editError, setEditError] = useState('');

  const [predictionsOpen, setPredictionsOpen] = useState(false);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);

  const [localEdits, setLocalEdits] = useState<Record<string, { home: string; away: string }>>({});
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});

  const { data: competition, isLoading, error } = useQuery({
    queryKey: ['competitions', id],
    queryFn: () => api.get<Competition>(`/competitions/${id}`),
  });

  const { data: leaderboard = [] } = useQuery({
    queryKey: ['competitions', id, 'leaderboard'],
    queryFn: () => api.get<LeaderboardEntry[]>(`/competitions/${id}/leaderboard`),
    enabled: !!competition,
  });

  const { data: tournamentsData = [] } = useQuery({
    queryKey: ['tournaments'],
    queryFn: () => api.get<Tournament[]>('/tournaments'),
    enabled: !!user?.isAdmin,
  });

  const { data: matchList = [] } = useQuery({
    queryKey: ['tournaments', competition?.tournamentId, 'matches'],
    queryFn: () => api.get<MatchWithTeams[]>(`/tournaments/${competition!.tournamentId}/matches`),
    enabled: !!competition,
  });

  const { data: savedPredictions = [] } = useQuery({
    queryKey: ['competitions', id, 'predictions'],
    queryFn: () => api.get<Prediction[]>(`/competitions/${id}/predictions`),
    enabled: !!competition,
  });

  useEffect(() => {
    if (!savedPredictions.length) return;
    setLocalEdits(prev => {
      let changed = false;
      const updates: Record<string, { home: string; away: string }> = {};
      for (const p of savedPredictions) {
        if (!(p.matchId in prev)) {
          updates[p.matchId] = { home: String(p.homeScore), away: String(p.awayScore) };
          changed = true;
        }
      }
      return changed ? { ...prev, ...updates } : prev;
    });
  }, [savedPredictions]);

  const predMap = useMemo(
    () => Object.fromEntries(savedPredictions.map(p => [p.matchId, p])),
    [savedPredictions]
  );

  const matchesByDate = useMemo(() => {
    const sorted = [...matchList].sort((a, b) => {
      if (!a.scheduledAt && !b.scheduledAt) return 0;
      if (!a.scheduledAt) return 1;
      if (!b.scheduledAt) return -1;
      return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
    });

    const groups: { dateKey: string; dateLabel: string; matches: MatchWithTeams[] }[] = [];
    const indexByKey = new Map<string, number>();

    for (const m of sorted) {
      let dateKey: string;
      let dateLabel: string;
      if (m.scheduledAt) {
        const d = new Date(m.scheduledAt);
        dateKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        dateLabel = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      } else {
        dateKey = 'unscheduled';
        dateLabel = 'Unscheduled';
      }
      if (!indexByKey.has(dateKey)) {
        indexByKey.set(dateKey, groups.length);
        groups.push({ dateKey, dateLabel, matches: [] });
      }
      groups[indexByKey.get(dateKey)!].matches.push(m);
    }

    return groups;
  }, [matchList]);

  const deadlinePassed = competition?.predictionDeadline
    ? new Date() > new Date(competition.predictionDeadline)
    : false;

  function isDirty(matchId: string): boolean {
    const edit = localEdits[matchId];
    if (!edit) return false;
    const saved = predMap[matchId];
    if (!saved) return edit.home !== '' || edit.away !== '';
    return edit.home !== String(saved.homeScore) || edit.away !== String(saved.awayScore);
  }

  function isValidEdit(matchId: string): boolean {
    const edit = localEdits[matchId];
    if (!edit) return false;
    const h = parseInt(edit.home, 10);
    const a = parseInt(edit.away, 10);
    return !isNaN(h) && !isNaN(a) && h >= 0 && a >= 0;
  }

  async function savePrediction(matchId: string) {
    const edit = localEdits[matchId];
    if (!edit) return;
    const homeScore = parseInt(edit.home, 10);
    const awayScore = parseInt(edit.away, 10);
    if (isNaN(homeScore) || isNaN(awayScore)) return;

    setSavingIds(prev => new Set([...prev, matchId]));
    setSaveErrors(prev => { const n = { ...prev }; delete n[matchId]; return n; });

    try {
      await api.post<Prediction>(`/competitions/${id}/predictions`, { matchId, homeScore, awayScore });
      queryClient.invalidateQueries({ queryKey: ['competitions', id, 'predictions'] });
      setSavedIds(prev => new Set([...prev, matchId]));
      setTimeout(() => setSavedIds(prev => { const n = new Set(prev); n.delete(matchId); return n; }), 2000);
    } catch (err) {
      setSaveErrors(prev => ({
        ...prev,
        [matchId]: err instanceof ApiError ? err.message : 'Failed to save',
      }));
    } finally {
      setSavingIds(prev => { const n = new Set(prev); n.delete(matchId); return n; });
    }
  }

  const updateMutation = useMutation({
    mutationFn: (body: { name?: string; imageUrl?: string | null; predictionDeadline?: string | null }) =>
      api.patch<Competition>(`/competitions/${id}`, body),
    onSuccess: () => {
      setShowEdit(false);
      setEditError('');
      queryClient.invalidateQueries({ queryKey: ['competitions', id] });
      queryClient.invalidateQueries({ queryKey: ['competitions'] });
    },
    onError: (err) => {
      setEditError(err instanceof ApiError ? err.message : 'Failed to update');
    },
  });

  function openEdit() {
    if (!competition) return;
    setEditName(competition.name);
    setEditImageUrl(competition.imageUrl ?? null);
    setEditDeadline(
      competition.predictionDeadline
        ? new Date(competition.predictionDeadline).toISOString().slice(0, 16)
        : ''
    );
    setShowEdit(true);
  }

  function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    updateMutation.mutate({
      name: editName.trim() || undefined,
      imageUrl: editImageUrl,
      predictionDeadline: editDeadline ? new Date(editDeadline).toISOString() : null,
    });
  }

  if (isLoading) return <p className="p-8 text-sm text-muted-foreground">Loading…</p>;
  if (error) {
    const msg = error instanceof ApiError ? error.message : 'Failed to load competition';
    return <p className="p-8 text-sm text-destructive">{msg}</p>;
  }
  if (!competition) return null;

  const tournament = tournamentsData.find(t => t.id === competition.tournamentId);

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <div className="mb-2 text-sm text-muted-foreground">
        <Link to={user?.isAdmin ? '/competitions' : '/'} className="hover:underline">
          ← {user?.isAdmin ? 'Competitions' : 'Home'}
        </Link>
      </div>

      {/* Header */}
      <div className="mb-8 flex items-start gap-4">
        {competition.imageUrl ? (
          <img
            src={competition.imageUrl}
            alt={competition.name}
            className="h-16 w-16 rounded-lg object-cover flex-shrink-0"
          />
        ) : (
          <div className="h-16 w-16 rounded-lg bg-muted flex-shrink-0" />
        )}
        <div className="flex-1">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold">{competition.name}</h1>
              {tournament && <p className="mt-1 text-sm text-muted-foreground">{tournament.name}</p>}
            </div>
            {user?.isAdmin && !showEdit && (
              <button
                onClick={openEdit}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted flex-shrink-0"
              >
                Edit
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Admin: invite code */}
      {user?.isAdmin && (
        <div className="mb-8 rounded-lg border bg-muted/30 p-4">
          <p className="text-sm font-medium">Invite Code</p>
          <p className="mt-1 font-mono text-3xl font-bold tracking-widest">{competition.inviteCode}</p>
          <p className="mt-1 text-xs text-muted-foreground">Share this code with players so they can join</p>
        </div>
      )}

      {/* Admin: edit form */}
      {showEdit && (
        <form onSubmit={handleUpdate} className="mb-8 rounded-lg border p-5 space-y-4">
          <h2 className="font-semibold">Edit Competition</h2>
          <div>
            <label className="mb-1 block text-sm font-medium">Name</label>
            <input
              type="text"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">
              Logo <span className="text-muted-foreground">(optional)</span>
            </label>
            <ImageUpload
              type="competitions"
              currentUrl={editImageUrl}
              onUploaded={setEditImageUrl}
              label="Change logo"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">
              Prediction Deadline <span className="text-muted-foreground">(optional)</span>
            </label>
            <input
              type="datetime-local"
              value={editDeadline}
              onChange={e => setEditDeadline(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {editError && <p className="text-sm text-destructive">{editError}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={updateMutation.isPending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {updateMutation.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => { setShowEdit(false); setEditError(''); }}
              className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Deadline banner — always visible */}
      {competition.predictionDeadline && (
        <div className={`mb-4 rounded-lg px-4 py-2.5 text-sm ${
          deadlinePassed
            ? 'bg-muted text-muted-foreground'
            : 'border border-amber-200 bg-amber-50 text-amber-800'
        }`}>
          {deadlinePassed
            ? `Predictions closed · ${new Date(competition.predictionDeadline).toLocaleString()}`
            : `Open until ${new Date(competition.predictionDeadline).toLocaleString()}`}
        </div>
      )}

      {/* Predictions — collapsible */}
      <div className="mb-6">
        <button
          onClick={() => setPredictionsOpen(o => !o)}
          className="flex w-full items-center justify-between mb-3 text-left"
        >
          <h2 className="font-semibold">Predictions</h2>
          <span className={`text-muted-foreground transition-transform duration-200 ${predictionsOpen ? 'rotate-180' : ''}`}>▾</span>
        </button>

        {predictionsOpen && (matchList.length === 0 ? (
          <p className="text-sm text-muted-foreground">No matches scheduled yet.</p>
        ) : (
          <div className="space-y-6">
            {matchesByDate.map(({ dateKey, dateLabel, matches }) => (
              <div key={dateKey}>
                <h3 className="mb-3 text-sm font-medium text-muted-foreground">{dateLabel}</h3>
                <div className="space-y-2">
                  {matches.map(match => {
                    const pred = predMap[match.id];
                    const edit = localEdits[match.id];
                    const saving = savingIds.has(match.id);
                    const justSaved = savedIds.has(match.id);
                    const saveErr = saveErrors[match.id];
                    const dirty = isDirty(match.id);
                    const valid = isValidEdit(match.id);

                    return (
                      <div key={match.id} className="rounded-lg border px-3 py-3">
                        {/* Stage label */}
                        <p className="mb-2 text-center text-sm font-bold uppercase tracking-widest text-muted-foreground">
                          {match.stage === 'group' && match.groupName
                            ? `Group ${match.groupName}`
                            : STAGE_LABELS[match.stage]}
                        </p>

                        {/* Match row — centered */}
                        <div className="flex items-center justify-center gap-3">
                          {/* Home team */}
                          <div className="flex w-32 items-center justify-end gap-2">
                            <span className="text-sm font-medium truncate text-right">
                              {match.homeTeamName ?? 'TBD'}
                            </span>
                            {match.homeTeamImageUrl && (
                              <img
                                src={match.homeTeamImageUrl}
                                alt=""
                                className="h-6 w-6 flex-shrink-0 rounded-full object-cover"
                              />
                            )}
                          </div>

                          {/* Score area */}
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {match.status === 'completed' ? (
                              <div className="flex items-center gap-2 text-xl font-bold">
                                <span className="w-10 text-center">{match.homeScore}</span>
                                <span className="text-muted-foreground">–</span>
                                <span className="w-10 text-center">{match.awayScore}</span>
                              </div>
                            ) : deadlinePassed ? (
                              <div className="flex items-center gap-2 text-xl text-muted-foreground">
                                <span className="w-10 text-center">{pred ? pred.homeScore : '—'}</span>
                                <span>–</span>
                                <span className="w-10 text-center">{pred ? pred.awayScore : '—'}</span>
                              </div>
                            ) : (
                              <>
                                <input
                                  type="number"
                                  min={0}
                                  max={99}
                                  value={edit?.home ?? ''}
                                  onChange={e => setLocalEdits(prev => ({
                                    ...prev,
                                    [match.id]: { home: e.target.value, away: prev[match.id]?.away ?? '' },
                                  }))}
                                  placeholder="0"
                                  className="w-12 rounded border text-center text-xl font-semibold py-1.5 focus:outline-none focus:ring-1 focus:ring-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                />
                                <span className="text-muted-foreground">–</span>
                                <input
                                  type="number"
                                  min={0}
                                  max={99}
                                  value={edit?.away ?? ''}
                                  onChange={e => setLocalEdits(prev => ({
                                    ...prev,
                                    [match.id]: { home: prev[match.id]?.home ?? '', away: e.target.value },
                                  }))}
                                  placeholder="0"
                                  className="w-12 rounded border text-center text-xl font-semibold py-1.5 focus:outline-none focus:ring-1 focus:ring-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                />
                              </>
                            )}
                          </div>

                          {/* Away team */}
                          <div className="flex w-32 items-center gap-2">
                            {match.awayTeamImageUrl && (
                              <img
                                src={match.awayTeamImageUrl}
                                alt=""
                                className="h-6 w-6 flex-shrink-0 rounded-full object-cover"
                              />
                            )}
                            <span className="text-sm font-medium truncate">
                              {match.awayTeamName ?? 'TBD'}
                            </span>
                          </div>
                        </div>

                        {/* Save / status — centered below match row */}
                        {match.status === 'scheduled' && !deadlinePassed && (
                          <div className="mt-2 text-center">
                            {saving ? (
                              <span className="text-xs text-muted-foreground">…</span>
                            ) : justSaved ? (
                              <span className="text-xs text-green-600">Saved</span>
                            ) : dirty && valid ? (
                              <button
                                onClick={() => savePrediction(match.id)}
                                className="text-xs rounded bg-primary px-3 py-1 text-primary-foreground hover:bg-primary/90"
                              >
                                Save
                              </button>
                            ) : null}
                          </div>
                        )}

                        {/* Time — centered below match row */}
                        {match.scheduledAt && (
                          <p className="mt-2 text-center text-xs text-muted-foreground">
                            {new Date(match.scheduledAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                          </p>
                        )}

                        {/* Completed: your prediction + points */}
                        {match.status === 'completed' && pred && (
                          <p className="mt-1 text-center text-xs text-muted-foreground">
                            Your prediction: {pred.homeScore}–{pred.awayScore}
                            {pred.points !== null && (
                              <span className="ml-1 font-medium text-foreground">+{pred.points} pts</span>
                            )}
                          </p>
                        )}

                        {saveErr && (
                          <p className="mt-1 text-center text-xs text-destructive">{saveErr}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Leaderboard — collapsible */}
      <div>
        <button
          onClick={() => setLeaderboardOpen(o => !o)}
          className="flex w-full items-center justify-between mb-3 text-left"
        >
          <h2 className="font-semibold">Leaderboard</h2>
          <span className={`text-muted-foreground transition-transform duration-200 ${leaderboardOpen ? 'rotate-180' : ''}`}>▾</span>
        </button>

        {leaderboardOpen && (
          leaderboard.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members yet.</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {leaderboard.map(entry => (
                <div key={entry.userId} className="flex items-center gap-3 px-4 py-3">
                  <span className="w-6 flex-shrink-0 text-sm font-medium text-muted-foreground text-right">
                    {entry.rank}
                  </span>
                  {entry.imageUrl ? (
                    <img src={entry.imageUrl} alt={entry.username} className="h-8 w-8 rounded-full object-cover flex-shrink-0" />
                  ) : (
                    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold">
                      {entry.username[0]?.toUpperCase()}
                    </span>
                  )}
                  <span className="text-sm font-medium">{entry.username}</span>
                  <span className="ml-auto text-sm font-semibold tabular-nums">
                    {entry.totalPoints} pts
                  </span>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </main>
  );
}
