import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import type { User } from '@tournament-predictor/shared';
import AppLayout from '@/components/AppLayout';
import HomePage from '@/pages/HomePage';
import AdminHomePage from '@/pages/AdminHomePage';
import LoginPage from '@/pages/LoginPage';
import RegisterPage from '@/pages/RegisterPage';
import TournamentsPage from '@/pages/TournamentsPage';
import TournamentDetailPage from '@/pages/TournamentDetailPage';
import CompetitionsPage from '@/pages/CompetitionsPage';
import CompetitionDetailPage from '@/pages/CompetitionDetailPage';
import EditUserPage from '@/pages/EditUserPage';
import EditTournamentPage from '@/pages/EditTournamentPage';
import EditTeamPage from '@/pages/EditTeamPage';
import TournamentKnockoutPage from '@/pages/TournamentKnockoutPage';
import MaintenancePage from '@/pages/MaintenancePage';

function PrivateRoute({ children, maintenanceMode }: { children: React.ReactNode; maintenanceMode: boolean }) {
  const { user, isLoading } = useAuthStore();
  if (isLoading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (maintenanceMode && !user.isAdmin && !user.isTestAccount) return <MaintenancePage />;
  return <AppLayout>{children}</AppLayout>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuthStore();
  if (isLoading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (!user.isAdmin) return <Navigate to="/" replace />;
  return <AppLayout>{children}</AppLayout>;
}

export default function App() {
  const { setUser, setLoading } = useAuthStore();

  const { data, isLoading } = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<User>('/auth/me'),
    retry: false,
  });

  const { data: maintenanceData } = useQuery({
    queryKey: ['maintenance'],
    queryFn: () => api.get<{ maintenanceMode: boolean }>('/settings/maintenance'),
    retry: false,
    refetchInterval: 30_000,
  });

  const maintenanceMode = maintenanceData?.maintenanceMode ?? false;

  useEffect(() => {
    setUser(data ?? null);
    setLoading(isLoading);
  }, [data, isLoading, setUser, setLoading]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        path="/"
        element={
          <PrivateRoute maintenanceMode={maintenanceMode}>
            <HomePage />
          </PrivateRoute>
        }
      />
      <Route
        path="/admin"
        element={
          <AdminRoute>
            <AdminHomePage maintenanceMode={maintenanceMode} />
          </AdminRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <PrivateRoute maintenanceMode={maintenanceMode}>
            <EditUserPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/admin/competitions"
        element={
          <AdminRoute>
            <CompetitionsPage />
          </AdminRoute>
        }
      />
      <Route
        path="/competitions/:id"
        element={
          <PrivateRoute maintenanceMode={maintenanceMode}>
            <CompetitionDetailPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/admin/tournaments"
        element={
          <AdminRoute>
            <TournamentsPage />
          </AdminRoute>
        }
      />
      <Route
        path="/admin/tournaments/:id"
        element={
          <AdminRoute>
            <TournamentDetailPage />
          </AdminRoute>
        }
      />
      <Route
        path="/admin/tournaments/:id/knockout"
        element={
          <AdminRoute>
            <TournamentKnockoutPage />
          </AdminRoute>
        }
      />
      <Route
        path="/admin/tournaments/:id/edit"
        element={
          <AdminRoute>
            <EditTournamentPage />
          </AdminRoute>
        }
      />
      <Route
        path="/admin/teams/:teamId/edit"
        element={
          <AdminRoute>
            <EditTeamPage />
          </AdminRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
