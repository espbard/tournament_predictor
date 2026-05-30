import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';

export default function Navbar() {
  const { user, setUser } = useAuthStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

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
        <div className="flex items-center gap-4">
          <Link
            to="/settings"
            className="flex items-center gap-2 text-sm text-primary-foreground/70 hover:text-primary-foreground"
          >
            {user?.imageUrl ? (
              <img
                src={user.imageUrl}
                alt={user.username}
                className="h-7 w-7 rounded-full object-cover"
              />
            ) : (
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-foreground/20 text-xs font-medium text-primary-foreground">
                {user?.username?.[0]?.toUpperCase()}
              </span>
            )}
            <span>{user?.username}</span>
          </Link>
          <button
            onClick={handleLogout}
            className="rounded-md border border-primary-foreground/30 px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary-foreground/10"
          >
            Log out
          </button>
        </div>
      </div>
    </nav>
  );
}
