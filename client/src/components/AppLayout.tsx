import Navbar from './Navbar';
import { useAuthStore } from '@/store/authStore';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user } = useAuthStore();

  return (
    <div className="min-h-screen bg-background">
      {!user?.isLeaderboardUser && <Navbar />}
      <div className={user?.isLeaderboardUser ? 'min-h-[100dvh]' : ''}>
        {children}
      </div>
      {user?.isLeaderboardUser && <Navbar />}
    </div>
  );
}
