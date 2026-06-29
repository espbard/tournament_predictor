import { Link, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Moon, Sun, ChevronDown } from 'lucide-react';
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
  const [langOpen, setLangOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [standingsOpen, setStandingsOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);
  const groupsRef = useRef<HTMLDivElement>(null);
  const standingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (langRef.current && !langRef.current.contains(e.target as Node)) {
        setLangOpen(false);
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

  const currentLang = LANGUAGES.find((l) => l.code === language) ?? LANGUAGES[0];

  const isOnCompetitionPage = /^\/competitions\/[^/]+$/.test(location.pathname);
  const activeTab = searchParams.get('tab') ?? (user?.isLeaderboardUser || user?.isAdmin ? 'leaderboard' : 'group');

  const setTab = (tab: string) => {
    setGroupsOpen(false);
    setStandingsOpen(false);
    setSearchParams(prev => {
      const n = new URLSearchParams(prev);
      n.set('tab', tab);
      return n;
    }, { replace: true });
  };

  const tabCls = (active: boolean) =>
    `whitespace-nowrap px-3 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-1 ${
      active
        ? 'border-primary-foreground text-primary-foreground'
        : 'border-transparent text-primary-foreground/60 hover:text-primary-foreground'
    }`;

  const dropItemCls = (active: boolean) =>
    `w-full text-left px-4 py-2 text-sm hover:bg-muted ${active ? 'text-primary font-medium' : 'text-foreground'}`;

  const groupsActive = activeTab === 'group' || activeTab === 'tables';
  const standingsActive = activeTab === 'leaderboard' || activeTab === 'pointProgression';

  return (
    <nav className="bg-primary">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <Link to="/" className="text-base font-semibold text-primary-foreground hover:opacity-80">
          {t('nav.appName')}
        </Link>
        <div className="flex items-center gap-3">
          <button
            onClick={toggleTheme}
            className="rounded-md border border-primary-foreground/30 p-1.5 text-primary-foreground hover:bg-primary-foreground/10"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <div ref={langRef} className="relative flex items-center">
            <button
              onClick={() => setLangOpen((o) => !o)}
              className="flex items-center hover:opacity-80"
              title={currentLang.label}
            >
              <img src={currentLang.flag} alt={currentLang.label} className="h-5 w-8 rounded-sm object-cover" />
            </button>
            {langOpen && (
              <div
                className="fixed sm:absolute left-1/2 sm:left-auto -translate-x-1/2 sm:translate-x-0 sm:right-0 top-12 sm:top-full sm:mt-2 z-50 flex flex-row gap-4 px-4 py-3 rounded-md border border-border bg-popover shadow-md"
                style={{ width: 'max-content' }}
              >
                {LANGUAGES.map((lang) => (
                  <img
                    key={lang.code}
                    src={lang.flag}
                    alt={lang.label}
                    title={lang.label}
                    onClick={() => { setLanguage(lang.code); setLangOpen(false); }}
                    className={`h-8 w-12 rounded-sm object-cover cursor-pointer hover:opacity-80 transition-opacity ${lang.code === language ? 'ring-2 ring-primary' : ''}`}
                  />
                ))}
              </div>
            )}
          </div>
          <Link
            to="/settings"
            className="flex items-center gap-2 text-sm text-primary-foreground/70 hover:text-primary-foreground"
          >
            {user && (
              <UserAvatar
                username={user.username}
                imageUrl={user.imageUrl}
                iconColor={user.iconColor}
                className="h-7 w-7"
              />
            )}
          </Link>
          <button
            onClick={handleLogout}
            className="rounded-md border border-primary-foreground/30 p-1.5 text-primary-foreground hover:bg-primary-foreground/10"
            title={t('nav.logOut')}
          >
            <span
              className="block h-4 w-4 bg-current"
              aria-hidden="true"
              style={{
                maskImage: 'url(/logout-icon.png)',
                WebkitMaskImage: 'url(/logout-icon.png)',
                maskSize: 'contain',
                WebkitMaskSize: 'contain',
                maskRepeat: 'no-repeat',
                WebkitMaskRepeat: 'no-repeat',
                maskPosition: 'center',
                WebkitMaskPosition: 'center',
              }}
            />
          </button>
        </div>
      </div>

      {isOnCompetitionPage && (
        <div className={`border-t border-primary-foreground/10 ${user?.isLeaderboardUser ? 'tv:hidden' : ''}`}>
          <div className="mx-auto flex items-stretch max-w-5xl px-2 overflow-x-auto">
            {!user?.isAdmin && !user?.isLeaderboardUser ? (
              <>
                {/* Groups dropdown */}
                <div ref={groupsRef} className="relative">
                  <button
                    onClick={() => { setGroupsOpen(o => !o); setStandingsOpen(false); }}
                    className={tabCls(groupsActive)}
                  >
                    {t('nav.tabGroups')}
                    <ChevronDown size={13} className={`transition-transform duration-150 ${groupsOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {groupsOpen && (
                    <div className="absolute left-0 top-full z-50 min-w-[160px] rounded-md border border-border bg-popover shadow-md py-1">
                      <button onClick={() => setTab('group')} className={dropItemCls(activeTab === 'group')}>
                        {t('competitionDetail.tabs.groupStage')}
                      </button>
                      <button onClick={() => setTab('tables')} className={dropItemCls(activeTab === 'tables')}>
                        {t('competitionDetail.tabs.groupTables')}
                      </button>
                    </div>
                  )}
                </div>

                <button onClick={() => setTab('knockout')} className={tabCls(activeTab === 'knockout')}>
                  {t('competitionDetail.tabs.knockoutStage')}
                </button>
                <button onClick={() => setTab('bonus')} className={tabCls(activeTab === 'bonus')}>
                  {t('competitionDetail.tabs.bonusQuestions')}
                </button>

                {/* Standings dropdown */}
                <div ref={standingsRef} className="relative">
                  <button
                    onClick={() => { setStandingsOpen(o => !o); setGroupsOpen(false); }}
                    className={tabCls(standingsActive)}
                  >
                    {t('nav.tabStandings')}
                    <ChevronDown size={13} className={`transition-transform duration-150 ${standingsOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {standingsOpen && (
                    <div className="absolute left-0 top-full z-50 min-w-[190px] rounded-md border border-border bg-popover shadow-md py-1">
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
              /* Admin */
              <button onClick={() => setTab('leaderboard')} className={tabCls(activeTab === 'leaderboard')}>
                {t('competitionDetail.tabs.leaderboard')}
              </button>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
