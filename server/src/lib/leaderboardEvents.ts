import type { Response } from 'express';

const connections = new Map<string, Set<Response>>();

export function subscribeLeaderboard(competitionId: string, res: Response): void {
  if (!connections.has(competitionId)) {
    connections.set(competitionId, new Set());
  }
  connections.get(competitionId)!.add(res);
}

export function unsubscribeLeaderboard(competitionId: string, res: Response): void {
  const conns = connections.get(competitionId);
  if (!conns) return;
  conns.delete(res);
  if (conns.size === 0) connections.delete(competitionId);
}

export function notifyLeaderboardUpdate(competitionIds: string[]): void {
  for (const id of competitionIds) {
    const conns = connections.get(id);
    if (!conns?.size) continue;
    for (const res of conns) {
      res.write('event: leaderboard-updated\ndata: {}\n\n');
    }
  }
}
