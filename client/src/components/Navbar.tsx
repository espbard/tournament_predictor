import { Link, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Moon, Sun, ChevronDown, LogOut, Settings, Home } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useLanguageStore } from '@/store/languageStore';
import { useThemeStore } from '@/store/themeStore';
import { useT } from '@/lib/useT';
import { UserAvatar } from '@/components/UserAvatar';
import type { Competition, Tournament } from '@tournament-predictor/shared';

const LANGUAGES = [
  { code: 'no', label: 'Norsk', flag: '/flag-no.png' },
  { code: 'en', label: 'English', flag: '/flag-en.png' },
  { code: 'de', label: 'Deutsch', flag: '/flag-de.png' },
] as const;

export default function Navbar() {
  const { user, setUser } = useAuthStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { language, setLanguage } = useLanguageStore();
  const { theme, toggleTheme } = useThemeStore();
  const { t } = useT();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [standingsOpen, setStandingsOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const groupsRef = useRef<HTMLDivElement>(null);
  const standingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
      if (groupsRef.current && !groupsRef.current.contains(e.target as Node)) {
        setGroupsOpen(false);
      }
      if (standingsRef.current && !standingsRef.current.contains(e.target as Node)) {
        setStandingsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  async function handleLogout() {
    await api.post('/auth/logout', {});
    setUser(null);
    queryClient.clear();
    navigate('/login');
  }

  const isOnCompetitionPage = /^\/competitions\/[^/]+$/.test(location.pathname);
  const isOnPredictionsPage = /^\/competitions\/[^/]+\/predictions\/[^/]+$/.test(location.pathname);
  const showTabs = isOnCompetitionPage || isOnPredictionsPage;
  const competitionId = location.pathname.match(/^\/competitions\/([^/]+)/)?.[1];

  const { data: navCompetition } = useQuery({
    queryKey: ['competitions', competitionId],
    queryFn: () => api.get<Competition>(`/competitions/${competitionId}`),
    enabled: !!competitionId && showTabs,
  });

  const { data: navTournament } = useQuery({
    queryKey: ['tournament', navCompetition?.tournamentId],
    queryFn: () => api.get<Tournament>(`/tournaments/${navCompetition!.tournamentId}`),
    enabled: !!navCompetition && !user?.isAdmin,
  });

  const tournamentCompleted = navTournament?.status === 'completed';

  const activeTab = searchParams.get('tab') ?? (user?.isLeaderboardUser || user?.isAdmin ? 'leaderboard' : 'group');

  const setTab = (tab: string) => {
    setGroupsOpen(false);
    setStandingsOpen(false);
    if (isOnPredictionsPage && competitionId) {
      navigate(`/competitions/${competitionId}?tab=${tab}`);
    } else {
      setSearchParams(prev => {
        const n = new URLSearchParams(prev);
        n.set('tab', tab);
        return n;
      }, { replace: true });
    }
  };

  const tabCls = (active: boolean) =>
    `whitespace-nowrap px-2 sm:px-3 lg:px-4 py-1.5 sm:py-2 lg:py-2.5 text-sm sm:text-[0.9rem] lg:text-base font-medium transition-colors flex items-center gap-1 ${
      active
        ? 'text-foreground'
        : 'text-foreground/60 hover:text-foreground dark:text-foreground/75'
    }`;

  const dropItemCls = (active: boolean) =>
    `w-full text-left px-4 py-2 lg:py-2.5 text-sm lg:text-[0.9rem] hover:bg-muted ${active ? 'text-primary dark:text-blue-400 font-medium' : 'text-foreground'}`;

  const predictionsActive = activeTab === 'group' || activeTab === 'tables' || activeTab === 'knockout' || activeTab === 'bonus';
  const standingsActive = activeTab === 'leaderboard' || activeTab === 'pointProgression' || activeTab === 'finalResults';

  return (
    <nav className="bg-background border-b border-border">
      <div className="mx-auto flex items-center max-w-5xl lg:max-w-[80%] px-3 sm:px-4 py-1 sm:py-2 lg:py-2.5">
        {/* Home icon – shown when not on home page */}
        {location.pathname !== '/' && (
          <Link to="/" className="shrink-0 flex items-center py-1 pl-1 sm:mr-2 lg:mr-3 text-foreground hover:opacity-70" aria-label="Home">
            <Home size={18} className="sm:hidden" />
            <Home size={20} className="hidden sm:block lg:hidden" />
            <Home size={22} className="hidden lg:block" />
          </Link>
        )}

        {/* Site name – hidden on mobile only when tabs are shown */}
        <Link
          to="/"
          className={`shrink-0 flex items-center text-base lg:text-lg font-semibold text-foreground hover:opacity-70 mr-2 py-2 sm:py-3 ${showTabs ? 'hidden sm:flex' : ''}`}
        >
          {t('nav.appName')}
        </Link>

        {/* Spacer – always pushes tabs and avatar to the right */}
        <div className="flex-1" />

        {/* Competition tabs */}
        {showTabs && (
          <div className={`flex items-center min-w-0 ${user?.isLeaderboardUser ? 'tv:hidden' : ''}`}>
            {!user?.isAdmin && !user?.isLeaderboardUser ? (
              <>
                {/* Predictions dropdown */}
                <div ref={groupsRef} className="relative">
                  <button
                    onClick={() => { setGroupsOpen(o => !o); setStandingsOpen(false); }}
                    className={tabCls(predictionsActive)}
                  >
                    {t('nav.tabGroups')}
                    <ChevronDown size={13} className={`transition-transform duration-150 lg:w-4 lg:h-4 ${groupsOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {groupsOpen && (
                    <div className="absolute left-0 top-full z-[100] min-w-[180px] rounded-md border border-border bg-popover shadow-md py-1">
                      <button onClick={() => setTab('group')} className={dropItemCls(activeTab === 'group')}>
                        {t('competitionDetail.tabs.groupStage')}
                      </button>
                      <button onClick={() => setTab('tables')} className={dropItemCls(activeTab === 'tables')}>
                        {t('competitionDetail.tabs.groupTables')}
                      </button>
                      <button onClick={() => setTab('knockout')} className={dropItemCls(activeTab === 'knockout')}>
                        {t('competitionDetail.tabs.knockoutStage')}
                      </button>
                      <button onClick={() => setTab('bonus')} className={dropItemCls(activeTab === 'bonus')}>
                        {t('competitionDetail.tabs.bonusQuestions')}
                      </button>
                    </div>
                  )}
                </div>

                {/* Results dropdown */}
                <div ref={standingsRef} className="relative">
                  <button
                    onClick={() => { setStandingsOpen(o => !o); setGroupsOpen(false); }}
                    className={tabCls(standingsActive)}
                  >
                    {t('nav.tabStandings')}
                    <ChevronDown size={13} className={`transition-transform duration-150 lg:w-4 lg:h-4 ${standingsOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {standingsOpen && (
                    <div className="absolute left-0 top-full z-[100] min-w-[190px] rounded-md border border-border bg-popover shadow-md py-1">
                      <button onClick={() => setTab('leaderboard')} className={dropItemCls(activeTab === 'leaderboard')}>
                        {t('competitionDetail.tabs.leaderboard')}
                      </button>
                      <button onClick={() => setTab('pointProgression')} className={dropItemCls(activeTab === 'pointProgression')}>
                        {t('competitionDetail.tabs.pointProgression')}
                      </button>
                      {(tournamentCompleted || user?.isTestAccount) && (
                        <button onClick={() => setTab('finalResults')} className={dropItemCls(activeTab === 'finalResults')}>
                          {t('competitionDetail.tabs.finalResults')}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <button onClick={() => setTab('userStats')} className={tabCls(activeTab === 'userStats')}>
                  {t('competitionDetail.tabs.userStats')}
                </button>
              </>
            ) : user?.isLeaderboardUser ? (
              <>
                <button onClick={() => setTab('leaderboard')} className={tabCls(activeTab === 'leaderboard')}>
                  {t('competitionDetail.tabs.leaderboard')}
                </button>
                <button onClick={() => setTab('pointProgression')} className={tabCls(activeTab === 'pointProgression')}>
                  {t('competitionDetail.tabs.pointProgression')}
                </button>
              </>
            ) : (
              <button onClick={() => setTab('leaderboard')} className={tabCls(activeTab === 'leaderboard')}>
                {t('competitionDetail.tabs.leaderboard')}
              </button>
            )}
          </div>
        )}

        {/* User settings menu */}
        {user && (
          <div ref={userMenuRef} className="relative shrink-0 flex items-center ml-1">
            <button
              onClick={() => setUserMenuOpen(o => !o)}
              className="flex items-center py-1.5 sm:py-2 hover:opacity-80"
            >
              <UserAvatar
                username={user.username}
                imageUrl={user.imageUrl}
                iconColor={user.iconColor}
                className="h-8 w-8 lg:h-9 lg:w-9 rounded-full"
              />
            </button>
            {userMenuOpen && (
              <div className="absolute right-0 top-full mt-2 z-[100] w-52 rounded-md border border-border bg-popover shadow-md py-2">
                {/* Language picker */}
                <div className="px-4 py-2 flex items-center gap-2">
                  {LANGUAGES.map((lang) => (
                    <img
                      key={lang.code}
                      src={lang.flag}
                      alt={lang.label}
                      title={lang.label}
                      onClick={() => setLanguage(lang.code)}
                      className={`h-6 w-9 rounded-sm object-cover cursor-pointer hover:opacity-80 transition-opacity ${lang.code === language ? 'ring-2 ring-primary' : ''}`}
                    />
                  ))}
                </div>

                <div className="border-t border-border my-1" />

                {/* Theme toggle */}
                <button
                  onClick={toggleTheme}
                  className="w-full flex items-center gap-3 px-4 py-2 text-sm text-foreground hover:bg-muted"
                >
                  {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
                  {theme === 'dark' ? t('nav.lightMode') : t('nav.darkMode')}
                </button>

                <div className="border-t border-border my-1" />

                {/* Edit profile */}
                <Link
                  to="/settings"
                  onClick={() => setUserMenuOpen(false)}
                  className="flex items-center gap-3 px-4 py-2 text-sm text-foreground hover:bg-muted"
                >
                  <Settings size={15} />
                  {t('nav.editProfile')}
                </Link>

                <div className="border-t border-border my-1" />

                {/* Logout */}
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-3 px-4 py-2 text-sm text-foreground hover:bg-muted"
                >
                  <LogOut size={15} />
                  {t('nav.logOut')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
