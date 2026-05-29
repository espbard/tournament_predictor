import { Link } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';

export default function HomePage() {
  const { user } = useAuthStore();

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <div className="mb-8 flex items-center gap-4">
        {user?.imageUrl ? (
          <img
            src={user.imageUrl}
            alt={user.username}
            className="h-14 w-14 rounded-full object-cover"
          />
        ) : (
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-100 text-xl font-semibold">
            {user?.username?.[0]?.toUpperCase()}
          </span>
        )}
        <div>
          <h1 className="text-2xl font-bold">Welcome, {user?.username}!</h1>
          <p className="text-sm text-muted-foreground">Pick your scores and climb the leaderboard</p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          to="/tournaments"
          className="rounded-lg border p-5 transition-colors hover:bg-gray-50"
        >
          <h2 className="mb-1 font-semibold">Tournaments</h2>
          <p className="text-sm text-muted-foreground">Browse active and upcoming tournaments</p>
        </Link>
        <div className="cursor-not-allowed rounded-lg border p-5 opacity-50">
          <h2 className="mb-1 font-semibold">My Competitions</h2>
          <p className="text-sm text-muted-foreground">Coming soon</p>
        </div>
        <div className="cursor-not-allowed rounded-lg border p-5 opacity-50">
          <h2 className="mb-1 font-semibold">My Predictions</h2>
          <p className="text-sm text-muted-foreground">Coming soon</p>
        </div>
        <div className="cursor-not-allowed rounded-lg border p-5 opacity-50">
          <h2 className="mb-1 font-semibold">Leaderboard</h2>
          <p className="text-sm text-muted-foreground">Coming soon</p>
        </div>
      </div>
    </main>
  );
}
