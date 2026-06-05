import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Moon, Sun } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useLanguageStore } from '@/store/languageStore';
import { useThemeStore } from '@/store/themeStore';
import { useT } from '@/lib/useT';

export default function Navbar() {
  const { user, setUser } = useAuthStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { language, setLanguage } = useLanguageStore();
  const { theme, toggleTheme } = useThemeStore();
  const { t } = useT();

  async function handleLogout() {
    await api.post('/auth/logout', {});
    setUser(null);
    queryClient.clear();
    navigate('/login');
  }

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
          <button
            onClick={() => setLanguage(language === 'no' ? 'en' : 'no')}
            className="rounded-md border border-primary-foreground/30 px-2 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary-foreground/10 tracking-wide"
            title={language === 'no' ? 'Switch to English' : 'Bytt til norsk'}
          >
            {language === 'no' ? 'EN' : 'NO'}
          </button>
          <Link
            to="/settings"
            className="flex items-center gap-2 text-sm text-primary-foreground/70 hover:text-primary-foreground"
          >
            <img
              src={user?.imageUrl ?? '/default-avatar.png'}
              alt={user?.username}
              className="h-7 w-7 rounded-full object-cover"
            />
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
