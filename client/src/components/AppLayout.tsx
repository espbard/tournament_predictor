import Navbar from './Navbar';
import { useAuthStore } from '@/store/authStore';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user } = useAuthStore();

  return (
    <div className="min-h-screen bg-background">
      {!user?.isLeaderboardUser && <Navbar />}
      {children}
      {user?.isLeaderboardUser && <Navbar />}
    </div>
  );
}
