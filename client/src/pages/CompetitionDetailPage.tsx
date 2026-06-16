import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import ImageUpload from '@/components/ImageUpload';
import KnockoutStageContent from '@/components/KnockoutStageContent';
import PlayerPodium from '@/components/PlayerPodium';
import { SoccerKickAnimation } from '@/components/SoccerKickAnimation';
import { CryingPlayerAnimation } from '@/components/CryingPlayerAnimation';
import BonusQuestionsTab from './BonusQuestionsTab';
import { useT } from '@/lib/useT';
import type { Competition, Tournament, Prediction, MatchStage, LeaderboardEntry, BracketPredictions } from '@tournament-predictor/shared';
import {
  sortGroupTeams,
  sortLuckyLosers,
  findGroupDisciplinaryTies,
  findLuckyLoserDisciplinaryTies,
  makeDisciplinaryKey,
  type MatchResult,
  type DisciplinaryChoices,
} from '@/lib/tiebreakers';

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
  progressingTeamId: string | null;
}

interface MatchPredictionEntry {
  matchId: string;
  userId: string;
  username: string;
  imageUrl: string | null;
  homeScore: number;
  awayScore: number;
  progressingTeamId: string | null;
  points: number | null;
}

export default function CompetitionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { t } = useT();

  const [editName, setEditName] = useState('');
  const [editImageUrl, setEditImageUrl] = useState<string | null>(null);
  const [editDeadline, setEditDeadline] = useState('');
  const [showEdit, setShowEdit] = useState(false);
  const [editError, setEditError] = useState('');

  const [currentGroupMatchIdx, setCurrentGroupMatchIdx] = useState(0);

  const [localEdits, setLocalEdits] = useState<Record<string, { home: string; away: string }>>({});
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});

  const [activeTab, setActiveTab] = useState<'group' | 'tables' | 'knockout' | 'bonus' | 'leaderboard'>(
    () => {
      const u = useAuthStore.getState().user;
      return u?.isLeaderboardUser || u?.isAdmin ? 'leaderboard' : 'group';
    }
  );
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const [hasDeclined, setHasDeclined] = useState(false);
  const [showProceedPrompt, setShowProceedPrompt] = useState(false);
  const [showKnockoutCompletePrompt, setShowKnockoutCompletePrompt] = useState(false);
  const [hasDeclinedKnockout, setHasDeclinedKnockout] = useState(false);

  const [currentPredMatchIdx, setCurrentPredMatchIdx] = useState(0);
  const [matchPredictionsCollapsed, setMatchPredictionsCollapsed] = useState(false);

  const [groupDisciplinaryChoices, setGroupDisciplinaryChoices] = useState<DisciplinaryChoices>({});
  const [luckyLoserDisciplinaryChoices, setLuckyLoserDisciplinaryChoices] = useState<DisciplinaryChoices>({});

  const localEditsRef = useRef(localEdits);
  useEffect(() => { localEditsRef.current = localEdits; }, [localEdits]);

  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const firstGroupUnfilledRef = useRef(false);
  const groupFillInitializedRef = useRef(false);
  const lastResultFocusedRef = useRef(false);
  const predMatchInitializedRef = useRef(false);
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

  const { data: tournamentData } = useQuery({
    queryKey: ['tournament', competition?.tournamentId],
    queryFn: () => api.get<Tournament>(`/tournaments/${competition!.tournamentId}`),
    enabled: !!competition && !user?.isAdmin,
  });

  const { data: matchList = [] } = useQuery({
    queryKey: ['tournaments', competition?.tournamentId, 'matches'],
    queryFn: () => api.get<MatchWithTeams[]>(`/tournaments/${competition!.tournamentId}/matches`),
    enabled: !!competition && !user?.isAdmin,
  });

  const { data: savedPredictions = [], isFetched: predictionsFetched } = useQuery({
    queryKey: ['competitions', id, 'predictions'],
    queryFn: () => api.get<Prediction[]>(`/competitions/${id}/predictions`),
    enabled: !!competition && !user?.isAdmin && !user?.isLeaderboardUser,
  });

  const { data: savedTiebreakerChoices } = useQuery({
    queryKey: ['competitions', id, 'tiebreak-choices'],
    queryFn: () => api.get<{ groupChoices: DisciplinaryChoices; luckyLoserChoices: DisciplinaryChoices }>(`/competitions/${id}/tiebreak-choices`),
    enabled: !!competition && !user?.isAdmin && !user?.isLeaderboardUser,
  });

  const { data: myStatus } = useQuery({
    queryKey: ['competitions', id, 'my-status'],
    queryFn: () => api.get<{ groupStageLocked: boolean; knockoutCompleteSeen: boolean }>(`/competitions/${id}/my-status`),
    enabled: !!competition && !user?.isAdmin && !user?.isLeaderboardUser,
  });

  const { data: bracketPreds } = useQuery({
    queryKey: ['competitions', id, 'bracket-predictions'],
    queryFn: () => api.get<BracketPredictions>(`/competitions/${id}/bracket-predictions`),
    enabled: !!competition && !user?.isAdmin && !user?.isLeaderboardUser && (myStatus?.groupStageLocked ?? false),
  });

  const { data: leaderboard = [] } = useQuery({
    queryKey: ['competitions', id, 'leaderboard'],
    queryFn: () => api.get<LeaderboardEntry[]>(`/competitions/${id}/leaderboard`),
    enabled: !!competition && (activeTab === 'leaderboard' || (!user?.isAdmin && !!user?.isLeaderboardUser)),
  });

  const { data: allMatchPredictions = [] } = useQuery({
    queryKey: ['competitions', id, 'all-match-predictions'],
    queryFn: () => api.get<MatchPredictionEntry[]>(`/competitions/${id}/all-match-predictions`),
    enabled: !!competition && !user?.isAdmin && (activeTab === 'leaderboard' || !!user?.isLeaderboardUser),
  });

  useEffect(() => {
    if (!id || (activeTab !== 'leaderboard' && !user?.isLeaderboardUser)) return;
    const es = new EventSource(`/api/competitions/${id}/leaderboard/events`, { withCredentials: true });
    es.addEventListener('leaderboard-updated', () => {
      queryClient.invalidateQueries({ queryKey: ['competitions', id, 'leaderboard'] });
    });
    return () => es.close();
  }, [id, activeTab, user?.isAdmin, user?.isLeaderboardUser, queryClient]);

  const lockMutation = useMutation({
    mutationFn: () => api.post<{ groupStageLocked: boolean }>(`/competitions/${id}/lock-group-stage`, {}),
    onSuccess: () => {
      queryClient.setQueryData(['competitions', id, 'my-status'], { groupStageLocked: true });
    },
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

  useEffect(() => {
    if (savedTiebreakerChoices?.groupChoices) {
      setGroupDisciplinaryChoices(savedTiebreakerChoices.groupChoices);
    }
    if (savedTiebreakerChoices?.luckyLoserChoices) {
      setLuckyLoserDisciplinaryChoices(savedTiebreakerChoices.luckyLoserChoices);
    }
  }, [savedTiebreakerChoices]);

  const saveTiebreakerChoicesMutation = useMutation({
    mutationFn: (body: { groupChoices?: DisciplinaryChoices; luckyLoserChoices?: DisciplinaryChoices }) =>
      api.post(`/competitions/${id}/tiebreak-choices`, body),
    onSuccess: (_, variables) => {
      queryClient.setQueryData(
        ['competitions', id, 'tiebreak-choices'],
        (old: { groupChoices: DisciplinaryChoices; luckyLoserChoices: DisciplinaryChoices } | undefined) => ({
          groupChoices: variables.groupChoices ?? old?.groupChoices ?? {},
          luckyLoserChoices: variables.luckyLoserChoices ?? old?.luckyLoserChoices ?? {},
        })
      );
    },
  });

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

  const { groupStandings, effectiveGroupResults } = useMemo(() => {
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

    const groupResultsMap = new Map<string, MatchResult[]>();

    for (const m of groupMatches) {
      if (!m.homeTeamId || !m.awayTeamId || !m.groupName) continue;
      let hs: number | null = null;
      let as_: number | null = null;
      const edit = localEdits[m.id];
      if (edit) {
        const h = parseInt(edit.home, 10); const a = parseInt(edit.away, 10);
        if (!isNaN(h) && !isNaN(a) && h >= 0 && a >= 0) { hs = h; as_ = a; }
      } else {
        const pred = predMap[m.id];
        if (pred) { hs = pred.homeScore; as_ = pred.awayScore; }
      }
      if (hs === null || as_ === null) continue;
      const home = teamMap.get(m.homeTeamId);
      const away = teamMap.get(m.awayTeamId);
      if (home) { home.P++; home.GF += hs; home.GA += as_; if (hs > as_) home.W++; else if (hs === as_) home.D++; else home.L++; }
      if (away) { away.P++; away.GF += as_; away.GA += hs; if (as_ > hs) away.W++; else if (hs === as_) away.D++; else away.L++; }
      if (!groupResultsMap.has(m.groupName)) groupResultsMap.set(m.groupName, []);
      groupResultsMap.get(m.groupName)!.push({ homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId, homeScore: hs, awayScore: as_ });
    }

    const byGroup = new Map<string, TeamStat[]>();
    for (const tm of teamMap.values()) {
      if (!byGroup.has(tm.group)) byGroup.set(tm.group, []);
      byGroup.get(tm.group)!.push(tm);
    }

    for (const [groupName, teams] of byGroup) {
      const results = groupResultsMap.get(groupName) ?? [];
      const tiebreakerStats = teams.map(tm => ({ teamId: tm.teamId, points: tm.W * 3 + tm.D, gd: tm.GF - tm.GA, gf: tm.GF }));
      const sortedIds = sortGroupTeams(tiebreakerStats, results, groupDisciplinaryChoices).map(s => s.teamId);
      teams.sort((a, b) => sortedIds.indexOf(a.teamId) - sortedIds.indexOf(b.teamId));
    }

    return {
      groupStandings: [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b)),
      effectiveGroupResults: groupResultsMap,
    };
  }, [matchList, localEdits, predMap, groupDisciplinaryChoices]);

  // Actual standings from completed matches only — used to detect correct group position predictions
  const { actualGroupStandings, completedGroupMatchCounts } = useMemo(() => {
    const groupMatches = matchList.filter(m => m.stage === 'group');
    const teamMap = new Map<string, TeamStat>();
    const matchCounts = new Map<string, { total: number; completed: number }>();

    for (const m of groupMatches) {
      const g = m.groupName;
      if (!g) continue;
      if (m.homeTeamId && m.homeTeamName && !teamMap.has(m.homeTeamId))
        teamMap.set(m.homeTeamId, { teamId: m.homeTeamId, teamName: m.homeTeamName, imageUrl: m.homeTeamImageUrl, group: g, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0 });
      if (m.awayTeamId && m.awayTeamName && !teamMap.has(m.awayTeamId))
        teamMap.set(m.awayTeamId, { teamId: m.awayTeamId, teamName: m.awayTeamName, imageUrl: m.awayTeamImageUrl, group: g, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0 });
    }

    const groupResultsMap = new Map<string, MatchResult[]>();
    for (const m of groupMatches) {
      if (!m.homeTeamId || !m.awayTeamId || !m.groupName) continue;
      // Update counts only for matches with real teams assigned
      if (!matchCounts.has(m.groupName)) matchCounts.set(m.groupName, { total: 0, completed: 0 });
      const cnt2 = matchCounts.get(m.groupName)!;
      cnt2.total++;
      if (m.status === 'completed') cnt2.completed++;
      if (m.status !== 'completed' || m.homeScore === null || m.awayScore === null) continue;
      const hs = m.homeScore, as_ = m.awayScore;
      const home = teamMap.get(m.homeTeamId);
      const away = teamMap.get(m.awayTeamId);
      if (home) { home.P++; home.GF += hs; home.GA += as_; if (hs > as_) home.W++; else if (hs === as_) home.D++; else home.L++; }
      if (away) { away.P++; away.GF += as_; away.GA += hs; if (as_ > hs) away.W++; else if (hs === as_) away.D++; else away.L++; }
      if (!groupResultsMap.has(m.groupName)) groupResultsMap.set(m.groupName, []);
      groupResultsMap.get(m.groupName)!.push({ homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId, homeScore: hs, awayScore: as_ });
    }

    const byGroup = new Map<string, TeamStat[]>();
    for (const tm of teamMap.values()) {
      if (!byGroup.has(tm.group)) byGroup.set(tm.group, []);
      byGroup.get(tm.group)!.push(tm);
    }
    for (const [groupName, teams] of byGroup) {
      const results = groupResultsMap.get(groupName) ?? [];
      const stats = teams.map(tm => ({ teamId: tm.teamId, points: tm.W * 3 + tm.D, gd: tm.GF - tm.GA, gf: tm.GF }));
      const sortedIds = sortGroupTeams(stats, results, {}).map(s => s.teamId);
      teams.sort((a, b) => sortedIds.indexOf(a.teamId) - sortedIds.indexOf(b.teamId));
    }

    return { actualGroupStandings: byGroup, completedGroupMatchCounts: matchCounts };
  }, [matchList]);

  const qualifyingThirdPlaceIds = useMemo(() => {
    const third = groupStandings
      .filter(([, teams]) => teams.length >= 3)
      .map(([, teams]) => teams[2]);
    const tiebreakerStats = third.map(tm => ({ teamId: tm.teamId, points: tm.W * 3 + tm.D, gd: tm.GF - tm.GA, gf: tm.GF }));
    const sortedIds = sortLuckyLosers(tiebreakerStats, luckyLoserDisciplinaryChoices).map(s => s.teamId);
    const sortedThird = sortedIds.map(sid => third.find(tm => tm.teamId === sid)!).filter(Boolean);
    const qualifying = sortedThird.slice(0, 8);
    if (qualifying.length === 8 && sortedThird.length > 8) {
      const edge = qualifying[7];
      const edgePts = edge.W * 3 + edge.D; const edgeGD = edge.GF - edge.GA;
      for (const tm of sortedThird.slice(8)) {
        const pts = tm.W * 3 + tm.D; const gd = tm.GF - tm.GA;
        if (pts === edgePts && gd === edgeGD && tm.GF === edge.GF) qualifying.push(tm);
        else break;
      }
    }
    return new Set(qualifying.map(tm => tm.teamId));
  }, [groupStandings, luckyLoserDisciplinaryChoices]);

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
        dateLabel = t('common.noDate');
      }
      if (!indexByKey.has(dateKey)) {
        indexByKey.set(dateKey, groups.length);
        groups.push({ dateKey, dateLabel, matches: [] });
      }
      groups[indexByKey.get(dateKey)!].matches.push(m);
    }

    return groups;
  }, [matchList, t]);

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

  const allGroupMatchesList = useMemo(
    () => groupMatchesByDate.flatMap(g => g.matches),
    [groupMatchesByDate]
  );

  const groupFillCount = useMemo(() => {
    return allGroupMatchesList.filter(m => {
      if (m.status === 'completed') return true;
      const edit = localEdits[m.id];
      if (edit) {
        const h = parseInt(edit.home, 10);
        const a = parseInt(edit.away, 10);
        if (!isNaN(h) && !isNaN(a) && h >= 0 && a >= 0) return true;
      }
      return !!predMap[m.id];
    }).length;
  }, [allGroupMatchesList, localEdits, predMap]);

  const completedMatchesWithResults = useMemo(
    () => [...matchList]
      .filter(m => m.status === 'completed' && m.homeScore !== null && m.awayScore !== null)
      .sort((a, b) => {
        if (!a.scheduledAt && !b.scheduledAt) return 0;
        if (!a.scheduledAt) return 1;
        if (!b.scheduledAt) return -1;
        return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
      }),
    [matchList]
  );

  useEffect(() => {
    if (!predMatchInitializedRef.current && completedMatchesWithResults.length > 0) {
      predMatchInitializedRef.current = true;
      setCurrentPredMatchIdx(completedMatchesWithResults.length - 1);
    }
  }, [completedMatchesWithResults]);

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

  const tournament = useMemo(
    () => user?.isAdmin
      ? tournamentsData.find(tm => tm.id === competition?.tournamentId)
      : tournamentData,
    [user?.isAdmin, tournamentsData, tournamentData, competition?.tournamentId]
  );

  const groupDisciplinaryTies = useMemo(() => {
    const directQualifiers = tournament?.knockoutConfig?.directQualifiers ?? 2;
    const result: Array<{ groupName: string; teams: TeamStat[]; key: string; requiredRankings: number }> = [];
    for (const [groupName, teams] of groupStandings) {
      const results = effectiveGroupResults.get(groupName) ?? [];
      const tiebreakerStats = teams.map(tm => ({ teamId: tm.teamId, points: tm.W * 3 + tm.D, gd: tm.GF - tm.GA, gf: tm.GF }));
      const tiedGroups = findGroupDisciplinaryTies(tiebreakerStats, results);
      for (const tiedGroup of tiedGroups) {
        const key = makeDisciplinaryKey(tiedGroup.map(tm => tm.teamId));
        const existing = groupDisciplinaryChoices[key] ?? [];
        if (existing.length < tiedGroup.length) {
          const startIndex = Math.min(...tiedGroup.map(tm => teams.findIndex(tt => tt.teamId === tm.teamId)));
          const K = Math.max(1, Math.min(directQualifiers, startIndex + tiedGroup.length) - startIndex);
          const requiredRankings = Math.min(K, tiedGroup.length - 1);
          result.push({ groupName, teams: tiedGroup.map(s => teams.find(tm => tm.teamId === s.teamId)!).filter(Boolean), key, requiredRankings });
        }
      }
    }
    return result;
  }, [groupStandings, effectiveGroupResults, groupDisciplinaryChoices, tournament]);

  const luckyLoserDisciplinaryTies = useMemo(() => {
    if (!tournament?.knockoutConfig) return [];
    const { directQualifiers } = tournament.knockoutConfig;
    const third = groupStandings
      .filter(([, tms]) => tms.length > directQualifiers)
      .map(([, tms]) => tms[directQualifiers]);
    const tiebreakerStats = third.map(tm => ({ teamId: tm.teamId, points: tm.W * 3 + tm.D, gd: tm.GF - tm.GA, gf: tm.GF }));
    return findLuckyLoserDisciplinaryTies(tiebreakerStats)
      .filter(group => {
        const key = makeDisciplinaryKey(group.map(tm => tm.teamId));
        return (luckyLoserDisciplinaryChoices[key] ?? []).length < group.length;
      })
      .map(group => ({
        key: makeDisciplinaryKey(group.map(tm => tm.teamId)),
        teams: group.map(s => third.find(tm => tm.teamId === s.teamId)!).filter(Boolean),
      }));
  }, [groupStandings, tournament?.knockoutConfig, luckyLoserDisciplinaryChoices]);

  const tiebreakerChosenTeams = useMemo(() => {
    const s = new Set<string>();
    for (const ids of Object.values(groupDisciplinaryChoices)) {
      for (const id of ids) s.add(id);
    }
    return s;
  }, [groupDisciplinaryChoices]);

  const groupStageLocked = myStatus?.groupStageLocked ?? false;

  useEffect(() => {
    if (allGroupMatchesList.length === 0 || !predictionsFetched) return;

    if (!groupFillInitializedRef.current) {
      groupFillInitializedRef.current = true;
      if (allGroupFilled && !groupStageLocked) {
        setActiveTab('tables');
      }
      return;
    }

    if (!allGroupFilled) {
      setHasDeclined(false);
      setShowProceedPrompt(false);
      return;
    }

    if (!groupStageLocked && !hasDeclined && !showProceedPrompt) {
      const timer = setTimeout(() => {
        setShowProceedPrompt(true);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [allGroupMatchesList, allGroupFilled, localEdits, groupStageLocked, hasDeclined, showProceedPrompt, predictionsFetched]);

  useEffect(() => {
    if (firstGroupUnfilledRef.current || !savedPredictions.length) return;
    firstGroupUnfilledRef.current = true;
  }, [savedPredictions]);

  useEffect(() => {
    if (user?.isLeaderboardUser) setActiveTab('leaderboard');
  }, [user?.isLeaderboardUser]);

  useEffect(() => {
    if (lastResultFocusedRef.current || allGroupMatchesList.length === 0) return;
    const lastCompletedIdx = allGroupMatchesList.reduce(
      (acc, m, i) => (m.status === 'completed' ? i : acc),
      -1
    );
    if (lastCompletedIdx >= 0) {
      setCurrentGroupMatchIdx(lastCompletedIdx);
      lastResultFocusedRef.current = true;
    }
  }, [allGroupMatchesList]);

  const deadlinePassed =
    (competition?.predictionDeadline ? new Date() > new Date(competition.predictionDeadline) : false)
    || tournament?.status === 'active'
    || tournament?.status === 'completed';

  const hasKnockoutPredictions = Object.keys(bracketPreds ?? {}).length > 0;
  const isLocked = deadlinePassed || (groupStageLocked && hasKnockoutPredictions);

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
        [matchId]: err instanceof ApiError ? err.message : t('common.failedToSave'),
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

  function handleProceedToKnockout() {
    lockMutation.mutate(undefined, {
      onSuccess: () => setActiveTab('knockout'),
    });
  }

  function handleDeclineProceed() {
    setHasDeclined(true);
    setShowProceedPrompt(false);
  }

  const clearPredictionsMutation = useMutation({
    mutationFn: () => api.delete(`/competitions/${id}/predictions`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['competitions', id, 'predictions'] });
      queryClient.invalidateQueries({ queryKey: ['competitions', id, 'bracket-predictions'] });
      queryClient.invalidateQueries({ queryKey: ['competitions', id, 'tiebreak-choices'] });
      queryClient.invalidateQueries({ queryKey: ['competitions', id, 'my-status'] });
      setLocalEdits({});
      setGroupDisciplinaryChoices({});
      setLuckyLoserDisciplinaryChoices({});
      setCurrentGroupMatchIdx(0);
      setShowClearConfirm(false);
    },
  });

  useEffect(() => {
    if (myStatus?.knockoutCompleteSeen) setHasDeclinedKnockout(true);
  }, [myStatus]);

  const acknowledgeKnockoutMutation = useMutation({
    mutationFn: () => api.post(`/competitions/${id}/acknowledge-knockout`, {}),
  });

  const leaveMutation = useMutation({
    mutationFn: () => api.delete(`/competitions/${id}/leave`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['competitions'] });
      navigate('/');
    },
  });

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
      setEditError(err instanceof ApiError ? err.message : t('competitionDetail.failedToUpdate'));
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

  function handleDisciplinaryChoice(
    choices: DisciplinaryChoices,
    setChoices: (c: DisciplinaryChoices) => void,
    key: string,
    teamId: string,
  ) {
    const ranking = [...(choices[key] ?? [])];
    const idx = ranking.indexOf(teamId);
    if (idx !== -1) {
      ranking.splice(idx, 1);
    } else {
      ranking.push(teamId);
    }
    setChoices({ ...choices, [key]: ranking });
  }

  function confirmGroupTiebreaker(key: string, allTeamIds: string[]) {
    const ranked = groupDisciplinaryChoices[key] ?? [];
    const remaining = allTeamIds.filter(tid => !ranked.includes(tid)).sort();
    const next = { ...groupDisciplinaryChoices, [key]: [...ranked, ...remaining] };
    setGroupDisciplinaryChoices(next);
    saveTiebreakerChoicesMutation.mutate({ groupChoices: next });
  }

  function confirmLuckyLoserTiebreaker(key: string, allTeamIds: string[]) {
    const ranked = luckyLoserDisciplinaryChoices[key] ?? [];
    const remaining = allTeamIds.filter(tid => !ranked.includes(tid)).sort();
    const next = { ...luckyLoserDisciplinaryChoices, [key]: [...ranked, ...remaining] };
    setLuckyLoserDisciplinaryChoices(next);
    saveTiebreakerChoicesMutation.mutate({ luckyLoserChoices: next });
  }

  const stageLabel = (stage: MatchStage, groupName?: string | null) => {
    if (stage === 'group' && groupName) return `Group ${groupName}`;
    const map: Record<MatchStage, string> = {
      group: t('stages.group'),
      round_of_32: t('stages.round_of_32'),
      round_of_16: t('stages.round_of_16'),
      quarter_final: t('stages.quarter_final'),
      semi_final: t('stages.semi_final'),
      bronze_final: t('stages.bronze_final'),
      final: t('stages.final'),
    };
    return map[stage];
  };

  if (isLoading) return <p className="p-8 text-sm text-muted-foreground">{t('common.loading')}</p>;
  if (error) {
    const msg = error instanceof ApiError ? error.message : t('competitionDetail.failedToLoad');
    return <p className="p-8 text-sm text-destructive">{msg}</p>;
  }
  if (!competition) return null;

  return (
    <main className={`mx-auto px-4 py-12 ${
      user?.isLeaderboardUser
        ? 'max-w-2xl md:max-w-4xl lg:max-w-6xl tv:max-w-none tv:px-16'
        : activeTab === 'leaderboard'
          ? 'max-w-2xl md:max-w-4xl lg:max-w-6xl'
          : 'max-w-2xl'
    }`}>
      <div>
      {!user?.isLeaderboardUser && (
        <div className="mb-2 text-sm text-muted-foreground">
          <Link to={user?.isAdmin ? '/competitions' : '/'} className="hover:underline">
            {user?.isAdmin ? t('competitionDetail.backToCompetitions') : t('competitionDetail.backToHome')}
          </Link>
        </div>
      )}

      {/* Header */}
      {user?.isLeaderboardUser ? (
        <div className="mb-4 flex items-center gap-3 tv:hidden">
          {competition.imageUrl && (
            <img
              src={competition.imageUrl}
              alt={competition.name}
              className="h-10 w-10 rounded-lg object-cover flex-shrink-0"
            />
          )}
          <div>
            <h1 className="text-xl font-bold leading-tight">{competition.name}</h1>
            {tournament && <p className="text-sm text-muted-foreground">{tournament.name}</p>}
          </div>
        </div>
      ) : (
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
                {!user?.isAdmin && (
                  <p className="mt-1 text-xs text-muted-foreground font-mono tracking-wider">
                    {t('competitionDetail.inviteCodeLabel')}: {competition.inviteCode}
                  </p>
                )}
              </div>
              {user?.isAdmin && !showEdit && (
                <button
                  onClick={openEdit}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted flex-shrink-0"
                >
                  {t('common.edit')}
                </button>
              )}
              {!user?.isAdmin && (
                <button
                  onClick={() => setShowLeaveConfirm(true)}
                  className="rounded-md border px-3 py-1.5 text-sm flex-shrink-0 text-destructive border-destructive/30 hover:bg-destructive/5"
                >
                  {t('competitionDetail.leave')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Admin: invite code */}
      {user?.isAdmin && (
        <div className="mb-8 rounded-lg border bg-muted/30 p-4">
          <p className="text-sm font-medium">{t('competitionDetail.inviteCode')}</p>
          <p className="mt-1 font-mono text-3xl font-bold tracking-widest">{competition.inviteCode}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('competitionDetail.shareCode')}</p>
        </div>
      )}

      {/* Admin: edit form */}
      {showEdit && (
        <form onSubmit={handleUpdate} className="mb-8 rounded-lg border p-5 space-y-4">
          <h2 className="font-semibold">{t('competitionDetail.editCompetition')}</h2>
          <div>
            <label className="mb-1 block text-sm font-medium">{t('common.name')}</label>
            <input
              type="text"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">
              {t('competitions.logo')} <span className="text-muted-foreground">{t('common.optional')}</span>
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
              {t('competitions.predictionDeadline')} <span className="text-muted-foreground">{t('common.optional')}</span>
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
              {updateMutation.isPending ? t('common.saving') : t('common.save')}
            </button>
            <button
              type="button"
              onClick={() => { setShowEdit(false); setEditError(''); }}
              className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
            >
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}

      {user?.isAdmin && (
        <div className="flex flex-wrap gap-1 mb-6 border-b">
          <button
            onClick={() => setActiveTab('leaderboard')}
            className={`whitespace-nowrap px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === 'leaderboard' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t('competitionDetail.tabs.leaderboard')}
          </button>
        </div>
      )}

      {!user?.isAdmin && (<>
      {!user?.isLeaderboardUser && (
      <div className="flex flex-wrap gap-1 mb-6 border-b">
        {([
          ['group', t('competitionDetail.tabs.groupStage')],
          ['tables', t('competitionDetail.tabs.groupTables')],
          ['knockout', t('competitionDetail.tabs.knockoutStage')],
          ['bonus', t('competitionDetail.tabs.bonusQuestions')],
          ['leaderboard', t('competitionDetail.tabs.leaderboard')],
        ] as const).map(([tab, label]) => (
          <button
            key={tab}
            onClick={() => {
              setActiveTab(tab);
              if (tab === 'group') {
                setShowProceedPrompt(false);
                if (allGroupFilled) setHasDeclined(true);
              }
            }}
            className={`whitespace-nowrap px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === tab
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      )}

      {activeTab === 'tables' && (
        <div>
          {groupStandings.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('competitionDetail.noGroupMatches')}</p>
          ) : (
            <div className="space-y-6">
              {!allGroupFilled && scheduledGroupMatches.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  {t('competitionDetail.tables.predictionsFilled', { filled: groupFillCount, total: allGroupMatchesList.length })}
                </p>
              )}

              <div className="grid gap-6 sm:grid-cols-2">
                {groupStandings.map(([groupName, teams]) => {
                  const groupTies = allGroupFilled
                    ? groupDisciplinaryTies.filter(tie => tie.groupName === groupName)
                    : [];
                  return (
                    <div key={groupName} className="space-y-3">
                      <div className="rounded-lg border dark:bg-white/5 p-2">
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
                              <th className="py-1.5 text-center w-8 font-bold text-foreground">Pts</th>
                              <th className="pr-3 py-1.5 w-12" />
                            </tr>
                          </thead>
                          <tbody className="divide-y">
                            {teams.map((tm, i) => {
                              const counts = completedGroupMatchCounts.get(groupName);
                              const groupComplete = counts && counts.total > 0 && counts.completed === counts.total;
                              const actualTeams = actualGroupStandings.get(groupName) ?? [];
                              const positionCorrect = groupComplete && actualTeams[i]?.teamId === tm.teamId;
                              return (
                              <tr key={tm.teamId} className={
                                i < 2
                                  ? 'bg-green-50 dark:bg-green-950/30'
                                  : i === 2 && qualifyingThirdPlaceIds.has(tm.teamId)
                                  ? 'bg-yellow-50 dark:bg-yellow-950/30'
                                  : ''
                              }>
                                <td className="pl-3 py-1.5 text-muted-foreground">{i + 1}</td>
                                <td className="py-1.5 pr-2">
                                  <div className="flex items-center gap-1.5">
                                    {tm.imageUrl ? (
                                      <img src={tm.imageUrl} alt="" className="h-4 w-4 rounded-full object-cover flex-shrink-0" />
                                    ) : (
                                      <div className="h-4 w-4 rounded-full bg-muted flex-shrink-0" />
                                    )}
                                    <span className="truncate">{tm.teamName}</span>
                                    {tiebreakerChosenTeams.has(tm.teamId) && (
                                      <span className="text-amber-600 dark:text-amber-400 font-bold flex-shrink-0">✓</span>
                                    )}
                                  </div>
                                </td>
                                <td className="py-1.5 text-center text-muted-foreground">{tm.P}</td>
                                <td className="py-1.5 text-center text-muted-foreground">{tm.W}</td>
                                <td className="py-1.5 text-center text-muted-foreground">{tm.D}</td>
                                <td className="py-1.5 text-center text-muted-foreground">{tm.L}</td>
                                <td className="py-1.5 text-center text-muted-foreground">{tm.GF}</td>
                                <td className="py-1.5 text-center text-muted-foreground">{tm.GA}</td>
                                <td className="py-1.5 text-center font-bold">{tm.W * 3 + tm.D}</td>
                                <td className="pr-3 py-1.5 text-right">
                                  {positionCorrect && (
                                    <span className="text-green-600 dark:text-green-400 font-semibold whitespace-nowrap">
                                      +{competition.scoringConfig.correct_group_position}
                                    </span>
                                  )}
                                </td>
                              </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      {groupTies.map(tie => {
                        const ranked = groupDisciplinaryChoices[tie.key] ?? [];
                        const enoughRanked = ranked.length >= tie.requiredRankings;
                        return (
                          <div key={tie.key} className="rounded-lg border border-amber-400/40 bg-amber-50/10 p-3 text-xs">
                            <p className="font-semibold text-amber-700 dark:text-amber-400 mb-1">
                              {t('competitionDetail.tables.disciplinaryTiebreaker')}
                            </p>
                            <p className="text-muted-foreground mb-2">
                              {enoughRanked
                                ? `${t('competitionDetail.tables.selected')}: ${ranked.slice(0, tie.requiredRankings).map(tid => tie.teams.find(tm => tm.teamId === tid)?.teamName).join(' › ')}`
                                : t('competitionDetail.tables.selectTeams', { n: tie.requiredRankings, s: tie.requiredRankings > 1 ? 's' : '' })}
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                              {tie.teams.map(tm => {
                                const rank = ranked.indexOf(tm.teamId);
                                const isRanked = rank !== -1;
                                const isLockedBtn = !isRanked && enoughRanked;
                                return (
                                  <button
                                    key={tm.teamId}
                                    onClick={() => !isLockedBtn && handleDisciplinaryChoice(groupDisciplinaryChoices, setGroupDisciplinaryChoices, tie.key, tm.teamId)}
                                    disabled={isLockedBtn}
                                    className={`flex items-center gap-1 rounded border px-2 py-1 transition-colors ${isRanked ? 'border-amber-500 bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300' : isLockedBtn ? 'border-border opacity-30 cursor-not-allowed' : 'border-border hover:border-amber-400 hover:bg-amber-50/20'}`}
                                  >
                                    {isRanked && <span className="font-bold text-amber-600 dark:text-amber-400">{rank + 1}.</span>}
                                    {tm.imageUrl && <img src={tm.imageUrl} alt="" className="h-3.5 w-3.5 rounded-sm" />}
                                    {tm.teamName}
                                  </button>
                                );
                              })}
                              {enoughRanked && (
                                <button
                                  onClick={() => confirmGroupTiebreaker(tie.key, tie.teams.map(tm => tm.teamId))}
                                  className="rounded border border-green-500/50 bg-green-50/20 px-2 py-1 font-medium text-green-700 dark:text-green-400 hover:bg-green-50/40 transition-colors"
                                >
                                  {t('common.confirm')}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>

              {/* Legend */}
              <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm bg-green-500/70 inline-block" /> {t('competitionDetail.tables.qualifying')}
                </span>
                {(tournament?.knockoutConfig?.luckyLosers ?? 0) > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm bg-yellow-400/70 inline-block" /> {t('competitionDetail.tables.luckyLoser')}
                  </span>
                )}
                {tiebreakerChosenTeams.size > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="text-amber-600 dark:text-amber-400 font-bold">✓</span> {t('competitionDetail.tables.tiebreakerChosen')}
                  </span>
                )}
              </div>

              {/* Lucky loser tiebreakers */}
              {allGroupFilled && luckyLoserDisciplinaryTies.length > 0 && (
                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-semibold">{t('competitionDetail.tables.luckyLoserTiebreakers')}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t('competitionDetail.tables.luckyLoserTiebreakerDesc')}
                    </p>
                  </div>
                  {luckyLoserDisciplinaryTies.map(tie => {
                    const ranked = luckyLoserDisciplinaryChoices[tie.key] ?? [];
                    const requiredRankings = Math.max(1, tie.teams.length - 1);
                    const enoughRanked = ranked.length >= requiredRankings;
                    return (
                      <div key={tie.key} className="rounded-lg border border-amber-400/40 bg-amber-50/10 p-3 text-xs">
                        <p className="font-semibold text-amber-700 dark:text-amber-400 mb-1">
                          {t('competitionDetail.tables.disciplinaryTiebreakerLL')}
                        </p>
                        <p className="text-muted-foreground mb-2">
                          {enoughRanked
                            ? `${t('competitionDetail.tables.selected')}: ${ranked.slice(0, requiredRankings).map(tid => tie.teams.find(tm => tm.teamId === tid)?.teamName).join(' › ')}`
                            : t('competitionDetail.tables.selectTeams', { n: requiredRankings, s: requiredRankings > 1 ? 's' : '' })}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {tie.teams.map(tm => {
                            const rank = ranked.indexOf(tm.teamId);
                            const isRanked = rank !== -1;
                            const isLockedBtn = !isRanked && enoughRanked;
                            return (
                              <button
                                key={tm.teamId}
                                onClick={() => !isLockedBtn && handleDisciplinaryChoice(luckyLoserDisciplinaryChoices, setLuckyLoserDisciplinaryChoices, tie.key, tm.teamId)}
                                disabled={isLockedBtn}
                                className={`flex items-center gap-1 rounded border px-2 py-1 transition-colors ${isRanked ? 'border-amber-500 bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300' : isLockedBtn ? 'border-border opacity-30 cursor-not-allowed' : 'border-border hover:border-amber-400 hover:bg-amber-50/20'}`}
                              >
                                {isRanked && <span className="font-bold text-amber-600 dark:text-amber-400">{rank + 1}.</span>}
                                {tm.imageUrl && <img src={tm.imageUrl} alt="" className="h-3.5 w-3.5 rounded-sm" />}
                                {tm.teamName}
                              </button>
                            );
                          })}
                          {enoughRanked && (
                            <button
                              onClick={() => confirmLuckyLoserTiebreaker(tie.key, tie.teams.map(tm => tm.teamId))}
                              className="rounded border border-green-500/50 bg-green-50/20 px-2 py-1 font-medium text-green-700 dark:text-green-400 hover:bg-green-50/40 transition-colors"
                            >
                              {t('common.confirm')}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Proceed to knockout */}
              {allGroupFilled && !groupStageLocked && groupDisciplinaryTies.length === 0 && luckyLoserDisciplinaryTies.length === 0 && (
                <div className="pt-4 border-t">
                  <p className="text-sm text-muted-foreground mb-3">{t('competitionDetail.tables.allPredictionsIn')}</p>
                  <button
                    onClick={handleProceedToKnockout}
                    disabled={lockMutation.isPending}
                    className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {lockMutation.isPending ? t('competitionDetail.tables.locking') : t('competitionDetail.tables.proceedToKnockout')}
                  </button>
                  <p className="mt-1.5 text-xs text-muted-foreground">{t('competitionDetail.tables.lockNote')}</p>
                </div>
              )}
              {allGroupFilled && (groupDisciplinaryTies.length > 0 || luckyLoserDisciplinaryTies.length > 0) && (
                <p className="text-xs text-amber-600 dark:text-amber-400">{t('competitionDetail.tables.resolveTiebreakers')}</p>
              )}
              {groupStageLocked && (
                <div className="pt-4 border-t flex items-center gap-3">
                  <p className="text-sm text-muted-foreground">{t('competitionDetail.tables.groupStageLockedMsg')}</p>
                  <button
                    onClick={() => setActiveTab('knockout')}
                    className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                  >
                    {t('competitionDetail.tables.goToKnockout')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {activeTab === 'bonus' && competition.tournamentId && (
        <BonusQuestionsTab
          competitionId={id!}
          tournamentId={competition.tournamentId}
          deadlinePassed={deadlinePassed}
        />
      )}

      {activeTab === 'knockout' && id && (
        <KnockoutStageContent
          competitionId={id}
          onAllComplete={() => {
            if (!hasDeclinedKnockout) setShowKnockoutCompletePrompt(true);
          }}
          onGoToGroupStage={() => setActiveTab('group')}
        />
      )}

      {activeTab === 'group' && <>

      {/* Deadline banner */}
      {competition.predictionDeadline && (
        <div className={`mb-4 rounded-lg px-4 py-2.5 text-sm ${
          deadlinePassed
            ? 'bg-muted text-muted-foreground'
            : 'border border-amber-200 bg-amber-50 text-amber-800'
        }`}>
          {deadlinePassed
            ? `${t('competitionDetail.deadline.closed')} · ${new Date(competition.predictionDeadline).toLocaleString()}`
            : `${t('competitionDetail.deadline.openUntil')} ${new Date(competition.predictionDeadline).toLocaleString()}`}
        </div>
      )}

      {/* Group stage locked banner */}
      {groupStageLocked && hasKnockoutPredictions && (
        <div className="mb-4 rounded-lg bg-muted px-4 py-2.5 text-sm text-muted-foreground">
          {t('competitionDetail.groupStageLocked')}
        </div>
      )}

      {/* Predictions */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">{t('competitionDetail.predictions.title')}</h2>
          <div className="flex gap-2">
            {!isLocked && scheduledGroupMatches.length > 0 && (
              <button onClick={simulatePredictions} className="text-xs rounded border px-2.5 py-1 hover:bg-muted">
                {t('competitionDetail.predictions.simulate')}
              </button>
            )}
            {allGroupMatchesList.length > 0 && (
              <button
                onClick={() => setShowClearConfirm(true)}
                className="text-xs rounded border px-2.5 py-1 text-destructive border-destructive/30 hover:bg-destructive/5"
              >
                {t('competitionDetail.predictions.resetAll')}
              </button>
            )}
          </div>
        </div>

        {allGroupMatchesList.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('competitionDetail.predictions.noMatches')}</p>
        ) : (
          <>
            {/* Match dots */}
            <div className="mb-5">
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {allGroupMatchesList.map((m, idx) => {
                  const isCurrent = idx === currentGroupMatchIdx;
                  const isFilled = (() => {
                    if (m.status === 'completed') return true;
                    const edit = localEdits[m.id];
                    if (edit) {
                      const h = parseInt(edit.home, 10);
                      const a = parseInt(edit.away, 10);
                      if (!isNaN(h) && !isNaN(a) && h >= 0 && a >= 0) return true;
                    }
                    return !!predMap[m.id];
                  })();
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setCurrentGroupMatchIdx(idx)}
                      className={`rounded-full transition-all duration-200 ${
                        isCurrent
                          ? 'w-5 h-2.5 bg-primary'
                          : isFilled
                          ? 'w-2.5 h-2.5 bg-green-500'
                          : 'w-2.5 h-2.5 bg-muted-foreground/30 hover:bg-muted-foreground/50'
                      }`}
                      aria-label={`Match ${idx + 1}`}
                    />
                  );
                })}
              </div>
              {groupFillCount === allGroupMatchesList.length && (
                <p className="text-xs text-green-600 font-medium">{t('competitionDetail.predictions.allDone')}</p>
              )}
            </div>

            {/* Focused match card */}
            {(() => {
              const match = allGroupMatchesList[currentGroupMatchIdx];
              if (!match) return null;
              const pred = predMap[match.id];
              const edit = localEdits[match.id];
              const saving = savingIds.has(match.id);
              const justSaved = savedIds.has(match.id);
              const saveErr = saveErrors[match.id];
              const canGoPrev = currentGroupMatchIdx > 0;
              const canGoNext = currentGroupMatchIdx < allGroupMatchesList.length - 1;

              const hasActual = match.status === 'completed' && match.homeScore !== null && match.awayScore !== null;
              const isCorrectResult = hasActual && pred != null &&
                Math.sign(pred.homeScore - pred.awayScore) === Math.sign(match.homeScore! - match.awayScore!);
              const isExactScore = hasActual && pred != null &&
                pred.homeScore === match.homeScore && pred.awayScore === match.awayScore;

              return (
                <div className="rounded-xl border bg-muted/20 p-5">
                  <div className="text-center mb-4">
                    <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                      {stageLabel(match.stage, match.groupName)}
                    </p>
                    {match.scheduledAt && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {new Date(match.scheduledAt).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
                        {' · '}
                        {new Date(match.scheduledAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {currentGroupMatchIdx + 1} / {allGroupMatchesList.length}
                    </p>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setCurrentGroupMatchIdx(i => Math.max(0, i - 1))}
                      disabled={!canGoPrev}
                      className="hidden sm:flex flex-shrink-0 h-10 w-10 rounded-full border items-center justify-center transition-opacity disabled:opacity-20"
                      aria-label="Previous match"
                    >
                      ←
                    </button>

                    <div className="flex-1">
                      <div className={`rounded-xl border-2 shadow-sm overflow-hidden w-full max-w-xs mx-auto ${isCorrectResult ? 'border-green-400 bg-green-50/60 dark:bg-green-950/25' : 'bg-card'}`}>
                        {/* Home row */}
                        <div className="flex items-center gap-3 px-4 py-3.5">
                          {match.homeTeamImageUrl ? (
                            <img src={match.homeTeamImageUrl} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
                          ) : (
                            <div className="h-7 w-7 rounded-full bg-muted flex-shrink-0" />
                          )}
                          <span className="flex-1 text-sm font-medium truncate">{match.homeTeamName ?? 'TBD'}</span>
                          {match.status === 'completed' ? (
                            <span className={`w-11 h-9 flex items-center justify-center text-xl font-bold rounded-lg flex-shrink-0 ${isExactScore ? 'text-amber-500 dark:text-amber-400 border border-amber-400 bg-amber-50/70 dark:bg-amber-900/30' : ''}`}>{pred ? pred.homeScore : match.homeScore}</span>
                          ) : isLocked ? (
                            <span className="w-11 h-9 flex items-center justify-center text-xl text-muted-foreground flex-shrink-0">{pred ? pred.homeScore : '—'}</span>
                          ) : (
                            <div className="flex items-center gap-0.5 flex-shrink-0">
                              <button
                                type="button"
                                onClick={() => {
                                  const cur = parseInt(edit?.home ?? '0') || 0;
                                  const val = String(Math.max(0, cur - 1));
                                  setLocalEdits(prev => ({ ...prev, [match.id]: { home: val, away: prev[match.id]?.away ?? '' } }));
                                  scheduleAutoSave(match.id);
                                }}
                                className="h-10 w-10 flex items-center justify-center rounded-md border bg-muted hover:bg-muted/80 text-base font-bold select-none active:scale-95 transition-all"
                              >−</button>
                              <input
                                type="text"
                                inputMode="numeric"
                                value={edit?.home ?? ''}
                                onChange={e => {
                                  const val = e.target.value.replace(/\D/g, '').slice(0, 2);
                                  setLocalEdits(prev => ({ ...prev, [match.id]: { home: val, away: prev[match.id]?.away ?? '' } }));
                                  scheduleAutoSave(match.id);
                                }}
                                placeholder="–"
                                className="w-11 h-9 text-center text-xl font-bold rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-primary flex-shrink-0"
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  const cur = parseInt(edit?.home ?? '0') || 0;
                                  const val = String(Math.min(99, cur + 1));
                                  setLocalEdits(prev => ({ ...prev, [match.id]: { home: val, away: prev[match.id]?.away ?? '' } }));
                                  scheduleAutoSave(match.id);
                                }}
                                className="h-10 w-10 flex items-center justify-center rounded-md border bg-muted hover:bg-muted/80 text-base font-bold select-none active:scale-95 transition-all"
                              >+</button>
                            </div>
                          )}
                        </div>
                        <div className="h-px bg-border" />
                        {/* Away row */}
                        <div className="flex items-center gap-3 px-4 py-3.5">
                          {match.awayTeamImageUrl ? (
                            <img src={match.awayTeamImageUrl} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
                          ) : (
                            <div className="h-7 w-7 rounded-full bg-muted flex-shrink-0" />
                          )}
                          <span className="flex-1 text-sm font-medium truncate">{match.awayTeamName ?? 'TBD'}</span>
                          {match.status === 'completed' ? (
                            <span className={`w-11 h-9 flex items-center justify-center text-xl font-bold rounded-lg flex-shrink-0 ${isExactScore ? 'text-amber-500 dark:text-amber-400 border border-amber-400 bg-amber-50/70 dark:bg-amber-900/30' : ''}`}>{pred ? pred.awayScore : match.awayScore}</span>
                          ) : isLocked ? (
                            <span className="w-11 h-9 flex items-center justify-center text-xl text-muted-foreground flex-shrink-0">{pred ? pred.awayScore : '—'}</span>
                          ) : (
                            <div className="flex items-center gap-0.5 flex-shrink-0">
                              <button
                                type="button"
                                onClick={() => {
                                  const cur = parseInt(edit?.away ?? '0') || 0;
                                  const val = String(Math.max(0, cur - 1));
                                  setLocalEdits(prev => ({ ...prev, [match.id]: { home: prev[match.id]?.home ?? '', away: val } }));
                                  scheduleAutoSave(match.id);
                                }}
                                className="h-10 w-10 flex items-center justify-center rounded-md border bg-muted hover:bg-muted/80 text-base font-bold select-none active:scale-95 transition-all"
                              >−</button>
                              <input
                                type="text"
                                inputMode="numeric"
                                value={edit?.away ?? ''}
                                onChange={e => {
                                  const val = e.target.value.replace(/\D/g, '').slice(0, 2);
                                  setLocalEdits(prev => ({ ...prev, [match.id]: { home: prev[match.id]?.home ?? '', away: val } }));
                                  scheduleAutoSave(match.id);
                                }}
                                placeholder="–"
                                className="w-11 h-9 text-center text-xl font-bold rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-primary flex-shrink-0"
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  const cur = parseInt(edit?.away ?? '0') || 0;
                                  const val = String(Math.min(99, cur + 1));
                                  setLocalEdits(prev => ({ ...prev, [match.id]: { home: prev[match.id]?.home ?? '', away: val } }));
                                  scheduleAutoSave(match.id);
                                }}
                                className="h-10 w-10 flex items-center justify-center rounded-md border bg-muted hover:bg-muted/80 text-base font-bold select-none active:scale-95 transition-all"
                              >+</button>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Status row */}
                      <div className="mt-2 text-center space-y-0.5">
                        {match.status === 'scheduled' && !isLocked && saving && (
                          <p className="text-xs text-muted-foreground">…</p>
                        )}
                        {match.status === 'scheduled' && !isLocked && justSaved && !saving && (
                          <p className="text-xs text-green-600">{t('competitionDetail.predictions.saved')}</p>
                        )}
                        {match.status === 'completed' && pred && (() => {
                          const cfg = competition.scoringConfig;
                          const hasActual = match.homeScore !== null && match.awayScore !== null;
                          const exactScore = hasActual &&
                            pred.homeScore === match.homeScore && pred.awayScore === match.awayScore
                            ? cfg.exact_score : 0;
                          const correctResult = hasActual &&
                            Math.sign(pred.homeScore - pred.awayScore) === Math.sign(match.homeScore! - match.awayScore!)
                            ? cfg.correct_result : 0;
                          const total = exactScore + correctResult;
                          return (
                            <div className="space-y-0.5">
                              <p className="text-xs text-muted-foreground">
                                {t('competitionDetail.predictions.actualResult')}: {match.homeScore}–{match.awayScore}
                              </p>
                              {pred.points !== null && (
                                <div className="flex flex-wrap justify-center items-center gap-x-2 gap-y-0.5 text-xs">
                                  <span className={`font-semibold ${total > 0 ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground'}`}>
                                    {total > 0 ? `+${total} pts` : '0 pts'}
                                  </span>
                                  {correctResult > 0 && <span className="text-muted-foreground">+{correctResult} {t('competitionDetail.predictions.correctResult')}</span>}
                                  {exactScore > 0 && <span className="text-muted-foreground">+{exactScore} {t('competitionDetail.predictions.correctExactScore')}</span>}
                                </div>
                              )}
                            </div>
                          );
                        })()}
                        {saveErr && <p className="text-xs text-destructive">{saveErr}</p>}
                      </div>
                      <div className="mt-3 flex sm:hidden items-center justify-between">
                        <button
                          type="button"
                          onClick={() => setCurrentGroupMatchIdx(i => Math.max(0, i - 1))}
                          disabled={!canGoPrev}
                          className="h-11 w-11 rounded-full border flex items-center justify-center transition-opacity disabled:opacity-20"
                          aria-label="Previous match"
                        >←</button>
                        <button
                          type="button"
                          onClick={() => setCurrentGroupMatchIdx(i => Math.min(allGroupMatchesList.length - 1, i + 1))}
                          disabled={!canGoNext}
                          className="h-11 w-11 rounded-full border flex items-center justify-center transition-opacity disabled:opacity-20"
                          aria-label="Next match"
                        >→</button>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setCurrentGroupMatchIdx(i => Math.min(allGroupMatchesList.length - 1, i + 1))}
                      disabled={!canGoNext}
                      className="hidden sm:flex flex-shrink-0 h-10 w-10 rounded-full border items-center justify-center transition-opacity disabled:opacity-20"
                      aria-label="Next match"
                    >
                      →
                    </button>
                  </div>
                </div>
              );
            })()}
          </>
        )}
      </div>

      {allGroupFilled && (groupDisciplinaryTies.length > 0 || luckyLoserDisciplinaryTies.length > 0) && (
        <div className="mt-6 rounded-lg border border-amber-400/40 bg-amber-50/10 px-4 py-3 text-sm">
          <p className="font-medium text-amber-700 dark:text-amber-400">{t('competitionDetail.tiebreakers.title')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('competitionDetail.tiebreakers.tabNote').replace(
              t('competitionDetail.tiebreakers.tabNote'),
              ''
            )}
            <button onClick={() => setActiveTab('tables')} className="underline hover:text-foreground">
              {t('competitionDetail.tiebreakers.goToGroupTablesLink')}
            </button>{' '}
            {t('competitionDetail.tiebreakers.tabNote')}
          </p>
        </div>
      )}
      </>}
      </>)}

      {activeTab === 'leaderboard' && (
        <>
          {leaderboard.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">{t('competitionDetail.leaderboard.noScores')}</p>
          ) : (() => {
          const lastRank = leaderboard[leaderboard.length - 1].rank;
          const rankColor = (rank: number) => {
            if (rank === 1) return 'text-yellow-500';
            if (rank === 2) return 'text-slate-400';
            if (rank === 3) return 'text-amber-600';
            if (rank === lastRank && rank > 3) return 'text-red-500';
            return 'text-muted-foreground';
          };
          const rowBg = (rank: number) => {
            if (rank === 1) return 'bg-yellow-50 dark:bg-yellow-500/10';
            if (rank === 2) return 'bg-slate-100 dark:bg-slate-400/10';
            if (rank === 3) return 'bg-amber-50 dark:bg-amber-600/10';
            if (rank === lastRank && rank > 3) return 'bg-red-50 dark:bg-red-500/10';
            return '';
          };
          return (<>
            {tournament?.status !== 'upcoming' && (
              user?.isLeaderboardUser ? (
                <div className="tv:relative">
                  <div className="hidden tv:flex items-center gap-3 absolute left-0 top-0 bottom-0">
                    {competition.imageUrl && (
                      <img
                        src={competition.imageUrl}
                        alt={competition.name}
                        className="h-10 w-10 rounded-lg object-cover flex-shrink-0"
                      />
                    )}
                    <div>
                      <h1 className="text-xl font-bold leading-tight">{competition.name}</h1>
                      {tournament && <p className="text-sm text-muted-foreground">{tournament.name}</p>}
                    </div>
                  </div>
                  <PlayerPodium leaderboard={leaderboard} large={true} competitionId={id} />
                </div>
              ) : (
                <PlayerPodium leaderboard={leaderboard} large={false} competitionId={id} />
              )
            )}

            {/* Standard table (hidden on TV for leaderboard users) */}
            <div className={`overflow-x-auto rounded-lg border mt-4 dark:bg-white/5 p-2 ${user?.isLeaderboardUser ? 'tv:hidden' : ''}`}>
              <div style={{ position: 'relative' }}>
                <SoccerKickAnimation />
                <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/50 text-muted-foreground">
                    <th className="pl-3 pr-2 py-2 text-left w-6">#</th>
                    <th className="px-3 py-2 text-left min-w-[110px]">{t('competitionDetail.leaderboard.player')}</th>
                    <th className="px-2 py-2 text-center font-bold text-foreground border-r max-w-[4.5rem] break-words">{t('competitionDetail.leaderboard.total')}</th>
                    <th className="px-2 py-2 text-center max-w-[4.5rem] break-words">{t('competitionDetail.leaderboard.result')}</th>
                    <th className="px-2 py-2 text-center max-w-[4.5rem] break-words">{t('competitionDetail.leaderboard.exact')}</th>
                    <th className="px-2 py-2 text-center max-w-[4.5rem] break-words">{t('competitionDetail.leaderboard.group')}</th>
                    <th className="px-2 py-2 text-center max-w-[4.5rem] break-words">{t('competitionDetail.leaderboard.progresses')}</th>
                    <th className="px-2 py-2 text-center max-w-[4.5rem] break-words">{t('competitionDetail.leaderboard.koTie')}</th>
                    <th className="px-2 py-2 text-center max-w-[4.5rem] break-words">{t('competitionDetail.leaderboard.final')}</th>
                    <th className="px-2 py-2 text-center max-w-[4.5rem] break-words">{t('competitionDetail.leaderboard.winner')}</th>
                    <th className="pl-2 pr-3 py-2 text-center max-w-[4.5rem] break-words">{t('competitionDetail.leaderboard.bonus')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {leaderboard.map((entry) => {
                    const isMe = entry.userId === user?.id;
                    const b = entry.breakdown;
                    return (
                      <tr key={entry.userId} className={rowBg(entry.rank) || (isMe ? 'bg-primary/5' : '')}>
                        <td className={`pl-3 pr-2 py-2.5 font-bold text-center ${rankColor(entry.rank)}`}>
                          {entry.rank}
                        </td>
                        <td className="px-3 py-2.5">
                          <Link to={`/competitions/${id}/predictions/${entry.userId}`} className="flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity">
                            <img src={entry.imageUrl ?? '/default-avatar.png'} alt="" className="h-5 w-5 rounded-full object-cover flex-shrink-0" />
                            <span className={`font-medium truncate ${isMe ? 'text-primary' : ''}`}>
                              {entry.username}
                              {isMe && <span className="ml-1 font-normal text-muted-foreground">{t('competitionDetail.leaderboard.you')}</span>}
                            </span>
                          </Link>
                        </td>
                        <td className="px-2 py-2.5 text-center font-bold text-sm border-r">{entry.totalPoints}</td>
                        <td className="px-2 py-2.5 text-center text-muted-foreground">{b.correctResultPoints}</td>
                        <td className="px-2 py-2.5 text-center text-muted-foreground">{b.exactScorePoints}</td>
                        <td className="px-2 py-2.5 text-center text-muted-foreground">{b.correctGroupPositionPoints}</td>
                        <td className="px-2 py-2.5 text-center text-muted-foreground">{b.correctTeamProgressesPoints}</td>
                        <td className="px-2 py-2.5 text-center text-muted-foreground">{b.correctTeamInKnockoutTiePoints}</td>
                        <td className="px-2 py-2.5 text-center text-muted-foreground">{b.correctTeamInFinalPoints}</td>
                        <td className="px-2 py-2.5 text-center text-muted-foreground">{b.correctWinnerPoints}</td>
                        <td className="pl-2 pr-3 py-2.5 text-center text-muted-foreground">{b.bonusQuestionPoints}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </div>

            {/* TV split view: two columns, no headers */}
            {user?.isLeaderboardUser && (() => {
              const mid = Math.ceil(leaderboard.length / 2);
              const renderRows = (entries: typeof leaderboard) => entries.map((entry) => {
                const b = entry.breakdown;
                return (
                  <tr key={entry.userId} className={rowBg(entry.rank)}>
                    <td className={`pl-4 pr-3 py-3 font-bold text-center text-base ${rankColor(entry.rank)}`}>
                      {entry.rank}
                    </td>
                    <td className="px-3 py-3">
                      <Link to={`/competitions/${id}/predictions/${entry.userId}`} className="flex items-center gap-3 min-w-0 hover:opacity-80 transition-opacity">
                        <img src={entry.imageUrl ?? '/default-avatar.png'} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
                        <span className="font-medium text-base truncate">{entry.username}</span>
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-center font-bold text-base border-r">{entry.totalPoints}</td>
                    <td className="px-3 py-3 text-center text-muted-foreground">{b.correctResultPoints}</td>
                    <td className="px-3 py-3 text-center text-muted-foreground">{b.exactScorePoints}</td>
                    <td className="px-3 py-3 text-center text-muted-foreground">{b.correctGroupPositionPoints}</td>
                    <td className="px-3 py-3 text-center text-muted-foreground">{b.correctTeamProgressesPoints}</td>
                    <td className="px-3 py-3 text-center text-muted-foreground">{b.correctTeamInKnockoutTiePoints}</td>
                    <td className="px-3 py-3 text-center text-muted-foreground">{b.correctTeamInFinalPoints}</td>
                    <td className="px-3 py-3 text-center text-muted-foreground">{b.correctWinnerPoints}</td>
                    <td className="pl-3 pr-4 py-3 text-center text-muted-foreground">{b.bonusQuestionPoints}</td>
                  </tr>
                );
              });
              const tableHead = (
                <thead>
                  <tr className="border-b bg-muted/50 text-muted-foreground">
                    <th className="pl-4 pr-3 py-3 text-left w-8">#</th>
                    <th className="px-3 py-3 text-left">{t('competitionDetail.leaderboard.player')}</th>
                    <th className="px-3 py-3 text-center font-bold text-foreground border-r max-w-[6rem] break-words">{t('competitionDetail.leaderboard.total')}</th>
                    <th className="px-3 py-3 text-center max-w-[6rem] break-words">{t('competitionDetail.leaderboard.result')}</th>
                    <th className="px-3 py-3 text-center max-w-[6rem] break-words">{t('competitionDetail.leaderboard.exact')}</th>
                    <th className="px-3 py-3 text-center max-w-[6rem] break-words">{t('competitionDetail.leaderboard.group')}</th>
                    <th className="px-3 py-3 text-center max-w-[6rem] break-words">{t('competitionDetail.leaderboard.progresses')}</th>
                    <th className="px-3 py-3 text-center max-w-[6rem] break-words">{t('competitionDetail.leaderboard.koTie')}</th>
                    <th className="px-3 py-3 text-center max-w-[6rem] break-words">{t('competitionDetail.leaderboard.final')}</th>
                    <th className="px-3 py-3 text-center max-w-[6rem] break-words">{t('competitionDetail.leaderboard.winner')}</th>
                    <th className="pl-3 pr-4 py-3 text-center max-w-[6rem] break-words">{t('competitionDetail.leaderboard.bonus')}</th>
                  </tr>
                </thead>
              );
              return (
                <div className="hidden tv:grid tv:grid-cols-2 tv:gap-8 tv:items-start mt-4">
                  <div className="rounded-lg border dark:bg-white/5 p-2">
                    <div style={{ position: 'relative' }}>
                      <SoccerKickAnimation />
                      <table className="w-full text-sm">
                        {tableHead}
                        <tbody className="divide-y">{renderRows(leaderboard.slice(0, mid))}</tbody>
                      </table>
                    </div>
                  </div>
                  <div className="rounded-lg border dark:bg-white/5 p-2">
                    <div style={{ position: 'relative' }}>
                      <CryingPlayerAnimation />
                      <table className="w-full text-sm">
                        {tableHead}
                        <tbody className="divide-y">{renderRows(leaderboard.slice(mid))}</tbody>
                      </table>
                    </div>
                  </div>
                </div>
              );
            })()}
          </>);
          })()}

          {/* Match Predictions */}
          {!user?.isAdmin && completedMatchesWithResults.length > 0 && (() => {
            const safePredMatchIdx = Math.min(currentPredMatchIdx, completedMatchesWithResults.length - 1);
            const match = completedMatchesWithResults[safePredMatchIdx];
            if (!match) return null;

            const matchPreds = [...allMatchPredictions]
              .filter(p => p.matchId === match.id)
              .sort((a, b) => {
                const pointsDiff = (b.points ?? 0) - (a.points ?? 0);
                if (pointsDiff !== 0) return pointsDiff;
                const actualGD = (match.homeScore ?? 0) - (match.awayScore ?? 0);
                const aGDDist = Math.abs((a.homeScore - a.awayScore) - actualGD);
                const bGDDist = Math.abs((b.homeScore - b.awayScore) - actualGD);
                return aGDDist - bGDDist;
              });

            const isKnockout = match.stage !== 'group';

            return (
              <div className={`mt-6 ${user?.isLeaderboardUser ? 'tv:hidden' : ''}`}>
                <button
                  type="button"
                  onClick={() => setMatchPredictionsCollapsed(c => !c)}
                  className="flex items-center justify-between w-full text-left mb-3"
                >
                  <h2 className="font-semibold">Match Predictions</h2>
                  <span className="text-xs text-muted-foreground">{matchPredictionsCollapsed ? '▼' : '▲'}</span>
                </button>

                {!matchPredictionsCollapsed && (
                  <>
                    {/* Navigation dots */}
                    <div className="mb-4">
                      <div className="flex flex-wrap gap-1.5">
                        {completedMatchesWithResults.map((m, idx) => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => setCurrentPredMatchIdx(idx)}
                            className={`rounded-full transition-all duration-200 ${
                              idx === safePredMatchIdx
                                ? 'w-5 h-2.5 bg-primary'
                                : 'w-2.5 h-2.5 bg-muted-foreground/30 hover:bg-muted-foreground/50'
                            }`}
                            aria-label={`Match ${idx + 1}`}
                          />
                        ))}
                      </div>
                    </div>

                    {/* Match card with actual result */}
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-4">
                      <button
                        type="button"
                        onClick={() => setCurrentPredMatchIdx(i => Math.max(0, i - 1))}
                        disabled={safePredMatchIdx === 0}
                        className="hidden sm:flex flex-shrink-0 h-10 w-10 rounded-full border items-center justify-center transition-opacity disabled:opacity-20"
                        aria-label="Previous match"
                      >←</button>

                      <div className="flex-1">
                        <div className="text-center mb-2">
                          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                            {stageLabel(match.stage, match.groupName)}
                          </p>
                          {match.scheduledAt && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {new Date(match.scheduledAt).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {safePredMatchIdx + 1} / {completedMatchesWithResults.length}
                          </p>
                        </div>

                        <div className="rounded-xl border-2 shadow-sm overflow-hidden w-full max-w-xs mx-auto bg-card">
                          <div className="flex items-center gap-3 px-4 py-3.5">
                            {match.homeTeamImageUrl ? (
                              <img src={match.homeTeamImageUrl} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
                            ) : (
                              <div className="h-7 w-7 rounded-full bg-muted flex-shrink-0" />
                            )}
                            <span className="flex-1 text-sm font-medium truncate">{match.homeTeamName ?? 'TBD'}</span>
                            <span className="w-11 h-9 flex items-center justify-center text-xl font-bold rounded-lg flex-shrink-0">{match.homeScore}</span>
                          </div>
                          <div className="h-px bg-border" />
                          <div className="flex items-center gap-3 px-4 py-3.5">
                            {match.awayTeamImageUrl ? (
                              <img src={match.awayTeamImageUrl} alt="" className="h-7 w-7 rounded-full object-cover flex-shrink-0" />
                            ) : (
                              <div className="h-7 w-7 rounded-full bg-muted flex-shrink-0" />
                            )}
                            <span className="flex-1 text-sm font-medium truncate">{match.awayTeamName ?? 'TBD'}</span>
                            <span className="w-11 h-9 flex items-center justify-center text-xl font-bold rounded-lg flex-shrink-0">{match.awayScore}</span>
                          </div>
                        </div>

                        <div className="mt-3 flex sm:hidden items-center justify-between">
                          <button
                            type="button"
                            onClick={() => setCurrentPredMatchIdx(i => Math.max(0, i - 1))}
                            disabled={safePredMatchIdx === 0}
                            className="h-11 w-11 rounded-full border flex items-center justify-center transition-opacity disabled:opacity-20"
                          >←</button>
                          <button
                            type="button"
                            onClick={() => setCurrentPredMatchIdx(i => Math.min(completedMatchesWithResults.length - 1, i + 1))}
                            disabled={safePredMatchIdx === completedMatchesWithResults.length - 1}
                            className="h-11 w-11 rounded-full border flex items-center justify-center transition-opacity disabled:opacity-20"
                          >→</button>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => setCurrentPredMatchIdx(i => Math.min(completedMatchesWithResults.length - 1, i + 1))}
                        disabled={safePredMatchIdx === completedMatchesWithResults.length - 1}
                        className="hidden sm:flex flex-shrink-0 h-10 w-10 rounded-full border items-center justify-center transition-opacity disabled:opacity-20"
                        aria-label="Next match"
                      >→</button>
                    </div>

                    {/* Prediction list */}
                    {matchPreds.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-2">No predictions for this match</p>
                    ) : (
                      <div className="space-y-1">
                        {matchPreds.map(pred => {
                          const isCorrectResult =
                            match.homeScore !== null && match.awayScore !== null &&
                            Math.sign(pred.homeScore - pred.awayScore) === Math.sign(match.homeScore - match.awayScore);
                          const isExactScore =
                            match.homeScore !== null && match.awayScore !== null &&
                            pred.homeScore === match.homeScore && pred.awayScore === match.awayScore;
                          const homeGetsCircle =
                            isKnockout &&
                            pred.progressingTeamId !== null &&
                            match.progressingTeamId !== null &&
                            pred.progressingTeamId === match.progressingTeamId &&
                            pred.progressingTeamId === match.homeTeamId;
                          const awayGetsCircle =
                            isKnockout &&
                            pred.progressingTeamId !== null &&
                            match.progressingTeamId !== null &&
                            pred.progressingTeamId === match.progressingTeamId &&
                            pred.progressingTeamId === match.awayTeamId;

                          return (
                            <div
                              key={pred.userId}
                              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                                isCorrectResult
                                  ? 'bg-green-50 dark:bg-green-950/25'
                                  : 'bg-muted/20'
                              }`}
                            >
                              <Link
                                to={`/competitions/${id}/predictions/${pred.userId}`}
                                className="flex-1 flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity"
                              >
                                <img
                                  src={pred.imageUrl ?? '/default-avatar.png'}
                                  alt=""
                                  className="h-5 w-5 rounded-full object-cover flex-shrink-0"
                                />
                                <span className="flex-1 truncate font-medium text-xs">{pred.username}</span>
                              </Link>

                              <div className="flex items-center gap-1 flex-shrink-0">
                                <div className={homeGetsCircle ? 'ring-2 ring-green-500 rounded-full' : ''}>
                                  {match.homeTeamImageUrl ? (
                                    <img src={match.homeTeamImageUrl} alt="" className="h-5 w-5 rounded-full object-cover" />
                                  ) : (
                                    <div className="h-5 w-5 rounded-full bg-muted" />
                                  )}
                                </div>

                                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-bold tabular-nums min-w-[2.5rem] justify-center ${
                                  isExactScore
                                    ? 'bg-amber-50 dark:bg-amber-900/30 border border-amber-400 text-amber-600 dark:text-amber-400'
                                    : 'bg-background border'
                                }`}>
                                  {pred.homeScore}–{pred.awayScore}
                                </span>

                                <div className={awayGetsCircle ? 'ring-2 ring-green-500 rounded-full' : ''}>
                                  {match.awayTeamImageUrl ? (
                                    <img src={match.awayTeamImageUrl} alt="" className="h-5 w-5 rounded-full object-cover" />
                                  ) : (
                                    <div className="h-5 w-5 rounded-full bg-muted" />
                                  )}
                                </div>
                              </div>

                              <span className={`text-xs font-bold flex-shrink-0 w-7 text-right ${
                                (pred.points ?? 0) > 0
                                  ? 'text-green-600 dark:text-green-400'
                                  : 'text-muted-foreground'
                              }`}>
                                {pred.points !== null ? ((pred.points > 0) ? `+${pred.points}` : `${pred.points}`) : '—'}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })()}
        </>
      )}

      </div>

      {/* Clear predictions confirm */}
      {showClearConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-background rounded-lg border p-6 max-w-sm w-full shadow-xl">
            <p className="font-semibold mb-1">{t('competitionDetail.resetConfirm.title')}</p>
            <p className="text-sm text-muted-foreground mb-6">{t('competitionDetail.resetConfirm.body')}</p>
            {clearPredictionsMutation.isError && (
              <p className="mb-4 text-sm text-destructive">
                {clearPredictionsMutation.error instanceof ApiError
                  ? clearPredictionsMutation.error.message
                  : t('competitionDetail.failedToClear')}
              </p>
            )}
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowClearConfirm(false)}
                disabled={clearPredictionsMutation.isPending}
                className="rounded-md border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => clearPredictionsMutation.mutate()}
                disabled={clearPredictionsMutation.isPending}
                className="rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
              >
                {clearPredictionsMutation.isPending ? t('competitionDetail.resetConfirm.resetting') : t('competitionDetail.resetConfirm.resetAll')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Leave competition confirm */}
      {showLeaveConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-background rounded-lg border p-6 max-w-sm w-full shadow-xl">
            <p className="font-semibold mb-1">{t('competitionDetail.leaveConfirm.title')}</p>
            <p className="text-sm text-muted-foreground mb-6">
              {t('competitionDetail.leaveConfirm.body', { name: competition.name })}
            </p>
            {leaveMutation.isError && (
              <p className="mb-4 text-sm text-destructive">
                {leaveMutation.error instanceof ApiError ? leaveMutation.error.message : t('competitionDetail.failedToLeave')}
              </p>
            )}
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowLeaveConfirm(false)}
                disabled={leaveMutation.isPending}
                className="rounded-md border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => leaveMutation.mutate()}
                disabled={leaveMutation.isPending}
                className="rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
              >
                {leaveMutation.isPending ? t('competitionDetail.leaveConfirm.leaving') : t('competitionDetail.leaveConfirm.leave')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* All group predictions filled — go to Group Tables */}
      {showProceedPrompt && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-background rounded-lg border p-6 max-w-md w-full shadow-xl">
            <p className="font-semibold mb-1">{t('competitionDetail.proceedPrompt.title')}</p>
            <p className="text-sm text-muted-foreground mb-6">{t('competitionDetail.proceedPrompt.body')}</p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={handleDeclineProceed}
                className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
              >
                {t('competitionDetail.proceedPrompt.stayHere')}
              </button>
              <button
                onClick={() => {
                  setHasDeclined(true);
                  setShowProceedPrompt(false);
                  setActiveTab('tables');
                }}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t('competitionDetail.proceedPrompt.goToGroupTables')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Knockout complete — go to bonus questions */}
      {showKnockoutCompletePrompt && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-background rounded-lg border p-6 max-w-md w-full shadow-xl">
            <p className="font-semibold mb-1">{t('competitionDetail.knockoutCompletePrompt.title')}</p>
            <p className="text-sm text-muted-foreground mb-6">{t('competitionDetail.knockoutCompletePrompt.body')}</p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => {
                  setHasDeclinedKnockout(true);
                  setShowKnockoutCompletePrompt(false);
                }}
                className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
              >
                {t('common.no')}
              </button>
              <button
                onClick={() => {
                  setHasDeclinedKnockout(true);
                  setShowKnockoutCompletePrompt(false);
                  acknowledgeKnockoutMutation.mutate();
                  setActiveTab('bonus');
                }}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t('competitionDetail.knockoutCompletePrompt.yesBonusQuestions')}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
