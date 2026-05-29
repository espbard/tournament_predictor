import { Link } from 'react-router-dom';

export default function AdminHomePage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Admin Panel</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage tournaments, teams, and match results
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          to="/tournaments"
          className="rounded-lg border p-5 transition-colors hover:bg-gray-50"
        >
          <h2 className="mb-1 font-semibold">Tournaments</h2>
          <p className="text-sm text-muted-foreground">
            Create and manage tournaments, add teams and matches, enter results
          </p>
        </Link>
        <div className="cursor-not-allowed rounded-lg border p-5 opacity-50">
          <h2 className="mb-1 font-semibold">Competitions</h2>
          <p className="text-sm text-muted-foreground">Coming soon</p>
        </div>
      </div>
    </main>
  );
}
