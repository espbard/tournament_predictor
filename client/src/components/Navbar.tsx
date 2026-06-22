import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Moon, Sun } from 'lucide-react';
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
] as const;

export default function Navbar() {
  const { user, setUser } = useAuthStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { language, setLanguage } = useLanguageStore();
  const { theme, toggleTheme } = useThemeStore();
  const { t } = useT();
  const [langOpen, setLangOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (langRef.current && !langRef.current.contains(e.target as Node)) {
        setLangOpen(false);
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

  return (
    <nav className="bg-primary px-4 py-3">
      <div className="mx-auto flex max-w-5xl items-center justify-between">
        <Link to="/" className="text-base font-semibold text-primary-foreground hover:opacity-80">
          Tournament Predictor
        </Link>
        <div className="flex items-center gap-3">
          <button
            onClick={toggleTheme}
            className="rounded-md border border-primary-foreground/30 p-1.5 text-primary-foreground hover:bg-primary-foreground/10"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <div ref={langRef} className="relative">
            <button
              onClick={() => setLangOpen((o) => !o)}
              className="rounded-md border border-primary-foreground/30 p-1 hover:bg-primary-foreground/10"
              title={currentLang.label}
            >
              <img src={currentLang.flag} alt={currentLang.label} className="h-5 w-8 rounded-sm object-cover" />
            </button>
            {langOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 min-w-[120px] overflow-hidden rounded-md border border-border bg-popover shadow-md">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang.code}
                    onClick={() => { setLanguage(lang.code); setLangOpen(false); }}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-sm text-popover-foreground hover:bg-accent ${lang.code === language ? 'bg-accent/50 font-semibold' : ''}`}
                  >
                    <img src={lang.flag} alt={lang.label} className="h-4 w-6 rounded-sm object-cover" />
                    {lang.label}
                  </button>
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
            className="rounded-md border border-primary-foreground/30 px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary-foreground/10"
          >
            {t('nav.logOut')}
          </button>
        </div>
      </div>
    </nav>
  );
}
