import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Pencil } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import ImageUpload from '@/components/ImageUpload';
import type { Tournament, Team, Match, MatchStage, Group } from '@tournament-predictor/shared';

type MatchWithTeams = Match & {
  homeTeamName: string | null;
  awayTeamName: string | null;
  homeTeamImageUrl?: string | null;
  awayTeamImageUrl?: string | null;
};

const STAGE_LABELS: Record<MatchStage, string> = {
  group: 'Group',
  round_of_32: 'Round of 32',
  round_of_16: 'Round of 16',
  quarter_final: 'Quarter-final',
  semi_final: 'Semi-final',
  bronze_final: 'Bronze Final',
  final: 'Final',
};

const STATUS_COLORS: Record<Tournament['status'], string> = {
  upcoming: 'bg-primary/10 text-primary',
  active: 'bg-accent/15 text-accent',
  completed: 'bg-muted text-muted-foreground',
};

const MINUTE_OPTIONS = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'];
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));

// ── DateTimePickerFields ──────────────────────────────────────────────────────

function DateTimePickerFields({
  date, hour, minute,
  onDate, onHour, onMinute,
}: {
  date: string; hour: string; minute: string;
  onDate: (v: string) => void;
  onHour: (v: string) => void;
  onMinute: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="date"
        value={date}
        onChange={e => onDate(e.target.value)}
        className="flex-1 min-w-32 rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
      />
      <div className="flex items-center gap-1">
        <select
          value={hour}
          onChange={e => onHour(e.target.value)}
          className="rounded-md border px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {HOUR_OPTIONS.map(h => (
            <option key={h} value={h}>{h}</option>
          ))}
        </select>
        <span className="text-sm text-muted-foreground">:</span>
        <select
          value={minute}
          onChange={e => onMinute(e.target.value)}
          className="rounded-md border px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {MINUTE_OPTIONS.map(m => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ── DnD sub-components ────────────────────────────────────────────────────────

function TeamChip({ team, ghost, editPath }: { team: Team; ghost?: boolean; editPath?: string }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-sm shadow-sm ${
        ghost ? 'opacity-40' : ''
      }`}
    >
      {team.imageUrl ? (
        <img src={team.imageUrl} alt={team.name} className="h-5 w-5 flex-shrink-0 rounded-sm object-cover" />
      ) : (
        <span className="h-5 w-5 flex-shrink-0 rounded-sm bg-muted inline-block" />
      )}
      <span className="min-w-0 flex-1 truncate">{team.name}</span>
      {editPath && (
        <Link
          to={editPath}
          onPointerDown={e => e.stopPropagation()}
          className="flex-shrink-0 text-red-400 hover:text-red-600"
          title="Edit team"
        >
          <Pencil size={12} />
        </Link>
      )}
    </div>
  );
}

function DraggableTeamChip({ team }: { team: Team }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: team.id,
    data: { team },
  });
  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className="cursor-grab touch-none active:cursor-grabbing"
    >
      <TeamChip team={team} ghost={isDragging} editPath={`/admin/teams/${team.id}/edit`} />
    </div>
  );
}

function DroppableZone({
  id,
  label,
  teams,
  onDelete,
}: {
  id: string;
  label: string;
  teams: Team[];
  onDelete?: () => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`flex min-h-32 w-44 flex-shrink-0 flex-col rounded-lg border-2 transition-colors ${
        isOver ? 'border-primary bg-primary/5' : 'border-border bg-muted/50'
      }`}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="text-xs text-red-400 hover:text-red-600"
          >
            ✕
          </button>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 px-2 pb-2">
        {teams.map(team => (
          <DraggableTeamChip key={team.id} team={team} />
        ))}
      </div>
    </div>
  );
}

function TeamBadge({ name, imageUrl }: { name: string | null; imageUrl?: string | null }) {
  return (
    <span className="flex items-center gap-1.5">
      {imageUrl ? (
        <img src={imageUrl} alt={name ?? ''} className="h-5 w-5 rounded-sm object-cover" />
      ) : (
        <span className="h-5 w-5 rounded-sm bg-muted inline-block" />
      )}
      <span className="font-medium">{name ?? 'TBD'}</span>
    </span>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function TournamentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const isAdmin = user?.isAdmin ?? false;

  const [showAddTeam, setShowAddTeam] = useState(false);
  const [scoreMatchId, setScoreMatchId] = useState<string | null>(null);
  const [activeTeamId, setActiveTeamId] = useState<string | null>(null);

  const [showAddGroup, setShowAddGroup] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [addGroupError, setAddGroupError] = useState('');

  const [teamName, setTeamName] = useState('');
  const [teamGroupId, setTeamGroupId] = useState('');
  const [teamImageUrl, setTeamImageUrl] = useState<string | null>(null);

  // Add match state — null=hidden, ''=top form, 'YYYY-MM-DD'=below that day group
  const [addMatchForDate, setAddMatchForDate] = useState<string | null>(null);
  const [matchHomeTeamId, setMatchHomeTeamId] = useState('');
  const [matchAwayTeamId, setMatchAwayTeamId] = useState('');
  const [matchStage, setMatchStage] = useState<MatchStage>('group');
  const [matchGroupId, setMatchGroupId] = useState('');
  const [addDate, setAddDate] = useState('');
  const [addHour, setAddHour] = useState('21');
  const [addMinute, setAddMinute] = useState('00');

  // Edit match state
  const [editMatchId, setEditMatchId] = useState<string | null>(null);
  const [editStage, setEditStage] = useState<MatchStage>('group');
  const [editGroupId, setEditGroupId] = useState('');
  const [editHomeTeamId, setEditHomeTeamId] = useState('');
  const [editAwayTeamId, setEditAwayTeamId] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editHour, setEditHour] = useState('21');
  const [editMinute, setEditMinute] = useState('00');
  const [editError, setEditError] = useState('');

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

  const { data: groupList = [] } = useQuery({
    queryKey: ['groups', id],
    queryFn: () => api.get<Group[]>(`/tournaments/${id}/groups`),
    enabled: !!id,
  });

  const { data: matchList = [] } = useQuery({
    queryKey: ['matches', id],
    queryFn: () => api.get<MatchWithTeams[]>(`/tournaments/${id}/matches`),
    enabled: !!id,
  });

  const groupMap = new Map(groupList.map(g => [g.id, g]));

  // Partition teams into groups + uncategorized
  const teamsByGroup = new Map<string | null, Team[]>();
  teamsByGroup.set(null, []);
  for (const g of groupList) teamsByGroup.set(g.id, []);
  for (const t of teams) {
    const key = t.groupId ?? null;
    if (!teamsByGroup.has(key)) teamsByGroup.set(key, []);
    teamsByGroup.get(key)!.push(t);
  }
  for (const bucket of teamsByGroup.values()) {
    bucket.sort((a, b) => a.name.localeCompare(b.name));
  }

  const activeTeam = activeTeamId ? teams.find(t => t.id === activeTeamId) : null;

  // ── Mutations ───────────────────────────────────────────────────────────────

  const addGroupMutation = useMutation({
    mutationFn: (data: { name: string }) =>
      api.post<Group>(`/tournaments/${id}/groups`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groups', id] });
      setGroupName('');
      setShowAddGroup(false);
      setAddGroupError('');
    },
    onError: (err: any) => setAddGroupError(err.message),
  });

  const deleteGroupMutation = useMutation({
    mutationFn: (groupId: string) =>
      api.delete<Group>(`/tournaments/${id}/groups/${groupId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groups', id] });
      queryClient.invalidateQueries({ queryKey: ['teams', id] });
    },
  });

  const assignGroupMutation = useMutation({
    mutationFn: ({ teamId, groupId }: { teamId: string; groupId: string | null }) =>
      api.patch<Team>(`/teams/${teamId}`, { groupId }),
    onSuccess: updated => {
      queryClient.setQueryData<Team[]>(['teams', id], prev =>
        prev?.map(t => (t.id === updated.id ? updated : t)) ?? []
      );
    },
  });

  const updateStatusMutation = useMutation({
    mutationFn: (status: Tournament['status']) =>
      api.patch<Tournament>(`/tournaments/${id}`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tournament', id] }),
  });

  const addTeamMutation = useMutation({
    mutationFn: (data: { name: string; groupId?: string | null; imageUrl: string | null }) =>
      api.post<Team>(`/tournaments/${id}/teams`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['teams', id] });
      setTeamName('');
      setTeamGroupId('');
      setTeamImageUrl(null);
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
      setMatchGroupId('');
      setAddDate('');
      setAddHour('21');
      setAddMinute('00');
      setAddMatchForDate(null);
      setAddMatchError('');
    },
    onError: (err: any) => setAddMatchError(err.message),
  });

  const updateScoreMutation = useMutation({
    mutationFn: ({ matchId, home, away }: { matchId: string; home: number; away: number }) =>
      api.patch<Match>(`/matches/${matchId}`, { homeScore: home, awayScore: away }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['matches', id] });
      setScoreMatchId(null);
      setHomeScore('');
      setAwayScore('');
      setScoreError('');
    },
    onError: (err: any) => setScoreError(err.message),
  });

  const editMatchMutation = useMutation({
    mutationFn: ({ matchId, data }: { matchId: string; data: unknown }) =>
      api.patch<Match>(`/matches/${matchId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['matches', id] });
      setEditMatchId(null);
      setEditError('');
    },
    onError: (err: any) => setEditError(err.message),
  });

  const simulateGroupStageMutation = useMutation({
    mutationFn: () => api.post(`/tournaments/${id}/simulate-group-stage`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['matches', id] }),
  });

  const clearGroupStageMutation = useMutation({
    mutationFn: () => api.post(`/tournaments/${id}/clear-group-stage`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['matches', id] }),
  });

  // ── DnD handlers ────────────────────────────────────────────────────────────

  function handleDragStart(event: DragStartEvent) {
    setActiveTeamId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveTeamId(null);
    const { active, over } = event;
    if (!over) return;
    const teamId = String(active.id);
    const destId = String(over.id);
    const destGroupId = destId === 'uncategorized' ? null : destId;
    const team = teams.find(t => t.id === teamId);
    if (!team || team.groupId === destGroupId) return;
    assignGroupMutation.mutate({ teamId, groupId: destGroupId });
  }

  // ── Event handlers ───────────────────────────────────────────────────────────

  function handleAddGroup(e: React.FormEvent) {
    e.preventDefault();
    addGroupMutation.mutate({ name: groupName.trim() });
  }

  function handleAddTeam(e: React.FormEvent) {
    e.preventDefault();
    addTeamMutation.mutate({ name: teamName, groupId: teamGroupId || null, imageUrl: teamImageUrl });
  }

  function openAddMatch(dateStr: string = '') {
    setAddMatchForDate(dateStr);
    setAddDate(dateStr || new Date().toLocaleDateString('en-CA'));
    setAddHour('21');
    setAddMinute('00');
    setMatchHomeTeamId('');
    setMatchAwayTeamId('');
    setMatchStage('group');
    setMatchGroupId('');
    setAddMatchError('');
    setEditMatchId(null);
  }

  function openEditMatch(match: MatchWithTeams) {
    setEditMatchId(match.id);
    setEditStage(match.stage);
    const homeTeam = match.homeTeamId ? teams.find(t => t.id === match.homeTeamId) : null;
    setEditGroupId(homeTeam?.groupId ?? '');
    setEditHomeTeamId(match.homeTeamId ?? '');
    setEditAwayTeamId(match.awayTeamId ?? '');
    if (match.scheduledAt) {
      const d = new Date(match.scheduledAt);
      setEditDate(d.toLocaleDateString('en-CA'));
      setEditHour(String(d.getHours()).padStart(2, '0'));
      const roundedMins = Math.round(d.getMinutes() / 5) * 5 % 60;
      setEditMinute(String(roundedMins).padStart(2, '0'));
    } else {
      setEditDate('');
      setEditHour('21');
      setEditMinute('00');
    }
    setEditError('');
    setAddMatchForDate(null);
  }

  function handleAddMatch(e: React.FormEvent) {
    e.preventDefault();
    const scheduledAt = addDate
      ? new Date(`${addDate}T${addHour}:${addMinute}:00`).toISOString()
      : null;
    addMatchMutation.mutate({
      homeTeamId: matchHomeTeamId || null,
      awayTeamId: matchAwayTeamId || null,
      stage: matchStage,
      scheduledAt,
    });
  }

  function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editMatchId) return;
    const scheduledAt = editDate
      ? new Date(`${editDate}T${editHour}:${editMinute}:00`).toISOString()
      : null;
    editMatchMutation.mutate({
      matchId: editMatchId,
      data: {
        homeTeamId: editHomeTeamId || null,
        awayTeamId: editAwayTeamId || null,
        stage: editStage,
        scheduledAt,
      },
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

  // Group matches by calendar date for display — group stage only (knockout shown in Knockout tab)
  const groupStageMatches = matchList.filter(m => m.stage === 'group');
  const sortedMatches = [...groupStageMatches].sort((a, b) => {
    if (!a.scheduledAt && !b.scheduledAt) return 0;
    if (!a.scheduledAt) return 1;
    if (!b.scheduledAt) return -1;
    return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
  });
  const matchGroups: { dateLabel: string; isoDate: string; matches: MatchWithTeams[] }[] = [];
  for (const match of sortedMatches) {
    const isoDate = match.scheduledAt
      ? new Date(match.scheduledAt).toLocaleDateString('en-CA')
      : '__none__';
    const dateLabel = match.scheduledAt
      ? new Date(match.scheduledAt).toLocaleDateString(undefined, { dateStyle: 'long' })
      : 'No date';
    const last = matchGroups[matchGroups.length - 1];
    if (last && last.isoDate === isoDate) {
      last.matches.push(match);
    } else {
      matchGroups.push({ dateLabel, isoDate, matches: [match] });
    }
  }

  function matchStageLabel(match: MatchWithTeams) {
    if (match.stage !== 'group') return STAGE_LABELS[match.stage];
    const team = teams.find(t => t.id === match.homeTeamId || t.id === match.awayTeamId);
    const group = team?.groupId ? groupMap.get(team.groupId) : null;
    return group ? `Group ${group.name}` : 'Group';
  }

  const sortedTeams = [...teams].sort((a, b) => {
    const ga = a.groupId ? (groupMap.get(a.groupId)?.name ?? '') : '￿';
    const gb = b.groupId ? (groupMap.get(b.groupId)?.name ?? '') : '￿';
    if (ga !== gb) return ga.localeCompare(gb);
    return a.name.localeCompare(b.name);
  });

  // ── Add match form (shared between top and per-day positions) ─────────────

  function renderAddMatchForm() {
    const addTeamsForStage = matchStage === 'group' && matchGroupId
      ? teams.filter(t => t.groupId === matchGroupId)
      : teams;
    return (
      <form onSubmit={handleAddMatch} className="mt-3 rounded-lg border p-4">
        <div className="mb-3 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Stage</label>
            <select
              value={matchStage}
              onChange={e => {
                const stage = e.target.value as MatchStage;
                setMatchStage(stage);
                if (stage !== 'group') setMatchGroupId('');
                setMatchHomeTeamId('');
                setMatchAwayTeamId('');
              }}
              className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              required
            >
              {(Object.entries(STAGE_LABELS) as [MatchStage, string][]).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          </div>
          {matchStage === 'group' && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Group</label>
              <select
                value={matchGroupId}
                onChange={e => {
                  setMatchGroupId(e.target.value);
                  setMatchHomeTeamId('');
                  setMatchAwayTeamId('');
                }}
                className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">All groups</option>
                {groupList.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Home Team</label>
            <select
              value={matchHomeTeamId}
              onChange={e => setMatchHomeTeamId(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="">TBD</option>
              {addTeamsForStage.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Away Team</label>
            <select
              value={matchAwayTeamId}
              onChange={e => setMatchAwayTeamId(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="">TBD</option>
              {addTeamsForStage.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div className="col-span-2">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Date &amp; Time (optional)
            </label>
            <DateTimePickerFields
              date={addDate} hour={addHour} minute={addMinute}
              onDate={setAddDate} onHour={setAddHour} onMinute={setAddMinute}
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
            onClick={() => setAddMatchForDate(null)}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <Link
        to="/admin/tournaments"
        className="mb-4 inline-block text-sm text-muted-foreground hover:text-foreground"
      >
        ← Back to Tournaments
      </Link>

      {/* Stage tabs */}
      <div className="flex border-b mb-6">
        <div className="px-4 py-2 text-sm font-medium border-b-2 border-primary -mb-px">
          Group Stage
        </div>
        <Link
          to={`/admin/tournaments/${id}/knockout`}
          className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
        >
          Knockout Stage
        </Link>
      </div>

      {/* Header */}
      <div className="mb-8 flex flex-wrap items-center gap-3">
        {tournament.imageUrl && (
          <img
            src={tournament.imageUrl}
            alt={tournament.name}
            className="h-12 w-12 rounded-lg object-cover"
          />
        )}
        <h1 className="text-2xl font-bold">{tournament.name}</h1>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[tournament.status]}`}
        >
          {tournament.status}
        </span>
        {isAdmin && (
          <>
            <select
              value={tournament.status}
              onChange={e => updateStatusMutation.mutate(e.target.value as Tournament['status'])}
              className="rounded-md border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              disabled={updateStatusMutation.isPending}
            >
              <option value="upcoming">Upcoming</option>
              <option value="active">Active</option>
              <option value="completed">Completed</option>
            </select>
            <Link
              to={`/admin/tournaments/${id}/edit`}
              className="ml-auto rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            >
              Edit
            </Link>
          </>
        )}
      </div>

      {/* Teams */}
      <section className="mb-8">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">Teams ({teams.length})</h2>
          {isAdmin && (
            <div className="ml-auto flex gap-2">
              {!showAddGroup && (
                <button
                  onClick={() => setShowAddGroup(true)}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                >
                  Add Group
                </button>
              )}
              {!showAddTeam && (
                <button
                  onClick={() => setShowAddTeam(true)}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                >
                  Add Team
                </button>
              )}
            </div>
          )}
        </div>

        {/* Add Group form */}
        {isAdmin && showAddGroup && (
          <form onSubmit={handleAddGroup} className="mb-4 rounded-lg border p-4">
            <div className="mb-3 flex gap-2">
              <input
                type="text"
                placeholder="Group name (e.g. A, B, Group A)"
                value={groupName}
                onChange={e => setGroupName(e.target.value)}
                className="flex-1 rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                required
                autoFocus
                maxLength={20}
              />
            </div>
            {addGroupError && <p className="mb-2 text-sm text-red-600">{addGroupError}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={addGroupMutation.isPending}
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {addGroupMutation.isPending ? 'Adding…' : 'Add Group'}
              </button>
              <button
                type="button"
                onClick={() => { setShowAddGroup(false); setGroupName(''); setAddGroupError(''); }}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* Add Team form */}
        {isAdmin && showAddTeam && (
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
              <select
                value={teamGroupId}
                onChange={e => setTeamGroupId(e.target.value)}
                className="w-36 rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">Uncategorized</option>
                {groupList.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
            <div className="mb-3">
              <p className="mb-1 text-xs font-medium text-muted-foreground">Team icon (optional)</p>
              <ImageUpload
                type="teams"
                currentUrl={teamImageUrl}
                onUploaded={setTeamImageUrl}
                label="Choose icon"
              />
            </div>
            {addTeamError && <p className="mb-2 text-sm text-red-600">{addTeamError}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={addTeamMutation.isPending}
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {addTeamMutation.isPending ? 'Adding…' : 'Add Team'}
              </button>
              <button
                type="button"
                onClick={() => { setShowAddTeam(false); setTeamName(''); setTeamGroupId(''); setTeamImageUrl(null); setAddTeamError(''); }}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {teams.length === 0 ? (
          <p className="text-sm text-muted-foreground">No teams added yet.</p>
        ) : isAdmin ? (
          /* Drag-and-drop board for admins */
          <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div className="flex flex-wrap gap-3">
              <DroppableZone
                id="uncategorized"
                label="Uncategorized"
                teams={teamsByGroup.get(null) ?? []}
              />
              {groupList.map(group => (
                <DroppableZone
                  key={group.id}
                  id={group.id}
                  label={group.name}
                  teams={teamsByGroup.get(group.id) ?? []}
                  onDelete={() => deleteGroupMutation.mutate(group.id)}
                />
              ))}
            </div>
            <DragOverlay dropAnimation={null}>
              {activeTeam && <TeamChip team={activeTeam} />}
            </DragOverlay>
          </DndContext>
        ) : (
          /* Simple grouped list for non-admins */
          <div className="divide-y rounded-lg border">
            {sortedTeams.map(team => {
              const gName = team.groupId ? (groupMap.get(team.groupId)?.name ?? null) : null;
              return (
                <div
                  key={team.id}
                  className="flex items-center justify-between px-4 py-2.5 text-sm"
                >
                  <span className="flex items-center gap-2">
                    {team.imageUrl ? (
                      <img src={team.imageUrl} alt={team.name} className="h-6 w-6 rounded-sm object-cover" />
                    ) : (
                      <span className="h-6 w-6 rounded-sm bg-muted inline-block" />
                    )}
                    {team.name}
                  </span>
                  {gName && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      Group {gName}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Matches */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Matches ({groupStageMatches.length})</h2>
          {isAdmin && (
            <div className="flex flex-wrap gap-2">
              {matchList.some(m => m.stage === 'group') && (
                <>
                  <button
                    onClick={() => simulateGroupStageMutation.mutate()}
                    disabled={simulateGroupStageMutation.isPending}
                    className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                  >
                    {simulateGroupStageMutation.isPending ? 'Simulating…' : 'Simulate Group Stage'}
                  </button>
                  <button
                    onClick={() => clearGroupStageMutation.mutate()}
                    disabled={clearGroupStageMutation.isPending}
                    className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                  >
                    {clearGroupStageMutation.isPending ? 'Clearing…' : 'Clear Group Stage Results'}
                  </button>
                </>
              )}
              {addMatchForDate === null && (
                <button
                  onClick={() => openAddMatch()}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                >
                  Add Match
                </button>
              )}
            </div>
          )}
        </div>

        {/* Top-level add match form */}
        {isAdmin && addMatchForDate === '' && renderAddMatchForm()}

        {matchList.length === 0 ? (
          <p className="text-sm text-muted-foreground">No matches added yet.</p>
        ) : (
          <div className="space-y-6">
            {matchGroups.map(({ dateLabel, isoDate, matches }) => (
              <div key={isoDate}>
                <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{dateLabel}</h3>
                <div className="space-y-2">
                  {matches.map(match => (
                    <div key={match.id} className="rounded-lg border p-4">
                      {/* Match header row */}
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs font-bold">
                          {matchStageLabel(match)}
                          {match.scheduledAt && (
                            <span className="ml-1.5 font-normal text-muted-foreground">
                              {new Date(match.scheduledAt).toLocaleTimeString(undefined, { timeStyle: 'short' })}
                            </span>
                          )}
                        </span>
                        <div className="flex items-center gap-2">
                          {match.status === 'completed' && (
                            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
                              Final
                            </span>
                          )}
                          {isAdmin && (
                            <button
                              type="button"
                              onClick={() => editMatchId === match.id ? setEditMatchId(null) : openEditMatch(match)}
                              className="text-muted-foreground hover:text-foreground"
                              title="Edit match"
                            >
                              <Pencil size={13} />
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Teams + score button */}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <TeamBadge name={match.homeTeamName} imageUrl={match.homeTeamImageUrl} />
                          {match.status === 'completed' ? (
                            <span className="rounded bg-muted px-2 py-0.5 text-sm font-bold tabular-nums">
                              {match.homeScore} – {match.awayScore}
                            </span>
                          ) : (
                            <span className="text-sm text-muted-foreground">vs</span>
                          )}
                          <TeamBadge name={match.awayTeamName} imageUrl={match.awayTeamImageUrl} />
                        </div>

                        {isAdmin && match.status === 'scheduled' && scoreMatchId !== match.id && (
                          <button
                            onClick={() => openScoreForm(match.id)}
                            className="rounded-md border px-3 py-1 text-xs hover:bg-muted"
                          >
                            Enter Score
                          </button>
                        )}
                      </div>

                      {/* Score form */}
                      {scoreMatchId === match.id && (
                        <form onSubmit={handleEnterScore} className="mt-3 flex flex-wrap items-center gap-2">
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
                            onClick={() => { setScoreMatchId(null); setScoreError(''); }}
                            className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
                          >
                            Cancel
                          </button>
                        </form>
                      )}

                      {/* Inline edit form */}
                      {editMatchId === match.id && (
                        <form onSubmit={handleSaveEdit} className="mt-3 rounded-md border p-3">
                          <div className="mb-3 grid grid-cols-2 gap-3">
                            <div>
                              <label className="mb-1 block text-xs font-medium text-muted-foreground">Stage</label>
                              <select
                                value={editStage}
                                onChange={e => {
                                  const stage = e.target.value as MatchStage;
                                  setEditStage(stage);
                                  if (stage !== 'group') setEditGroupId('');
                                  setEditHomeTeamId('');
                                  setEditAwayTeamId('');
                                }}
                                className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                                required
                              >
                                {(Object.entries(STAGE_LABELS) as [MatchStage, string][]).map(([val, label]) => (
                                  <option key={val} value={val}>{label}</option>
                                ))}
                              </select>
                            </div>
                            {editStage === 'group' && (
                              <div>
                                <label className="mb-1 block text-xs font-medium text-muted-foreground">Group</label>
                                <select
                                  value={editGroupId}
                                  onChange={e => {
                                    setEditGroupId(e.target.value);
                                    setEditHomeTeamId('');
                                    setEditAwayTeamId('');
                                  }}
                                  className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                                >
                                  <option value="">All groups</option>
                                  {groupList.map(g => (
                                    <option key={g.id} value={g.id}>{g.name}</option>
                                  ))}
                                </select>
                              </div>
                            )}
                            <div>
                              <label className="mb-1 block text-xs font-medium text-muted-foreground">Home Team</label>
                              <select
                                value={editHomeTeamId}
                                onChange={e => setEditHomeTeamId(e.target.value)}
                                className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                              >
                                <option value="">TBD</option>
                                {(editStage === 'group' && editGroupId
                                  ? teams.filter(t => t.groupId === editGroupId)
                                  : teams
                                ).map(t => (
                                  <option key={t.id} value={t.id}>{t.name}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="mb-1 block text-xs font-medium text-muted-foreground">Away Team</label>
                              <select
                                value={editAwayTeamId}
                                onChange={e => setEditAwayTeamId(e.target.value)}
                                className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                              >
                                <option value="">TBD</option>
                                {(editStage === 'group' && editGroupId
                                  ? teams.filter(t => t.groupId === editGroupId)
                                  : teams
                                ).map(t => (
                                  <option key={t.id} value={t.id}>{t.name}</option>
                                ))}
                              </select>
                            </div>
                            <div className="col-span-2">
                              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                                Date &amp; Time (optional)
                              </label>
                              <DateTimePickerFields
                                date={editDate} hour={editHour} minute={editMinute}
                                onDate={setEditDate} onHour={setEditHour} onMinute={setEditMinute}
                              />
                            </div>
                          </div>
                          {editError && <p className="mb-2 text-sm text-red-600">{editError}</p>}
                          <div className="flex gap-2">
                            <button
                              type="submit"
                              disabled={editMatchMutation.isPending}
                              className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                            >
                              {editMatchMutation.isPending ? 'Saving…' : 'Save changes'}
                            </button>
                            <button
                              type="button"
                              onClick={() => { setEditMatchId(null); setEditError(''); }}
                              className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      )}
                    </div>
                  ))}
                </div>

                {/* Per-day add match form or button */}
                {isAdmin && isoDate !== '__none__' && (
                  addMatchForDate === isoDate
                    ? renderAddMatchForm()
                    : (
                      <button
                        type="button"
                        onClick={() => openAddMatch(isoDate)}
                        className="mt-2 w-full rounded-md border border-dashed px-3 py-1.5 text-xs text-muted-foreground hover:border-solid hover:bg-muted hover:text-foreground"
                      >
                        + Add match on this day
                      </button>
                    )
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
