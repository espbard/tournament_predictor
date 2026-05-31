import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import ImageUpload from '@/components/ImageUpload';
import type { Competition, Tournament, Prediction, MatchStage } from '@tournament-predictor/shared';

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
  round_of_32: 'Round of 32',
  round_of_16: 'Round of 16',
  quarter_final: 'Quarter-finals',
  semi_final: 'Semi-finals',
  bronze_final: 'Bronze Final',
  final: 'Final',
};

export default function CompetitionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [editName, setEditName] = useState('');
  const [editImageUrl, setEditImageUrl] = useState<string | null>(null);
  const [editDeadline, setEditDeadline] = useState('');
  const [showEdit, setShowEdit] = useState(false);
  const [editError, setEditError] = useState('');

  const [predictionsOpen, setPredictionsOpen] = useState(false);

  const [localEdits, setLocalEdits] = useState<Record<string, { home: string; away: string }>>({});
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});

  const [groupStageLocked, setGroupStageLocked] = useState(
    () => localStorage.getItem(`competition:${id}:groupStageLocked`) === 'true'
  );
  const [hasDeclined, setHasDeclined] = useState(
    () => localStorage.getItem(`competition:${id}:groupStageDeclined`) === 'true'
  );
  const [showProceedPrompt, setShowProceedPrompt] = useState(false);

  const localEditsRef = useRef(localEdits);
  useEffect(() => { localEditsRef.current = localEdits; }, [localEdits]);

  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => {
    const timers = debounceTimers.current;
    return () => { Object.values(timers).forEach(clearTimeout); };
  }, []);

  const { data: competition, isLoading, error } = useQuery({
    queryKey: ['competitions', id],
    queryFn: () => api.get<Competition>(`/competitions/${id}`),
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

  type TeamStat = {
    teamId: string;
    teamName: string;
    imageUrl: string | null;
    group: string;
    P: number; W: number; D: number; L: number; GF: number; GA: number;
  };

  const groupStandings = useMemo(() => {
    const groupMatches = matchList.filter(m => m.stage === 'group');
    const teamMap = new Map<string, TeamStat>();

    for (const m of groupMatches) {
      const g = m.groupName;
      if (!g) continue;
      if (m.homeTeamId && m.homeTeamName && !teamMap.has(m.homeTeamId)) {
        teamMap.set(m.homeTeamId, { teamId: m.homeTeamId, teamName: m.homeTeamName, imageUrl: m.homeTeamImageUrl, group: g, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0 });
      }
      if (m.awayTeamId && m.awayTeamName && !teamMap.has(m.awayTeamId)) {
        teamMap.set(m.awayTeamId, { teamId: m.awayTeamId, teamName: m.awayTeamName, imageUrl: m.awayTeamImageUrl, group: g, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0 });
      }
    }

    for (const m of groupMatches) {
      if (!m.homeTeamId || !m.awayTeamId || !m.groupName) continue;
      let hs: number | null = null;
      let as_: number | null = null;
      if (m.status === 'completed') {
        hs = m.homeScore; as_ = m.awayScore;
      } else {
        const edit = localEdits[m.id];
        if (edit) {
          const h = parseInt(edit.home, 10); const a = parseInt(edit.away, 10);
          if (!isNaN(h) && !isNaN(a) && h >= 0 && a >= 0) { hs = h; as_ = a; }
        }
      }
      if (hs === null || as_ === null) continue;
      const home = teamMap.get(m.homeTeamId);
      const away = teamMap.get(m.awayTeamId);
      if (home) { home.P++; home.GF += hs; home.GA += as_; if (hs > as_) home.W++; else if (hs === as_) home.D++; else home.L++; }
      if (away) { away.P++; away.GF += as_; away.GA += hs; if (as_ > hs) away.W++; else if (hs === as_) away.D++; else away.L++; }
    }

    const byGroup = new Map<string, TeamStat[]>();
    for (const t of teamMap.values()) {
      if (!byGroup.has(t.group)) byGroup.set(t.group, []);
      byGroup.get(t.group)!.push(t);
    }
    for (const teams of byGroup.values()) {
      teams.sort((a, b) => {
        const pa = a.W * 3 + a.D; const pb = b.W * 3 + b.D;
        if (pb !== pa) return pb - pa;
        const gda = a.GF - a.GA; const gdb = b.GF - b.GA;
        if (gdb !== gda) return gdb - gda;
        return b.GF - a.GF;
      });
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [matchList, localEdits]);

  const qualifyingThirdPlaceIds = useMemo(() => {
    const third = groupStandings
      .filter(([, teams]) => teams.length >= 3)
      .map(([, teams]) => teams[2]);
    third.sort((a, b) => {
      const pa = a.W * 3 + a.D; const pb = b.W * 3 + b.D;
      if (pb !== pa) return pb - pa;
      const gda = a.GF - a.GA; const gdb = b.GF - b.GA;
      if (gdb !== gda) return gdb - gda;
      return b.GF - a.GF;
    });
    const qualifying = third.slice(0, 8);
    if (qualifying.length === 8 && third.length > 8) {
      const edge = qualifying[7];
      const edgePts = edge.W * 3 + edge.D; const edgeGD = edge.GF - edge.GA;
      for (const t of third.slice(8)) {
        const pts = t.W * 3 + t.D; const gd = t.GF - t.GA;
        if (pts === edgePts && gd === edgeGD && t.GF === edge.GF) qualifying.push(t);
        else break;
      }
    }
    return new Set(qualifying.map(t => t.teamId));
  }, [groupStandings]);

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

  const groupMatchesByDate = useMemo(
    () => matchesByDate
      .map(g => ({ ...g, matches: g.matches.filter(m => m.stage === 'group') }))
      .filter(g => g.matches.length > 0),
    [matchesByDate]
  );

  const scheduledGroupMatches = useMemo(
    () => matchList.filter(m => m.stage === 'group' && m.status === 'scheduled'),
    [matchList]
  );

  const allGroupFilled = useMemo(() => {
    if (scheduledGroupMatches.length === 0) return false;
    return scheduledGroupMatches.every(m => {
      const edit = localEdits[m.id];
      if (edit) {
        const h = parseInt(edit.home, 10);
        const a = parseInt(edit.away, 10);
        if (!isNaN(h) && !isNaN(a) && h >= 0 && a >= 0) return true;
      }
      return !!predMap[m.id];
    });
  }, [scheduledGroupMatches, localEdits, predMap]);

  useEffect(() => {
    if (allGroupFilled && !groupStageLocked && !hasDeclined) {
      setShowProceedPrompt(true);
    }
  }, [allGroupFilled, groupStageLocked, hasDeclined]);

  const deadlinePassed = competition?.predictionDeadline
    ? new Date() > new Date(competition.predictionDeadline)
    : false;

  const isLocked = deadlinePassed || groupStageLocked;

  async function savePrediction(matchId: string) {
    const edit = localEditsRef.current[matchId];
    if (!edit) return;
    const homeScore = parseInt(edit.home, 10);
    const awayScore = parseInt(edit.away, 10);
    if (isNaN(homeScore) || isNaN(awayScore) || homeScore < 0 || awayScore < 0) return;

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

  function scheduleAutoSave(matchId: string) {
    if (debounceTimers.current[matchId]) clearTimeout(debounceTimers.current[matchId]);
    debounceTimers.current[matchId] = setTimeout(() => savePrediction(matchId), 3000);
  }

  function simulatePredictions() {
    const scheduledMatches = matchList.filter(m => m.status === 'scheduled' && m.stage === 'group');
    const newEdits: Record<string, { home: string; away: string }> = {};
    for (const m of scheduledMatches) {
      newEdits[m.id] = {
        home: String(Math.floor(Math.random() * 6)),
        away: String(Math.floor(Math.random() * 6)),
      };
    }
    localEditsRef.current = { ...localEditsRef.current, ...newEdits };
    setLocalEdits(prev => ({ ...prev, ...newEdits }));
    for (const m of scheduledMatches) {
      if (debounceTimers.current[m.id]) clearTimeout(debounceTimers.current[m.id]);
      savePrediction(m.id);
    }
  }

  function clearPredictions() {
    const scheduledMatches = matchList.filter(m => m.status === 'scheduled' && m.stage === 'group');
    for (const m of scheduledMatches) {
      if (debounceTimers.current[m.id]) {
        clearTimeout(debounceTimers.current[m.id]);
        delete debounceTimers.current[m.id];
      }
    }
    setLocalEdits(prev => {
      const next = { ...prev };
      for (const m of scheduledMatches) delete next[m.id];
      return next;
    });
  }

  function handleProceedToKnockout() {
    localStorage.setItem(`competition:${id}:groupStageLocked`, 'true');
    setGroupStageLocked(true);
    navigate(`/competitions/${id}/knockout`);
  }

  function handleDeclineProceed() {
    localStorage.setItem(`competition:${id}:groupStageDeclined`, 'true');
    setHasDeclined(true);
    setShowProceedPrompt(false);
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
    <main className="mx-auto max-w-6xl px-4 py-12">
      <div className="lg:flex lg:items-start lg:gap-8">
      <div className="flex-1 min-w-0">
      <div className="mb-2 text-sm text-muted-foreground">
        <Link to={user?.isAdmin ? '/competitions' : '/'} className="hover:underline">
          ← {user?.isAdmin ? 'Competitions' : 'Home'}
        </Link>
      </div>

      <h1 className="text-4xl font-bold mb-6">Group Stage</h1>

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
              <h2 className="text-2xl font-bold">{competition.name}</h2>
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

      {/* Deadline banner */}
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

      {/* Group stage locked banner */}
      {groupStageLocked && (
        <div className="mb-4 rounded-lg bg-muted px-4 py-2.5 text-sm text-muted-foreground">
          Group stage predictions are locked.
        </div>
      )}

      {/* Navigate to knockout when locked */}
      {groupStageLocked && (
        <div className="mb-6">
          <Link
            to={`/competitions/${id}/knockout`}
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Go to knockout predictions →
          </Link>
        </div>
      )}

      {/* Go to knockout button — shown permanently after declining */}
      {hasDeclined && !groupStageLocked && (
        <div className="mb-6">
          <button
            onClick={() => setShowProceedPrompt(true)}
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            Go to knockout predictions →
          </button>
        </div>
      )}

      {/* Predictions — collapsible */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => setPredictionsOpen(o => !o)}
            className="flex items-center gap-2 text-left"
          >
            <h2 className="font-semibold">Predictions</h2>
            <span className={`text-muted-foreground transition-transform duration-200 ${predictionsOpen ? 'rotate-180' : ''}`}>▾</span>
          </button>
          {!isLocked && scheduledGroupMatches.length > 0 && (
            <div className="flex gap-2">
              <button
                onClick={simulatePredictions}
                className="text-xs rounded border px-2.5 py-1 hover:bg-muted"
              >
                Simulate
              </button>
              <button
                onClick={clearPredictions}
                className="text-xs rounded border px-2.5 py-1 hover:bg-muted"
              >
                Clear
              </button>
            </div>
          )}
        </div>

        {predictionsOpen && (groupMatchesByDate.length === 0 ? (
          <p className="text-sm text-muted-foreground">No group stage matches scheduled yet.</p>
        ) : (
          <div className="space-y-6">
            {groupMatchesByDate.map(({ dateKey, dateLabel, matches }) => (
              <div key={dateKey}>
                <h3 className="mb-3 text-sm font-medium text-muted-foreground">{dateLabel}</h3>
                <div className="space-y-2">
                  {matches.map(match => {
                    const pred = predMap[match.id];
                    const edit = localEdits[match.id];
                    const saving = savingIds.has(match.id);
                    const justSaved = savedIds.has(match.id);
                    const saveErr = saveErrors[match.id];

                    return (
                      <div key={match.id} className="rounded-lg border px-3 py-3">
                        {/* Stage label */}
                        <p className="mb-2 text-center text-sm font-bold uppercase tracking-widest text-muted-foreground">
                          {match.stage === 'group' && match.groupName
                            ? `Group ${match.groupName}`
                            : STAGE_LABELS[match.stage]}
                        </p>

                        {/* Match row */}
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
                            ) : isLocked ? (
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
                                  onChange={e => {
                                    setLocalEdits(prev => ({ ...prev, [match.id]: { home: e.target.value, away: prev[match.id]?.away ?? '' } }));
                                    scheduleAutoSave(match.id);
                                  }}
                                  placeholder="0"
                                  className="w-12 rounded border text-center text-xl font-semibold py-1.5 focus:outline-none focus:ring-1 focus:ring-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                />
                                <span className="text-muted-foreground">–</span>
                                <input
                                  type="number"
                                  min={0}
                                  max={99}
                                  value={edit?.away ?? ''}
                                  onChange={e => {
                                    setLocalEdits(prev => ({ ...prev, [match.id]: { home: prev[match.id]?.home ?? '', away: e.target.value } }));
                                    scheduleAutoSave(match.id);
                                  }}
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

                        {/* Save status */}
                        {match.status === 'scheduled' && !isLocked && (saving || justSaved) && (
                          <div className="mt-2 text-center">
                            {saving ? (
                              <span className="text-xs text-muted-foreground">…</span>
                            ) : (
                              <span className="text-xs text-green-600">Saved</span>
                            )}
                          </div>
                        )}

                        {/* Time */}
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
      </div>

      {/* Group standings sidebar */}
      {groupStandings.length > 0 && (
        <aside className="mt-8 lg:mt-0 lg:w-80 lg:flex-shrink-0">
          <div className="lg:sticky lg:top-4 space-y-4">
            <h2 className="font-semibold">Group Standings</h2>
            {groupStandings.map(([groupName, teams]) => (
              <div key={groupName} className="rounded-lg border overflow-hidden">
                <div className="bg-muted/50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Group {groupName}
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="pl-3 py-1.5 text-left w-6">#</th>
                      <th className="py-1.5 text-left">Team</th>
                      <th className="py-1.5 text-center w-6">P</th>
                      <th className="py-1.5 text-center w-6">W</th>
                      <th className="py-1.5 text-center w-6">D</th>
                      <th className="py-1.5 text-center w-6">L</th>
                      <th className="py-1.5 text-center w-8">GF</th>
                      <th className="py-1.5 text-center w-8">GA</th>
                      <th className="pr-3 py-1.5 text-center w-8 font-bold text-foreground">Pts</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {teams.map((t, i) => (
                      <tr key={t.teamId} className={
                        i < 2
                          ? 'bg-green-50 dark:bg-green-950/30'
                          : i === 2 && qualifyingThirdPlaceIds.has(t.teamId)
                          ? 'bg-yellow-50 dark:bg-yellow-950/30'
                          : 'hover:bg-muted/30'
                      }>
                        <td className="pl-3 py-1.5 text-muted-foreground">{i + 1}</td>
                        <td className="py-1.5 pr-2">
                          <div className="flex items-center gap-1.5">
                            {t.imageUrl ? (
                              <img src={t.imageUrl} alt="" className="h-4 w-4 rounded-full object-cover flex-shrink-0" />
                            ) : (
                              <div className="h-4 w-4 rounded-full bg-muted flex-shrink-0" />
                            )}
                            <span className="truncate max-w-[80px]">{t.teamName}</span>
                          </div>
                        </td>
                        <td className="py-1.5 text-center text-muted-foreground">{t.P}</td>
                        <td className="py-1.5 text-center text-muted-foreground">{t.W}</td>
                        <td className="py-1.5 text-center text-muted-foreground">{t.D}</td>
                        <td className="py-1.5 text-center text-muted-foreground">{t.L}</td>
                        <td className="py-1.5 text-center text-muted-foreground">{t.GF}</td>
                        <td className="py-1.5 text-center text-muted-foreground">{t.GA}</td>
                        <td className="pr-3 py-1.5 text-center font-bold">{t.W * 3 + t.D}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </aside>
      )}
      </div>

      {/* Proceed to knockout prompt */}
      {showProceedPrompt && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-background rounded-lg border p-6 max-w-md w-full shadow-xl">
            <p className="font-semibold mb-1">All group stage results filled in.</p>
            <p className="text-sm text-muted-foreground mb-1">Continue to knockout predictions?</p>
            <p className="text-sm text-muted-foreground mb-6">
              All group stage predictions will be locked and can not be changed again if you proceed.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={handleDeclineProceed}
                className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
              >
                No
              </button>
              <button
                onClick={handleProceedToKnockout}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Yes, continue
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
