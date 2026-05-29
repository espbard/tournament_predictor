import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';

export default function Navbar() {
  const { user, setUser } = useAuthStore();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  async function handleLogout() {
    await api.post('/auth/logout', {});
    setUser(null);
    queryClient.clear();
    navigate('/login');
  }

  const isAdminPage = location.pathname === '/admin';

  return (
    <nav className="border-b bg-white px-4 py-3">
      <div className="mx-auto flex max-w-5xl items-center justify-between">
        <Link to="/" className="text-base font-semibold text-foreground hover:opacity-80">
          Tournament Predictor
        </Link>
        <div className="flex items-center gap-4">
          {user?.isAdmin && (
            <div className="flex items-center gap-1 rounded-md border p-0.5">
              <Link
                to="/"
                className={`rounded px-3 py-1 text-sm transition-colors ${
                  !isAdminPage
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Player
              </Link>
              <Link
                to="/admin"
                className={`rounded px-3 py-1 text-sm transition-colors ${
                  isAdminPage
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Admin
              </Link>
            </div>
          )}
          <Link
            to="/settings"
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            {user?.imageUrl ? (
              <img
                src={user.imageUrl}
                alt={user.username}
                className="h-7 w-7 rounded-full object-cover"
              />
            ) : (
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-100 text-xs font-medium">
                {user?.username?.[0]?.toUpperCase()}
              </span>
            )}
            <span>{user?.username}</span>
          </Link>
          <button
            onClick={handleLogout}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-gray-50"
          >
            Log out
          </button>
        </div>
      </div>
    </nav>
  );
}
