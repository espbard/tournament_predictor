import { Link, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Moon, Sun, ChevronDown, LogOut, Settings } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useLanguageStore } from '@/store/languageStore';
import { useThemeStore } from '@/store/themeStore';
import { useT } from '@/lib/useT';
import { UserAvatar } from '@/components/UserAvatar';

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
    `whitespace-nowrap px-3 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-1 ${
      active
        ? 'border-foreground text-foreground'
        : 'border-transparent text-foreground/50 hover:text-foreground'
    }`;

  const dropItemCls = (active: boolean) =>
    `w-full text-left px-4 py-2 text-sm hover:bg-muted ${active ? 'text-primary dark:text-blue-400 font-medium' : 'text-foreground'}`;

  const predictionsActive = activeTab === 'group' || activeTab === 'tables' || activeTab === 'knockout' || activeTab === 'bonus';
  const standingsActive = activeTab === 'leaderboard' || activeTab === 'pointProgression';

  return (
    <nav className="bg-background border-b border-border">
      <div className="mx-auto flex items-center max-w-5xl px-4 py-2">
        {/* Site name – hidden on mobile only when tabs are shown */}
        <Link
          to="/"
          className={`shrink-0 flex items-center text-base font-semibold text-foreground hover:opacity-70 mr-3 py-3 ${showTabs ? 'hidden sm:flex' : ''}`}
        >
          {t('nav.appName')}
        </Link>

        {/* Competition tabs */}
        {showTabs ? (
          <div className={`flex items-center flex-1 min-w-0 ${user?.isLeaderboardUser ? 'tv:hidden' : ''}`}>
            {!user?.isAdmin && !user?.isLeaderboardUser ? (
              <>
                {/* Predictions dropdown */}
                <div ref={groupsRef} className="relative">
                  <button
                    onClick={() => { setGroupsOpen(o => !o); setStandingsOpen(false); }}
                    className={tabCls(predictionsActive)}
                  >
                    {t('nav.tabGroups')}
                    <ChevronDown size={13} className={`transition-transform duration-150 ${groupsOpen ? 'rotate-180' : ''}`} />
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
                    <ChevronDown size={13} className={`transition-transform duration-150 ${standingsOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {standingsOpen && (
                    <div className="absolute left-0 top-full z-[100] min-w-[190px] rounded-md border border-border bg-popover shadow-md py-1">
                      <button onClick={() => setTab('leaderboard')} className={dropItemCls(activeTab === 'leaderboard')}>
                        {t('competitionDetail.tabs.leaderboard')}
                      </button>
                      <button onClick={() => setTab('pointProgression')} className={dropItemCls(activeTab === 'pointProgression')}>
                        {t('competitionDetail.tabs.pointProgression')}
                      </button>
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
        ) : (
          <div className="flex-1" />
        )}

        {/* User settings menu */}
        {user && (
          <div ref={userMenuRef} className="relative shrink-0 flex items-center ml-2">
            <button
              onClick={() => setUserMenuOpen(o => !o)}
              className="flex items-center py-2 hover:opacity-80"
            >
              <UserAvatar
                username={user.username}
                imageUrl={user.imageUrl}
                iconColor={user.iconColor}
                className="h-8 w-8 rounded-full"
              />
            </button>
            {userMenuOpen && (
              <div className="absolute right-0 top-full mt-2 z-[100] w-52 rounded-md border border-border bg-popover shadow-md py-2">
                {/* Theme toggle */}
                <button
                  onClick={toggleTheme}
                  className="w-full flex items-center gap-3 px-4 py-2 text-sm text-foreground hover:bg-muted"
                >
                  {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
                  {theme === 'dark' ? t('nav.lightMode') : t('nav.darkMode')}
                </button>

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

                {/* Edit profile */}
                <Link
                  to="/settings"
                  onClick={() => setUserMenuOpen(false)}
                  className="flex items-center gap-3 px-4 py-2 text-sm text-foreground hover:bg-muted"
                >
                  <Settings size={15} />
                  {t('nav.editProfile')}
                </Link>

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
