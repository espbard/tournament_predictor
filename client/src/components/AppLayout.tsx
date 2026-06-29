import Navbar from './Navbar';
import { useAuthStore } from '@/store/authStore';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user } = useAuthStore();
  const showFeedbackButton = !!user && !user.isAdmin && !user.isLeaderboardUser;

  return (
    <div className="min-h-screen bg-background">
      {!user?.isLeaderboardUser && (
        <div className="fixed top-0 inset-x-0 z-50">
          <Navbar />
        </div>
      )}
      <div className={`${user?.isLeaderboardUser ? 'min-h-[100dvh]' : 'pt-16'} ${showFeedbackButton ? 'pb-20' : ''}`}>
        {children}
      </div>
      {user?.isLeaderboardUser && <Navbar />}
    </div>
  );
}
