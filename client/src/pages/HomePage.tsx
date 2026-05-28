import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';

export default function HomePage() {
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
    <main className="flex min-h-screen flex-col items-center justify-center gap-6">
      <h1 className="text-3xl font-bold">Tournament Predictor</h1>
      <p className="text-muted-foreground">Welcome, {user?.username}!</p>
      <div className="flex flex-col items-center gap-3">
        <Link
          to="/tournaments"
          className="rounded-md bg-primary px-6 py-2 text-sm text-primary-foreground hover:bg-primary/90"
        >
          View Tournaments
        </Link>
        <button
          onClick={handleLogout}
          className="rounded-md border px-6 py-2 text-sm hover:bg-gray-50"
        >
          Log out
        </button>
      </div>
    </main>
  );
}
