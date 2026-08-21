import type { Response } from 'express';

// ── Live competition SSE ──────────────────────────────────────────────────────
//
// A parallel copy of server/src/lib/leaderboardEvents.ts, keyed by live competition id
// and with its own event names. Deliberately not shared: the two namespaces should be
// free to grow apart, and the live type pushes fixture updates as well as leaderboard
// ones because scores arrive on their own rather than when an admin types them in.
//
// Connections live in process memory, so a second replica would only reach its own
// clients. That is the same limitation the manual type already has, and it is acceptable
// while this deploys as a single Railway service.

export type LiveEventName = 'fixtures-updated' | 'leaderboard-updated';

const connections = new Map<string, Set<Response>>();

export function subscribeLiveCompetition(competitionId: string, res: Response): void {
  let conns = connections.get(competitionId);
  if (!conns) {
    conns = new Set();
    connections.set(competitionId, conns);
  }
  conns.add(res);
}

export function unsubscribeLiveCompetition(competitionId: string, res: Response): void {
  const conns = connections.get(competitionId);
  if (!conns) return;
  conns.delete(res);
  if (conns.size === 0) connections.delete(competitionId);
}

export function notifyLiveCompetitions(competitionIds: string[], event: LiveEventName): void {
  for (const id of new Set(competitionIds)) {
    const conns = connections.get(id);
    if (!conns?.size) continue;
    for (const res of conns) {
      try {
        res.write(`event: ${event}\ndata: {}\n\n`);
      } catch {
        // A dead connection should not take the sync tick down with it; the close
        // handler on the route unsubscribes it.
      }
    }
  }
}

/** Test/introspection helper: how many clients are listening to a competition. */
export function liveSubscriberCount(competitionId: string): number {
  return connections.get(competitionId)?.size ?? 0;
}
