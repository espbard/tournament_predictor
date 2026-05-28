import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import type { Tournament, Team, Match, MatchStage } from '@tournament-predictor/shared';

type MatchWithTeams = Match & { homeTeamName: string | null; awayTeamName: string | null };

const STAGE_LABELS: Record<MatchStage, string> = {
  group: 'Group',
  round_of_16: 'Round of 16',
  quarter_final: 'Quarter-final',
  semi_final: 'Semi-final',
  final: 'Final',
};

const STATUS_COLORS: Record<Tournament['status'], string> = {
  upcoming: 'bg-yellow-100 text-yellow-800',
  active: 'bg-green-100 text-green-800',
  completed: 'bg-gray-100 text-gray-600',
};

export default function TournamentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const isAdmin = user?.isAdmin ?? false;

  const [showAddTeam, setShowAddTeam] = useState(false);
  const [showAddMatch, setShowAddMatch] = useState(false);
  const [scoreMatchId, setScoreMatchId] = useState<string | null>(null);

  const [teamName, setTeamName] = useState('');
  const [teamGroup, setTeamGroup] = useState('');
  const [matchHomeTeamId, setMatchHomeTeamId] = useState('');
  const [matchAwayTeamId, setMatchAwayTeamId] = useState('');
  const [matchStage, setMatchStage] = useState<MatchStage>('group');
  const [matchScheduledAt, setMatchScheduledAt] = useState('');
  const [homeScore, setHomeScore] = useState('');
  const [awayScore, setAwayScore] = useState('');

  const [addTeamError, setAddTeamError] = useState('');
  const [addMatchError, setAddMatchError] = useState('');
  const [scoreError, setScoreError] = useState('');

  const { data: tournament, isLoading: tournamentLoading } = useQuery({
    queryKey: ['tournament', id],
    queryFn: () => api.get<Tournament>(`/tournaments/${id}`),
    enabled: !!id,
  });

  const { data: teams = [] } = useQuery({
    queryKey: ['teams', id],
    queryFn: () => api.get<Team[]>(`/tournaments/${id}/teams`),
    enabled: !!id,
  });

  const { data: matchList = [] } = useQuery({
    queryKey: ['matches', id],
    queryFn: () => api.get<MatchWithTeams[]>(`/tournaments/${id}/matches`),
    enabled: !!id,
  });

  const updateStatusMutation = useMutation({
    mutationFn: (status: Tournament['status']) =>
      api.patch<Tournament>(`/tournaments/${id}`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tournament', id] }),
  });

  const addTeamMutation = useMutation({
    mutationFn: (data: { name: string; group?: string }) =>
      api.post<Team>(`/tournaments/${id}/teams`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['teams', id] });
      setTeamName('');
      setTeamGroup('');
      setShowAddTeam(false);
      setAddTeamError('');
    },
    onError: (err: any) => setAddTeamError(err.message),
  });

  const addMatchMutation = useMutation({
    mutationFn: (data: unknown) => api.post<Match>(`/tournaments/${id}/matches`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['matches', id] });
      setMatchHomeTeamId('');
      setMatchAwayTeamId('');
      setMatchStage('group');
      setMatchScheduledAt('');
      setShowAddMatch(false);
      setAddMatchError('');
    },
    onError: (err: any) => setAddMatchError(err.message),
  });

  const updateScoreMutation = useMutation({
    mutationFn: ({
      matchId,
      home,
      away,
    }: {
      matchId: string;
      home: number;
      away: number;
    }) => api.patch<Match>(`/matches/${matchId}`, { homeScore: home, awayScore: away }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['matches', id] });
      setScoreMatchId(null);
      setHomeScore('');
      setAwayScore('');
      setScoreError('');
    },
    onError: (err: any) => setScoreError(err.message),
  });

  function handleAddTeam(e: React.FormEvent) {
    e.preventDefault();
    addTeamMutation.mutate({ name: teamName, group: teamGroup || undefined });
  }

  function handleAddMatch(e: React.FormEvent) {
    e.preventDefault();
    addMatchMutation.mutate({
      homeTeamId: matchHomeTeamId || null,
      awayTeamId: matchAwayTeamId || null,
      stage: matchStage,
      scheduledAt: matchScheduledAt ? new Date(matchScheduledAt).toISOString() : null,
    });
  }

  function handleEnterScore(e: React.FormEvent) {
    e.preventDefault();
    if (!scoreMatchId) return;
    updateScoreMutation.mutate({
      matchId: scoreMatchId,
      home: parseInt(homeScore, 10),
      away: parseInt(awayScore, 10),
    });
  }

  function openScoreForm(matchId: string) {
    setScoreMatchId(matchId);
    setHomeScore('');
    setAwayScore('');
    setScoreError('');
  }

  if (tournamentLoading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }
  if (!tournament) {
    return <div className="p-8 text-sm">Tournament not found.</div>;
  }

  const sortedTeams = [...teams].sort((a, b) => {
    const ga = a.group ?? '';
    const gb = b.group ?? '';
    if (ga !== gb) return ga.localeCompare(gb);
    return a.name.localeCompare(b.name);
  });

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Link
        to="/tournaments"
        className="mb-4 inline-block text-sm text-muted-foreground hover:text-foreground"
      >
        ← Back to Tournaments
      </Link>

      {/* Header */}
      <div className="mb-8 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{tournament.name}</h1>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[tournament.status]}`}
        >
          {tournament.status}
        </span>
        {isAdmin && (
          <select
            value={tournament.status}
            onChange={e => updateStatusMutation.mutate(e.target.value as Tournament['status'])}
            className="ml-auto rounded-md border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            disabled={updateStatusMutation.isPending}
          >
            <option value="upcoming">Upcoming</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
          </select>
        )}
      </div>

      {/* Teams */}
      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Teams ({teams.length})</h2>
          {isAdmin && !showAddTeam && (
            <button
              onClick={() => setShowAddTeam(true)}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-gray-50"
            >
              Add Team
            </button>
          )}
        </div>

        {showAddTeam && (
          <form onSubmit={handleAddTeam} className="mb-4 rounded-lg border p-4">
            <div className="mb-3 flex gap-2">
              <input
                type="text"
                placeholder="Team name"
                value={teamName}
                onChange={e => setTeamName(e.target.value)}
                className="flex-1 rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                required
                autoFocus
              />
              <input
                type="text"
                placeholder="Group (A, B, …)"
                value={teamGroup}
                onChange={e => setTeamGroup(e.target.value)}
                className="w-32 rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                maxLength={10}
              />
            </div>
            {addTeamError && <p className="mb-2 text-sm text-red-600">{addTeamError}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={addTeamMutation.isPending}
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {addTeamMutation.isPending ? 'Adding…' : 'Add'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAddTeam(false);
                  setTeamName('');
                  setTeamGroup('');
                  setAddTeamError('');
                }}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {sortedTeams.length === 0 ? (
          <p className="text-sm text-muted-foreground">No teams added yet.</p>
        ) : (
          <div className="divide-y rounded-lg border">
            {sortedTeams.map(team => (
              <div
                key={team.id}
                className="flex items-center justify-between px-4 py-2.5 text-sm"
              >
                <span>{team.name}</span>
                {team.group && (
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                    Group {team.group}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Matches */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Matches ({matchList.length})</h2>
          {isAdmin && !showAddMatch && (
            <button
              onClick={() => setShowAddMatch(true)}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-gray-50"
            >
              Add Match
            </button>
          )}
        </div>

        {showAddMatch && (
          <form onSubmit={handleAddMatch} className="mb-4 rounded-lg border p-4">
            <div className="mb-3 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Home Team</label>
                <select
                  value={matchHomeTeamId}
                  onChange={e => setMatchHomeTeamId(e.target.value)}
                  className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="">TBD</option>
                  {teams.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Away Team</label>
                <select
                  value={matchAwayTeamId}
                  onChange={e => setMatchAwayTeamId(e.target.value)}
                  className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="">TBD</option>
                  {teams.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Stage</label>
                <select
                  value={matchStage}
                  onChange={e => setMatchStage(e.target.value as MatchStage)}
                  className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  required
                >
                  {(Object.entries(STAGE_LABELS) as [MatchStage, string][]).map(([val, label]) => (
                    <option key={val} value={val}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  Date &amp; Time (optional)
                </label>
                <input
                  type="datetime-local"
                  value={matchScheduledAt}
                  onChange={e => setMatchScheduledAt(e.target.value)}
                  className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
            </div>
            {addMatchError && <p className="mb-2 text-sm text-red-600">{addMatchError}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={addMatchMutation.isPending}
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {addMatchMutation.isPending ? 'Adding…' : 'Add Match'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAddMatch(false);
                  setAddMatchError('');
                }}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {matchList.length === 0 ? (
          <p className="text-sm text-muted-foreground">No matches added yet.</p>
        ) : (
          <div className="space-y-2">
            {matchList.map(match => (
              <div key={match.id} className="rounded-lg border p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {STAGE_LABELS[match.stage]}
                    {match.scheduledAt &&
                      ` · ${new Date(match.scheduledAt).toLocaleString(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}`}
                  </span>
                  {match.status === 'completed' && (
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                      Final
                    </span>
                  )}
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="font-medium">{match.homeTeamName ?? 'TBD'}</span>
                    {match.status === 'completed' ? (
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-sm font-bold tabular-nums">
                        {match.homeScore} – {match.awayScore}
                      </span>
                    ) : (
                      <span className="text-sm text-muted-foreground">vs</span>
                    )}
                    <span className="font-medium">{match.awayTeamName ?? 'TBD'}</span>
                  </div>

                  {isAdmin && match.status === 'scheduled' && scoreMatchId !== match.id && (
                    <button
                      onClick={() => openScoreForm(match.id)}
                      className="rounded-md border px-3 py-1 text-xs hover:bg-gray-50"
                    >
                      Enter Score
                    </button>
                  )}
                </div>

                {scoreMatchId === match.id && (
                  <form
                    onSubmit={handleEnterScore}
                    className="mt-3 flex flex-wrap items-center gap-2"
                  >
                    <input
                      type="number"
                      min="0"
                      value={homeScore}
                      onChange={e => setHomeScore(e.target.value)}
                      className="w-14 rounded-md border px-2 py-1.5 text-center text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                      placeholder="0"
                      required
                      autoFocus
                    />
                    <span className="text-sm font-medium">–</span>
                    <input
                      type="number"
                      min="0"
                      value={awayScore}
                      onChange={e => setAwayScore(e.target.value)}
                      className="w-14 rounded-md border px-2 py-1.5 text-center text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                      placeholder="0"
                      required
                    />
                    {scoreError && <span className="text-xs text-red-600">{scoreError}</span>}
                    <button
                      type="submit"
                      disabled={updateScoreMutation.isPending}
                      className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                      {updateScoreMutation.isPending ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setScoreMatchId(null);
                        setScoreError('');
                      }}
                      className="rounded-md border px-3 py-1.5 text-xs hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </form>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
