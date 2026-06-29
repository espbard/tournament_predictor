import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import ImageUpload from '@/components/ImageUpload';
import KnockoutStageContent from '@/components/KnockoutStageContent';
import PlayerPodium from '@/components/PlayerPodium';
import LeaderboardLineGraph from '@/components/LeaderboardLineGraph';
import UserStatCard from '@/components/UserStatCard';
import HaalandDistributionCard from '@/components/HaalandDistributionCard';
import { UserAvatar } from '@/components/UserAvatar';
import { SoccerKickAnimation } from '@/components/SoccerKickAnimation';
import { CryingPlayerAnimation } from '@/components/CryingPlayerAnimation';
import BonusQuestionsTab from './BonusQuestionsTab';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import BackButton from '@/components/BackButton';
import { useT } from '@/lib/useT';
import { useTeamName } from '@/lib/teamTranslations';
import type { Competition, Tournament, Prediction, MatchStage, LeaderboardEntry, BracketPredictions, BracketMatchPrediction, UserStatCardData, LeaderboardProgressionResponse } from '@tournament-predictor/shared';
import {
  sortGroupTeams,
  sortLuckyLosers,
  findGroupDisciplinaryTies,
  findLuckyLoserDisciplinaryTies,
  makeDisciplinaryKey,
  type MatchResult,
  type TeamTiebreakerStat,
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
  bracketIndex: number | null;
}

interface PredBreakdown {
  exactScore: number;
  correctResult: number;
  correctTeamProgresses: number;
  correctTeamInKnockoutTie: number;
  correctTeamInFinal: number;
  correctWinner: number;
}

interface MatchPredictionEntry {
  matchId: string;
  userId: string;
  username: string;
  imageUrl: string | null;
  iconColor?: string | null;
  isComparisonUser?: boolean;
  homeScore: number;
  awayScore: number;
  progressingTeamId: string | null;
  points: number | null;
  isReplacement?: boolean;
  breakdown: PredBreakdown;
  flipped?: boolean;
  predHomeTeamId?: string | null;
  predAwayTeamId?: string | null;
  predHomeTeamImageUrl?: string | null;
  predAwayTeamImageUrl?: string | null;
}

export default function CompetitionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { t, language } = useT();
  const { tn } = useTeamName();
  const dateLocale = { no: 'nb-NO', en: 'en-GB', de: 'de-DE' }[language];

  const [editName, setEditName] = useState('');
  const [editImageUrl, setEditImageUrl] = useState<string | null>(null);
  const [editDeadline, setEditDeadline] = useState('');
  const [editAllowLateAdditions, setEditAllowLateAdditions] = useState(true);
  const [showEdit, setShowEdit] = useState(false);
  const [editError, setEditError] = useState('');

  const [currentGroupMatchIdx, setCurrentGroupMatchIdx] = useState(0);

  const [localEdits, setLocalEdits] = useState<Record<string, { home: string; away: string }>>({});
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});

  const [searchParams, setSearchParams] = useSearchParams();
  type TabId = 'group' | 'tables' | 'knockout' | 'bonus' | 'leaderboard' | 'pointProgression' | 'userStats';
  const VALID_TABS: TabId[] = ['group', 'tables', 'knockout', 'bonus', 'leaderboard', 'pointProgression', 'userStats'];
  const tabParam = searchParams.get('tab') as TabId | null;
  const activeTab: TabId = VALID_TABS.includes(tabParam!)
    ? tabParam!
    : (user?.isLeaderboardUser || user?.isAdmin ? 'leaderboard' : 'group');
  const setActiveTab = (tab: TabId) => {
    setSearchParams(prev => { const n = new URLSearchParams(prev); n.set('tab', tab); return n; }, { replace: true });
  };
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showComparisonUsers, setShowComparisonUsers] = useState(false);
  const [showInactiveUsers, setShowInactiveUsers] = useState(false);

  const [hasDeclined, setHasDeclined] = useState(false);
  const [showProceedPrompt, setShowProceedPrompt] = useState(false);
  const [showKnockoutCompletePrompt, setShowKnockoutCompletePrompt] = useState(false);
  const [hasDeclinedKnockout, setHasDeclinedKnockout] = useState(false);

  const [currentPredMatchIdx, setCurrentPredMatchIdx] = useState(0);
  const [matchPredictionsCollapsed, setMatchPredictionsCollapsed] = useState(false);
  const [expandedPredKey, setExpandedPredKey] = useState<string | null>(null);
  const [pendingScrollMatchId, setPendingScrollMatchId] = useState<string | null>(null);
  const matchPredictionsRef = useRef<HTMLDivElement>(null);

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

  const { data: matchList = [], isLoading: matchListLoading } = useQuery({
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
    queryFn: () => api.get<{ groupStageLocked: boolean; knockoutCompleteSeen: boolean; lateAdditionWindowEndsAt: string | null }>(`/competitions/${id}/my-status`),
    enabled: !!competition && !user?.isAdmin && !user?.isLeaderboardUser,
  });

  const { data: bracketPreds } = useQuery({
    queryKey: ['competitions', id, 'bracket-predictions'],
    queryFn: () => api.get<BracketPredictions>(`/competitions/${id}/bracket-predictions`),
    enabled: !!competition && !user?.isAdmin && !user?.isLeaderboardUser,
  });

  const { data: leaderboard = [], isLoading: leaderboardLoading } = useQuery({
    queryKey: ['competitions', id, 'leaderboard', showComparisonUsers],
    queryFn: () => api.get<LeaderboardEntry[]>(`/competitions/${id}/leaderboard${showComparisonUsers ? '?includeComparison=true' : ''}`),
    enabled: !!competition && (activeTab === 'leaderboard' || (!user?.isAdmin && !!user?.isLeaderboardUser)),
  });

  const { data: allMatchPredictions = [] } = useQuery({
    queryKey: ['competitions', id, 'all-match-predictions', showComparisonUsers],
    queryFn: () => api.get<MatchPredictionEntry[]>(`/competitions/${id}/all-match-predictions${showComparisonUsers ? '?includeComparison=true' : ''}`),
    enabled: !!competition && !user?.isAdmin && (activeTab === 'leaderboard' || !!user?.isLeaderboardUser),
  });

  const { data: leaderboardProgression } = useQuery({
    queryKey: ['competitions', id, 'leaderboard-progression', showComparisonUsers, showInactiveUsers],
    queryFn: () => {
      const params = new URLSearchParams();
      if (showComparisonUsers) params.set('includeComparison', 'true');
      if (showInactiveUsers) params.set('includeInactive', 'true');
      const qs = params.toString();
      return api.get<LeaderboardProgressionResponse>(`/competitions/${id}/leaderboard-progression${qs ? `?${qs}` : ''}`);
    },
    enabled: !!competition && activeTab === 'pointProgression',
  });

  const { data: userStats = [] } = useQuery({
    queryKey: ['competitions', id, 'user-stats', language],
    queryFn: () => api.get<UserStatCardData[]>(`/competitions/${id}/user-stats?lang=${language}`),
    enabled: !!competition && activeTab === 'userStats',
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
        if (p.isReplacement) continue;
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

  // Map actual knockout match UUIDs → the user's bracket prediction for that slot.
  // Bracket predictions are keyed by position (e.g. "round_of_16_0") not by match UUID.
  // Keys are assigned using bracketIndex-first ordering (matching how the bracket UI stores them).
  const knockoutPredByMatchId = useMemo<Record<string, BracketMatchPrediction>>(() => {
    if (!bracketPreds) return {};
    const koMatches = [...matchList]
      .filter(m => m.stage !== 'group')
      .sort((a, b) => {
        const aHasIdx = a.bracketIndex != null;
        const bHasIdx = b.bracketIndex != null;
        if (aHasIdx && bHasIdx && a.bracketIndex !== b.bracketIndex) return a.bracketIndex! - b.bracketIndex!;
        if (aHasIdx && !bHasIdx) return -1;
        if (!aHasIdx && bHasIdx) return 1;
        if (!a.scheduledAt && !b.scheduledAt) return 0;
        if (!a.scheduledAt) return 1;
        if (!b.scheduledAt) return -1;
        return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
      });
    const stageCount = new Map<string, number>();
    const result: Record<string, BracketMatchPrediction> = {};
    for (const m of koMatches) {
      const i = stageCount.get(m.stage) ?? 0;
      stageCount.set(m.stage, i + 1);
      const pred = bracketPreds[`${m.stage}_${i}`];
      if (pred) result[m.id] = pred;
    }
    return result;
  }, [matchList, bracketPreds]);

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
  const { actualGroupStandings } = useMemo(() => {
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

    return { actualGroupStandings: byGroup };
  }, [matchList]);

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

  const allMatchesSorted = useMemo(
    () => [...matchList].sort((a, b) => {
      if (!a.scheduledAt && !b.scheduledAt) return 0;
      if (!a.scheduledAt) return 1;
      if (!b.scheduledAt) return -1;
      return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
    }),
    [matchList]
  );

  useEffect(() => {
    if (!predMatchInitializedRef.current && completedMatchesWithResults.length > 0 && allMatchesSorted.length > 0) {
      predMatchInitializedRef.current = true;
      const lastCompletedId = completedMatchesWithResults[completedMatchesWithResults.length - 1].id;
      const idx = allMatchesSorted.findIndex(m => m.id === lastCompletedId);
      setCurrentPredMatchIdx(idx >= 0 ? idx : 0);
    }
  }, [completedMatchesWithResults, allMatchesSorted]);

  useEffect(() => {
    if (pendingScrollMatchId && activeTab === 'leaderboard') {
      matchPredictionsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setPendingScrollMatchId(null);
    }
  }, [pendingScrollMatchId, activeTab]);

  const handleStatCardMatchClick = (matchId: string) => {
    const idx = allMatchesSorted.findIndex(m => m.id === matchId);
    if (idx === -1) return;
    setActiveTab('leaderboard');
    setCurrentPredMatchIdx(idx);
    setMatchPredictionsCollapsed(false);
    setPendingScrollMatchId(matchId);
  };

  const handleStatCardLeaderboardClick = () => {
    setActiveTab('leaderboard');
  };

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

  // When the admin has confirmed standings, reorder the actual group display to match.
  const displayActualGroupStandings = useMemo(() => {
    const confirmed = tournament?.knockoutConfig?.confirmedGroupStandings;
    if (!confirmed || Object.keys(confirmed).length === 0) return actualGroupStandings;
    const result = new Map(actualGroupStandings);
    for (const [groupName, confirmedOrder] of Object.entries(confirmed)) {
      const teams = actualGroupStandings.get(groupName);
      if (!teams) continue;
      const reordered = confirmedOrder
        .map(teamId => teams.find(t => t.teamId === teamId))
        .filter((t): t is typeof teams[number] => t !== undefined);
      result.set(groupName, reordered);
    }
    return result;
  }, [actualGroupStandings, tournament?.knockoutConfig?.confirmedGroupStandings]);

  useEffect(() => {
    if (tabParam || user?.isLeaderboardUser || user?.isAdmin || !tournament) return;
    if (tournament.status === 'active' || tournament.status === 'completed') {
      setSearchParams(
        prev => { const n = new URLSearchParams(prev); n.set('tab', 'leaderboard'); return n; },
        { replace: true }
      );
    }
  }, [tournament?.status, tabParam, user?.isLeaderboardUser, user?.isAdmin, setSearchParams]);

  const directQualifiers = tournament?.knockoutConfig?.directQualifiers ?? 2;

  const qualifyingThirdPlaceIds = useMemo(() => {
    const luckyLosers = tournament?.knockoutConfig?.luckyLosers ?? 0;
    if (luckyLosers <= 0) return new Set<string>();
    const third = groupStandings
      .filter(([, teams]) => teams.length > directQualifiers)
      .map(([, teams]) => teams[directQualifiers]);
    const stats: TeamTiebreakerStat[] = third.map(t => ({
      teamId: t.teamId, points: t.W * 3 + t.D, gd: t.GF - t.GA, gf: t.GF,
    }));
    const sorted = sortLuckyLosers(stats, luckyLoserDisciplinaryChoices);
    return new Set(sorted.slice(0, luckyLosers).map(s => s.teamId));
  }, [groupStandings, luckyLoserDisciplinaryChoices, tournament, directQualifiers]);

  const actualQualifyingThirdPlaceIds = useMemo(() => {
    const luckyLosers = tournament?.knockoutConfig?.luckyLosers ?? 0;
    if (luckyLosers <= 0) return new Set<string>();
    const confirmedLuckyLosers = tournament?.knockoutConfig?.confirmedLuckyLosers;
    if (tournament?.knockoutConfig?.groupStandingsLocked && confirmedLuckyLosers) {
      return new Set<string>(confirmedLuckyLosers.slice(0, luckyLosers));
    }
    const groupEntries = [...displayActualGroupStandings.entries()].sort(([a], [b]) => a.localeCompare(b));
    const third = groupEntries
      .filter(([, teams]) => teams.length > directQualifiers)
      .map(([, teams]) => teams[directQualifiers]);
    const sorted = [...third].sort((a, b) => {
      const pa = a.W * 3 + a.D, pb = b.W * 3 + b.D;
      if (pb !== pa) return pb - pa;
      const ga = a.GF - a.GA, gb = b.GF - b.GA;
      if (gb !== ga) return gb - ga;
      return b.GF - a.GF;
    });
    const qualifying = new Set<string>();
    let filled = 0;
    let i = 0;
    while (i < sorted.length && filled < luckyLosers) {
      let j = i + 1;
      while (
        j < sorted.length &&
        sorted[j].W * 3 + sorted[j].D === sorted[i].W * 3 + sorted[i].D &&
        sorted[j].GF - sorted[j].GA === sorted[i].GF - sorted[i].GA &&
        sorted[j].GF === sorted[i].GF
      ) j++;
      const bucket = sorted.slice(i, j);
      const remaining = luckyLosers - filled;
      if (bucket.length <= remaining) {
        for (const tm of bucket) qualifying.add(tm.teamId);
        filled += bucket.length;
      } else {
        break;
      }
      i = j;
    }
    return qualifying;
  }, [displayActualGroupStandings, tournament, directQualifiers]);

  // All disciplinary ties for the group stage, including already-resolved ones.
  const allGroupDisciplinaryTieInfo = useMemo(() => {
    const directQualifiers = tournament?.knockoutConfig?.directQualifiers ?? 2;
    const result: Array<{ groupName: string; teams: TeamStat[]; key: string; requiredRankings: number }> = [];
    for (const [groupName, teams] of groupStandings) {
      const results = effectiveGroupResults.get(groupName) ?? [];
      const tiebreakerStats = teams.map(tm => ({ teamId: tm.teamId, points: tm.W * 3 + tm.D, gd: tm.GF - tm.GA, gf: tm.GF }));
      const tiedGroups = findGroupDisciplinaryTies(tiebreakerStats, results);
      for (const tiedGroup of tiedGroups) {
        const key = makeDisciplinaryKey(tiedGroup.map(tm => tm.teamId));
        const startIndex = Math.min(...tiedGroup.map(tm => teams.findIndex(tt => tt.teamId === tm.teamId)));
        const K = Math.max(1, Math.min(directQualifiers, startIndex + tiedGroup.length) - startIndex);
        const requiredRankings = Math.min(K, tiedGroup.length - 1);
        result.push({ groupName, teams: tiedGroup.map(s => teams.find(tm => tm.teamId === s.teamId)!).filter(Boolean), key, requiredRankings });
      }
    }
    return result;
  }, [groupStandings, effectiveGroupResults, tournament]);

  const groupDisciplinaryTies = useMemo(() => {
    return allGroupDisciplinaryTieInfo.filter(tie => (groupDisciplinaryChoices[tie.key] ?? []).length < tie.teams.length);
  }, [allGroupDisciplinaryTieInfo, groupDisciplinaryChoices]);

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
    for (const tie of allGroupDisciplinaryTieInfo) {
      const ranked = groupDisciplinaryChoices[tie.key] ?? [];
      for (const id of ranked.slice(0, tie.requiredRankings)) s.add(id);
    }
    return s;
  }, [allGroupDisciplinaryTieInfo, groupDisciplinaryChoices]);

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

    if (activeTab !== 'group') {
      setShowProceedPrompt(false);
      return;
    }

    const tournamentUnderway = tournament?.status === 'active' || tournament?.status === 'completed';
    if (!groupStageLocked && !hasDeclined && !showProceedPrompt && !tournamentUnderway) {
      const timer = setTimeout(() => {
        setShowProceedPrompt(true);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [allGroupMatchesList, allGroupFilled, localEdits, groupStageLocked, hasDeclined, showProceedPrompt, predictionsFetched, tournament?.status, activeTab]);

  const prevActiveTabRef = useRef(activeTab);
  useEffect(() => {
    const prev = prevActiveTabRef.current;
    prevActiveTabRef.current = activeTab;
    if (prev !== 'group' && activeTab === 'group') {
      setShowProceedPrompt(false);
      if (allGroupFilled) setHasDeclined(true);
    }
  }, [activeTab, allGroupFilled]);

  useEffect(() => {
    if (firstGroupUnfilledRef.current || !savedPredictions.length) return;
    firstGroupUnfilledRef.current = true;
  }, [savedPredictions]);

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

  const lateAdditionWindowActive =
    myStatus !== undefined &&
    myStatus.lateAdditionWindowEndsAt != null &&
    new Date() < new Date(myStatus.lateAdditionWindowEndsAt);

  const deadlinePassed =
    !user?.isComparisonUser && !lateAdditionWindowActive && (
      (competition?.predictionDeadline ? new Date() > new Date(competition.predictionDeadline) : false)
      || tournament?.status === 'active'
      || tournament?.status === 'completed'
    );

  const hasKnockoutPredictions = Object.keys(bracketPreds ?? {}).length > 0;
  const isLocked = deadlinePassed || (!user?.isComparisonUser && !lateAdditionWindowActive && groupStageLocked && hasKnockoutPredictions);

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
    mutationFn: (body: { name?: string; imageUrl?: string | null; predictionDeadline?: string | null; allowLateAdditions?: boolean }) =>
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
    setEditAllowLateAdditions(competition.allowLateAdditions);
    setShowEdit(true);
  }

  function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    updateMutation.mutate({
      name: editName.trim() || undefined,
      imageUrl: editImageUrl,
      predictionDeadline: editDeadline ? new Date(editDeadline).toISOString() : null,
      allowLateAdditions: editAllowLateAdditions,
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
    if (stage === 'group' && groupName) return `${t('common.group')} ${groupName}`;
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

  if (isLoading) return <LoadingSpinner />;
  if (error) {
    const msg = error instanceof ApiError ? error.message : t('competitionDetail.failedToLoad');
    return <p className="p-8 text-sm text-destructive">{msg}</p>;
  }
  if (!competition) return null;

  return (
    <main className={`mx-auto px-4 py-12 ${
      user?.isLeaderboardUser
        ? 'max-w-2xl md:max-w-4xl lg:max-w-[80%] tv:max-w-none tv:px-16'
        : 'max-w-2xl md:max-w-4xl lg:max-w-[80%]'
    }`}>
      <div>
      {!user?.isLeaderboardUser && (
        <BackButton href={user?.isAdmin ? '/competitions' : '/'} />
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
                  className="rounded-md border border-red-600 bg-red-600 px-3 py-1.5 text-sm flex-shrink-0 text-white hover:bg-red-700 hover:border-red-700 transition-colors"
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
          <div className="flex items-center gap-2">
            <input
              id="allow-late-additions"
              type="checkbox"
              checked={editAllowLateAdditions}
              onChange={e => setEditAllowLateAdditions(e.target.checked)}
              className="h-4 w-4 rounded border"
            />
            <label htmlFor="allow-late-additions" className="text-sm font-medium">
              Allow Late Additions
            </label>
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

      {!user?.isAdmin && (<>

      {activeTab === 'tables' && (
        <div>
          {matchListLoading ? (
            <LoadingSpinner />
          ) : groupStandings.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('competitionDetail.noGroupMatches')}</p>
          ) : (
            <div className="space-y-6">
              {!allGroupFilled && scheduledGroupMatches.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  {t('competitionDetail.tables.predictionsFilled', { filled: groupFillCount, total: allGroupMatchesList.length })}
                </p>
              )}

              {tournament?.status === 'upcoming' ? (
                /* Upcoming: original 2-col group grid, predicted only */
                <div className="grid gap-6 sm:grid-cols-2">
                  {groupStandings.map(([groupName, teams]) => {
                    const groupTies = allGroupFilled
                      ? groupDisciplinaryTies.filter(tie => tie.groupName === groupName)
                      : [];
                    return (
                      <div key={groupName} className="space-y-3">
                        <div className="rounded-lg border dark:bg-white/5 p-2">
                          <div className="bg-muted/50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            {t('common.group')} {groupName}
                          </div>
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b text-muted-foreground">
                                <th className="pl-3 py-1.5 text-left w-6">#</th>
                                <th className="py-1.5 text-left">{t('groupTable.team')}</th>
                                <th className="py-1.5 text-center w-6">{t('groupTable.played')}</th>
                                <th className="py-1.5 text-center w-6">{t('groupTable.won')}</th>
                                <th className="py-1.5 text-center w-6">{t('groupTable.drawn')}</th>
                                <th className="py-1.5 text-center w-6">{t('groupTable.lost')}</th>
                                <th className="py-1.5 text-center w-8">{t('groupTable.gf')}</th>
                                <th className="py-1.5 text-center w-8">{t('groupTable.ga')}</th>
                                <th className="py-1.5 text-center w-8 font-bold text-foreground">{t('groupTable.pts')}</th>
                                <th className="pr-3 py-1.5 w-12" />
                              </tr>
                            </thead>
                            <tbody className="divide-y">
                              {teams.map((tm, i) => {
                                const actualTeams = displayActualGroupStandings.get(groupName) ?? [];
                                const positionCorrect = Boolean(tournament?.knockoutConfig?.confirmedGroupStandings?.[groupName]) && actualTeams[i]?.teamId === tm.teamId;
                                const effectiveDQ = Math.min(directQualifiers, teams.length - 1);
                                return (
                                <tr key={tm.teamId} className={
                                  i < effectiveDQ
                                    ? 'bg-green-50 dark:bg-green-950/30'
                                    : i === effectiveDQ && qualifyingThirdPlaceIds.has(tm.teamId)
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
                                      <Link to={`/competitions/${id}/team/${tm.teamId}`} className="truncate hover:underline">{tn(tm.teamName)}</Link>
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
                                  ? `${t('competitionDetail.tables.selected')}: ${ranked.slice(0, tie.requiredRankings).map(tid => tn(tie.teams.find(tm => tm.teamId === tid)?.teamName)).join(' › ')}`
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
                                      {tn(tm.teamName)}
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
              ) : (
                /* Active/completed: per-group split — on mobile stacks as Pred A, Act A, Pred B, Act B...
                   On sm+ each group row shows predicted | actual side by side */
                <div className="space-y-3">
                  {/* Column headers — only visible on sm+ */}
                  <div className="hidden sm:grid sm:grid-cols-2 sm:gap-x-6">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b pb-1.5">
                      {t('competitionDetail.tables.yourPredictions')}
                    </h3>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b pb-1.5">
                      {t('competitionDetail.tables.actualResults')}
                    </h3>
                  </div>

                  {groupStandings.map(([groupName, teams]) => {
                    const groupTies = allGroupFilled
                      ? groupDisciplinaryTies.filter(tie => tie.groupName === groupName)
                      : [];
                    const actualTeams = displayActualGroupStandings.get(groupName) ?? [];
                    return (
                      <div key={groupName} className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
                        {/* Predicted */}
                        <div className="space-y-2 min-w-0">
                          <div className="rounded-lg border dark:bg-white/5 p-2">
                            <div className="bg-muted/50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground flex justify-between items-center">
                              <span>{t('common.group')} {groupName}</span>
                              <span className="sm:hidden normal-case tracking-normal font-medium rounded px-1.5 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">{t('competitionDetail.tables.labelPredicted')}</span>
                            </div>
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="border-b text-muted-foreground">
                                  <th className="pl-3 py-1.5 text-left w-6">#</th>
                                  <th className="py-1.5 text-left">{t('groupTable.team')}</th>
                                  <th className="py-1.5 text-center w-6">{t('groupTable.played')}</th>
                                  <th className="py-1.5 text-center w-6">{t('groupTable.won')}</th>
                                  <th className="py-1.5 text-center w-6">{t('groupTable.drawn')}</th>
                                  <th className="py-1.5 text-center w-6">{t('groupTable.lost')}</th>
                                  <th className="py-1.5 text-center w-8">{t('groupTable.gf')}</th>
                                  <th className="py-1.5 text-center w-8">{t('groupTable.ga')}</th>
                                  <th className="py-1.5 text-center w-8 font-bold text-foreground">{t('groupTable.pts')}</th>
                                  <th className="pr-3 py-1.5 w-12" />
                                </tr>
                              </thead>
                              <tbody className="divide-y">
                                {teams.map((tm, i) => {
                                  const positionCorrect = Boolean(tournament?.knockoutConfig?.confirmedGroupStandings?.[groupName]) && actualTeams[i]?.teamId === tm.teamId;
                                  const effectiveDQ = Math.min(directQualifiers, teams.length - 1);
                                  return (
                                  <tr key={tm.teamId} className={
                                    i < effectiveDQ
                                      ? 'bg-green-50 dark:bg-green-950/30'
                                      : i === effectiveDQ && qualifyingThirdPlaceIds.has(tm.teamId)
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
                                        <Link to={`/competitions/${id}/team/${tm.teamId}`} className="truncate hover:underline">{tn(tm.teamName)}</Link>
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
                                    ? `${t('competitionDetail.tables.selected')}: ${ranked.slice(0, tie.requiredRankings).map(tid => tn(tie.teams.find(tm => tm.teamId === tid)?.teamName)).join(' › ')}`
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
                                        {tn(tm.teamName)}
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

                        {/* Actual */}
                        <div className="min-w-0">
                          <div className="rounded-lg border dark:bg-white/5 p-2">
                            <div className="bg-muted/50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground flex justify-between items-center">
                              <span>{t('common.group')} {groupName}</span>
                              <span className="sm:hidden normal-case tracking-normal font-medium rounded px-1.5 py-0.5 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">{t('competitionDetail.tables.labelActual')}</span>
                            </div>
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="border-b text-muted-foreground">
                                  <th className="pl-3 py-1.5 text-left w-6">#</th>
                                  <th className="py-1.5 text-left">{t('groupTable.team')}</th>
                                  <th className="py-1.5 text-center w-6">{t('groupTable.played')}</th>
                                  <th className="py-1.5 text-center w-6">{t('groupTable.won')}</th>
                                  <th className="py-1.5 text-center w-6">{t('groupTable.drawn')}</th>
                                  <th className="py-1.5 text-center w-6">{t('groupTable.lost')}</th>
                                  <th className="py-1.5 text-center w-8">{t('groupTable.gf')}</th>
                                  <th className="py-1.5 text-center w-8">{t('groupTable.ga')}</th>
                                  <th className="pr-3 py-1.5 text-center w-8 font-bold text-foreground">{t('groupTable.pts')}</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y">
                                {actualTeams.map((tm, i) => {
                                  const effectiveDQ = Math.min(directQualifiers, actualTeams.length - 1);
                                  return (
                                  <tr key={tm.teamId} className={
                                    i < effectiveDQ
                                      ? 'bg-green-50 dark:bg-green-950/30'
                                      : actualQualifyingThirdPlaceIds.has(tm.teamId)
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
                                        <Link to={`/competitions/${id}/team/${tm.teamId}`} className="truncate hover:underline">{tn(tm.teamName)}</Link>
                                      </div>
                                    </td>
                                    <td className="py-1.5 text-center text-muted-foreground">{tm.P}</td>
                                    <td className="py-1.5 text-center text-muted-foreground">{tm.W}</td>
                                    <td className="py-1.5 text-center text-muted-foreground">{tm.D}</td>
                                    <td className="py-1.5 text-center text-muted-foreground">{tm.L}</td>
                                    <td className="py-1.5 text-center text-muted-foreground">{tm.GF}</td>
                                    <td className="py-1.5 text-center text-muted-foreground">{tm.GA}</td>
                                    <td className="pr-3 py-1.5 text-center font-bold">{tm.W * 3 + tm.D}</td>
                                  </tr>
                                );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

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

              {/* Lucky Losers Table */}
              {(tournament?.knockoutConfig?.luckyLosers ?? 0) > 0 && (() => {
                const numLL = tournament!.knockoutConfig!.luckyLosers!;

                const predLLCandidates = groupStandings
                  .filter(([, teams]) => teams.length > directQualifiers)
                  .map(([groupName, teams]) => ({ groupName, tm: teams[directQualifiers] }));
                const predLLMap = new Map(predLLCandidates.map(c => [c.tm.teamId, c]));
                const predLLStats: TeamTiebreakerStat[] = predLLCandidates.map(({ tm }) => ({
                  teamId: tm.teamId,
                  points: tm.W * 3 + tm.D,
                  gd: tm.GF - tm.GA,
                  gf: tm.GF,
                }));
                const sortedPredLL = sortLuckyLosers(predLLStats, luckyLoserDisciplinaryChoices)
                  .map(stat => predLLMap.get(stat.teamId)!)
                  .filter(Boolean);

                // Build a flat lookup so we can order by admin-confirmed list when available
                const actualTeamDataMap = new Map<string, { groupName: string; tm: TeamStat }>();
                for (const [groupName, teams] of displayActualGroupStandings.entries()) {
                  for (const tm of teams) actualTeamDataMap.set(tm.teamId, { groupName, tm });
                }

                const confirmedLL = tournament?.knockoutConfig?.confirmedLuckyLosers;
                const llLocked = tournament?.knockoutConfig?.groupStandingsLocked ?? false;

                const sortedActualLL: { groupName: string; tm: TeamStat }[] = llLocked && confirmedLL?.length
                  ? confirmedLL
                      .map(teamId => actualTeamDataMap.get(teamId))
                      .filter((x): x is { groupName: string; tm: TeamStat } => x !== undefined)
                  : [...displayActualGroupStandings.entries()]
                      .sort(([a], [b]) => a.localeCompare(b))
                      .filter(([, teams]) => teams.length > directQualifiers)
                      .map(([groupName, teams]) => ({ groupName, tm: teams[directQualifiers] }))
                      .sort((a, b) => {
                        const pa = a.tm.W * 3 + a.tm.D, pb = b.tm.W * 3 + b.tm.D;
                        if (pb !== pa) return pb - pa;
                        const gda = a.tm.GF - a.tm.GA, gdb = b.tm.GF - b.tm.GA;
                        if (gdb !== gda) return gdb - gda;
                        return b.tm.GF - a.tm.GF;
                      });

                if (sortedPredLL.length === 0) return null;

                const llTableHeaders = (
                  <tr className="border-b text-muted-foreground">
                    <th className="pl-3 py-1.5 text-left w-6">#</th>
                    <th className="py-1.5 text-left">{t('groupTable.team')}</th>
                    <th className="py-1.5 text-center w-6">{t('groupTable.played')}</th>
                    <th className="py-1.5 text-center w-6">{t('groupTable.won')}</th>
                    <th className="py-1.5 text-center w-6">{t('groupTable.drawn')}</th>
                    <th className="py-1.5 text-center w-6">{t('groupTable.lost')}</th>
                    <th className="py-1.5 text-center w-8">{t('groupTable.gd')}</th>
                    <th className="py-1.5 text-center w-8">{t('groupTable.gf')}</th>
                    <th className="py-1.5 text-center w-8 font-bold text-foreground">{t('groupTable.pts')}</th>
                    <th className="py-1.5 text-center w-8">Grp</th>
                  </tr>
                );

                const renderRow = (groupName: string, tm: TeamStat, i: number) => (
                  <tr key={tm.teamId} className={i < numLL ? 'bg-green-50 dark:bg-green-950/30' : ''}>
                    <td className="pl-3 py-1.5 text-muted-foreground">{i + 1}</td>
                    <td className="py-1.5 pr-2 overflow-hidden">
                      <div className="flex items-center gap-1.5 min-w-0">
                        {tm.imageUrl ? <img src={tm.imageUrl} alt="" className="h-4 w-4 rounded-full object-cover flex-shrink-0" /> : <div className="h-4 w-4 rounded-full bg-muted flex-shrink-0" />}
                        <Link to={`/competitions/${id}/team/${tm.teamId}`} className="truncate hover:underline">{tn(tm.teamName)}</Link>
                      </div>
                    </td>
                    <td className="py-1.5 text-center text-muted-foreground">{tm.P}</td>
                    <td className="py-1.5 text-center text-muted-foreground">{tm.W}</td>
                    <td className="py-1.5 text-center text-muted-foreground">{tm.D}</td>
                    <td className="py-1.5 text-center text-muted-foreground">{tm.L}</td>
                    <td className="py-1.5 text-center text-muted-foreground">{tm.GF - tm.GA > 0 ? `+${tm.GF - tm.GA}` : tm.GF - tm.GA}</td>
                    <td className="py-1.5 text-center text-muted-foreground">{tm.GF}</td>
                    <td className="py-1.5 text-center font-bold">{tm.W * 3 + tm.D}</td>
                    <td className="py-1.5 text-center text-muted-foreground">{groupName}</td>
                  </tr>
                );

                return (
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold">{t('competitionDetail.tables.luckyLosersTable')}</h3>
                    {tournament?.status === 'upcoming' ? (
                      <div className="rounded-lg border dark:bg-white/5 p-2">
                        <table className="w-full text-xs table-fixed">
                          <thead>{llTableHeaders}</thead>
                          <tbody className="divide-y">
                            {sortedPredLL.map(({ groupName, tm }, i) => renderRow(groupName, tm, i))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="hidden sm:grid sm:grid-cols-2 sm:gap-x-6">
                          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b pb-1.5">
                            {t('competitionDetail.tables.yourPredictions')}
                          </h3>
                          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b pb-1.5">
                            {t('competitionDetail.tables.actualResults')}
                          </h3>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                          <div className="min-w-0">
                            <div className="sm:hidden text-xs font-medium rounded px-1.5 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 inline-block mb-1">
                              {t('competitionDetail.tables.labelPredicted')}
                            </div>
                            <div className="rounded-lg border dark:bg-white/5 p-2">
                              <table className="w-full text-xs table-fixed">
                                <thead>{llTableHeaders}</thead>
                                <tbody className="divide-y">
                                  {sortedPredLL.map(({ groupName, tm }, i) => renderRow(groupName, tm, i))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                          <div className="min-w-0">
                            <div className="sm:hidden text-xs font-medium rounded px-1.5 py-0.5 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 inline-block mb-1">
                              {t('competitionDetail.tables.labelActual')}
                            </div>
                            <div className="rounded-lg border dark:bg-white/5 p-2">
                              <table className="w-full text-xs table-fixed">
                                <thead>{llTableHeaders}</thead>
                                <tbody className="divide-y">
                                  {sortedActualLL.map(({ groupName, tm }, i) => renderRow(groupName, tm, i))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

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
                            ? `${t('competitionDetail.tables.selected')}: ${ranked.slice(0, requiredRankings).map(tid => tn(tie.teams.find(tm => tm.teamId === tid)?.teamName)).join(' › ')}`
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
                                {tn(tm.teamName)}
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
          lateAdditionWindowActive={lateAdditionWindowActive}
          onAllComplete={() => {
            if (!hasDeclinedKnockout) setShowKnockoutCompletePrompt(true);
          }}
          onGoToGroupStage={() => setActiveTab('group')}
        />
      )}

      {activeTab === 'group' && <>

      {/* Deadline banner */}
      {(competition.predictionDeadline || lateAdditionWindowActive) && (
        <div className={`mb-4 rounded-lg px-4 py-2.5 text-sm ${
          deadlinePassed
            ? 'bg-muted text-muted-foreground'
            : 'border border-amber-200 bg-amber-50 text-amber-800'
        }`}>
          {lateAdditionWindowActive
            ? `${t('competitionDetail.deadline.openUntil')} ${new Date(myStatus!.lateAdditionWindowEndsAt!).toLocaleString()}`
            : deadlinePassed
              ? `${t('competitionDetail.deadline.closed')} · ${new Date(competition.predictionDeadline!).toLocaleString()}`
              : `${t('competitionDetail.deadline.openUntil')} ${new Date(competition.predictionDeadline!).toLocaleString()}`}
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
            {allGroupMatchesList.length > 0 && tournament?.status === 'upcoming' && (
              <button
                onClick={() => setShowClearConfirm(true)}
                className="text-xs rounded border px-2.5 py-1 text-destructive border-destructive/30 hover:bg-destructive/5"
              >
                {t('competitionDetail.predictions.resetAll')}
              </button>
            )}
          </div>
        </div>

        {matchListLoading ? (
          <LoadingSpinner />
        ) : allGroupMatchesList.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('competitionDetail.predictions.noMatches')}</p>
        ) : (
          <>
            {/* Match dots */}
            <div className="mb-5">
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {allGroupMatchesList.map((m, idx) => {
                  const isCurrent = idx === currentGroupMatchIdx;
                  const pred = predMap[m.id];
                  const localEdit = localEdits[m.id];
                  const hasActual = m.status === 'completed' && m.homeScore !== null && m.awayScore !== null;
                  const hasPendingEdit = !hasActual && (() => {
                    if (localEdit) {
                      const h = parseInt(localEdit.home, 10);
                      const a = parseInt(localEdit.away, 10);
                      if (!isNaN(h) && !isNaN(a) && h >= 0 && a >= 0) return true;
                    }
                    return false;
                  })();
                  const hasPred = !!pred;
                  const isCorrectResult = hasPred && hasActual &&
                    Math.sign(pred.homeScore - pred.awayScore) === Math.sign(m.homeScore! - m.awayScore!);
                  const isExactScore = hasPred && hasActual &&
                    pred.homeScore === m.homeScore && pred.awayScore === m.awayScore;
                  const dotClass = isCurrent
                    ? 'w-5 h-2.5 bg-primary dark:bg-blue-400'
                    : !hasPred && !hasPendingEdit
                    ? 'w-2.5 h-2.5 bg-muted-foreground/30 hover:bg-muted-foreground/50'
                    : !hasActual
                    ? 'w-2.5 h-2.5 bg-yellow-300'
                    : isExactScore
                    ? 'w-2.5 h-2.5 bg-green-500 ring-1 ring-offset-1 ring-offset-background ring-amber-400'
                    : isCorrectResult
                    ? 'w-2.5 h-2.5 bg-green-500'
                    : 'w-2.5 h-2.5 bg-red-500';
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setCurrentGroupMatchIdx(idx)}
                      className={`rounded-full transition-all duration-200 ${dotClass}${pred?.isReplacement ? ' opacity-40' : ''}`}
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

              // For late addition users in their window: lock individual matches whose kickoff time has passed
              const isMatchLocked = isLocked || (lateAdditionWindowActive && match.scheduledAt != null && new Date() > new Date(match.scheduledAt));

              return (
                <div className="rounded-xl border bg-muted/20 p-5">
                  <div className="text-center mb-4">
                    <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                      {stageLabel(match.stage, match.groupName)}
                    </p>
                    {match.scheduledAt && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {new Date(match.scheduledAt).toLocaleDateString(dateLocale, { weekday: 'short', day: 'numeric', month: 'short' })}
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
                      className="hidden sm:flex flex-shrink-0 h-10 w-10 rounded-full border items-center justify-center transition-opacity disabled:opacity-20 dark:border-blue-400 dark:text-blue-400"
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
                          {match.homeTeamId ? (
                            <Link to={`/competitions/${id}/team/${match.homeTeamId}`} className="flex-1 text-sm font-medium truncate hover:underline">{tn(match.homeTeamName) || 'TBD'}</Link>
                          ) : (
                            <span className="flex-1 text-sm font-medium truncate">{tn(match.homeTeamName) || 'TBD'}</span>
                          )}
                          {match.status === 'completed' && !user?.isComparisonUser ? (
                            <span className={`w-11 h-9 flex items-center justify-center text-xl font-bold rounded-lg flex-shrink-0 ${isExactScore ? 'text-amber-500 dark:text-amber-400 border border-amber-400 bg-amber-50/70 dark:bg-amber-900/30' : ''}`}>{pred ? pred.homeScore : '—'}</span>
                          ) : isMatchLocked ? (
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
                          {match.awayTeamId ? (
                            <Link to={`/competitions/${id}/team/${match.awayTeamId}`} className="flex-1 text-sm font-medium truncate hover:underline">{tn(match.awayTeamName) || 'TBD'}</Link>
                          ) : (
                            <span className="flex-1 text-sm font-medium truncate">{tn(match.awayTeamName) || 'TBD'}</span>
                          )}
                          {match.status === 'completed' && !user?.isComparisonUser ? (
                            <span className={`w-11 h-9 flex items-center justify-center text-xl font-bold rounded-lg flex-shrink-0 ${isExactScore ? 'text-amber-500 dark:text-amber-400 border border-amber-400 bg-amber-50/70 dark:bg-amber-900/30' : ''}`}>{pred ? pred.awayScore : '—'}</span>
                          ) : isMatchLocked ? (
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
                        {match.status === 'scheduled' && !isMatchLocked && saving && (
                          <p className="text-xs text-muted-foreground">…</p>
                        )}
                        {match.status === 'scheduled' && !isMatchLocked && justSaved && !saving && (
                          <p className="text-xs text-green-600">{t('competitionDetail.predictions.saved')}</p>
                        )}
                        {match.status === 'completed' && pred && (() => {
                          if (pred.isReplacement) {
                            return (
                              <div className="space-y-0.5">
                                <p className="text-xs text-muted-foreground">
                                  {t('competitionDetail.predictions.actualResult')}: {match.homeScore}–{match.awayScore}
                                </p>
                                <p className="text-xs text-muted-foreground italic">
                                  {language === 'no' ? 'Kopiert tips (gir ikke poeng)' : 'Copied prediction (no points)'}
                                </p>
                              </div>
                            );
                          }
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
                          className="h-11 w-11 rounded-full border flex items-center justify-center transition-opacity disabled:opacity-20 dark:border-blue-400 dark:text-blue-400"
                          aria-label="Previous match"
                        >←</button>
                        <button
                          type="button"
                          onClick={() => setCurrentGroupMatchIdx(i => Math.min(allGroupMatchesList.length - 1, i + 1))}
                          disabled={!canGoNext}
                          className="h-11 w-11 rounded-full border flex items-center justify-center transition-opacity disabled:opacity-20 dark:border-blue-400 dark:text-blue-400"
                          aria-label="Next match"
                        >→</button>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setCurrentGroupMatchIdx(i => Math.min(allGroupMatchesList.length - 1, i + 1))}
                      disabled={!canGoNext}
                      className="hidden sm:flex flex-shrink-0 h-10 w-10 rounded-full border items-center justify-center transition-opacity disabled:opacity-20 dark:border-blue-400 dark:text-blue-400"
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
          <div className="flex flex-wrap gap-4 mb-3">
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showComparisonUsers}
                onChange={e => setShowComparisonUsers(e.target.checked)}
                className="rounded"
              />
              {t('competitionDetail.leaderboard.showAiUsers')}
            </label>
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showInactiveUsers}
                onChange={e => setShowInactiveUsers(e.target.checked)}
                className="rounded"
              />
              {t('competitionDetail.leaderboard.showInactiveUsers')}
            </label>
          </div>
          {leaderboardLoading ? (
            <LoadingSpinner />
          ) : leaderboard.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">{t('competitionDetail.leaderboard.noScores')}</p>
          ) : (() => {
          const rankEntries = leaderboard
            .filter(e => showComparisonUsers || !e.isComparisonUser)
            .filter(e => showInactiveUsers || !e.inactive);
          const lastActiveRank = rankEntries.length > 0 ? rankEntries[rankEntries.length - 1].rank : 0;
          const rankColor = (rank: number) => {
            if (rank === 1) return 'text-yellow-500';
            if (rank === 2) return 'text-slate-400';
            if (rank === 3) return 'text-amber-600';
            if (rankEntries.length >= 5 && lastActiveRank > 3 && rank >= lastActiveRank) return 'text-red-500';
            return 'text-muted-foreground';
          };
          const rowBg = (rank: number) => {
            if (rank === 1) return 'bg-yellow-50 dark:bg-yellow-500/10';
            if (rank === 2) return 'bg-slate-100 dark:bg-slate-400/10';
            if (rank === 3) return 'bg-amber-50 dark:bg-amber-600/10';
            if (rankEntries.length >= 5 && lastActiveRank > 3 && rank >= lastActiveRank) return 'bg-red-50 dark:bg-red-500/10';
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
                  <PlayerPodium leaderboard={rankEntries} large={true} competitionId={id} tournamentStatus={tournament?.status} />
                </div>
              ) : (
                <PlayerPodium leaderboard={rankEntries} large={false} competitionId={id} tournamentStatus={tournament?.status} />
              )
            )}

            {/* Standard table (hidden on TV for leaderboard users) */}
            <div className={`overflow-x-auto rounded-lg border mt-4 dark:bg-white/5 p-2 ${user?.isLeaderboardUser ? 'tv:hidden' : ''}`}>
              <div style={{ position: 'relative' }}>
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
                  {rankEntries.map((entry) => {
                    const isMe = entry.userId === user?.id;
                    const isComparison = entry.isComparisonUser;
                    const b = entry.breakdown;
                    return (
                      <tr key={entry.userId} className={`${rowBg(entry.rank) || (isMe ? 'bg-primary/5' : '')}${isComparison ? ' italic opacity-80' : ''}${entry.inactive ? ' opacity-60' : ''}`}>
                        <td className={`pl-3 pr-2 py-2.5 font-bold text-center ${rankColor(entry.rank)}`}>
                          {entry.rank}
                        </td>
                        <td className="px-3 py-2.5">
                          <Link to={`/competitions/${id}/predictions/${entry.userId}`} className="flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity">
                            <UserAvatar username={entry.username} imageUrl={entry.imageUrl} iconColor={entry.iconColor} className="h-5 w-5 flex-shrink-0" />
                            <span className={`font-medium truncate ${isMe ? 'text-primary dark:text-[hsl(231,60%,65%)]' : ''}`}>
                              {entry.username}
                              {isMe && <span className="ml-1 font-normal text-muted-foreground">{t('competitionDetail.leaderboard.you')}</span>}
                              {isComparison && <span className="ml-1 font-normal text-muted-foreground not-italic">(AI)</span>}
                            </span>
                            {entry.isLateAddition && <span className="inline-block w-2 h-2 rounded-full bg-yellow-400 flex-shrink-0" title={t('competitionDetail.leaderboard.lateAdditionLegend')} />}
                            {entry.inactive && <span className="inline-block w-2 h-2 rounded-full bg-red-500 flex-shrink-0" title={t('competitionDetail.leaderboard.inactiveLegend')} />}
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
              const mid = Math.ceil(rankEntries.length / 2);
              const renderRows = (entries: typeof leaderboard) => entries.map((entry) => {
                const b = entry.breakdown;
                return (
                  <tr key={entry.userId} className={`${rowBg(entry.rank)}${entry.inactive ? ' opacity-60' : ''}`}>
                    <td className={`pl-4 pr-3 py-3 font-bold text-center text-base ${rankColor(entry.rank)}`}>
                      {entry.rank}
                    </td>
                    <td className="px-3 py-3">
                      <Link to={`/competitions/${id}/predictions/${entry.userId}`} className="flex items-center gap-3 min-w-0 hover:opacity-80 transition-opacity">
                        <UserAvatar username={entry.username} imageUrl={entry.imageUrl} iconColor={entry.iconColor} className="h-7 w-7 flex-shrink-0" />
                        <span className="font-medium text-base truncate">{entry.username}</span>
                        {entry.isLateAddition && <span className="inline-block w-2 h-2 rounded-full bg-yellow-400 flex-shrink-0" />}
                        {entry.inactive && <span className="inline-block w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />}
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
                        <tbody className="divide-y">{renderRows(rankEntries.slice(0, mid))}</tbody>
                      </table>
                    </div>
                  </div>
                  <div className="rounded-lg border dark:bg-white/5 p-2">
                    <div style={{ position: 'relative' }}>
                      <CryingPlayerAnimation />
                      <table className="w-full text-sm">
                        {tableHead}
                        <tbody className="divide-y">{renderRows(rankEntries.slice(mid))}</tbody>
                      </table>
                    </div>
                  </div>
                </div>
              );
            })()}

            {leaderboard.some(e => e.isLateAddition) && (
              <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground mt-3">
                <span className="inline-block w-2 h-2 rounded-full bg-yellow-400 flex-shrink-0" />
                {t('competitionDetail.leaderboard.lateAdditionLegend')}
              </p>
            )}
            {showInactiveUsers && leaderboard.some(e => e.inactive) && (
              <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground mt-3">
                <span className="inline-block w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
                {t('competitionDetail.leaderboard.inactiveLegend')}
              </p>
            )}
          </>);
          })()}

          {/* Match Predictions */}
          {!user?.isAdmin && completedMatchesWithResults.length > 0 && (() => {
            const safePredMatchIdx = Math.min(currentPredMatchIdx, allMatchesSorted.length - 1);
            const match = allMatchesSorted[safePredMatchIdx];
            if (!match) return null;

            const hasResult = match.homeScore !== null && match.awayScore !== null;
            const matchPreds = [...allMatchPredictions]
              .filter(p => p.matchId === match.id && !p.isReplacement)
              .sort((a, b) => {
                if (hasResult) {
                  const pointsDiff = (b.points ?? 0) - (a.points ?? 0);
                  if (pointsDiff !== 0) return pointsDiff;
                  const actualGD = (match.homeScore ?? 0) - (match.awayScore ?? 0);
                  const aGDDist = Math.abs((a.homeScore - a.awayScore) - actualGD);
                  const bGDDist = Math.abs((b.homeScore - b.awayScore) - actualGD);
                  const gdDiff = aGDDist - bGDDist;
                  if (gdDiff !== 0) return gdDiff;
                  const aHomeDist = Math.abs(a.homeScore - (match.homeScore ?? 0));
                  const bHomeDist = Math.abs(b.homeScore - (match.homeScore ?? 0));
                  return aHomeDist - bHomeDist;
                } else {
                  const aGD = a.homeScore - a.awayScore;
                  const bGD = b.homeScore - b.awayScore;
                  if (bGD !== aGD) return bGD - aGD;
                  return b.homeScore - a.homeScore;
                }
              });

            const isKnockout = match.stage !== 'group';
            const actualIsDraw = isKnockout && match.homeScore !== null && match.awayScore !== null && match.homeScore === match.awayScore;
            const actualProgressorIsHome = actualIsDraw && match.progressingTeamId !== null && match.progressingTeamId === match.homeTeamId;
            const actualProgressorIsAway = actualIsDraw && match.progressingTeamId !== null && match.progressingTeamId === match.awayTeamId;

            return (
              <div ref={matchPredictionsRef} className={`mt-6 ${user?.isLeaderboardUser ? 'tv:hidden' : ''}`}>
                <button
                  type="button"
                  onClick={() => setMatchPredictionsCollapsed(c => !c)}
                  className="flex items-center justify-between w-full text-left mb-3"
                >
                  <h2 className="font-semibold">{t('competitionDetail.leaderboard.matchPredictions')}</h2>
                  <span className="text-xs text-muted-foreground">{matchPredictionsCollapsed ? '▼' : '▲'}</span>
                </button>

                {!matchPredictionsCollapsed && (
                  <>
                    {/* Navigation dots */}
                    <div className="mb-4">
                      <div className="flex flex-wrap gap-1.5">
                        {allMatchesSorted.map((m, idx) => {
                          const isCurrent = idx === safePredMatchIdx;
                          const groupPred = predMap[m.id];
                          const koPred = knockoutPredByMatchId[m.id];
                          const activePred = groupPred ?? koPred;
                          const hasActual = m.status === 'completed' && m.homeScore !== null && m.awayScore !== null;
                          const hasPred = !!activePred;
                          const flipAct = !!(koPred?.flipped);
                          const effActH = flipAct ? (m.awayScore ?? 0) : (m.homeScore ?? 0);
                          const effActA = flipAct ? (m.homeScore ?? 0) : (m.awayScore ?? 0);
                          const isCorrectResult = hasPred && hasActual &&
                            Math.sign(activePred!.homeScore - activePred!.awayScore) === Math.sign(effActH - effActA);
                          const isExactScore = hasPred && hasActual &&
                            activePred!.homeScore === effActH && activePred!.awayScore === effActA;
                          const dotClass = isCurrent
                            ? 'w-5 h-2.5 bg-primary dark:bg-blue-400'
                            : !hasPred
                            ? 'w-2.5 h-2.5 bg-muted-foreground/30 hover:bg-muted-foreground/50'
                            : !hasActual
                            ? 'w-2.5 h-2.5 bg-yellow-300'
                            : isExactScore
                            ? 'w-2.5 h-2.5 bg-green-500 ring-1 ring-offset-1 ring-offset-background ring-amber-400'
                            : isCorrectResult
                            ? 'w-2.5 h-2.5 bg-green-500'
                            : 'w-2.5 h-2.5 bg-red-500';
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => setCurrentPredMatchIdx(idx)}
                              className={`rounded-full transition-all duration-200 ${dotClass}`}
                              aria-label={`Match ${idx + 1}`}
                            />
                          );
                        })}
                      </div>
                    </div>

                    {/* Match card with actual result */}
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-4">
                      <button
                        type="button"
                        onClick={() => setCurrentPredMatchIdx(i => Math.max(0, i - 1))}
                        disabled={safePredMatchIdx === 0}
                        className="hidden sm:flex flex-shrink-0 h-10 w-10 rounded-full border items-center justify-center transition-opacity disabled:opacity-20 dark:border-blue-400 dark:text-blue-400"
                        aria-label="Previous match"
                      >←</button>

                      <div className="flex-1">
                        <div className="text-center mb-2">
                          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                            {stageLabel(match.stage, match.groupName)}
                          </p>
                          {match.scheduledAt && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {new Date(match.scheduledAt).toLocaleDateString(dateLocale, { weekday: 'short', day: 'numeric', month: 'short' })}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {safePredMatchIdx + 1} / {allMatchesSorted.length}
                          </p>
                        </div>

                        <div className="rounded-xl border-2 shadow-sm overflow-hidden w-full max-w-xs mx-auto bg-card">
                          <div className="flex items-center gap-3 px-4 py-3.5">
                            <div className={`flex-shrink-0 ${actualProgressorIsHome ? 'ring-2 ring-amber-400 rounded-full' : ''}`}>
                              {match.homeTeamImageUrl ? (
                                <img src={match.homeTeamImageUrl} alt="" className="h-7 w-7 rounded-full object-cover" />
                              ) : (
                                <div className="h-7 w-7 rounded-full bg-muted" />
                              )}
                            </div>
                            {match.homeTeamId ? (
                              <Link to={`/competitions/${id}/team/${match.homeTeamId}`} className="flex-1 text-sm font-medium truncate hover:underline">{tn(match.homeTeamName) || 'TBD'}</Link>
                            ) : (
                              <span className="flex-1 text-sm font-medium truncate">{tn(match.homeTeamName) || 'TBD'}</span>
                            )}
                            <span className="w-11 h-9 flex items-center justify-center text-xl font-bold rounded-lg flex-shrink-0">{match.homeScore ?? '—'}</span>
                          </div>
                          <div className="h-px bg-border" />
                          <div className="flex items-center gap-3 px-4 py-3.5">
                            <div className={`flex-shrink-0 ${actualProgressorIsAway ? 'ring-2 ring-amber-400 rounded-full' : ''}`}>
                              {match.awayTeamImageUrl ? (
                                <img src={match.awayTeamImageUrl} alt="" className="h-7 w-7 rounded-full object-cover" />
                              ) : (
                                <div className="h-7 w-7 rounded-full bg-muted" />
                              )}
                            </div>
                            {match.awayTeamId ? (
                              <Link to={`/competitions/${id}/team/${match.awayTeamId}`} className="flex-1 text-sm font-medium truncate hover:underline">{tn(match.awayTeamName) || 'TBD'}</Link>
                            ) : (
                              <span className="flex-1 text-sm font-medium truncate">{tn(match.awayTeamName) || 'TBD'}</span>
                            )}
                            <span className="w-11 h-9 flex items-center justify-center text-xl font-bold rounded-lg flex-shrink-0">{match.awayScore ?? '—'}</span>
                          </div>
                        </div>

                        <div className="mt-3 flex sm:hidden items-center justify-between">
                          <button
                            type="button"
                            onClick={() => setCurrentPredMatchIdx(i => Math.max(0, i - 1))}
                            disabled={safePredMatchIdx === 0}
                            className="h-11 w-11 rounded-full border flex items-center justify-center transition-opacity disabled:opacity-20 dark:border-blue-400 dark:text-blue-400"
                          >←</button>
                          <button
                            type="button"
                            onClick={() => setCurrentPredMatchIdx(i => Math.min(allMatchesSorted.length - 1, i + 1))}
                            disabled={safePredMatchIdx === allMatchesSorted.length - 1}
                            className="h-11 w-11 rounded-full border flex items-center justify-center transition-opacity disabled:opacity-20 dark:border-blue-400 dark:text-blue-400"
                          >→</button>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => setCurrentPredMatchIdx(i => Math.min(completedMatchesWithResults.length - 1, i + 1))}
                        disabled={safePredMatchIdx === completedMatchesWithResults.length - 1}
                        className="hidden sm:flex flex-shrink-0 h-10 w-10 rounded-full border items-center justify-center transition-opacity disabled:opacity-20 dark:border-blue-400 dark:text-blue-400"
                        aria-label="Next match"
                      >→</button>
                    </div>

                    {/* Prediction list */}
                    {matchPreds.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-2">No predictions for this match</p>
                    ) : (
                      <div className="space-y-1">
                        {matchPreds.map(pred => {
                          const predKey = `${match.id}_${pred.userId}`;
                          const isExpanded = expandedPredKey === predKey;
                          const effectiveMatchHome = pred.flipped ? (match.awayScore ?? 0) : (match.homeScore ?? 0);
                          const effectiveMatchAway = pred.flipped ? (match.homeScore ?? 0) : (match.awayScore ?? 0);
                          const isExactScore =
                            match.homeScore !== null && match.awayScore !== null &&
                            pred.homeScore === effectiveMatchHome && pred.awayScore === effectiveMatchAway;
                          const predHomeId = pred.predHomeTeamId ?? match.homeTeamId;
                          const predAwayId = pred.predAwayTeamId ?? match.awayTeamId;
                          const homeGetsCircle =
                            isKnockout &&
                            pred.progressingTeamId !== null &&
                            match.progressingTeamId !== null &&
                            pred.progressingTeamId === match.progressingTeamId &&
                            pred.progressingTeamId === predHomeId;
                          const awayGetsCircle =
                            isKnockout &&
                            pred.progressingTeamId !== null &&
                            match.progressingTeamId !== null &&
                            pred.progressingTeamId === match.progressingTeamId &&
                            pred.progressingTeamId === predAwayId;
                          const displayHomeImg = pred.predHomeTeamImageUrl !== undefined
                            ? pred.predHomeTeamImageUrl
                            : (pred.flipped ? match.awayTeamImageUrl : match.homeTeamImageUrl);
                          const displayAwayImg = pred.predAwayTeamImageUrl !== undefined
                            ? pred.predAwayTeamImageUrl
                            : (pred.flipped ? match.homeTeamImageUrl : match.awayTeamImageUrl);

                          const predIsDraw = isKnockout && pred.homeScore === pred.awayScore;
                          const predProgressorIsHome = predIsDraw && pred.progressingTeamId !== null && pred.progressingTeamId === predHomeId;
                          const predProgressorIsAway = predIsDraw && pred.progressingTeamId !== null && pred.progressingTeamId === predAwayId;

                          const bd = pred.breakdown;
                          const breakdownLines: { label: string; pts: number }[] = bd ? [
                            { label: t('competitionDetail.leaderboard.exact'), pts: bd.exactScore },
                            { label: t('competitionDetail.leaderboard.result'), pts: bd.correctResult },
                            { label: t('competitionDetail.leaderboard.progresses'), pts: bd.correctTeamProgresses },
                            { label: t('competitionDetail.leaderboard.koTie'), pts: bd.correctTeamInKnockoutTie },
                            { label: t('competitionDetail.leaderboard.final'), pts: bd.correctTeamInFinal },
                            { label: t('competitionDetail.leaderboard.winner'), pts: bd.correctWinner },
                          ].filter(l => l.pts > 0) : [];

                          return (
                            <div key={pred.userId} className="rounded-lg overflow-hidden">
                              <button
                                type="button"
                                onClick={() => setExpandedPredKey(k => k === predKey ? null : predKey)}
                                className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-opacity hover:opacity-80 ${
                                  (pred.points ?? 0) > 0 ? 'bg-green-50 dark:bg-green-950/25' : 'bg-muted/20'
                                }`}
                              >
                                <UserAvatar username={pred.username} imageUrl={pred.imageUrl} iconColor={pred.iconColor} className="h-5 w-5 flex-shrink-0" />
                                <span className="flex-1 truncate font-medium text-xs">
                                  {pred.username}
                                  {pred.isComparisonUser && <span className="ml-1 font-normal text-muted-foreground not-italic">(AI)</span>}
                                  {pred.isReplacement && <span className="ml-1 font-normal text-muted-foreground not-italic">{language === 'no' ? '(kopiert)' : '(copied)'}</span>}
                                </span>

                                <div className="flex items-center gap-1 flex-shrink-0">
                                  <div className="relative">
                                    <div className={homeGetsCircle ? 'ring-2 ring-green-500 rounded-full' : ''}>
                                      {displayHomeImg ? (
                                        <img src={displayHomeImg} alt="" className="h-5 w-5 rounded-full object-cover" />
                                      ) : (
                                        <div className="h-5 w-5 rounded-full bg-muted" />
                                      )}
                                    </div>
                                    {predProgressorIsHome && (
                                      <span className="absolute -top-2 left-1/2 -translate-x-1/2 text-yellow-500 text-[9px] leading-none pointer-events-none">▲</span>
                                    )}
                                  </div>

                                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-bold tabular-nums min-w-[2.5rem] justify-center ${
                                    isExactScore
                                      ? 'bg-amber-50 dark:bg-amber-900/30 border border-amber-400 text-amber-600 dark:text-amber-400'
                                      : 'bg-background border'
                                  }`}>
                                    {pred.homeScore}–{pred.awayScore}
                                  </span>

                                  <div className="relative">
                                    <div className={awayGetsCircle ? 'ring-2 ring-green-500 rounded-full' : ''}>
                                      {displayAwayImg ? (
                                        <img src={displayAwayImg} alt="" className="h-5 w-5 rounded-full object-cover" />
                                      ) : (
                                        <div className="h-5 w-5 rounded-full bg-muted" />
                                      )}
                                    </div>
                                    {predProgressorIsAway && (
                                      <span className="absolute -top-2 left-1/2 -translate-x-1/2 text-yellow-500 text-[9px] leading-none pointer-events-none">▲</span>
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

                                <span className="text-muted-foreground flex-shrink-0 text-xs w-3">
                                  {isExpanded ? '▴' : '▾'}
                                </span>
                              </button>

                              {isExpanded && (
                                <div className={`px-3 py-2 text-xs space-y-1 border-t ${
                                  (pred.points ?? 0) > 0 ? 'bg-green-50/50 dark:bg-green-950/10 border-green-100 dark:border-green-900/30' : 'bg-muted/10 border-border'
                                }`}>
                                  {breakdownLines.length === 0 ? (
                                    <p className="text-muted-foreground">No points earned</p>
                                  ) : breakdownLines.map(line => (
                                    <div key={line.label} className="flex justify-between">
                                      <span className="text-muted-foreground">{line.label}</span>
                                      <span className="font-semibold text-green-600 dark:text-green-400">+{line.pts}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
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

      {activeTab === 'pointProgression' && (
        <div>
          <div className="flex flex-wrap gap-4 mb-3">
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showComparisonUsers}
                onChange={e => setShowComparisonUsers(e.target.checked)}
                className="rounded"
              />
              {t('competitionDetail.leaderboard.showAiUsers')}
            </label>
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showInactiveUsers}
                onChange={e => setShowInactiveUsers(e.target.checked)}
                className="rounded"
              />
              {t('competitionDetail.leaderboard.showInactiveUsers')}
            </label>
          </div>
          {leaderboardProgression && leaderboardProgression.matches.length > 0 ? (
            <LeaderboardLineGraph data={leaderboardProgression} />
          ) : (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {language === 'no' ? 'Ingen kamper er fullført ennå.' : 'No matches completed yet.'}
            </p>
          )}
        </div>
      )}

      {activeTab === 'userStats' && (
        <div className="columns-1 sm:columns-2 md:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6 gap-6 px-4 sm:px-0">
          {userStats.map((stat, i) => {
            const cardEl = (
              <UserStatCard
                competitionId={id!}
                data={stat}
                iconOnRight={i % 2 === 1}
                onMatchClick={handleStatCardMatchClick}
                onLeaderboardClick={handleStatCardLeaderboardClick}
              />
            );
            if (stat.distributionData?.length) {
              return (
                <div key={stat.id} className="break-inside-avoid mb-6 max-w-44 mx-auto flex flex-col gap-2">
                  {cardEl}
                  <HaalandDistributionCard data={stat} />
                </div>
              );
            }
            return <div key={stat.id} className="break-inside-avoid mb-6 max-w-44 mx-auto">{cardEl}</div>;
          })}
        </div>
      )}

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
