import { useAuthStore } from '@/store/authStore';
import { api } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

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
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-3xl font-bold">Tournament Predictor</h1>
      <p className="text-muted-foreground">Welcome, {user?.username}!</p>
      <button
        onClick={handleLogout}
        className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
      >
        Log out
      </button>
    </main>
  );
}
