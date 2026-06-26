import { useState } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import BackButton from '@/components/BackButton';
import { Pencil, ChevronDown, Trash2 } from 'lucide-react';
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
import { useT } from '@/lib/useT';
import { useTeamName } from '@/lib/teamTranslations';
import BonusQuestionsTab from './BonusQuestionsTab';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { TournamentKnockoutTabContent } from './TournamentKnockoutPage';
import type { Tournament, Team, Match, MatchStage, Group, Player } from '@tournament-predictor/shared';

type MatchWithTeams = Match & {
  homeTeamName: string | null;
  awayTeamName: string | null;
  homeTeamImageUrl?: string | null;
  awayTeamImageUrl?: string | null;
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
  const { t } = useT();
  const { tn } = useTeamName();

  const STAGE_LABELS: Record<MatchStage, string> = {
    group: t('stages.group'),
    round_of_32: t('stages.round_of_32'),
    round_of_16: t('stages.round_of_16'),
    quarter_final: t('stages.quarter_final'),
    semi_final: t('stages.semi_final'),
    bronze_final: t('stages.bronze_final'),
    final: t('stages.final'),
  };

  const [showAddTeam, setShowAddTeam] = useState(false);
  const [scoreMatchId, setScoreMatchId] = useState<string | null>(null);
  const [activeTeamId, setActiveTeamId] = useState<string | null>(null);

  const [searchParams, setSearchParams] = useSearchParams();
  type TabId = 'group' | 'standings' | 'knockout' | 'bonus' | 'players';
  const VALID_TABS: TabId[] = ['group', 'standings', 'knockout', 'bonus', 'players'];
  const tabParam = searchParams.get('tab') as TabId | null;
  const activeTab: TabId = VALID_TABS.includes(tabParam!) ? tabParam! : 'group';
  const setActiveTab = (tab: TabId) => {
    setSearchParams(prev => { const n = new URLSearchParams(prev); n.set('tab', tab); return n; }, { replace: true });
  };

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

  const [pendingResults, setPendingResults] = useState<Record<string, { home: number; away: number }>>({});

  const [teamsOpen, setTeamsOpen] = useState<boolean | null>(null);

  const [completedGamesOpen, setCompletedGamesOpen] = useState(false);
  const [upcomingGamesOpen, setUpcomingGamesOpen] = useState(true);

  const [addTeamError, setAddTeamError] = useState('');
  const [addMatchError, setAddMatchError] = useState('');

  // Group standings per-group manual override state
  const [groupOrderEdits, setGroupOrderEdits] = useState<Record<string, string[]>>({});
  const [overrideLuckyLosers, setOverrideLuckyLosers] = useState<string[] | null>(null);
  const [showConfirmGroupDialog, setShowConfirmGroupDialog] = useState<string | null>(null);
  const [showLuckyLosersDialog, setShowLuckyLosersDialog] = useState(false);
  const [notConfirmedGroupsOpen, setNotConfirmedGroupsOpen] = useState(true);
  const [confirmedGroupsOpen, setConfirmedGroupsOpen] = useState(false);

  // Players tab state
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [playerName, setPlayerName] = useState('');
  const [playerGamesPlayed, setPlayerGamesPlayed] = useState('');
  const [playerGoalsScored, setPlayerGoalsScored] = useState('');
  const [addPlayerError, setAddPlayerError] = useState('');
  const [editPlayerId, setEditPlayerId] = useState<string | null>(null);
  const [editPlayerName, setEditPlayerName] = useState('');
  const [editPlayerGamesPlayed, setEditPlayerGamesPlayed] = useState('');
  const [editPlayerGoalsScored, setEditPlayerGoalsScored] = useState('');
  const [editPlayerError, setEditPlayerError] = useState('');

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

  const { data: playerList = [] } = useQuery({
    queryKey: ['players', id],
    queryFn: () => api.get<Player[]>(`/tournaments/${id}/players`),
    enabled: !!id && isAdmin,
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

  const confirmResultsMutation = useMutation({
    mutationFn: async () => {
      for (const [matchId, { home, away }] of Object.entries(pendingResults)) {
        await api.patch<Match>(`/matches/${matchId}`, { homeScore: home, awayScore: away });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['matches', id] });
      setPendingResults({});
      setScoreMatchId(null);
    },
    onError: (err: any) => console.error('Confirm results error:', err),
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

  const deleteMatchMutation = useMutation({
    mutationFn: (matchId: string) => api.delete(`/matches/${matchId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['matches', id] }),
  });

  function simulateGroupStage() {
    const scheduled = matchList.filter(m => m.stage === 'group' && m.status === 'scheduled');
    const staged: Record<string, { home: number; away: number }> = {};
    for (const m of scheduled) {
      staged[m.id] = {
        home: Math.floor(Math.random() * 5),
        away: Math.floor(Math.random() * 5),
      };
    }
    setPendingResults(prev => ({ ...prev, ...staged }));
  }

  const recalculateScoresMutation = useMutation({
    mutationFn: () => api.post(`/tournaments/${id}/recalculate-scores`, {}),
  });

  const clearGroupStageMutation = useMutation({
    mutationFn: () => api.post(`/tournaments/${id}/clear-group-stage`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['matches', id] }),
  });

  const confirmGroupMutation = useMutation({
    mutationFn: ({ groupName, standings }: { groupName: string; standings: string[] }) =>
      api.post(`/tournaments/${id}/confirm-group/${groupName}`, { standings }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tournament', id] });
      queryClient.invalidateQueries({ queryKey: ['matches', id] });
      setShowConfirmGroupDialog(null);
    },
  });

  const reopenGroupMutation = useMutation({
    mutationFn: (groupName: string) =>
      api.post(`/tournaments/${id}/reopen-group/${groupName}`, {}),
    onSuccess: (_data, groupName) => {
      queryClient.invalidateQueries({ queryKey: ['tournament', id] });
      queryClient.invalidateQueries({ queryKey: ['matches', id] });
      setGroupOrderEdits(prev => { const n = { ...prev }; delete n[groupName]; return n; });
    },
  });

  const reopenGroupStandingsMutation = useMutation({
    mutationFn: () => api.post(`/tournaments/${id}/reopen-group-standings`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tournament', id] });
      queryClient.invalidateQueries({ queryKey: ['matches', id] });
      setOverrideLuckyLosers(null);
    },
  });

  const confirmGroupStandingsMutation = useMutation({
    mutationFn: (body: { luckyLosers: string[] }) =>
      api.post(`/tournaments/${id}/confirm-group-standings`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tournament', id] });
      queryClient.invalidateQueries({ queryKey: ['matches', id] });
      setShowLuckyLosersDialog(false);
      setOverrideLuckyLosers(null);
    },
  });

  const addPlayerMutation = useMutation({
    mutationFn: (data: { name: string; gamesPlayed: number; goalsScored: number }) =>
      api.post<Player>(`/tournaments/${id}/players`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['players', id] });
      setPlayerName('');
      setPlayerGamesPlayed('');
      setPlayerGoalsScored('');
      setShowAddPlayer(false);
      setAddPlayerError('');
    },
    onError: (err: any) => setAddPlayerError(err.message),
  });

  const updatePlayerMutation = useMutation({
    mutationFn: ({ playerId, data }: { playerId: string; data: { name?: string; gamesPlayed?: number; goalsScored?: number } }) =>
      api.patch<Player>(`/tournaments/${id}/players/${playerId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['players', id] });
      setEditPlayerId(null);
      setEditPlayerError('');
    },
    onError: (err: any) => setEditPlayerError(err.message),
  });

  const deletePlayerMutation = useMutation({
    mutationFn: (playerId: string) => api.delete(`/tournaments/${id}/players/${playerId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['players', id] }),
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

  function autoStageScore(matchId: string, homeVal: string, awayVal: string) {
    const home = parseInt(homeVal, 10);
    const away = parseInt(awayVal, 10);
    if (homeVal === '' || awayVal === '' || isNaN(home) || isNaN(away) || home < 0 || away < 0) return;
    setPendingResults(prev => ({ ...prev, [matchId]: { home, away } }));
    setScoreMatchId(null);
    setHomeScore('');
    setAwayScore('');
  }

  function openScoreForm(matchId: string) {
    setScoreMatchId(matchId);
    const p = pendingResults[matchId];
    setHomeScore(p ? String(p.home) : '');
    setAwayScore(p ? String(p.away) : '');
  }

  function removePendingResult(matchId: string) {
    setPendingResults(prev => {
      const n = { ...prev };
      delete n[matchId];
      return n;
    });
  }

  if (tournamentLoading) {
    return <LoadingSpinner />;
  }
  if (!tournament) {
    return <div className="p-8 text-sm">{t('tournamentDetail.notFound')}</div>;
  }

  const canEditTeams = isAdmin && tournament.status === 'upcoming';
  const teamsIsOpen = teamsOpen ?? (tournament.status === 'upcoming');

  // ── Standings computation ─────────────────────────────────────────────────────

  type FullRow = {
    team: Team;
    mp: number; w: number; d: number; l: number;
    gf: number; ga: number; gd: number; pts: number;
  };

  const directQualifiers = tournament.knockoutConfig?.directQualifiers ?? 2;
  const numLuckyLosers = tournament.knockoutConfig?.luckyLosers ?? 0;

  const groupStandingData = groupList.map(group => {
    const teamsInGroup = teamsByGroup.get(group.id) ?? [];
    const groupTeamIds = new Set(teamsInGroup.map(t => t.id));
    const statMap = new Map<string, { mp: number; w: number; d: number; l: number; gf: number; ga: number; gd: number; pts: number }>();

    for (const team of teamsInGroup) {
      statMap.set(team.id, { mp: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 });
    }
    for (const match of matchList) {
      if (match.stage !== 'group' || !match.homeTeamId || !match.awayTeamId) continue;
      if (!groupTeamIds.has(match.homeTeamId) || !groupTeamIds.has(match.awayTeamId)) continue;
      const p = pendingResults[match.id];
      let hS: number | null = null, aS: number | null = null;
      if (p) { hS = p.home; aS = p.away; }
      else if (match.status === 'completed' && match.homeScore !== null && match.awayScore !== null) {
        hS = match.homeScore; aS = match.awayScore;
      }
      if (hS === null || aS === null) continue;
      const home = statMap.get(match.homeTeamId)!;
      const away = statMap.get(match.awayTeamId)!;
      home.mp++; away.mp++;
      home.gf += hS; home.ga += aS;
      away.gf += aS; away.ga += hS;
      if (hS > aS) { home.w++; home.pts += 3; away.l++; }
      else if (hS < aS) { away.w++; away.pts += 3; home.l++; }
      else { home.d++; home.pts++; away.d++; away.pts++; }
      home.gd = home.gf - home.ga;
      away.gd = away.gf - away.ga;
    }

    const rows: FullRow[] = teamsInGroup
      .map(team => {
        const s = statMap.get(team.id) ?? { mp: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 };
        return { team, ...s };
      })
      .sort((a, b) => {
        if (b.pts !== a.pts) return b.pts - a.pts;
        if (b.gd !== a.gd) return b.gd - a.gd;
        return b.gf - a.gf;
      });

    return { group, rows };
  });

  // Lucky loser candidates from computed standings (for pre-confirmation visualization)
  const sortedLL = groupStandingData
    .map(gd => gd.rows[directQualifiers])
    .filter((r): r is FullRow => r !== undefined)
    .sort((a, b) => {
      if (b.pts !== a.pts) return b.pts - a.pts;
      if (b.gd !== a.gd) return b.gd - a.gd;
      return b.gf - a.gf;
    });
  const luckyLoserIds = new Set(sortedLL.slice(0, numLuckyLosers).map(r => r.team.id));

  // Group standings confirmation
  const groupStandingsLocked = tournament.knockoutConfig?.groupStandingsLocked ?? false;
  const confirmedGroupStandings = tournament.knockoutConfig?.confirmedGroupStandings ?? {};
  const hasPendingResults = Object.keys(pendingResults).length > 0;

  // Per-group: which groups have all their matches completed
  const teamGroupIdMap = new Map<string, string>(); // teamId -> groupId
  for (const t of teams) if (t.groupId) teamGroupIdMap.set(t.id, t.groupId);
  const groupMatchesDoneMap = new Map<string, boolean>();
  for (const g of groupList) {
    const groupTeamIds = new Set(teams.filter(t => t.groupId === g.id).map(t => t.id));
    const gMatches = matchList.filter(
      m => m.stage === 'group' && m.homeTeamId && m.awayTeamId &&
           groupTeamIds.has(m.homeTeamId!) && groupTeamIds.has(m.awayTeamId!),
    );
    groupMatchesDoneMap.set(g.name, gMatches.length > 0 && gMatches.every(m => m.status === 'completed'));
  }
  const allGroupsConfirmed = groupList.length > 0 &&
    groupList.every(g => Boolean(confirmedGroupStandings[g.name]));

  // When a group is confirmed, reorder display rows to match the confirmed order
  const displayGroupStandingData = groupStandingData.map(({ group, rows }) => {
    const confirmed = confirmedGroupStandings[group.name];
    if (confirmed) {
      const reordered = confirmed
        .map(teamId => rows.find(r => r.team.id === teamId))
        .filter((r): r is FullRow => r !== undefined);
      return { group, rows: reordered };
    }
    return { group, rows };
  });

  // Build a fast teamId→row lookup across all groups
  const teamRowMap = new Map<string, FullRow>();
  for (const { rows } of groupStandingData) {
    for (const row of rows) teamRowMap.set(row.team.id, row);
  }

  // When all groups confirmed: ALL non-direct-qualifying teams are LL candidates (admin can freely reorder)
  const confirmedLLCandidateIds: string[] = groupStandingData.flatMap(({ group }) => {
    const confirmedOrder = confirmedGroupStandings[group.name];
    if (!confirmedOrder) return [];
    return confirmedOrder.slice(directQualifiers).filter(Boolean);
  });
  const defaultLLOrder = [...confirmedLLCandidateIds].sort((a, b) => {
    const ra = teamRowMap.get(a);
    const rb = teamRowMap.get(b);
    if (!ra || !rb) return 0;
    if (rb.pts !== ra.pts) return rb.pts - ra.pts;
    if (rb.gd !== ra.gd) return rb.gd - ra.gd;
    return rb.gf - ra.gf;
  });
  const llDisplayOrder = overrideLuckyLosers ?? defaultLLOrder;

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
      : t('common.noDate');
    const last = matchGroups[matchGroups.length - 1];
    if (last && last.isoDate === isoDate) {
      last.matches.push(match);
    } else {
      matchGroups.push({ dateLabel, isoDate, matches: [match] });
    }
  }

  const completedSortedMatches = sortedMatches.filter(m => m.homeScore !== null && m.awayScore !== null);
  const upcomingSortedMatches = sortedMatches.filter(m => m.homeScore === null || m.awayScore === null);

  function buildMatchGroups(matches: MatchWithTeams[]) {
    const groups: { dateLabel: string; isoDate: string; matches: MatchWithTeams[] }[] = [];
    for (const match of matches) {
      const isoDate = match.scheduledAt ? new Date(match.scheduledAt).toLocaleDateString('en-CA') : '__none__';
      const dateLabel = match.scheduledAt ? new Date(match.scheduledAt).toLocaleDateString(undefined, { dateStyle: 'long' }) : t('common.noDate');
      const last = groups[groups.length - 1];
      if (last && last.isoDate === isoDate) {
        last.matches.push(match);
      } else {
        groups.push({ dateLabel, isoDate, matches: [match] });
      }
    }
    return groups;
  }

  const completedMatchGroups = buildMatchGroups(completedSortedMatches);
  const upcomingMatchGroups = buildMatchGroups(upcomingSortedMatches);

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
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('tournamentDetail.matchForm.stage')}</label>
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
                <option value="">{t('tournamentDetail.matchForm.allGroups')}</option>
                {groupList.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('tournamentDetail.matchForm.homeTeam')}</label>
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
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('tournamentDetail.matchForm.awayTeam')}</label>
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
            {addMatchMutation.isPending ? t('tournamentDetail.matchForm.addingMatch') : t('tournamentDetail.matchForm.addMatch')}
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
      <BackButton href="/admin/tournaments" />

      {/* Stage tabs */}
      <div className="flex flex-wrap gap-1 border-b mb-6">
        {([
          ['group', t('tournamentDetail.tabs.groupStage')],
          ['standings', t('tournamentDetail.tabs.groupTables')],
          ['knockout', t('tournamentDetail.tabs.knockoutStage')],
          ['bonus', t('tournamentDetail.tabs.bonusQuestions')],
        ] as const).map(([tab, label]) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`whitespace-nowrap px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === tab ? 'border-primary text-primary dark:border-[hsl(231,60%,65%)] dark:text-[hsl(231,60%,65%)]' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
        {isAdmin && (
          <button
            onClick={() => setActiveTab('players')}
            className={`whitespace-nowrap px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === 'players' ? 'border-primary text-primary dark:border-[hsl(231,60%,65%)] dark:text-[hsl(231,60%,65%)]' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            Players
          </button>
        )}
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
            <button
              onClick={() => recalculateScoresMutation.mutate()}
              disabled={recalculateScoresMutation.isPending}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            >
              {recalculateScoresMutation.isPending ? t('tournamentDetail.recalculating') : t('tournamentDetail.recalculate')}
            </button>
            <Link
              to={`/admin/tournaments/${id}/edit`}
              className="ml-auto rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            >
              Edit
            </Link>
          </>
        )}
      </div>

      {activeTab === 'standings' && (
        <section className="space-y-8">
          {groupList.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('tournamentDetail.standings.noGroups')}</p>
          ) : (<>
            {/* Group tables */}
            <div className="grid gap-6 sm:grid-cols-2">
              {displayGroupStandingData.map(({ group, rows }) => {
                const hasPending = Object.keys(pendingResults).length > 0;
                return (
                  <div key={group.id} className="rounded-lg border overflow-hidden">
                    <div className="flex items-center justify-between border-b px-4 py-2.5 bg-muted/30">
                      <h3 className="font-semibold text-sm">{t('common.group')} {group.name}</h3>
                      {hasPending && (
                        <span className="text-xs text-amber-600 dark:text-amber-400">{t('tournamentDetail.standings.provisional')}</span>
                      )}
                    </div>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-xs text-muted-foreground">
                          <th className="w-1 py-1.5" />
                          <th className="px-3 py-1.5 text-left w-6">#</th>
                          <th className="px-3 py-1.5 text-left">{t('groupTable.team')}</th>
                          <th className="px-2 py-1.5 text-center w-8">{t('groupTable.played')}</th>
                          <th className="px-2 py-1.5 text-center w-8">{t('groupTable.won')}</th>
                          <th className="px-2 py-1.5 text-center w-8">{t('groupTable.drawn')}</th>
                          <th className="px-2 py-1.5 text-center w-8">{t('groupTable.lost')}</th>
                          <th className="px-2 py-1.5 text-center w-8">{t('groupTable.gd')}</th>
                          <th className="px-2 py-1.5 text-center w-10 font-bold">{t('groupTable.pts')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.length === 0 ? (
                          <tr>
                            <td colSpan={9} className="px-3 py-3 text-xs text-muted-foreground text-center">
                              {t('tournamentDetail.standings.noTeamsInGroup')}
                            </td>
                          </tr>
                        ) : rows.map((row, i) => {
                          const effectiveDQ = Math.min(directQualifiers, rows.length - 1);
                          const isDirect = i < effectiveDQ;
                          const isLL = i === effectiveDQ && luckyLoserIds.has(row.team.id);
                          const stripe = isDirect
                            ? 'bg-green-500'
                            : isLL
                            ? 'bg-yellow-400'
                            : 'bg-transparent';
                          return (
                            <tr key={row.team.id} className="border-b last:border-0 hover:bg-muted/20">
                              <td className={`w-1 ${stripe}`} />
                              <td className="px-3 py-2 text-muted-foreground text-xs">{i + 1}</td>
                              <td className="px-3 py-2">
                                <span className="flex items-center gap-2">
                                  {row.team.imageUrl ? (
                                    <img src={row.team.imageUrl} alt={row.team.name} className="h-5 w-5 rounded-sm object-cover flex-shrink-0" />
                                  ) : (
                                    <span className="h-5 w-5 rounded-sm bg-muted inline-block flex-shrink-0" />
                                  )}
                                  <span className="truncate">{row.team.name}</span>
                                </span>
                              </td>
                              <td className="px-2 py-2 text-center tabular-nums">{row.mp}</td>
                              <td className="px-2 py-2 text-center tabular-nums">{row.w}</td>
                              <td className="px-2 py-2 text-center tabular-nums">{row.d}</td>
                              <td className="px-2 py-2 text-center tabular-nums">{row.l}</td>
                              <td className="px-2 py-2 text-center tabular-nums">{row.gd > 0 ? `+${row.gd}` : row.gd}</td>
                              <td className="px-2 py-2 text-center tabular-nums font-bold">{row.pts}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>

            {/* Legend */}
            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-green-500" /> {t('tournamentDetail.standings.directQualifier')}
              </span>
              {numLuckyLosers > 0 && (
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm bg-yellow-400" /> {t('tournamentDetail.standings.luckyLoser')}
                </span>
              )}
            </div>

            {/* Lucky Losers Table — only shown once all groups are confirmed */}
            {numLuckyLosers > 0 && allGroupsConfirmed && (() => {
              // Build map: teamId → { group, row } for all non-direct-qualifying teams
              const llRowMap = new Map<string, { group: typeof groupList[0]; row: FullRow }>();
              for (const { group, rows } of groupStandingData) {
                const confirmedOrder = confirmedGroupStandings[group.name];
                if (!confirmedOrder) continue;
                for (let pos = directQualifiers; pos < confirmedOrder.length; pos++) {
                  const llTeamId = confirmedOrder[pos];
                  if (!llTeamId) continue;
                  const llRow = rows.find(r => r.team.id === llTeamId);
                  if (llRow) llRowMap.set(llTeamId, { group, row: llRow });
                }
              }

              if (llRowMap.size === 0) return null;

              // Determine display order
              const displayIds = llDisplayOrder;

              const llTableRows = displayIds
                .map(teamId => {
                  const entry = llRowMap.get(teamId);
                  return entry ? { teamId, ...entry } : null;
                })
                .filter((x): x is { teamId: string; group: typeof groupList[0]; row: FullRow } => x !== null);

              if (llTableRows.length === 0) return null;

              const isInteractive = isAdmin; // allGroupsConfirmed guaranteed by outer condition

              return (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold">{t('tournamentDetail.standings.luckyLosersTable')}</h3>
                    {groupStandingsLocked && (
                      <span className="rounded-full bg-green-500/10 px-2.5 py-1 text-xs font-medium text-green-600 dark:text-green-400">Locked</span>
                    )}
                  </div>

                  {isInteractive && (
                    <p className="text-xs text-muted-foreground">
                      Use the arrows to freely re-order all non-qualifying teams. The top {numLuckyLosers} (highlighted) will advance as lucky losers regardless of points or goals.
                    </p>
                  )}

                  <div className="rounded-lg border overflow-hidden">
                    <table className="w-full text-sm table-fixed">
                      <thead>
                        <tr className="border-b text-xs text-muted-foreground bg-muted/30">
                          <th className="w-1 py-1.5" />
                          <th className="px-3 py-1.5 text-left w-6">#</th>
                          <th className="px-3 py-1.5 text-left">{t('groupTable.team')}</th>
                          <th className="px-2 py-1.5 text-center w-8">{t('groupTable.played')}</th>
                          <th className="px-2 py-1.5 text-center w-8">{t('groupTable.won')}</th>
                          <th className="px-2 py-1.5 text-center w-8">{t('groupTable.drawn')}</th>
                          <th className="px-2 py-1.5 text-center w-8">{t('groupTable.lost')}</th>
                          <th className="px-2 py-1.5 text-center w-8">{t('groupTable.gd')}</th>
                          <th className="px-2 py-1.5 text-center w-8">{t('groupTable.gf')}</th>
                          <th className="px-2 py-1.5 text-center w-10 font-bold">{t('groupTable.pts')}</th>
                          <th className="px-2 py-1.5 text-center w-10">Grp</th>
                          {isInteractive && <th className="w-16" />}
                        </tr>
                      </thead>
                      <tbody>
                        {llTableRows.map(({ teamId, group, row }, i) => {
                          const isQualifying = i < numLuckyLosers;
                          return (
                            <tr key={teamId} className={`border-b last:border-0 hover:bg-muted/20 ${isQualifying ? 'bg-green-500/5' : ''}`}>
                              <td className={`w-1 ${isQualifying ? 'bg-green-500' : 'bg-transparent'}`} />
                              <td className="px-3 py-2 text-muted-foreground text-xs">{i + 1}</td>
                              <td className="px-3 py-2 overflow-hidden">
                                <span className="flex items-center gap-2 min-w-0">
                                  {row.team.imageUrl ? (
                                    <img src={row.team.imageUrl} alt={row.team.name} className="h-5 w-5 rounded-sm object-cover flex-shrink-0" />
                                  ) : (
                                    <span className="h-5 w-5 rounded-sm bg-muted inline-block flex-shrink-0" />
                                  )}
                                  <span className="truncate">{row.team.name}</span>
                                </span>
                              </td>
                              <td className="px-2 py-2 text-center tabular-nums">{row.mp}</td>
                              <td className="px-2 py-2 text-center tabular-nums">{row.w}</td>
                              <td className="px-2 py-2 text-center tabular-nums">{row.d}</td>
                              <td className="px-2 py-2 text-center tabular-nums">{row.l}</td>
                              <td className="px-2 py-2 text-center tabular-nums">{row.gd > 0 ? `+${row.gd}` : row.gd}</td>
                              <td className="px-2 py-2 text-center tabular-nums">{row.gf}</td>
                              <td className="px-2 py-2 text-center tabular-nums font-bold">{row.pts}</td>
                              <td className="px-2 py-2 text-center text-muted-foreground text-xs">{group.name}</td>
                              {isInteractive && (
                                <td className="px-1 py-1.5">
                                  <div className="flex gap-0.5 justify-end">
                                    <button
                                      type="button"
                                      disabled={i === 0}
                                      onClick={() => {
                                        const next = [...displayIds];
                                        [next[i - 1], next[i]] = [next[i], next[i - 1]];
                                        setOverrideLuckyLosers(next);
                                      }}
                                      className="rounded px-1 py-0.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                                    >↑</button>
                                    <button
                                      type="button"
                                      disabled={i === llTableRows.length - 1}
                                      onClick={() => {
                                        const next = [...displayIds];
                                        [next[i], next[i + 1]] = [next[i + 1], next[i]];
                                        setOverrideLuckyLosers(next);
                                      }}
                                      className="rounded px-1 py-0.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                                    >↓</button>
                                  </div>
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {groupStandingsLocked && (
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-xs text-muted-foreground">Lucky losers are locked. Points have been calculated.</p>
                      <button
                        type="button"
                        disabled={reopenGroupStandingsMutation.isPending}
                        onClick={() => reopenGroupStandingsMutation.mutate()}
                        className="flex-shrink-0 rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                      >
                        {reopenGroupStandingsMutation.isPending ? 'Clearing…' : 'Re-open'}
                      </button>
                    </div>
                  )}

                  {isInteractive && (
                    <button
                      type="button"
                      onClick={() => setShowLuckyLosersDialog(true)}
                      className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                    >
                      {groupStandingsLocked ? 'Update Lucky Losers' : 'Confirm Lucky Losers'}
                    </button>
                  )}
                </div>
              );
            })()}

            {/* Per-group confirm/re-open — admin only */}
            {isAdmin && !hasPendingResults && groupList.some(g => groupMatchesDoneMap.get(g.name)) && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">Confirm Group Standings</h3>

                {/* Not Confirmed groups */}
                {groupStandingData.some(({ group }) => groupMatchesDoneMap.get(group.name) && !confirmedGroupStandings[group.name]) && (
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={() => setNotConfirmedGroupsOpen(o => !o)}
                      className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-foreground/80"
                    >
                      <span className={`inline-block transition-transform ${notConfirmedGroupsOpen ? 'rotate-90' : ''}`}>▶</span>
                      Not Confirmed
                    </button>
                    {notConfirmedGroupsOpen && (
                      <div className="grid gap-4 sm:grid-cols-2">
                        {groupStandingData.map(({ group, rows }) => {
                          const isDone = groupMatchesDoneMap.get(group.name) ?? false;
                          const isConfirmed = Boolean(confirmedGroupStandings[group.name]);
                          if (!isDone || isConfirmed) return null;

                          const computedOrder = rows.map(r => r.team.id);
                          const editOrder = groupOrderEdits[group.name] ?? computedOrder;

                          return (
                            <div key={group.id} className="rounded-lg border overflow-hidden">
                              <div className="flex items-center justify-between border-b px-3 py-2 bg-muted/30">
                                <h4 className="font-semibold text-sm">Group {group.name}</h4>
                              </div>

                              <div className="p-2 space-y-1">
                                {editOrder.map((teamId, idx) => {
                                  const team = teams.find(t => t.id === teamId);
                                  if (!team) return null;
                                  const effectiveDQ = Math.min(directQualifiers, editOrder.length - 1);
                                  const isDirect = idx < effectiveDQ;
                                  const isLL = numLuckyLosers > 0 && idx === effectiveDQ;
                                  return (
                                    <div
                                      key={teamId}
                                      className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 ${isDirect ? 'border-green-500/30 bg-green-500/5' : isLL ? 'border-yellow-400/30 bg-yellow-400/5' : ''}`}
                                    >
                                      <span className="w-5 text-xs font-bold tabular-nums text-muted-foreground">{idx + 1}.</span>
                                      {team.imageUrl ? (
                                        <img src={team.imageUrl} alt={team.name} className="h-5 w-5 rounded-sm object-cover flex-shrink-0" />
                                      ) : (
                                        <span className="h-5 w-5 rounded-sm bg-muted inline-block flex-shrink-0" />
                                      )}
                                      <span className="flex-1 text-sm truncate">{team.name}</span>
                                      <div className="flex gap-0.5">
                                        <button
                                          type="button"
                                          disabled={idx === 0}
                                          onClick={() => {
                                            const next = [...editOrder];
                                            [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                                            setGroupOrderEdits(prev => ({ ...prev, [group.name]: next }));
                                          }}
                                          className="rounded px-1 py-0.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                                        >↑</button>
                                        <button
                                          type="button"
                                          disabled={idx === editOrder.length - 1}
                                          onClick={() => {
                                            const next = [...editOrder];
                                            [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                                            setGroupOrderEdits(prev => ({ ...prev, [group.name]: next }));
                                          }}
                                          className="rounded px-1 py-0.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                                        >↓</button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>

                              <div className="px-2 pb-2">
                                <button
                                  type="button"
                                  onClick={() => setShowConfirmGroupDialog(group.name)}
                                  className="w-full rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                                >
                                  Confirm Group {group.name}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Confirmed groups */}
                {groupStandingData.some(({ group }) => groupMatchesDoneMap.get(group.name) && confirmedGroupStandings[group.name]) && (
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={() => setConfirmedGroupsOpen(o => !o)}
                      className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-foreground/80"
                    >
                      <span className={`inline-block transition-transform ${confirmedGroupsOpen ? 'rotate-90' : ''}`}>▶</span>
                      Confirmed
                    </button>
                    {confirmedGroupsOpen && (
                      <div className="grid gap-4 sm:grid-cols-2">
                        {groupStandingData.map(({ group, rows }) => {
                          const isDone = groupMatchesDoneMap.get(group.name) ?? false;
                          const isConfirmed = Boolean(confirmedGroupStandings[group.name]);
                          if (!isDone || !isConfirmed) return null;

                          const computedOrder = rows.map(r => r.team.id);
                          const editOrder = confirmedGroupStandings[group.name] ?? computedOrder;

                          return (
                            <div key={group.id} className="rounded-lg border overflow-hidden">
                              <div className="flex items-center justify-between border-b px-3 py-2 bg-muted/30">
                                <h4 className="font-semibold text-sm">Group {group.name}</h4>
                                <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
                                  Confirmed
                                </span>
                              </div>

                              <div className="p-2 space-y-1">
                                {editOrder.map((teamId, idx) => {
                                  const team = teams.find(t => t.id === teamId);
                                  if (!team) return null;
                                  const effectiveDQ = Math.min(directQualifiers, editOrder.length - 1);
                                  const isDirect = idx < effectiveDQ;
                                  const isLL = numLuckyLosers > 0 && idx === effectiveDQ;
                                  return (
                                    <div
                                      key={teamId}
                                      className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 ${isDirect ? 'border-green-500/30 bg-green-500/5' : isLL ? 'border-yellow-400/30 bg-yellow-400/5' : ''}`}
                                    >
                                      <span className="w-5 text-xs font-bold tabular-nums text-muted-foreground">{idx + 1}.</span>
                                      {team.imageUrl ? (
                                        <img src={team.imageUrl} alt={team.name} className="h-5 w-5 rounded-sm object-cover flex-shrink-0" />
                                      ) : (
                                        <span className="h-5 w-5 rounded-sm bg-muted inline-block flex-shrink-0" />
                                      )}
                                      <span className="flex-1 text-sm truncate">{team.name}</span>
                                    </div>
                                  );
                                })}
                              </div>

                              <div className="px-2 pb-2">
                                <button
                                  type="button"
                                  disabled={reopenGroupMutation.isPending && reopenGroupMutation.variables === group.name}
                                  onClick={() => reopenGroupMutation.mutate(group.name)}
                                  className="w-full rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                                >
                                  {reopenGroupMutation.isPending && reopenGroupMutation.variables === group.name ? 'Re-opening…' : 'Re-open Group'}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

          </>)}
        </section>
      )}

      {/* Per-group confirm dialog */}
      {showConfirmGroupDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="max-w-sm w-full rounded-lg border bg-card p-6 shadow-xl">
            <h3 className="mb-2 text-base font-semibold">Confirm Group {showConfirmGroupDialog}?</h3>
            <p className="mb-4 text-sm text-muted-foreground">
              This will lock Group {showConfirmGroupDialog}'s standings, award group position points, and add the direct qualifiers to the knockout bracket.
            </p>
            {confirmGroupMutation.isError && (
              <p className="mb-3 text-sm text-red-600">
                {(confirmGroupMutation.error as any)?.message ?? 'An error occurred'}
              </p>
            )}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => {
                  const gName = showConfirmGroupDialog;
                  const gData = groupStandingData.find(gd => gd.group.name === gName);
                  const computedOrder = gData?.rows.map(r => r.team.id) ?? [];
                  const standings = groupOrderEdits[gName] ?? computedOrder;
                  confirmGroupMutation.mutate({ groupName: gName, standings });
                }}
                disabled={confirmGroupMutation.isPending}
                className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {confirmGroupMutation.isPending ? 'Confirming…' : 'Yes, Confirm'}
              </button>
              <button
                type="button"
                onClick={() => setShowConfirmGroupDialog(null)}
                disabled={confirmGroupMutation.isPending}
                className="flex-1 rounded-md border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lucky losers confirm dialog */}
      {showLuckyLosersDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="max-w-sm w-full rounded-lg border bg-card p-6 shadow-xl">
            <h3 className="mb-2 text-base font-semibold">{groupStandingsLocked ? 'Update Lucky Losers?' : 'Confirm Lucky Losers?'}</h3>
            <p className="mb-4 text-sm text-muted-foreground">
              {groupStandingsLocked
                ? 'This will update the lucky loser selection and recalculate points.'
                : 'This will lock the lucky loser selection and place them in the knockout bracket.'}
            </p>
            {confirmGroupStandingsMutation.isError && (
              <p className="mb-3 text-sm text-red-600">
                {(confirmGroupStandingsMutation.error as any)?.message ?? 'An error occurred'}
              </p>
            )}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => {
                  confirmGroupStandingsMutation.mutate({ luckyLosers: llDisplayOrder });
                }}
                disabled={confirmGroupStandingsMutation.isPending}
                className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {confirmGroupStandingsMutation.isPending ? 'Confirming…' : 'Yes, Confirm'}
              </button>
              <button
                type="button"
                onClick={() => setShowLuckyLosersDialog(false)}
                disabled={confirmGroupStandingsMutation.isPending}
                className="flex-1 rounded-md border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'bonus' && (
        <BonusQuestionsTab tournamentId={id!} deadlinePassed={false} />
      )}

      {activeTab === 'knockout' && (
        <TournamentKnockoutTabContent tournamentId={id!} />
      )}

      {activeTab === 'players' && isAdmin && (
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Players ({playerList.length})</h2>
            {!showAddPlayer && (
              <button
                onClick={() => setShowAddPlayer(true)}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
              >
                Add Player
              </button>
            )}
          </div>

          {showAddPlayer && (
            <form
              onSubmit={e => {
                e.preventDefault();
                addPlayerMutation.mutate({
                  name: playerName.trim(),
                  gamesPlayed: parseInt(playerGamesPlayed, 10) || 0,
                  goalsScored: parseInt(playerGoalsScored, 10) || 0,
                });
              }}
              className="mb-4 rounded-lg border p-4"
            >
              <div className="mb-3 grid grid-cols-3 gap-3">
                <div className="col-span-3 sm:col-span-1">
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
                  <input
                    type="text"
                    value={playerName}
                    onChange={e => setPlayerName(e.target.value)}
                    className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    required
                    maxLength={100}
                    autoFocus
                    placeholder="Player name"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Games Played</label>
                  <input
                    type="number"
                    min="0"
                    value={playerGamesPlayed}
                    onChange={e => setPlayerGamesPlayed(e.target.value)}
                    className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Goals Scored</label>
                  <input
                    type="number"
                    min="0"
                    value={playerGoalsScored}
                    onChange={e => setPlayerGoalsScored(e.target.value)}
                    className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    placeholder="0"
                  />
                </div>
              </div>
              {addPlayerError && <p className="mb-2 text-sm text-red-600">{addPlayerError}</p>}
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={addPlayerMutation.isPending || !playerName.trim()}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {addPlayerMutation.isPending ? 'Adding…' : 'Add Player'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowAddPlayer(false); setPlayerName(''); setPlayerGamesPlayed(''); setPlayerGoalsScored(''); setAddPlayerError(''); }}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {playerList.length === 0 ? (
            <p className="text-sm text-muted-foreground">No players yet.</p>
          ) : (
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground bg-muted/30">
                    <th className="px-4 py-2.5 text-left">Name</th>
                    <th className="px-4 py-2.5 text-center">Games Played</th>
                    <th className="px-4 py-2.5 text-center">Goals Scored</th>
                    <th className="px-4 py-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {playerList.map(player => (
                    <tr key={player.id} className="border-b last:border-0">
                      {editPlayerId === player.id ? (
                        <td colSpan={4} className="px-4 py-3">
                          <form
                            onSubmit={e => {
                              e.preventDefault();
                              updatePlayerMutation.mutate({
                                playerId: player.id,
                                data: {
                                  name: editPlayerName.trim(),
                                  gamesPlayed: parseInt(editPlayerGamesPlayed, 10) || 0,
                                  goalsScored: parseInt(editPlayerGoalsScored, 10) || 0,
                                },
                              });
                            }}
                          >
                            <div className="mb-2 grid grid-cols-3 gap-3">
                              <div className="col-span-3 sm:col-span-1">
                                <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
                                <input
                                  type="text"
                                  value={editPlayerName}
                                  onChange={e => setEditPlayerName(e.target.value)}
                                  className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                                  required
                                  maxLength={100}
                                  autoFocus
                                />
                              </div>
                              <div>
                                <label className="mb-1 block text-xs font-medium text-muted-foreground">Games Played</label>
                                <input
                                  type="number"
                                  min="0"
                                  value={editPlayerGamesPlayed}
                                  onChange={e => setEditPlayerGamesPlayed(e.target.value)}
                                  className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                                />
                              </div>
                              <div>
                                <label className="mb-1 block text-xs font-medium text-muted-foreground">Goals Scored</label>
                                <input
                                  type="number"
                                  min="0"
                                  value={editPlayerGoalsScored}
                                  onChange={e => setEditPlayerGoalsScored(e.target.value)}
                                  className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                                />
                              </div>
                            </div>
                            {editPlayerError && <p className="mb-2 text-sm text-red-600">{editPlayerError}</p>}
                            <div className="flex gap-2">
                              <button
                                type="submit"
                                disabled={updatePlayerMutation.isPending || !editPlayerName.trim()}
                                className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                              >
                                {updatePlayerMutation.isPending ? 'Saving…' : 'Save'}
                              </button>
                              <button
                                type="button"
                                onClick={() => { setEditPlayerId(null); setEditPlayerError(''); }}
                                className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
                              >
                                Cancel
                              </button>
                            </div>
                          </form>
                        </td>
                      ) : (
                        <>
                          <td className="px-4 py-3 font-medium">{player.name}</td>
                          <td className="px-4 py-3 text-center tabular-nums">{player.gamesPlayed}</td>
                          <td className="px-4 py-3 text-center tabular-nums">{player.goalsScored}</td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex justify-end gap-2">
                              <button
                                onClick={() => {
                                  setEditPlayerId(player.id);
                                  setEditPlayerName(player.name);
                                  setEditPlayerGamesPlayed(String(player.gamesPlayed));
                                  setEditPlayerGoalsScored(String(player.goalsScored));
                                  setEditPlayerError('');
                                }}
                                className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => deletePlayerMutation.mutate(player.id)}
                                disabled={deletePlayerMutation.isPending}
                                className="rounded-md border px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {activeTab === 'group' && <>

      {/* Teams */}
      <section className="mb-8">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setTeamsOpen(o => !(o ?? (tournament.status === 'upcoming')))}
            className="flex items-center gap-1.5 text-left"
          >
            <h2 className="text-lg font-semibold">{t('tournamentDetail.teams')} ({teams.length})</h2>
            <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-200${teamsIsOpen ? ' rotate-180' : ''}`} />
          </button>
          {canEditTeams && (
            <div className="ml-auto flex gap-2">
              {!showAddGroup && (
                <button
                  onClick={() => setShowAddGroup(true)}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                >
                  {t('tournamentDetail.addGroup')}
                </button>
              )}
              {!showAddTeam && (
                <button
                  onClick={() => setShowAddTeam(true)}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                >
                  {t('tournamentDetail.addTeam')}
                </button>
              )}
            </div>
          )}
        </div>

        {teamsIsOpen && (
          <>
            {/* Add Group form */}
            {canEditTeams && showAddGroup && (
              <form onSubmit={handleAddGroup} className="mb-4 rounded-lg border p-4">
                <div className="mb-3 flex gap-2">
                  <input
                    type="text"
                    placeholder={t('tournamentDetail.groupNamePlaceholder')}
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
                    {addGroupMutation.isPending ? t('tournamentDetail.addingGroup') : t('tournamentDetail.addGroupBtn')}
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
            {canEditTeams && showAddTeam && (
              <form onSubmit={handleAddTeam} className="mb-4 rounded-lg border p-4">
                <div className="mb-3 flex gap-2">
                  <input
                    type="text"
                    placeholder={t('tournamentDetail.teamNamePlaceholder')}
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
                    <option value="">{t('tournamentDetail.uncategorized')}</option>
                    {groupList.map(g => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                </div>
                <div className="mb-3">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">{t('tournamentDetail.teamIcon')}</p>
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
                    {addTeamMutation.isPending ? t('tournamentDetail.addingTeam') : t('tournamentDetail.addTeamBtn')}
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
              <p className="text-sm text-muted-foreground">{t('tournamentDetail.noTeams')}</p>
            ) : canEditTeams ? (
              /* Drag-and-drop board for admins when tournament is upcoming */
              <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
                <div className="flex flex-wrap gap-3">
                  <DroppableZone
                    id="uncategorized"
                    label={t('tournamentDetail.uncategorized')}
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
              /* Read-only list when tournament is active/completed, or for non-admins */
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
          </>
        )}
      </section>

      {/* Matches */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{t('tournamentDetail.matches')} ({groupStageMatches.length})</h2>
          {isAdmin && (
            <div className="flex flex-wrap gap-2">
              <button
                  onClick={() => confirmResultsMutation.mutate()}
                  disabled={confirmResultsMutation.isPending || Object.keys(pendingResults).length === 0}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {confirmResultsMutation.isPending
                    ? t('tournamentDetail.confirming')
                    : t('tournamentDetail.confirmResults', { n: Object.keys(pendingResults).length })}
                </button>
              {matchList.some(m => m.stage === 'group') && (
                <>
                  <button
                    onClick={simulateGroupStage}
                    className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                  >
                    {t('tournamentDetail.simulateGroupStage')}
                  </button>
                  <button
                    onClick={() => clearGroupStageMutation.mutate()}
                    disabled={clearGroupStageMutation.isPending}
                    className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                  >
                    {clearGroupStageMutation.isPending ? t('tournamentDetail.clearing') : t('tournamentDetail.clearGroupStage')}
                  </button>
                </>
              )}
              {addMatchForDate === null && (
                <button
                  onClick={() => openAddMatch()}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                >
                  {t('tournamentDetail.addMatch')}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Top-level add match form */}
        {isAdmin && addMatchForDate === '' && renderAddMatchForm()}

        {matchList.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('tournamentDetail.noMatches')}</p>
        ) : (
          <div className="space-y-4">

            {/* Upcoming Games */}
            <div>
              <button
                type="button"
                onClick={() => setUpcomingGamesOpen(o => !o)}
                className="mb-2 flex w-full items-center justify-between rounded-md px-1 py-1 text-left hover:bg-muted/50"
              >
                <span className="text-base font-semibold">Upcoming Games ({upcomingSortedMatches.length})</span>
                <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-200${upcomingGamesOpen ? ' rotate-180' : ''}`} />
              </button>
              {upcomingGamesOpen && (
                <div className="space-y-6">
                  {upcomingMatchGroups.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No upcoming games.</p>
                  ) : (
                    upcomingMatchGroups.map(({ dateLabel, isoDate, matches }) => (
                      <div key={isoDate}>
                        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{dateLabel}</h3>
                        <div className="space-y-2">
                          {matches.map(match => (
                            <div key={match.id} className="rounded-lg border p-4">
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
                                      {t('tournamentDetail.final')}
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
                                  {isAdmin && tournament?.status === 'upcoming' && match.stage === 'group' && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (confirm('Delete this match?')) deleteMatchMutation.mutate(match.id);
                                      }}
                                      disabled={deleteMatchMutation.isPending}
                                      className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                                      title="Delete match"
                                    >
                                      <Trash2 size={13} />
                                    </button>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                  <TeamBadge name={tn(match.homeTeamName)} imageUrl={match.homeTeamImageUrl} />
                                  {pendingResults[match.id] ? (
                                    <span className="rounded bg-amber-100 dark:bg-amber-900/30 px-2 py-0.5 text-sm font-bold tabular-nums text-amber-800 dark:text-amber-200">
                                      {pendingResults[match.id].home} – {pendingResults[match.id].away}
                                    </span>
                                  ) : match.status === 'completed' ? (
                                    <span className="rounded bg-muted px-2 py-0.5 text-sm font-bold tabular-nums">
                                      {match.homeScore} – {match.awayScore}
                                    </span>
                                  ) : (
                                    <span className="text-sm text-muted-foreground">vs</span>
                                  )}
                                  <TeamBadge name={tn(match.awayTeamName)} imageUrl={match.awayTeamImageUrl} />
                                </div>
                                {isAdmin && scoreMatchId !== match.id && (
                                  <div className="flex items-center gap-1.5">
                                    {pendingResults[match.id] ? (
                                      <>
                                        <button
                                          onClick={() => openScoreForm(match.id)}
                                          className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted"
                                        >
                                          Edit
                                        </button>
                                        <button
                                          onClick={() => removePendingResult(match.id)}
                                          className="rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                                          title="Remove staged result"
                                        >
                                          ×
                                        </button>
                                      </>
                                    ) : match.status === 'scheduled' ? (
                                      <button
                                        onClick={() => openScoreForm(match.id)}
                                        className="rounded-md border px-3 py-1 text-xs hover:bg-muted"
                                      >
                                        {t('tournamentDetail.enterScore')}
                                      </button>
                                    ) : null}
                                  </div>
                                )}
                              </div>
                              {scoreMatchId === match.id && (
                                <div className="mt-3 flex flex-wrap items-center gap-2">
                                  <input
                                    type="number"
                                    min="0"
                                    value={homeScore}
                                    onChange={e => {
                                      const val = e.target.value;
                                      setHomeScore(val);
                                      autoStageScore(match.id, val, awayScore);
                                    }}
                                    className="w-14 rounded-md border px-2 py-1.5 text-center text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                                    placeholder="0"
                                    autoFocus
                                  />
                                  <span className="text-sm font-medium">–</span>
                                  <input
                                    type="number"
                                    min="0"
                                    value={awayScore}
                                    onChange={e => {
                                      const val = e.target.value;
                                      setAwayScore(val);
                                      autoStageScore(match.id, homeScore, val);
                                    }}
                                    className="w-14 rounded-md border px-2 py-1.5 text-center text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                                    placeholder="0"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => setScoreMatchId(null)}
                                    className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              )}
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
                                          <option value="">{t('tournamentDetail.matchForm.allGroups')}</option>
                                          {groupList.map(g => (
                                            <option key={g.id} value={g.id}>{g.name}</option>
                                          ))}
                                        </select>
                                      </div>
                                    )}
                                    <div>
                                      <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('tournamentDetail.matchForm.homeTeam')}</label>
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
                                      <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('tournamentDetail.matchForm.awayTeam')}</label>
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
                                      {editMatchMutation.isPending ? t('tournamentDetail.matchForm.saving') : t('tournamentDetail.matchForm.saveChanges')}
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
                        {isAdmin && isoDate !== '__none__' && (
                          addMatchForDate === isoDate
                            ? renderAddMatchForm()
                            : (
                              <button
                                type="button"
                                onClick={() => openAddMatch(isoDate)}
                                className="mt-2 w-full rounded-md border border-dashed px-3 py-1.5 text-xs text-muted-foreground hover:border-solid hover:bg-muted hover:text-foreground"
                              >
                                {t('tournamentDetail.addMatchOnDay')}
                              </button>
                            )
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Completed Games */}
            <div>
              <button
                type="button"
                onClick={() => setCompletedGamesOpen(o => !o)}
                className="mb-2 flex w-full items-center justify-between rounded-md px-1 py-1 text-left hover:bg-muted/50"
              >
                <span className="text-base font-semibold">Completed Games ({completedSortedMatches.length})</span>
                <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-200${completedGamesOpen ? ' rotate-180' : ''}`} />
              </button>
              {completedGamesOpen && (
                <div className="space-y-6">
                  {completedMatchGroups.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No completed games.</p>
                  ) : (
                    completedMatchGroups.map(({ dateLabel, isoDate, matches }) => (
                      <div key={isoDate}>
                        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{dateLabel}</h3>
                        <div className="space-y-2">
                          {matches.map(match => (
                            <div key={match.id} className="rounded-lg border p-4">
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
                                      {t('tournamentDetail.final')}
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
                                  {isAdmin && tournament?.status === 'upcoming' && match.stage === 'group' && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (confirm('Delete this match?')) deleteMatchMutation.mutate(match.id);
                                      }}
                                      disabled={deleteMatchMutation.isPending}
                                      className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                                      title="Delete match"
                                    >
                                      <Trash2 size={13} />
                                    </button>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                  <TeamBadge name={tn(match.homeTeamName)} imageUrl={match.homeTeamImageUrl} />
                                  {pendingResults[match.id] ? (
                                    <span className="rounded bg-amber-100 dark:bg-amber-900/30 px-2 py-0.5 text-sm font-bold tabular-nums text-amber-800 dark:text-amber-200">
                                      {pendingResults[match.id].home} – {pendingResults[match.id].away}
                                    </span>
                                  ) : match.status === 'completed' ? (
                                    <span className="rounded bg-muted px-2 py-0.5 text-sm font-bold tabular-nums">
                                      {match.homeScore} – {match.awayScore}
                                    </span>
                                  ) : (
                                    <span className="text-sm text-muted-foreground">vs</span>
                                  )}
                                  <TeamBadge name={tn(match.awayTeamName)} imageUrl={match.awayTeamImageUrl} />
                                </div>
                                {isAdmin && scoreMatchId !== match.id && (
                                  <div className="flex items-center gap-1.5">
                                    {pendingResults[match.id] ? (
                                      <>
                                        <button
                                          onClick={() => openScoreForm(match.id)}
                                          className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted"
                                        >
                                          Edit
                                        </button>
                                        <button
                                          onClick={() => removePendingResult(match.id)}
                                          className="rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                                          title="Remove staged result"
                                        >
                                          ×
                                        </button>
                                      </>
                                    ) : match.status === 'scheduled' ? (
                                      <button
                                        onClick={() => openScoreForm(match.id)}
                                        className="rounded-md border px-3 py-1 text-xs hover:bg-muted"
                                      >
                                        {t('tournamentDetail.enterScore')}
                                      </button>
                                    ) : null}
                                  </div>
                                )}
                              </div>
                              {scoreMatchId === match.id && (
                                <div className="mt-3 flex flex-wrap items-center gap-2">
                                  <input
                                    type="number"
                                    min="0"
                                    value={homeScore}
                                    onChange={e => {
                                      const val = e.target.value;
                                      setHomeScore(val);
                                      autoStageScore(match.id, val, awayScore);
                                    }}
                                    className="w-14 rounded-md border px-2 py-1.5 text-center text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                                    placeholder="0"
                                    autoFocus
                                  />
                                  <span className="text-sm font-medium">–</span>
                                  <input
                                    type="number"
                                    min="0"
                                    value={awayScore}
                                    onChange={e => {
                                      const val = e.target.value;
                                      setAwayScore(val);
                                      autoStageScore(match.id, homeScore, val);
                                    }}
                                    className="w-14 rounded-md border px-2 py-1.5 text-center text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                                    placeholder="0"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => setScoreMatchId(null)}
                                    className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              )}
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
                                          <option value="">{t('tournamentDetail.matchForm.allGroups')}</option>
                                          {groupList.map(g => (
                                            <option key={g.id} value={g.id}>{g.name}</option>
                                          ))}
                                        </select>
                                      </div>
                                    )}
                                    <div>
                                      <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('tournamentDetail.matchForm.homeTeam')}</label>
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
                                      <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('tournamentDetail.matchForm.awayTeam')}</label>
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
                                      {editMatchMutation.isPending ? t('tournamentDetail.matchForm.saving') : t('tournamentDetail.matchForm.saveChanges')}
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
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

          </div>
        )}
      </section>
      </>}
    </main>
  );
}
